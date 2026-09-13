/**
  * 开发者自助测试规划智能体（Self-Test Planner）
  *
  * 核心职责：
  * 让开发者只需输入需求文档、功能描述或新模型规格（NewapiModelOnboardingSpec），
  * 即可自主决策：
  * - 测试什么业务领域（VIDEO / IMAGE / CANVAS / MULTI_MODAL）
  * - 涉及哪些具体模型、别名与能力约束
  * - 需要哪些前置条件（Session, CSRF, Token, Project）
  * - 采取何种执行模式（API_INTEGRATION / UI_E2E / MOCK）
  * - 调度哪些场景与风险防控（由 ScenarioPlanner 规划）
  * - 编排哪些依赖有向无环图步骤（由 ExecutionPlanner 规划）
  * - 需收集哪些关键证据与生效哪些 Oracle
  */

import type {
  DevTestFlowType,
  DevTestSelfTestInput,
  DevTestSelfTestPlan,
} from './types.js';
import { ScenarioPlanner } from './scenario-planner.js';
import { ExecutionPlanner } from './execution-planner.js';

export class SelfTestPlanner {
  /**
   * 基于输入需求与上下文自主生成测试规划
   */
  static plan(input: DevTestSelfTestInput): DevTestSelfTestPlan {
    const text = [
      input.requirement ?? '',
      input.featureDescription ?? '',
      input.modelSpec ? JSON.stringify(input.modelSpec) : '',
    ].join(' ').toLowerCase();

    // 0. 识别/决策测试流程类型（Flow Type: DIVERSION vs DIRECT）
    let flowType: DevTestFlowType;
    if (input.flowType) {
      flowType = input.flowType;
    } else {
      // 智能文本推导:
      // 分流信号: 包含"分流", "降级", "回退", "已有模型", "流量切换", "转接", "双向决策"等
      const hasDiversionSignal = /分流|降级|回退|已有模型|流量切换|转接|双向决策|diversion|fallback/i.test(text);
      // 直连/新模型信号: 包含"直接接入", "直连", "新模型", "新接入", "新上线", "直接调用"等
      const hasDirectSignal = /直接接入|直连|新模型|新接入|新上线|direct|onboard/i.test(text);

      if (hasDiversionSignal && !hasDirectSignal) {
        flowType = 'DIVERSION';
      } else if (hasDirectSignal && !hasDiversionSignal) {
        flowType = 'DIRECT';
      } else if (input.modelSpec && !hasDiversionSignal) {
        flowType = 'DIRECT';
      } else {
        // 默认已有模型分流测试模式
        flowType = 'DIVERSION';
      }
    }

    // 1. 识别领域（Domain）
    const hasVideo = /视频|video|wan|seedance|kling|sora|cogvideo/i.test(text) || input.modelSpec?.modelType === 'video';
    const hasImage = /图片|生图|image|banana|flux|runninghub|midjourney|2\.5/i.test(text) || input.modelSpec?.modelType === 'image';
    const hasCanvas = /画布|canvas|节点|node/i.test(text);

    let domain: DevTestSelfTestPlan['domain'] = 'VIDEO';
    if (hasCanvas) {
      domain = 'CANVAS';
    } else if (hasVideo && hasImage) {
      domain = 'MULTI_MODAL';
    } else if (hasImage) {
      domain = 'IMAGE';
    } else {
      domain = 'VIDEO';
    }

    // 2. 识别/提取目标模型
    const targetModels: DevTestSelfTestPlan['targetModels'] = [];
    if (input.modelSpec) {
      const spec = input.modelSpec;
      targetModels.push({
        id: spec.modelId,
        type: spec.modelType,
        alias: spec.alias ?? (spec.modelType === 'video' ? `newapi-video-${spec.modelId}` : `newapi-image-${spec.modelId}`),
        isGlobal: spec.isGlobal ?? false,
        capabilities: {
          taskType: spec.taskType,
          resolutions: spec.resolutions ?? ['720p'],
          aspectRatios: spec.aspectRatios ?? ['16:9'],
          durations: spec.durations ?? [5],
          serviceLine: spec.serviceLine ?? 'r',
        },
      });
    } else {
      // 智能文本抽取：识别知名模型或模型 ID
      if (domain === 'VIDEO' || domain === 'MULTI_MODAL') {
        const isWan3 = /wan\s*3/i.test(text) || /84/.test(text);
        const isSeedance = /seedance/i.test(text);
        if (isWan3 || !isSeedance) {
          targetModels.push({
            id: 84,
            type: 'video',
            alias: 'wan3.0-video',
            isGlobal: false,
            capabilities: {
              taskType: 28,
              resolutions: ['720p', '1080p'],
              aspectRatios: ['16:9', '9:16'],
              durations: [5],
            },
          });
        } else {
          targetModels.push({
            id: 16,
            type: 'video',
            alias: 'seedance-2.0',
            isGlobal: false,
            capabilities: { taskType: 28 },
          });
        }
      }

      if (domain === 'IMAGE' || domain === 'MULTI_MODAL') {
        const isImage25 = /2\.5|flare|sunburst|201/.test(text);
        if (isImage25) {
          targetModels.push({
            id: 201,
            type: 'image',
            alias: 'gpt-image-2.5-flare-economy',
            isGlobal: true,
            capabilities: { serviceLine: 'r', resolutions: ['1k'] },
          });
        } else {
          targetModels.push({
            id: 12,
            type: 'image',
            alias: 'runninghub-nano-banana-2',
            isGlobal: false,
            capabilities: { serviceLine: 'r' },
          });
        }
      }
    }

    // 3. 自主决策执行模式（Execution Mode）
    let executionMode: DevTestSelfTestPlan['executionMode'] = 'API_INTEGRATION';
    let modeReason = '默认使用高确定性 API_INTEGRATION 模式进行全链路接口真实验证';

    if (input.preferExecutionMode) {
      executionMode = input.preferExecutionMode;
      modeReason = `开发者显式指定优先执行模式: ${input.preferExecutionMode}`;
    } else if (/ui|浏览器|页面|点击|form|page|browser/i.test(text)) {
      if (input.browserAvailable) {
        executionMode = 'UI_E2E';
        modeReason = '需求涉及前端交互且检测到浏览器环境可用，启用真实 UI_E2E 模式';
      } else {
        executionMode = 'API_INTEGRATION';
        modeReason = '需求虽涉及 UI，但当前运行环境缺少可用浏览器，安全回退为真实 API_INTEGRATION';
      }
    }

    // 4. 提取前置条件
    const preconditions: string[] = [
      '测试账号会话有效 (PHPSESSID)',
      '主站 CSRF 防护签名可用 (__token__)',
      '测试项目隔离域就绪 (project_id 绑定)',
    ];
    if (flowType === 'DIVERSION') {
      if (targetModels.some((m) => !m.isGlobal)) {
        preconditions.push('已有非全量分流模型须已绑定有效企业路由组与 NewAPI Token');
      } else {
        preconditions.push('已有全量分流模型须具备全局分流开关配置及 NewAPI 渠道映射');
      }
    } else {
      preconditions.push('新接入模型白名单与直连路由分发逻辑已部署上线 (代码写死直连，免路由组配置)');
    }

    // 5. 调度场景规划器规划最小且完备场景
    const { scenarios, risks } = ScenarioPlanner.plan({
      domain,
      targetModels,
      flowType,
      hasBilling: true,
      hasFailureRefund: true,
      hasRouting: true,
      hasMediaAsset: true,
      hasIdempotency: true,
      requirementSummary: input.requirement ?? input.featureDescription,
    });

    // 6. 调度执行规划器为各场景生成步骤 DAG
    const executionDags = ExecutionPlanner.planDags(scenarios);

    // 7. 汇总必要 Oracles 与 Evidences
    const requiredOracles = [
      ...new Set(scenarios.flatMap((s) => s.requiredOracles)),
      'CrossStepAudit',
      'QualityGateEngine',
    ];
    const requiredEvidence = [
      ...new Set(scenarios.flatMap((s) => s.requiredEvidence)),
      'PRIMARY_KEYS_MATCHED',
      'CLEANUP_STATUS_VERIFIED',
    ];
    const mandatoryBranches = flowType === 'DIRECT'
      ? [
          'MAIN_HAPPY_PATH',
          'DIRECT_SPEC_MATRIX',
          'FAILURE_REFUND',
          'RETRY_IDEMPOTENCY',
        ]
      : [
          'MAIN_HAPPY_PATH',
          'ROUTING_DIVERSION',
          'DIVERSION_FALLBACK_DIRECT',
          'FAILURE_REFUND',
          'RETRY_IDEMPOTENCY',
        ];

    const flowTitle = flowType === 'DIRECT' ? '新模型直接接入测试' : '已有模型分流测试';
    const scope = `自动规划针对 ${domain} 领域 (${targetModels.map((m) => `${m.alias}#${m.id}`).join(', ')}) 的${flowTitle}方案`;

    return {
      flowType,
      domain,
      scope,
      targetModels,
      preconditions,
      executionMode,
      modeReason,
      requiredOracles,
      requiredEvidence,
      mandatoryBranches,
      risks,
      scenarios,
      executionDags,
    };
  }
}
