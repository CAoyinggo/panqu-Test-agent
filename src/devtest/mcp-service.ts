/**
 * Panqu AI DevTest 纯净 MCP 服务 (TRAE MCP Control Surface)
 * 单工具 devtest，4 项核心 Action: probe, plan, execute, verify，直接路由到 core-kernel。
 */
import { probe, plan, execute, verify, type VerifyKernelResult } from './core-kernel.js';
import { parseChangeIntent } from './env-probe.js';
import type { DiversionBaseline, MemoryCandidatePayload, RecordCandidateResult } from './types.js';
import {
  recordCandidateToSharedMemory,
  promoteConfirmedExperiences,
  type PromotionReport,
} from './domain-knowledge.js';
import { PanquMediaExecutionAdapter, type ExecutionAdapter } from './execution-ports.js';

/**
 * 单一兼容投影器 (Single Compatibility Projector)
 * 仅用于对外兼容旧调用方所需的 verdict / acceptance / passed 字段
 * 严格约束 (Requirement 7):
 * 1. 只接收 core-kernel 返回的 operationStatus / lifecycleStatus；
 * 2. 绝对不得重新读取原始业务事实进行二次判定；
 * 3. 绝对不得将 probe/plan/execute 的非验真状态伪造成业务 PASS/FAIL；
 * 4. 缺少输入或门禁阻断属于请求状态，绝对不得伪装为业务通过。
 */
export function projectOperationToCompatibility(
  action: 'probe' | 'plan' | 'execute',
  status: string,
): {
  readonly operationStatus: string;
  readonly lifecycleStatus: string;
  readonly passed: boolean;
  readonly verdict: string;
  readonly acceptance: string;
} {
  const isBlocked = status.startsWith('BLOCKED');
  if (isBlocked) {
    return {
      operationStatus: status,
      lifecycleStatus: status,
      passed: false,
      verdict: 'BLOCKED',
      acceptance: 'BLOCKED',
    };
  }

  if (action === 'execute') {
    const isSubmitted = status === 'SUBMITTED' || status === 'SUCCESS';
    return {
      operationStatus: status,
      lifecycleStatus: status,
      passed: false, // execute 只是派发/排队，无业务裁决，passed 永远为 false
      verdict: isSubmitted ? 'SUBMITTED' : status,
      acceptance: isSubmitted ? 'IN_FLIGHT' : status,
    };
  }

  // probe / plan
  return {
    operationStatus: status,
    lifecycleStatus: status,
    passed: false, // 只有 verify 具有业务 pass 裁决权
    verdict: status,
    acceptance: status,
  };
}

export const DEVTEST_MCP_TOOL = {
  name: 'devtest',
  description:
    'Panqu AI 研发测试副驾（双模支持：TRAE MCP 智能调用 + 本地终端 CLI 独立执行）。提供环境探活 (probe)、分流推导与规划 (plan)、任务执行 (execute)、物理验真与防资损对账 (verify)。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['probe', 'plan', 'execute', 'verify'],
        description: '核心操作：probe (环境探活), plan (分流推导与规划), execute (任务执行), verify (物理验真与对账)',
      },
      env: { type: 'string', enum: ['test', 'preonline'], description: '目标测试环境 (默认 test)' },
      base_url: { type: 'string', description: '主站 HTTPS 地址' },
      gateway_url: { type: 'string', description: '网关 HTTPS 地址' },
      session_file: { type: 'string', description: '会话凭证文件相对路径' },
      mock: { type: 'boolean', description: '是否为受控仿真 (默认 false)' },
      model_id: { type: 'number', description: '模型 ID (例如 84, 88, 201, 205)' },
      media_type: { type: 'string', enum: ['video', 'image'], description: '媒体类型' },
      flow_type: { type: 'string', enum: ['diversion', 'direct'], description: '分流模式' },
      mode: { type: 'string', enum: ['mock', 'real'], description: '执行模式' },
      resolution: { type: 'string', description: '分辨率规格 (如 720p, 1080p, 1k)' },
      aspect_ratio: { type: 'string', description: '画面比例 (如 16:9, 9:16)' },
      duration: { type: 'number', description: '生成时长秒数' },
      prompt: { type: 'string', description: '测试提示词' },
      task_id: { type: 'number', description: '任务 ID' },
      terminal_status: {
        type: 'string',
        enum: ['SUCCESS', 'FAILED', 'TIMEOUT', 'PROCESSING'],
        description: '任务终态',
      },
      score_logs: { type: 'array', description: '积分流水明细' },
      expected_points: { type: 'number', description: '预期扣除积分' },
      change_type: {
        type: 'string',
        enum: ['new_model', 'diversion_change'],
        description: '变更类型 (默认自适应识别)',
      },
      custom_points: { type: 'number', description: '自定义固定扣费积分刊例价' },
      points_per_second: { type: 'number', description: '按秒计费刊例价' },
      price: { type: 'number', description: '刊例价 (图片固定单价或视频每秒单价)' },
      is_global: { type: 'boolean', description: '是否全量开放' },
      alias: { type: 'string', description: '模型别名' },
      requirement: { type: 'string', description: '自然语言变更需求描述 (例如: 接入 960 视频模型)' },
      timeout_ms: { type: 'number', description: '探活请求超时时间毫秒 (默认 5000)' },
      video_url: { type: 'string', description: '待验真视频产物直链 (支持 MP4 深度结构与尾部 moov 范围解析)' },
      image_url: { type: 'string', description: '待验真图片产物直链 (支持 PNG/JPG/WebP/GIF 深度解析)' },
      db_extra_confirmed: { type: 'boolean', description: '是否已核实底层数据库 ai_tasks extra 分流字段' },
      gateway_channel_confirmed: { type: 'boolean', description: '是否已核实验证网关渠道分流' },
      unconfirmed_static: { type: 'boolean', description: '是否包含未确认的静态规则' },
      wait: {
        type: 'boolean',
        description:
          '是否在 execute 提交成功后自动等待轮询并串联进入 verify 终态闭环验真 (Agent 自主执行建议设置为 true，默认 false)',
      },
      poll_timeout_sec: { type: 'number', description: '轮询超时秒数 (默认: 视频 180s, 图片 60s)' },
      channel_id: { type: 'number', description: '网关渠道 ID (如 54 为 TD_国际)' },
      channel_name: { type: 'string', description: '网关渠道名称 (如 TD_国际)' },
      target_kind: {
        type: 'string',
        enum: ['channel', 'model'],
        description: '测试目标类型 (channel: 渠道级测试; model: 模型级测试)',
      },
      project_id: { type: 'number', description: '项目 ID (如 365)' },
      raw_target: { type: 'string', description: '原始测试目标字符串 (如 #54, 54, TD_国际)' },
    },
    required: ['action'],
    allOf: [
      {
        if: { properties: { action: { const: 'execute' } } },
        then: { required: ['model_id', 'media_type', 'mode'] },
      },
      {
        if: { properties: { action: { const: 'verify' } } },
        then: { required: ['task_id'] },
      },
      {
        if: { properties: { action: { const: 'plan' } } },
        then: {
          anyOf: [{ required: ['model_id', 'media_type'] }, { required: ['requirement'] }],
        },
      },
    ],
  },
};

