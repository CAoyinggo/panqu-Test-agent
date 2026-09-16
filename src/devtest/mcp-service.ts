/**
 * Panqu AI DevTest 纯净 MCP 服务 (TRAE MCP Control Surface)
 * 单工具 devtest，4 项核心 Action: probe, plan, execute, verify，直接路由到 core-kernel。
 */
import {
  probe,
  plan,
  execute,
  verify,
  type ProbeKernelOptions,
  type PlanKernelOptions,
  type ExecuteKernelOptions,
  type VerifyKernelOptions,
} from './core-kernel.js';
import type { DiversionBaseline } from './types.js';

export const DEVTEST_MCP_TOOL = {
  name: 'devtest',
  description: 'Panqu AI 研发测试副驾（双模支持：TRAE MCP 智能调用 + 本地终端 CLI 独立执行）。提供环境探活 (probe)、分流推导与规划 (plan)、任务执行 (execute)、物理验真与防资损对账 (verify)。',
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
      terminal_status: { type: 'string', enum: ['SUCCESS', 'FAILED', 'TIMEOUT'], description: '任务终态' },
      score_logs: { type: 'array', description: '积分流水明细' },
      expected_points: { type: 'number', description: '预期扣除积分' },
      change_type: { type: 'string', enum: ['new_model', 'diversion_change'], description: '变更类型 (默认自适应识别)' },
      custom_points: { type: 'number', description: '自定义固定扣费积分刊例价' },
      points_per_second: { type: 'number', description: '按秒计费刊例价' },
      price: { type: 'number', description: '刊例价 (图片固定单价或视频每秒单价)' },
      is_global: { type: 'boolean', description: '是否全量开放' },
      alias: { type: 'string', description: '模型别名' },
      requirement: { type: 'string', description: '自然语言变更需求描述 (例如: 接入 960 视频模型)' },
    },
    required: ['action'],
  },
};

export interface McpCallResult<T = any> {
  ok: boolean;
  action?: string;
  summary?: string;
  data?: T;
  error?: string;
}

export class DevTestMcpService {
  constructor(private readonly projectRoot = process.cwd()) {}

