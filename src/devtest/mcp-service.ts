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
    },
    required: ['action'],
  },
};

export class DevTestMcpService {
  constructor(private readonly projectRoot = process.cwd()) {}

  public async call(args: Record<string, any>): Promise<any> {
    const action = String(args.action || 'probe').toLowerCase();
    switch (action) {
      case 'probe': {
        const res = await probe({
          env: args.env,
          baseUrl: args.base_url || args.baseUrl,
          gatewayUrl: args.gateway_url || args.gatewayUrl,
          sessionFile: args.session_file || args.sessionFile,
          mock: args.mock ?? false,
          timeoutMs: args.timeout_ms || args.timeoutMs,
        });
        const summary = `### 📋 Panqu 环境探活回执\n- **环境**: ${res.env} | **状态**: ${res.status}\n- **主站**: ${res.baseUrl}\n- **网关**: ${res.gatewayUrl}\n- **可用渠道数**: ${res.candidateChannelCount}\n- **鉴权凭据**: ${res.auth.status} (${res.auth.details})`;
        return { ok: res.ok, action: 'probe', summary, data: res };
      }
      case 'plan': {
        const res = await plan({
          modelId: Number(args.model_id ?? args.modelId ?? 84),
          mediaType: (args.media_type || args.mediaType || 'video') as 'video' | 'image',
          flowType: args.flow_type || args.flowType || 'diversion',
          resolution: args.resolution,
          duration: args.duration,
          aspectRatio: args.aspect_ratio || args.aspectRatio,
        });
        const divertStr = res.willDivert ? `NEWAPI 切流 (线路 ${res.routeLine})` : `DIRECT 直连 (线路 ${res.routeLine})`;
        const summary = `### 📋 Panqu 分流推导回执\n- **模型**: #${res.modelId} (${res.mediaType})\n- **分流裁决**: ${divertStr} [${res.decision}]\n- **基准扣费**: ${res.expectedPoints} pt\n- **候选渠道**: ${res.candidateChannels.join(', ') || '无可用渠道'}\n- **推导依据**: ${res.reason}`;
        return { ok: res.ok, action: 'plan', summary, data: res };
      }
      case 'execute': {
        const res = await execute({
          modelId: Number(args.model_id ?? args.modelId ?? 84),
          mediaType: (args.media_type || args.mediaType || 'video') as 'video' | 'image',
          mode: args.mode === 'real' ? 'real' : 'mock',
          resolution: args.resolution,
          duration: args.duration,
          prompt: args.prompt,
          sessionFile: args.session_file || args.sessionFile,
          env: args.env,
        });
        const summary = `### 📋 Panqu 任务执行回执\n- **任务 ID**: #${res.taskId} [${res.mode.toUpperCase()}]\n- **执行状态**: ${res.status}\n- **预扣积分**: ${res.points} pt\n- **回执信息**: ${res.message}`;
        return { ok: res.ok, action: 'execute', summary, data: res };
      }
      case 'verify': {
        const res = await verify({
          taskId: Number(args.task_id ?? args.taskId ?? 0),
          modelId: Number(args.model_id ?? args.modelId ?? 84),
          mediaType: (args.media_type || args.mediaType || 'video') as 'video' | 'image',
          expectedPoints: args.expected_points ?? args.expectedPoints,
          terminalStatus: args.terminal_status || args.terminalStatus || 'SUCCESS',
          scoreLogs: args.score_logs || args.scoreLogs,
          resolution: args.resolution,
          duration: args.duration,
          sessionFile: args.session_file || args.sessionFile,
          env: args.env,
          videoUrl: args.video_url || args.videoUrl,
          imageUrl: args.image_url || args.imageUrl,
          assetBuffer: args.asset_buffer || args.assetBuffer,
          artifactBuffer: args.artifact_buffer || args.artifactBuffer,
        });
        const artifactStatus = res.artifact ? (res.artifact.decodable ? 'PASS (MP4/PNG容器结构完整)' : 'FAIL') : 'UNVERIFIED (未获取真实产物)';
        const billingStatus = res.billing ? (res.billing.passed ? 'PASS' : 'FAIL') : 'SKIPPED_NO_LOGS (未提供流水)';
        const antiDouble = res.invariants ? (res.invariants.antiDoubleBilling ? 'PASS' : 'FAIL') : 'SKIPPED';
        const netZero = res.invariants ? (res.invariants.netChargeZero ? 'PASS' : 'FAIL') : 'SKIPPED';
        const refundIdem = res.invariants ? (res.invariants.refundIdempotency ? 'PASS' : 'FAIL') : 'SKIPPED';
        const summary = `### 📋 Panqu 物理验真与防资损对账回执\n- **最终裁决**: ${res.passed ? 'ALL PASS' : res.status}\n- **产物验真**: ${artifactStatus}\n- **账务对账**: ${billingStatus}\n- **防重复扣费**: ${antiDouble}\n- **失败净扣归零**: ${netZero}\n- **退款幂等核销**: ${refundIdem}${res.reasons.length > 0 ? `\n- **核验明细**: ${res.reasons.join('; ')}` : ''}`;
        return { ok: res.ok, action: 'verify', summary, data: res };
      }
      default:
        return { ok: false, error: `Unsupported action "${action}". Allowed: probe, plan, execute, verify.` };
    }
  }
}