export const DEVTEST_RECORD_CANDIDATE_TOOL = {
  name: 'devtest_record_candidate',
  description:
    '受控的知识候选记录辅助入口。用于将分析代码库（如 GitHub Repository）或测试执行中提炼出的可复用认知存入 shared-memory 待审缓冲池 (inbox.md)。严禁绕过人工审核与 Promotion 直接写入长期知识库。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '知识候选主题或模式名称（例如: [FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)）',
      },
      content: {
        type: 'string',
        description: '知识候选提议内容与真实代码证据（必须包含事实、来源文件、复用价值与核验规则）',
      },
      agent: {
        type: 'string',
        enum: ['trae', 'antigravity', 'codex'],
        description: '提议 Agent 标识（默认 trae）',
      },
      dest: {
        type: 'string',
        description: '建议归宿（默认 L2-state/active-projects.md）',
      },
      pattern_id: {
        type: 'string',
        description: '关联的失效模式 ID (例如 FP-001 ~ FP-005)',
      },
      patternId: {
        type: 'string',
        description: '关联的失效模式 ID (camelCase)',
      },
      model_id: {
        type: 'number',
        description: '关联的模型 ID (例如 84, 88)',
      },
      modelId: {
        type: 'number',
        description: '关联的模型 ID (camelCase)',
      },
      task_id: {
        type: 'number',
        description: '关联的任务 ID',
      },
      taskId: {
        type: 'number',
        description: '关联的任务 ID (camelCase)',
      },
      confidence: {
        type: 'string',
        enum: ['CONFIRMED', 'OBSERVED', 'INFERRED'],
        description: '知识可信度（默认 CONFIRMED）',
      },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        description: '结构化事实证据与原因说明',
      },
      source: {
        type: 'string',
        description: '知识来源标识（例如 github）',
      },
      repository: {
        type: 'string',
        description: '来源代码仓库（例如 CAoyinggo/panqu-Test-agent）',
      },
      shared_memory_dir: {
        type: 'string',
        description: 'shared-memory 根目录路径（可选，用于测试隔离）',
      },
      sharedMemoryDir: {
        type: 'string',
        description: 'shared-memory 根目录路径（camelCase）',
      },
    },
    required: ['topic', 'content'],
  },
};

export interface McpCallResult<T = any> {
  ok: boolean;
  isError?: boolean;
  passed?: boolean;
  status?: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNVERIFIED' | 'BLOCKED' | 'BLOCKED_MISSING_INPUT' | 'ERROR' | string;
  verdict?: 'PASS' | 'FAIL' | 'PROCESSING' | 'UNVERIFIED' | string;
  acceptance?: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'UNVERIFIED' | string;
  operationStatus?: string;
  lifecycleStatus?: string;
  action?: string;
  summary?: string;
  report?: string;
  data?: T;
  error?: string;
  missingInputs?: string[];
  blockerCode?: string;
}

export class DevTestMcpService {
  private readonly projectRoot: string;
  private readonly defaultExecutionAdapter?: ExecutionAdapter;

  constructor(
    projectRootOrOptions: string | { projectRoot?: string; executionAdapter?: ExecutionAdapter } = process.cwd(),
  ) {
    if (typeof projectRootOrOptions === 'string') {
      this.projectRoot = projectRootOrOptions;
    } else {
      this.projectRoot = projectRootOrOptions?.projectRoot || process.cwd();
      this.defaultExecutionAdapter = projectRootOrOptions?.executionAdapter;
    }
  }