  public async call<T = any>(args: Record<string, unknown>): Promise<McpCallResult<T>> {
    const action = String(args.action || 'probe').toLowerCase();
    switch (action) {
      case 'probe': {
        const res = await probe({
          env: typeof args.env === 'string' ? args.env : undefined,
          baseUrl: typeof args.base_url === 'string' ? args.base_url : typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
          gatewayUrl: typeof args.gateway_url === 'string' ? args.gateway_url : typeof args.gatewayUrl === 'string' ? args.gatewayUrl : undefined,
          sessionFile: typeof args.session_file === 'string' ? args.session_file : typeof args.sessionFile === 'string' ? args.sessionFile : undefined,
          mock: typeof args.mock === 'boolean' ? args.mock : false,
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        });
        const summary = `### 📋 Panqu 环境探活回执\n- **环境**: ${res.env} | **状态**: ${res.status}\n- **主站**: ${res.baseUrl}\n- **网关**: ${res.gatewayUrl}\n- **可用渠道数**: ${res.candidateChannelCount}\n- **鉴权凭据**: ${res.auth.status} (${res.auth.details})`;
        return { ok: res.ok, action: 'probe', summary, data: res as unknown as T };
      }
      case 'plan': {
        const res = await plan({
          modelId: args.model_id !== undefined ? Number(args.model_id) : args.modelId !== undefined ? Number(args.modelId) : undefined,
          mediaType: args.media_type || args.mediaType ? (((args.media_type || args.mediaType) as string).toLowerCase() as 'video' | 'image') : undefined,
          flowType: typeof args.flow_type === 'string' ? args.flow_type : typeof args.flowType === 'string' ? args.flowType : undefined,
          changeType: (args.change_type || args.changeType) as any,
          requirement: typeof args.requirement === 'string' ? args.requirement : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          duration: typeof args.duration === 'number' ? args.duration : undefined,
          aspectRatio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined,
          customPoints: typeof args.custom_points === 'number' ? args.custom_points : typeof args.customPoints === 'number' ? args.customPoints : undefined,
          pointsPerSecond: typeof args.points_per_second === 'number' ? args.points_per_second : typeof args.pointsPerSecond === 'number' ? args.pointsPerSecond : undefined,
          price: typeof args.price === 'number' ? args.price : undefined,
          isGlobal: typeof args.is_global === 'boolean' ? args.is_global : typeof args.isGlobal === 'boolean' ? args.isGlobal : undefined,
          alias: typeof args.alias === 'string' ? args.alias : undefined,
        });
        const divertStr = res.willDivert ? `NEWAPI 切流 (线路 ${res.routeLine})` : `DIRECT 直连 (线路 ${res.routeLine})`;
        const forecastStr = res.acceptanceForecast ? `\n- **验收预判**: [${res.acceptanceForecast}]` : '';
        const missingInputsStr = res.missingInputs && res.missingInputs.length > 0 ? ` (缺失必填项: ${res.missingInputs.join(', ')})` : '';
        const blockedStr = res.blocked && res.blocked.length > 0 ? `\n⚠️ 阻断待补事实 (${res.blocked.length}项): ${res.blocked.map((b) => b.missingField || b.field).join(', ')}` : '';
        const skippedStr = res.testPlan?.skippedTests && res.testPlan.skippedTests.length > 0 ? `\n🛡️ 安全裁剪跳过: 共 ${res.testPlan.skippedTests.length} 项无关测试已排除` : '';
        const nextStepStr = res.testerActionSummary?.nextStep ? `\n🚀 下一步行动: ${res.testerActionSummary.nextStep}` : '';

        const summary = `### 📋 Panqu 分流推导回执与动态测试计划 [${res.scenarioName || res.scenario}]
- **模型**: #${res.modelId} (${res.mediaType}) | 别名: ${res.contract?.alias.value || '未知'} [${res.contract?.alias.source || 'default'}]
- **分流裁决**: ${divertStr} [${res.decision}]
- **定价状态**: ${res.pricingStatus} (${res.expectedPoints} pt)
- **测试计划**: 共 ${res.testPlan?.tests.length || 0} 项测试 (就绪 ${res.testPlan?.tests.filter((t) => t.status === 'READY').length || 0} 项)${skippedStr}${forecastStr}${missingInputsStr}${blockedStr}${nextStepStr}
- **候选渠道**: ${res.candidateChannels.join(', ') || '无可用渠道'}
- **推导依据**: ${res.reason}`;
        return { ok: res.ok, action: 'plan', summary, data: res as unknown as T };
      }
      case 'execute': {
        const res = await execute({
          modelId: Number(args.model_id ?? args.modelId ?? 84),
          mediaType: ((args.media_type || args.mediaType || 'video') as string).toLowerCase() as 'video' | 'image',
          mode: args.mode === 'real' ? 'real' : 'mock',
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          duration: typeof args.duration === 'number' ? args.duration : undefined,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          sessionFile: typeof args.session_file === 'string' ? args.session_file : typeof args.sessionFile === 'string' ? args.sessionFile : undefined,
          env: (args.env as 'test' | 'preonline') || undefined,
          price: typeof args.price === 'number' ? args.price : undefined,
          customPoints: typeof args.custom_points === 'number' ? args.custom_points : typeof args.customPoints === 'number' ? args.customPoints : undefined,
          pointsPerSecond: typeof args.points_per_second === 'number' ? args.points_per_second : typeof args.pointsPerSecond === 'number' ? args.pointsPerSecond : undefined,
        });
        const summary = `### 📋 Panqu 任务执行回执\n- **任务 ID**: #${res.taskId} [${res.mode.toUpperCase()}]\n- **执行状态**: ${res.status}\n- **预扣积分**: ${res.points} pt\n- **回执信息**: ${res.message}`;
        return { ok: res.ok, action: 'execute', summary, data: res as unknown as T };
      }
      case 'verify': {
        const terminalStatus = typeof args.terminal_status === 'string'
          ? (args.terminal_status as 'SUCCESS' | 'FAILED' | 'TIMEOUT')
          : typeof args.terminalStatus === 'string'
          ? (args.terminalStatus as 'SUCCESS' | 'FAILED' | 'TIMEOUT')
          : undefined;

        const res = await verify({
          taskId: Number(args.task_id ?? args.taskId ?? 0),
          modelId: args.model_id !== undefined ? Number(args.model_id) : args.modelId !== undefined ? Number(args.modelId) : undefined,
          mediaType: (args.media_type || args.mediaType) ? ((args.media_type || args.mediaType) as string).toLowerCase() as 'video' | 'image' : undefined,
          expectedPoints: typeof args.expected_points === 'number' ? args.expected_points : typeof args.expectedPoints === 'number' ? args.expectedPoints : undefined,
          price: typeof args.price === 'number' ? args.price : undefined,
          customPoints: typeof args.custom_points === 'number' ? args.custom_points : typeof args.customPoints === 'number' ? args.customPoints : undefined,
          pointsPerSecond: typeof args.points_per_second === 'number' ? args.points_per_second : typeof args.pointsPerSecond === 'number' ? args.pointsPerSecond : undefined,
          terminalStatus,
          scoreLogs: Array.isArray(args.score_logs) ? args.score_logs : Array.isArray(args.scoreLogs) ? args.scoreLogs : undefined,
          resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
          duration: typeof args.duration === 'number' ? args.duration : undefined,
          sessionFile: typeof args.session_file === 'string' ? args.session_file : typeof args.sessionFile === 'string' ? args.sessionFile : undefined,
          env: (args.env as 'test' | 'preonline') || undefined,
          videoUrl: typeof args.video_url === 'string' ? args.video_url : typeof args.videoUrl === 'string' ? args.videoUrl : undefined,
          imageUrl: typeof args.image_url === 'string' ? args.image_url : typeof args.imageUrl === 'string' ? args.imageUrl : undefined,
          assetBuffer: Buffer.isBuffer(args.asset_buffer) ? args.asset_buffer : Buffer.isBuffer(args.assetBuffer) ? args.assetBuffer : undefined,
          artifactBuffer: Buffer.isBuffer(args.artifact_buffer) ? args.artifact_buffer : Buffer.isBuffer(args.artifactBuffer) ? args.artifactBuffer : undefined,
          dbExtraConfirmed: Boolean(args.db_extra_confirmed ?? args.dbExtraConfirmed),
          gatewayChannelConfirmed: Boolean(args.gateway_channel_confirmed ?? args.gatewayChannelConfirmed),
          baseline: args.baseline as DiversionBaseline | undefined,
          unconfirmedStatic: Boolean(args.unconfirmed_static ?? args.unconfirmedStatic),
        });

        const taskStatus = res.evidence.task.status;
        const artifactStatus = res.evidence.media.status === 'PASS'
          ? `PASS (${(res.evidence.media.format || 'mp4').toUpperCase()} container structure PASS)`
          : res.evidence.media.status === 'FAIL' ? 'FAIL (损坏)' : 'UNVERIFIED (无产物)';
        const billingStatus = res.evidence.billing.status;
        const netZero = res.invariants ? (res.invariants.netChargeZero ? 'PASS' : 'FAIL (资损告警)') : 'SKIPPED';
        const antiDouble = res.invariants ? (res.invariants.antiDoubleBilling ? 'PASS' : 'FAIL (重扣告警)') : 'SKIPPED';
        const extraNotice = res.expectedVsActual?.evidenceStatus.extraSnapshot === 'MANUAL_DB_EVIDENCE_REQUIRED'
          ? '\n📌 关键分流落库证据: [MANUAL_DB_EVIDENCE_REQUIRED] (HTTP接口不返回extra，需只读查询DB ai_tasks)'
          : '';
        const completenessStr = res.evidenceCompleteness
          ? ` · 证据完整度 <${res.evidenceCompleteness.availableEvidence.length}/${res.evidenceCompleteness.requiredEvidence.length}${res.evidenceCompleteness.isComplete ? ' COMPLETE' : ' INCOMPLETE'}>`
          : '';

        const summary = `🎯 概况：模型 #${res.modelId} (${res.mediaType}) · [${res.mode.toUpperCase()}] · 任务 #${res.taskId}
🔍 验真：最终裁决 <${res.passed ? 'ALL PASS' : res.status}> · 生产验收 <${res.acceptance}>${completenessStr} · 任务状态 <${taskStatus}> · 产物结构 <${artifactStatus}> · 账单对账 <${billingStatus}> · 失败净扣归零 <${netZero}> · 防重复扣费 <${antiDouble}>${extraNotice}${res.reasons.length > 0 ? `\n⚠️ 详情：${res.reasons.join('; ')}` : ''}
💻 复现：npm run devtest -- verify --task ${res.taskId} --model ${res.modelId} --media ${res.mediaType}`;
        return { ok: res.ok, action: 'verify', summary, data: res as unknown as T };
      }
      default:
        return { ok: false, error: `Unsupported action "${action}". Allowed: probe, plan, execute, verify.` };
    }
  }
}