  public async call<T = any>(args: Record<string, unknown>): Promise<McpCallResult<T>> {
    if (!args || typeof args !== 'object' || !args.action || typeof args.action !== 'string' || !args.action.trim()) {
      return {
        ok: false,
        isError: true,
        summary:
          '### ⚠️ 工具调用错误：缺少必填参数 action\n- **说明**: devtest 工具必须指定 action 参数 ("probe" | "plan" | "execute" | "verify")。禁止缺少 action 时静默执行。',
        error: 'Missing required argument "action". Allowed values: "probe", "plan", "execute", "verify".',
      };
    }
    const action = args.action.trim().toLowerCase();
    const channelId =
      typeof args.channel_id === 'number'
        ? args.channel_id
        : typeof args.channelId === 'number'
          ? args.channelId
          : undefined;
    const channelName =
      typeof args.channel_name === 'string'
        ? args.channel_name
        : typeof args.channelName === 'string'
          ? args.channelName
          : undefined;
    const targetKind = (args.target_kind || args.targetKind) as 'channel' | 'model' | undefined;
    const projectId =
      typeof args.project_id === 'number'
        ? args.project_id
        : typeof args.projectId === 'number'
          ? args.projectId
          : undefined;
    const rawTarget = (args.raw_target || args.rawTarget) as string | undefined;

    switch (action) {
      case 'probe': {
        const res = await probe({
          env: typeof args.env === 'string' ? args.env : undefined,
          baseUrl:
            typeof args.base_url === 'string'
              ? args.base_url
              : typeof args.baseUrl === 'string'
                ? args.baseUrl
                : undefined,
          gatewayUrl:
            typeof args.gateway_url === 'string'
              ? args.gateway_url
              : typeof args.gatewayUrl === 'string'
                ? args.gatewayUrl
                : undefined,
          sessionFile:
            typeof args.session_file === 'string'
              ? args.session_file
              : typeof args.sessionFile === 'string'
                ? args.sessionFile
                : undefined,
          mock: typeof args.mock === 'boolean' ? args.mock : false,
          timeoutMs:
            typeof args.timeout_ms === 'number'
              ? args.timeout_ms
              : typeof args.timeoutMs === 'number'
                ? args.timeoutMs
                : undefined,
          requirement: typeof args.requirement === 'string' ? args.requirement : undefined,
          modelId:
            args.model_id !== undefined
              ? Number(args.model_id)
              : args.modelId !== undefined
                ? Number(args.modelId)
                : undefined,
          mediaType:
            args.media_type || args.mediaType
              ? (((args.media_type || args.mediaType) as string).toLowerCase() as 'video' | 'image')
              : undefined,
          extraExperiences: (args.extra_experiences || args.extraExperiences) as any,
          projectRoot:
            typeof args.project_root === 'string'
              ? args.project_root
              : typeof args.projectRoot === 'string'
                ? args.projectRoot
                : this.projectRoot,
        });
        const domainStr = res.domainAnalysis?.identifiedObjects
          ? `\n- **领域对象**: ${res.domainAnalysis.identifiedObjects.map((o) => o.name).join(', ')}`
          : '';
        const summary = `### 📋 Panqu 环境探活回执\n- **环境**: ${res.env} | **状态**: ${res.status}\n- **主站**: ${res.baseUrl}\n- **网关**: ${res.gatewayUrl}\n- **可用渠道数**: ${res.candidateChannelCount}\n- **鉴权凭据**: ${res.auth.status} (${res.auth.details})${domainStr}`;
        const proj = projectOperationToCompatibility('probe', res.status);
        return {
          ok: true,
          action: 'probe',
          operationStatus: proj.operationStatus,
          lifecycleStatus: proj.lifecycleStatus,
          passed: proj.passed,
          status: res.status,
          verdict: proj.verdict,
          acceptance: proj.acceptance,
          summary,
          data: res as unknown as T,
          ...(res.ok ? {} : { error: res.status === 'BLOCKED' ? 'Probe blocked' : 'Probe degraded' }),
        };
      }
      case 'plan': {
        let modelId =
          args.model_id !== undefined
            ? Number(args.model_id)
            : args.modelId !== undefined
              ? Number(args.modelId)
              : undefined;
        let mediaType =
          args.media_type || args.mediaType
            ? (((args.media_type || args.mediaType) as string).toLowerCase() as 'video' | 'image')
            : undefined;
        const requirement = typeof args.requirement === 'string' ? args.requirement : undefined;

        if (modelId === undefined || isNaN(modelId) || !mediaType) {
          if (requirement) {
            const parsed = parseChangeIntent(requirement);
            if (modelId === undefined || isNaN(modelId)) {
              modelId = parsed.modelId;
            }
            if (!mediaType) {
              mediaType = parsed.mediaType;
            }
          }
        }

        const missingInputs: string[] = [];
        if ((modelId === undefined || isNaN(modelId)) && channelId === undefined && !rawTarget)
          missingInputs.push('model_id');
        if (!mediaType && channelId === undefined && !rawTarget) missingInputs.push('media_type');

        if (missingInputs.length > 0) {
          const summary = `### ⚠️ Panqu 分流推导阻断 (缺失必填参数)\n- **缺失参数**: ${missingInputs.join(', ')}\n- **说明**: plan 需要明确的 model_id 与 media_type (直接传入或从 requirement 中推导)。禁止私自猜测参数。`;
          const proj = projectOperationToCompatibility('plan', 'BLOCKED_MISSING_INPUT');
          return {
            ok: true,
            action: 'plan',
            operationStatus: proj.operationStatus,
            lifecycleStatus: proj.lifecycleStatus,
            passed: proj.passed,
            status: 'BLOCKED_MISSING_INPUT',
            verdict: proj.verdict,
            acceptance: proj.acceptance,
            missingInputs,
            summary,
            error: `Missing required inputs: ${missingInputs.join(', ')}`,
          };
        }

        const res = await plan({
          modelId,
          mediaType,
          flowType:
            typeof args.flow_type === 'string'
              ? args.flow_type
              : typeof args.flowType === 'string'
                ? args.flowType
                : undefined,
          changeType: (args.change_type || args.changeType) as any,
          requirement,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          duration: typeof args.duration === 'number' ? args.duration : undefined,
          aspectRatio:
            typeof args.aspect_ratio === 'string'
              ? args.aspect_ratio
              : typeof args.aspectRatio === 'string'
                ? args.aspectRatio
                : undefined,
          customPoints:
            typeof args.custom_points === 'number'
              ? args.custom_points
              : typeof args.customPoints === 'number'
                ? args.customPoints
                : undefined,
          pointsPerSecond:
            typeof args.points_per_second === 'number'
              ? args.points_per_second
              : typeof args.pointsPerSecond === 'number'
                ? args.pointsPerSecond
                : undefined,
          price: typeof args.price === 'number' ? args.price : undefined,
          isGlobal:
            typeof args.is_global === 'boolean'
              ? args.is_global
              : typeof args.isGlobal === 'boolean'
                ? args.isGlobal
                : undefined,
          alias: typeof args.alias === 'string' ? args.alias : undefined,
          channelId,
          channelName,
          targetKind,
          projectId,
          rawTarget,
          extraExperiences: (args.extra_experiences || args.extraExperiences) as any,
          projectRoot:
            typeof args.project_root === 'string'
              ? args.project_root
              : typeof args.projectRoot === 'string'
                ? args.projectRoot
                : this.projectRoot,
        });
        const divertStr = res.willDivert
          ? `NEWAPI 切流 (线路 ${res.routeLine})`
          : `DIRECT 直连 (线路 ${res.routeLine})`;
        const forecastStr = res.acceptanceForecast ? `\n- **验收预判**: [${res.acceptanceForecast}]` : '';
        const missingInputsStr =
          res.missingInputs && res.missingInputs.length > 0 ? ` (缺失必填项: ${res.missingInputs.join(', ')})` : '';
        const blockedStr =
          res.blocked && res.blocked.length > 0
            ? `\n⚠️ 阻断待补事实 (${res.blocked.length}项): ${res.blocked.map((b) => b.missingField || b.field).join(', ')}`
            : '';
        const skippedStr =
          res.testPlan?.skippedTests && res.testPlan.skippedTests.length > 0
            ? `\n🛡️ 安全裁剪跳过: 共 ${res.testPlan.skippedTests.length} 项无关测试已排除`
            : '';
        const nextStepStr = res.testerActionSummary?.nextStep
          ? `\n🚀 下一步行动: ${res.testerActionSummary.nextStep}`
          : '';
        const domainPlanStr = res.domainPlan
          ? `\n- **业务闭环计划**: 共 ${res.domainPlan.steps.length} 步 (${res.domainPlan.steps.map((s) => s.stage).join(' → ')})`
          : '';

        const summary = `### 📋 Panqu 分流推导回执与动态测试计划 [${res.scenarioName || res.scenario}]
- **模型**: #${res.modelId} (${res.mediaType}) | 别名: ${res.contract?.alias.value || '未知'} [${res.contract?.alias.source || 'default'}]
- **分流裁决**: ${divertStr} [${res.decision}]
- **定价状态**: ${res.pricingStatus} (${res.expectedPoints} pt)
- **测试计划**: 共 ${res.testPlan?.tests.length || 0} 项测试 (就绪 ${res.testPlan?.tests.filter((t) => t.status === 'READY').length || 0} 项)${skippedStr}${forecastStr}${missingInputsStr}${blockedStr}${domainPlanStr}${nextStepStr}
- **候选渠道**: ${res.candidateChannels.join(', ') || '无可用渠道'}
- **推导依据**: ${res.reason}`;
        const planStatus = res.blocked && res.blocked.length > 0 ? 'BLOCKED' : res.ok ? 'READY' : 'BLOCKED';
        const proj = projectOperationToCompatibility('plan', planStatus);
        return {
          ok: res.ok,
          action: 'plan',
          operationStatus: proj.operationStatus,
          lifecycleStatus: proj.lifecycleStatus,
          passed: proj.passed,
          status: planStatus,
          verdict: proj.verdict,
          acceptance: proj.acceptance,
          missingInputs: res.missingInputs,
          summary,
          data: res as unknown as T,
        };
      }
      case 'execute': {
        const rawModelId =
          args.model_id !== undefined
            ? Number(args.model_id)
            : args.modelId !== undefined
              ? Number(args.modelId)
              : undefined;
        const rawMediaType =
          args.media_type || args.mediaType ? String(args.media_type || args.mediaType).toLowerCase() : undefined;
        const rawMode = args.mode !== undefined ? String(args.mode).toLowerCase() : undefined;

        const missingInputs: string[] = [];
        if (rawModelId === undefined || isNaN(rawModelId)) missingInputs.push('model_id');
        if (!rawMediaType || (rawMediaType !== 'video' && rawMediaType !== 'image')) missingInputs.push('media_type');
        if (!rawMode || (rawMode !== 'mock' && rawMode !== 'real')) missingInputs.push('mode');

        if (missingInputs.length > 0) {
          const summary = `### ⚠️ Panqu 任务执行阻断 (缺失必填参数)\n- **缺失参数**: ${missingInputs.join(', ')}\n- **说明**: execute 必须显式指定 model_id, media_type, mode ('mock' | 'real')。禁止静默回退默认值。`;
          const proj = projectOperationToCompatibility('execute', 'BLOCKED_MISSING_INPUT');
          return {
            ok: true,
            action: 'execute',
            operationStatus: proj.operationStatus,
            lifecycleStatus: proj.lifecycleStatus,
            passed: false,
            status: 'BLOCKED_MISSING_INPUT',
            verdict: proj.verdict,
            acceptance: proj.acceptance,
            missingInputs,
            summary,
            error: `Missing required inputs: ${missingInputs.join(', ')}`,
          };
        }

        const modelId = rawModelId!;
        const mediaType = rawMediaType as 'video' | 'image';
        const mode = rawMode as 'real' | 'mock';
        const resolution = typeof args.resolution === 'string' ? args.resolution : undefined;
        const duration = typeof args.duration === 'number' ? args.duration : undefined;
        const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
        const sessionFile =
          typeof args.session_file === 'string'
            ? args.session_file
            : typeof args.sessionFile === 'string'
              ? args.sessionFile
              : undefined;
        const env = (args.env as 'test' | 'preonline') || undefined;
        const price = typeof args.price === 'number' ? args.price : undefined;
        const customPoints =
          typeof args.custom_points === 'number'
            ? args.custom_points
            : typeof args.customPoints === 'number'
              ? args.customPoints
              : undefined;
        const pointsPerSecond =
          typeof args.points_per_second === 'number'
            ? args.points_per_second
            : typeof args.pointsPerSecond === 'number'
              ? args.pointsPerSecond
              : undefined;
        const alias = typeof args.alias === 'string' ? args.alias : undefined;
        const requirement = typeof args.requirement === 'string' ? args.requirement : undefined;
        const wait = Boolean(args.wait);
        const pollTimeoutSec =
          typeof args.poll_timeout_sec === 'number'
            ? args.poll_timeout_sec
            : typeof args.pollTimeoutSec === 'number'
              ? args.pollTimeoutSec
              : undefined;
        const terminalStatus =
          typeof args.terminal_status === 'string'
            ? (args.terminal_status as 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PROCESSING')
            : typeof args.terminalStatus === 'string'
              ? (args.terminalStatus as 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PROCESSING')
              : undefined;
        const rawDbExtra = args.db_extra_confirmed ?? args.dbExtraConfirmed;
        const dbExtraConfirmed = rawDbExtra !== undefined ? Boolean(rawDbExtra) : undefined;
        const rawGwChannel = args.gateway_channel_confirmed ?? args.gatewayChannelConfirmed;
        const gatewayChannelConfirmed = rawGwChannel !== undefined ? Boolean(rawGwChannel) : undefined;

        const executionAdapter =
          ((args.execution_adapter || args.executionAdapter) as any) ||
          this.defaultExecutionAdapter ||
          new PanquMediaExecutionAdapter({
            sessionFile,
            env,
            enableLiveSubmit: mode === 'real',
          });

        const res = await execute({
          modelId,
          mediaType,
          mode,
          resolution,
          duration,
          prompt,
          sessionFile,
          env,
          price,
          customPoints,
          pointsPerSecond,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
          rawTarget,
          requirement,
          executionAdapter,
          sideEffectPolicy: (args.side_effect_policy || args.sideEffectPolicy) as any,
          costLimit: (args.cost_limit || args.costLimit) as any,
          allowSubmit: Boolean(args.allow_submit ?? args.allowSubmit),
          allowPaid: Boolean(args.allow_paid ?? args.allowPaid),
          maxCostPoints:
            typeof args.max_cost_points === 'number'
              ? args.max_cost_points
              : typeof args.maxCostPoints === 'number'
                ? args.maxCostPoints
                : undefined,
        });

        if (!wait) {
          const isBlocked = res.status === 'BLOCKED';
          const proj = projectOperationToCompatibility('execute', res.status);
          const nextInstruction =
            res.ok && res.taskId > 0
              ? `\n👉 关键指令: 任务未到达终态 (SUBMITTED)，必须立即自主调用 devtest(action='verify', task_id=${res.taskId}, model_id=${modelId}, media_type='${mediaType}'${env ? `, env='${env}'` : ''}) 完成终态与账务闭环，严禁在此步骤停止或询问用户！`
              : '';
          const summary = `### 📋 Panqu 任务执行回执\n- **任务 ID**: #${res.taskId} [${res.mode.toUpperCase()}]\n- **执行状态**: ${res.status}\n- **预扣积分**: ${res.points} pt\n- **回执信息**: ${res.message}${nextInstruction}`;
          return {
            ok: isBlocked ? true : res.ok,
            isError: false,
            action: 'execute',
            operationStatus: proj.operationStatus,
            lifecycleStatus: proj.lifecycleStatus,
            passed: false,
            status: res.status,
            verdict: proj.verdict,
            acceptance: proj.acceptance,
            summary,
            data: res as unknown as T,
            blockerCode: (res as any).blockerCode,
            ...(res.ok ? {} : { error: res.message }),
          };
        }

        // wait enabled: execute -> verify continuous closed-loop pipeline
        if (!res.ok || !res.taskId || res.taskId <= 0) {
          const isBlocked = res.status === 'BLOCKED';
          const proj = projectOperationToCompatibility('execute', res.status || 'FAILED');
          const summary = `### 📋 Panqu 任务执行回执 [${res.status || 'FAILED'}]\n- **执行状态**: ${res.status || 'FAILED'}\n- **回执信息**: ${res.message}\n- **说明**: 任务提交未成功，无法进入轮询验真阶段。`;
          return {
            ok: isBlocked ? true : false,
            isError: false,
            action: 'execute',
            operationStatus: proj.operationStatus,
            lifecycleStatus: proj.lifecycleStatus,
            passed: false,
            status: res.status || 'FAILED',
            verdict: proj.verdict,
            acceptance: proj.acceptance,
            summary,
            data: res as unknown as T,
            blockerCode: (res as any).blockerCode,
            error: res.message,
          };
        }

        const verifyRes = await verify({
          taskId: res.taskId,
          modelId,
          mediaType,
          resolution,
          duration,
          sessionFile,
          env,
          price,
          customPoints,
          pointsPerSecond,
          pollTimeoutSec,
          terminalStatus,
          isSimulated: res.isSimulated,
          dbExtraConfirmed,
          gatewayChannelConfirmed,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
        });

        const taskStatus = verifyRes.evidence.task.status;
        const artifactStatus =
          verifyRes.evidence.media.status === 'PASS'
            ? `PASS (${(verifyRes.evidence.media.format || 'mp4').toUpperCase()} container structure PASS)`
            : verifyRes.evidence.media.status === 'FAIL'
              ? 'FAIL (损坏)'
              : 'UNVERIFIED (无产物)';
        const billingStatus = verifyRes.evidence.billing.status;
        const netZero = verifyRes.invariants
          ? verifyRes.invariants.netChargeZero
            ? 'PASS'
            : 'FAIL (资损告警)'
          : 'SKIPPED';
        const antiDouble = verifyRes.invariants
          ? verifyRes.invariants.antiDoubleBilling
            ? 'PASS'
            : 'FAIL (重扣告警)'
          : 'SKIPPED';
        const businessSuccessStr = verifyRes.businessValidation?.businessSuccess
          ? 'PASS'
          : verifyRes.businessValidation?.status || 'UNVERIFIED';
        const completenessStr = verifyRes.evidenceCompleteness
          ? ` · 证据完整度 <${verifyRes.evidenceCompleteness.availableEvidence.length}/${verifyRes.evidenceCompleteness.requiredEvidence.length}${verifyRes.evidenceCompleteness.isComplete ? ' COMPLETE' : ' INCOMPLETE'}>`
          : '';

        let verdictDesc: string;
        if (verifyRes.passed) {
          verdictDesc = 'ALL PASS (任务成功 + 物理产物结构有效 + 账务不变量全部通过)';
        } else if (verifyRes.status === 'PROCESSING') {
          verdictDesc = `PROCESSING (排队处理中: ${verifyRes.progress ?? 0}%, 轮询窗口已耗尽，非业务终态)`;
        } else if (verifyRes.status === 'UNVERIFIED') {
          verdictDesc = 'UNVERIFIED (证据未闭环，未通过线上验收)';
        } else {
          verdictDesc = 'FAILED (任务失败或存在违背缺陷)';
        }

        const summary = `### 🚀 Panqu E2E 任务执行与验真闭环 [${res.mode.toUpperCase()}]
- **任务概况**: 模型 #${verifyRes.modelId} (${verifyRes.mediaType}) · 任务 #${verifyRes.taskId}
- **技术裁决**: <${verdictDesc}>
- **生产验收**: <${verifyRes.acceptance}>${completenessStr}
- **证据明细**:
  - 任务执行 (Task): <${taskStatus}>
  - 产物结构 (Media): <${artifactStatus}>
  - 积分账务 (Billing): <${billingStatus}>
  - 失败净扣归零: <${netZero}>
  - 防重复扣费: <${antiDouble}>
  - 业务验证: <${businessSuccessStr}>
${verifyRes.reasons.length > 0 ? `- **核验明细**: ${verifyRes.reasons.join('; ')}` : ''}
- **本地复现**: npm run devtest -- verify --task ${verifyRes.taskId} --model ${verifyRes.modelId} --media ${verifyRes.mediaType}`;
        const report = formatVerifyReport(verifyRes);
        return {
          ok: true,
          action: 'execute',
          passed: verifyRes.passed,
          status: verifyRes.status,
          verdict: verifyRes.verdict,
          acceptance: verifyRes.acceptance,
          summary,
          report,
          data: verifyRes as unknown as T,
        };
      }
      case 'verify': {
        const rawTaskId =
          args.task_id !== undefined
            ? Number(args.task_id)
            : args.taskId !== undefined
              ? Number(args.taskId)
              : undefined;
        if (rawTaskId === undefined || isNaN(rawTaskId) || rawTaskId <= 0) {
          const missingInputs = ['task_id'];
          return {
            ok: true,
            action: 'verify',
            status: 'BLOCKED_MISSING_INPUT',
            verdict: 'BLOCKED',
            acceptance: 'BLOCKED',
            missingInputs,
            summary: `### ⚠️ Panqu 任务验真阻断 (缺失必填参数)\n- **缺失参数**: task_id\n- **说明**: verify 必须提供合法的 task_id (> 0)。禁止在缺失 task_id 时执行验真。`,
            error: 'Missing required input: task_id',
          };
        }
        const taskId = rawTaskId;
        const terminalStatus =
          typeof args.terminal_status === 'string'
            ? (args.terminal_status as 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PROCESSING')
            : typeof args.terminalStatus === 'string'
              ? (args.terminalStatus as 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PROCESSING')
              : undefined;
        const pollTimeoutSec =
          typeof args.poll_timeout_sec === 'number'
            ? args.poll_timeout_sec
            : typeof args.pollTimeoutSec === 'number'
              ? args.pollTimeoutSec
              : undefined;

        const res = await verify({
          taskId,
          modelId:
            args.model_id !== undefined
              ? Number(args.model_id)
              : args.modelId !== undefined
                ? Number(args.modelId)
                : undefined,
          mediaType:
            args.media_type || args.mediaType
              ? (((args.media_type || args.mediaType) as string).toLowerCase() as 'video' | 'image')
              : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          duration: typeof args.duration === 'number' ? args.duration : undefined,
          scoreLogs: Array.isArray(args.score_logs)
            ? args.score_logs
            : Array.isArray(args.scoreLogs)
              ? args.scoreLogs
              : undefined,
          expectedPoints:
            typeof args.expected_points === 'number'
              ? args.expected_points
              : typeof args.expectedPoints === 'number'
                ? args.expectedPoints
                : undefined,
          price: typeof args.price === 'number' ? args.price : undefined,
          customPoints:
            typeof args.custom_points === 'number'
              ? args.custom_points
              : typeof args.customPoints === 'number'
                ? args.customPoints
                : undefined,
          pointsPerSecond:
            typeof args.points_per_second === 'number'
              ? args.points_per_second
              : typeof args.pointsPerSecond === 'number'
                ? args.pointsPerSecond
                : undefined,
          alias: typeof args.alias === 'string' ? args.alias : undefined,
          channelId,
          channelName,
          targetKind,
          projectId,
          actualChannelId:
            typeof args.actual_channel_id === 'number'
              ? args.actual_channel_id
              : typeof args.actualChannelId === 'number'
                ? args.actualChannelId
                : typeof args.actual_channel === 'number'
                  ? args.actual_channel
                  : undefined,
          actualChannelName:
            typeof args.actual_channel_name === 'string'
              ? args.actual_channel_name
              : typeof args.actualChannelName === 'string'
                ? args.actualChannelName
                : undefined,
          fallbackChannel:
            typeof args.fallback_channel === 'string'
              ? args.fallback_channel
              : typeof args.fallbackChannel === 'string'
                ? args.fallbackChannel
                : undefined,
          retryProvider:
            typeof args.retry_provider === 'string'
              ? args.retry_provider
              : typeof args.retryProvider === 'string'
                ? args.retryProvider
                : undefined,
          extra: (args.extra as Record<string, unknown>) || undefined,
          retryLog: (args.retry_log || args.retryLog) as Record<string, unknown> | undefined,
          exceptionalTask: (args.exceptional_task || args.exceptionalTask) as Record<string, unknown> | undefined,
          terminalStatus,
          pollTimeoutSec,
          sessionFile:
            typeof args.session_file === 'string'
              ? args.session_file
              : typeof args.sessionFile === 'string'
                ? args.sessionFile
                : undefined,
          env: (args.env as 'test' | 'preonline') || undefined,
          videoUrl:
            typeof args.video_url === 'string'
              ? args.video_url
              : typeof args.videoUrl === 'string'
                ? args.videoUrl
                : undefined,
          imageUrl:
            typeof args.image_url === 'string'
              ? args.image_url
              : typeof args.imageUrl === 'string'
                ? args.imageUrl
                : undefined,
          assetBuffer: Buffer.isBuffer(args.asset_buffer)
            ? args.asset_buffer
            : Buffer.isBuffer(args.assetBuffer)
              ? args.assetBuffer
              : undefined,
          artifactBuffer: Buffer.isBuffer(args.artifact_buffer)
            ? args.artifact_buffer
            : Buffer.isBuffer(args.artifactBuffer)
              ? args.artifactBuffer
              : undefined,
          dbExtraConfirmed:
            args.db_extra_confirmed !== undefined
              ? Boolean(args.db_extra_confirmed)
              : args.dbExtraConfirmed !== undefined
                ? Boolean(args.dbExtraConfirmed)
                : undefined,
          gatewayChannelConfirmed:
            args.gateway_channel_confirmed !== undefined
              ? Boolean(args.gateway_channel_confirmed)
              : args.gatewayChannelConfirmed !== undefined
                ? Boolean(args.gatewayChannelConfirmed)
                : undefined,
          baseline: args.baseline as DiversionBaseline | undefined,
          unconfirmedStatic: Boolean(args.unconfirmed_static ?? args.unconfirmedStatic),
          apiResult: (args.api_result || args.apiResult) as any,
          folderId: typeof args.folder_id === 'number' ? args.folder_id : undefined,
          isFolderInProject: typeof args.is_folder_in_project === 'boolean' ? args.is_folder_in_project : undefined,
        });

        const taskStatus = res.evidence.task.status;
        const artifactStatus =
          res.evidence.media.status === 'PASS'
            ? `PASS (${(res.evidence.media.format || 'mp4').toUpperCase()} container structure PASS)`
            : res.evidence.media.status === 'FAIL'
              ? 'FAIL (损坏)'
              : 'UNVERIFIED (无产物)';
        const billingStatus = res.evidence.billing.status;
        const netZero = res.invariants ? (res.invariants.netChargeZero ? 'PASS' : 'FAIL (资损告警)') : 'SKIPPED';
        const antiDouble = res.invariants ? (res.invariants.antiDoubleBilling ? 'PASS' : 'FAIL (重扣告警)') : 'SKIPPED';
        const businessSuccessStr = res.businessValidation?.businessSuccess
          ? 'PASS'
          : res.businessValidation?.status || 'UNVERIFIED';
        const extraNotice =
          res.expectedVsActual?.evidenceStatus.extraSnapshot === 'MANUAL_DB_EVIDENCE_REQUIRED'
            ? '\n📌 关键分流落库证据: [MANUAL_DB_EVIDENCE_REQUIRED] (HTTP接口不返回extra，需只读查询DB ai_tasks)'
            : '';
        const completenessStr = res.evidenceCompleteness
          ? ` · 证据完整度 <${res.evidenceCompleteness.availableEvidence.length}/${res.evidenceCompleteness.requiredEvidence.length}${res.evidenceCompleteness.isComplete ? ' COMPLETE' : ' INCOMPLETE'}>`
          : '';

        let candidateNote = '';
        if (res.memoryCandidate) {
          const sharedMemoryDir =
            typeof args.shared_memory_dir === 'string'
              ? args.shared_memory_dir
              : typeof args.sharedMemoryDir === 'string'
                ? args.sharedMemoryDir
                : undefined;
          const recordRes = recordCandidateToSharedMemory(res.memoryCandidate, sharedMemoryDir);
          if (recordRes.recorded) {
            candidateNote = `\n💡 知识自学习: 自动沉淀失败模式提案 [${recordRes.candidateId}] 至 shared-memory 待审缓冲池`;
          } else if (recordRes.reason === 'DUPLICATE_CANDIDATE_SKIPPED') {
            candidateNote = `\n💡 知识自学习: 命中已有沉淀模式，跳过重复写入`;
          }
        }

        const summary = `🎯 概况：模型 #${res.modelId} (${res.mediaType}) · [${res.mode.toUpperCase()}] · 任务 #${res.taskId}
🔍 验真：最终裁决 <${res.passed ? 'ALL PASS' : res.status}> · 生产验收 <${res.acceptance}>${completenessStr} · 业务成功 <${businessSuccessStr}> · 任务状态 <${taskStatus}> · 产物结构 <${artifactStatus}> · 账单对账 <${billingStatus}> · 失败净扣归零 <${netZero}> · 防重复扣费 <${antiDouble}>${extraNotice}${candidateNote}${res.reasons.length > 0 ? `\n⚠️ 详情：${res.reasons.join('; ')}` : ''}
💻 复现：npm run devtest -- verify --task ${res.taskId} --model ${res.modelId} --media ${res.mediaType}`;
        const report = formatVerifyReport(res);
        return {
          ok: true,
          action: 'verify',
          passed: res.passed,
          status: res.status,
          verdict: res.verdict,
          acceptance: res.acceptance,
          missingInputs: res.evidenceCompleteness?.missingEvidence,
          summary,
          report,
          data: res as unknown as T,
        };
      }
      default:
        return {
          ok: false,
          isError: true,
          error: `Unsupported action "${action}". Allowed: probe, plan, execute, verify.`,
        };
    }
  }

  /**
   * 经验晋升管道 (Promotion Pipeline: Confirmed Experience -> Persistent Knowledge)
   * 独立 helper 方法，不属于 probe/plan/execute/verify 4 项核心测试 Action。
   */
  public async promoteConfirmedExperiences(options?: {
    sharedMemoryDir?: string;
    dryRun?: boolean;
    inboxPath?: string;
    candidatesJsonPath?: string;
  }): Promise<PromotionReport> {
    return promoteConfirmedExperiences({
      projectRoot: this.projectRoot,
      sharedMemoryDir: options?.sharedMemoryDir,
      dryRun: options?.dryRun,
      inboxPath: options?.inboxPath,
      candidatesJsonPath: options?.candidatesJsonPath,
    });
  }

  /**
   * 受控知识候选记录入口 (Record Knowledge Candidate)
   * 仅用于将外部 (如 GitHub MCP 分析、代码审查) 发现的候选事实写入 shared-memory 待审缓冲池。
   * 绝对不属于 probe/plan/execute/verify 4 项核心测试 Action，绝不直接修改 knowledge_candidates.json。
   */
  public async recordCandidate(args: Record<string, unknown>): Promise<RecordCandidateResult> {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const content = typeof args.content === 'string' ? args.content.trim() : '';

    if (!topic || !content) {
      return {
        ok: false,
        status: 'INVALID_ARGUMENTS',
        summary: '录入失败：缺少必填字段 topic 或 content',
        error: 'Both "topic" and "content" must be non-empty strings.',
      };
    }

    const agent = (args.agent === 'antigravity' || args.agent === 'codex' ? args.agent : 'trae') as
      'trae' | 'antigravity' | 'codex';
    const dest = typeof args.dest === 'string' && args.dest.trim() ? args.dest.trim() : 'L2-state/active-projects.md';
    const patternId =
      typeof args.pattern_id === 'string'
        ? args.pattern_id
        : typeof args.patternId === 'string'
          ? args.patternId
          : undefined;
    const modelId =
      args.model_id !== undefined
        ? Number(args.model_id)
        : args.modelId !== undefined
          ? Number(args.modelId)
          : undefined;
    const taskId =
      args.task_id !== undefined ? Number(args.task_id) : args.taskId !== undefined ? Number(args.taskId) : undefined;
    const confidence = (
      args.confidence === 'OBSERVED' || args.confidence === 'INFERRED' ? args.confidence : 'CONFIRMED'
    ) as 'CONFIRMED' | 'OBSERVED' | 'INFERRED';
    const reasons = Array.isArray(args.reasons) ? args.reasons.map(String) : [];
    const source = typeof args.source === 'string' ? args.source : 'github';
    const repository = typeof args.repository === 'string' ? args.repository : undefined;

    const payload: MemoryCandidatePayload = {
      agent,
      topic,
      content,
      dest,
      patternId,
      modelId,
      taskId,
      confidence,
      reasons,
      source,
      repository,
    };

    const sharedMemoryDir =
      typeof args.shared_memory_dir === 'string'
        ? args.shared_memory_dir
        : typeof args.sharedMemoryDir === 'string'
          ? args.sharedMemoryDir
          : '/Users/mac/agents/shared-memory';

    const res = recordCandidateToSharedMemory(payload, sharedMemoryDir);

    if (res.recorded) {
      return {
        ok: true,
        candidateId: res.candidateId,
        status: 'RECORDED_PENDING_CONFIRMATION',
        summary: `### 📥 Knowledge Candidate 已记录\n- **候选 ID**: ${res.candidateId}\n- **来源**: \`${agent}\`${repository ? ` (${repository})` : ''}\n- **主题**: ${topic}\n- **状态**: 待人工确认 (需人工将 inbox.md 中的 [ ] 审核为 [x])\n- **下一步**: 人工审核后触发 Promotion 晋升为长期知识`,
        data: {
          candidateId: res.candidateId,
          recorded: true,
          inboxPath: `${sharedMemoryDir}/candidates/inbox.md`,
          status: 'PENDING_CONFIRMATION',
          nextStep:
            'Review entry in shared-memory/candidates/inbox.md, mark [x], then run promoteConfirmedExperiences()',
          source,
          repository,
        },
      };
    }

    if (res.reason === 'DUPLICATE_CANDIDATE_SKIPPED') {
      return {
        ok: true,
        status: 'DUPLICATE_CANDIDATE_SKIPPED',
        summary: `### ℹ️ Knowledge Candidate 已存在 (跳过重复追加)\n- **主题**: ${topic}\n- **原因**: 命中已有候选去重规则，无需重复写入`,
        data: {
          recorded: false,
          inboxPath: `${sharedMemoryDir}/candidates/inbox.md`,
          status: 'SKIPPED',
          nextStep: 'No action needed: duplicate candidate already exists',
          source,
          repository,
        },
      };
    }

    return {
      ok: false,
      status: 'WRITE_ERROR',
      summary: `录入失败: ${res.reason}`,
      error: res.reason,
      data: {
        recorded: false,
        inboxPath: `${sharedMemoryDir}/candidates/inbox.md`,
        status: 'FAILED',
        nextStep: 'Check shared-memory directory path and permissions',
        source,
        repository,
      },
    };
  }
}

/**
 * 格式化输出完整的 DevTest 物理验真与防资损对账报告（纯净文本/Markdown，双模通用）
 */
export function formatVerifyReport(result: VerifyKernelResult): string {
  const taskStatusText = result.evidence.task.status;
  const ownershipText = result.evidence.media.ownership;
  const mediaStatusText = result.evidence.media.status;
  const billingStatusText = result.evidence.billing.status;
  const antiDoubleText =
    result.evidence.invariants.details?.antiDoubleBilling.status ??
    (result.invariants?.antiDoubleBilling ? 'PASS' : 'UNVERIFIED');
  const netZeroText =
    result.evidence.invariants.details?.netChargeZero.status ??
    (result.invariants?.netChargeZero ? 'PASS' : 'UNVERIFIED');
  const refundIdemText =
    result.evidence.invariants.details?.refundIdempotency.status ??
    (result.invariants?.refundIdempotency ? 'PASS' : 'UNVERIFIED');
  const finalVerdictText = result.verdict;

  const lines: string[] = [];

  lines.push(`🎯 概况：Task #${result.taskId} · [${result.executionMode.toUpperCase()}] · ${result.status}`);
  lines.push('');
  lines.push('🔍 验真：');
  lines.push(`Task <${taskStatusText}>`);
  lines.push(`Artifact ownership <${ownershipText}>`);
  lines.push(`Media <${mediaStatusText}>`);
  lines.push(`Billing <${billingStatusText}>`);
  lines.push(`antiDoubleBilling <${antiDoubleText}>`);
  lines.push(`netChargeZero <${netZeroText}>`);
  lines.push(`refundIdempotency <${refundIdemText}>`);
  lines.push(`生产验收裁决 <${result.acceptance}>`);
  lines.push(`最终技术判定 <${finalVerdictText}>`);
  lines.push('');
  lines.push('💻 复现：');
  lines.push(`npm run devtest -- verify --task ${result.taskId} --model ${result.modelId} --media ${result.mediaType}`);

  if (!result.passed && result.reasons.length > 0) {
    lines.push('');
    lines.push('⚠️ 缺陷：');
    for (const r of result.reasons) lines.push(`- ${r}`);
  }

  lines.push('');
  lines.push('======================================================');
  lines.push(`🔬 DevTest 物理验真与防资损对账明细 [任务 #${result.taskId}] [${result.executionMode.toUpperCase()}]`);

  if (!result.artifact && result.billingAudit === 'SKIPPED_NO_LOGS') {
    lines.push('⚠️ 提示: 当前未连接真实主站获取产物 URL / 账单流水，仅执行脱机静态演算，非线上真实验收结果。');
  }

  let acceptanceLabel: string;
  if (result.acceptance === 'ACCEPTED') {
    acceptanceLabel = '● ACCEPTED (生产级四态验收通过)';
  } else if (result.acceptance === 'REJECTED') {
    acceptanceLabel = '● REJECTED (验收驳回: 存在缺陷或非预期回归)';
  } else if (result.acceptance === 'BLOCKED') {
    acceptanceLabel =
      result.status === 'PROCESSING'
        ? '● BLOCKED / IN_FLIGHT (轮询窗口耗尽: 任务仍在排队处理中)'
        : '● BLOCKED (验收阻断: 缺失核心凭据或刊例单价)';
  } else {
    acceptanceLabel = '● UNVERIFIED (验收待确认: 测试通过但关键证据未闭环)';
  }
  lines.push(`生产验收裁决: ${acceptanceLabel}`);
  lines.push(
    `证据完整度: ${result.evidenceCompleteness.isComplete ? '✔ COMPLETE' : '○ INCOMPLETE'} (${result.evidenceCompleteness.availableEvidence.length}/${result.evidenceCompleteness.requiredEvidence.length})`,
  );
  if (result.evidenceCompleteness.missingEvidence.length > 0) {
    lines.push(`  待补证据: ${result.evidenceCompleteness.missingEvidence.join(', ')}`);
  }

  let verdictLabel: string;
  if (result.passed) {
    verdictLabel = '● ALL PASS (验真与账务全部通过)';
  } else if (result.status === 'PROCESSING') {
    verdictLabel = `● PROCESSING (排队处理中: ${result.progress ?? 0}%)`;
  } else if (result.status === 'UNVERIFIED') {
    verdictLabel = '● UNVERIFIED (凭据缺失，未通过线上验收)';
  } else {
    verdictLabel = '● FAILED (存在违背或缺陷)';
  }
  lines.push(`技术裁决: ${verdictLabel}`);

  lines.push('');
  lines.push(
    `1. 任务状态与执行 (Task Execution): ${result.evidence.task.status === 'PASS' ? '✔ PASS' : result.evidence.task.status === 'PROCESSING' ? '● PROCESSING' : result.evidence.task.status === 'UNVERIFIED' ? '● UNVERIFIED' : '✖ FAIL'} [${result.evidence.task.source}]`,
  );
  if (result.evidence.task.error) {
    lines.push(`   错误信息: ${result.evidence.task.error}`);
  }

  lines.push('');
  lines.push(
    `2. 产物物理结构验真 (Media Inspection): ${result.evidence.media.status === 'PASS' ? '✔ PASS' : result.evidence.media.status === 'UNVERIFIED' ? '● UNVERIFIED' : '✖ FAIL'} [${result.evidence.media.source}]`,
  );
  if (result.artifact) {
    if (result.probeDurationMs !== undefined) {
      lines.push(`   流式探测耗时: ${result.probeDurationMs} ms (Range: bytes=0-65535)`);
    }
    lines.push(
      `   容器标识: ${result.artifact.containerIdentified ? `✔ 规范合法 (${(result.artifact.format || 'mp4').toUpperCase()} container structure PASS)` : '✖ 缺失'} | 格式: ${result.artifact.format || 'unknown'} | 结构有效: ${result.artifact.decodable ? `✔ YES` : '✖ NO'} | 归属确认: ${result.evidence.media.ownership === 'VERIFIED' ? `✔ 绑定成功` : '○ 未绑定'}`,
    );
    if (result.artifact.dimensions) {
      lines.push(`   分辨率: ${result.artifact.dimensions.width}x${result.artifact.dimensions.height}`);
    }
    if (result.artifact.durationSeconds !== undefined) {
      lines.push(`   时长: ${result.artifact.durationSeconds} 秒`);
    }
    if (result.artifact.hasMdat !== undefined) {
      lines.push(`   数据块校验: ${result.artifact.hasMdat !== false ? '✔ 音视频裸流有效' : '✖ 缺少 mdat 数据块'}`);
    }
    if (result.artifact.reasons.length > 0) {
      for (const r of result.artifact.reasons) lines.push(`   ⚠ ${r}`);
    }
  } else {
    lines.push(`   ${result.evidence.media.reason || '未获取产物二进制 Buffer'}`);
  }

  lines.push('');
  lines.push(
    `3. 防资损账务对账 (Billing & Invariants): ${result.evidence.billing.status === 'PASS' ? '✔ PASS' : result.evidence.billing.status === 'UNVERIFIED' ? '● UNVERIFIED' : '✖ FAIL'} [${result.evidence.billing.source}]`,
  );
  if (result.billing) {
    lines.push(`   对账结果: ${result.billing.passed ? '✔ PASS' : '✖ MISMATCH'}`);
    lines.push(
      `   基准扣费: 预扣 ${result.billing.preDeductedPoints} pt | 实扣 ${result.billing.netDeductedPoints} pt | 结算 ${result.billing.settledPoints} pt | 退款 ${result.billing.refundedPoints} pt`,
    );
    if (result.invariants) {
      lines.push(`   核心不变量核验 (Invariants: ${result.evidence.invariants.status}):`);
      lines.push(
        `     - [防重复扣费] antiDoubleBilling:   ${result.invariants.antiDoubleBilling ? '✔ 符合' : '✖ 存在多重扣费'}`,
      );
      lines.push(
        `     - [失败净扣归零] netChargeZero:       ${result.invariants.netChargeZero ? '✔ 符合' : '✖ 失败未完全退款'}`,
      );
      lines.push(
        `     - [退款幂等核销] refundIdempotency:   ${result.invariants.refundIdempotency ? '✔ 符合' : '✖ 重复退款'}`,
      );
    }
  } else {
    lines.push('   未提供账单流水 (scoreLogs 缺失)，跳过账务对账 [SKIPPED_NO_LOGS]');
  }

  if (result.expectedVsActual) {
    lines.push('');
    lines.push('4. 预期与实际对比 (Expected vs Actual Matrix):');
    const diffItems = result.expectedVsActual.items || result.expectedVsActual.diffs || [];
    for (const item of diffItems) {
      const statusTag = `[${item.status}]`;
      const matchIcon = item.matched ? '✔ MATCH' : '✖ DIFF';
      lines.push(
        `   - [${item.layer.padEnd(10)}] ${item.field}: ${statusTag} ${matchIcon} (预期: ${JSON.stringify(item.expected)} | 实际: ${JSON.stringify(item.actual)}) [证据: ${item.evidence || 'N/A'}]`,
      );
      if (item.diff && item.diff !== 'MATCH') {
        lines.push(`     差异说明: ${item.diff}`);
      }
    }
    if (result.expectedVsActual.evidenceStatus?.extraSnapshot === 'MANUAL_DB_EVIDENCE_REQUIRED') {
      lines.push('');
      lines.push('📌 关键证据提醒: [MANUAL_DB_EVIDENCE_REQUIRED]');
      lines.push(`   ${result.expectedVsActual.manualVerificationGuide?.notice}`);
      lines.push(`   SQL 指引: ${result.expectedVsActual.manualVerificationGuide?.extraQuerySql}`);
    }
  }

  if (result.reasons.length > 0) {
    lines.push('');
    lines.push('核验明细 / 告警:');
    for (const r of result.reasons) lines.push(`  👉 ${r}`);
  }

  lines.push('');
  lines.push('🚀 下一步行动:');
  if (result.acceptance === 'ACCEPTED') {
    lines.push('  ✔ 验收全部通过！测试证据闭环，可合流上线 / 交付生产。');
  } else if (result.acceptance === 'BLOCKED') {
    if (result.status === 'PROCESSING') {
      lines.push(
        `  ⏳ 任务仍处于 PROCESSING/QUEUED 状态，本次 polling window 已耗尽。这并非业务失败，请继续执行 npm run devtest -- verify --task ${result.taskId} --model ${result.modelId} --media ${result.mediaType} 追踪终态闭环。`,
      );
    } else {
      lines.push('  ⚠️ 验收阻断：请先补充缺失的刊例定价或环境会话凭据。');
    }
  } else if (result.acceptance === 'REJECTED') {
    lines.push('  ✖ 验收驳回：发现明确业务缺陷或非预期回归，请联系研发排查。');
  } else {
    lines.push('  ○ 待闭环确认：执行 SQL 查询任务 extra 确认分流落库后，追加 --db-extra-confirmed 重新验真。');
  }
  lines.push('======================================================');

  return lines.join('\n');
}
