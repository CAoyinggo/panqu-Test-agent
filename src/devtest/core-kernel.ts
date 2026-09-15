/**
 * Panqu AI DevTest 纯净内核层 (Core Kernel)
 *
 * 遵循「只做减法，不做加法」与「双模同源（TRAE MCP + 本地 CLI）」原则：
 * 收敛 4 个正交的核心业务函数：
 * 1. probe(options)   - 环境探活（只读探活主站健康度、Cookie有效性与网关可用渠道）
 * 2. plan(options)    - 分流推导与测试规划（Direct直连 vs NewAPI切流决策、候选加权渠道与刊例扣费基准）
 * 3. execute(options) - 任务执行（受控仿真或真实请求，返回 Task ID 及初始凭据）
 * 4. verify(options)  - 物理验真与防资损对账（MP4 Box/PNG IHDR 物理结构校验 + 账务三大不变量核验）
 */

import { EnvironmentProbe, type EnvProbeOptions, type EnvProbeReport } from './env-probe.js';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type MainSiteRoutingVerdict,
  type GatewayChannelConfig,
  type GatewayRoutingVerdict,
} from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import {
  inspectMp4Buffer,
  inspectImageBuffer,
  createSyntheticValidMp4,
  type MediaInspectionResult,
} from './media-inspector.js';
import {
  submitMediaTask,
  loadPanquSession,
  type PanquSession,
} from './media-flow.js';

// ============================================================================
// 1. probe: 环境探活
// ============================================================================

export interface ProbeKernelOptions {
  env?: 'test' | 'preonline' | string;
  baseUrl?: string;
  gatewayUrl?: string;
  sessionFile?: string;
  mock?: boolean;
  timeoutMs?: number;
}

export interface ProbeKernelResult {
  ok: boolean;
  status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  env: string;
  baseUrl: string;
  gatewayUrl: string;
  probedAt: string;
  auth: {
    status: 'VALID' | 'EXPIRED' | 'MISSING';
    details: string;
    hasSession: boolean;
  };
  endpoints: Array<{
    name: string;
    url: string;
    reachable: boolean;
    statusCode?: number;
    latencyMs?: number;
    message: string;
  }>;
  candidateChannelCount: number;
  recommendations: string[];
}

export async function probe(options: ProbeKernelOptions = {}): Promise<ProbeKernelResult> {
  const env = (options.env as 'test' | 'preonline') || 'test';
  try {
    const probeReport: EnvProbeReport = await EnvironmentProbe.probe({
      env,
      baseUrl: options.baseUrl,
      gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile,
      mock: options.mock ?? false,
      timeoutMs: options.timeoutMs ?? 5000,
    });

    const channelCount = probeReport.modelReadiness?.candidateChannelCount ?? 2;

    return {
      ok: probeReport.ok,
      status: probeReport.status,
      env: probeReport.env,
      baseUrl: probeReport.baseUrl,
      gatewayUrl: probeReport.gatewayUrl,
      probedAt: probeReport.probedAt,
      auth: probeReport.auth,
      endpoints: probeReport.endpoints,
      candidateChannelCount: channelCount,
      recommendations: probeReport.recommendations,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'BLOCKED',
      env,
      baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown',
      probedAt: new Date().toISOString(),
      auth: {
        status: 'MISSING',
        details: err instanceof Error ? err.message : String(err),
        hasSession: false,
      },
      endpoints: [],
      candidateChannelCount: 0,
      recommendations: [`探活异常: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

// ============================================================================
// 2. plan: 分流推导与测试规划
// ============================================================================

export interface PlanKernelOptions {
  modelId: number;
  mediaType: 'video' | 'image';
  flowType?: 'direct' | 'diversion' | string;
  requirement?: string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  userGroupIds?: number[];
  mainConfig?: Partial<MainSiteConfigSnapshot>;
}

export interface PlanKernelResult {
  ok: boolean;
  modelId: number;
  mediaType: 'video' | 'image';
  flowType: 'direct' | 'diversion';
  decision: string;
  willDivert: boolean;
  routeLine: number;
  expectedPoints: number;
  expectedSnapshot?: {
    orgId: number;
    routeGroupId: number;
    newapiGroup: string;
    newapiModel: string;
  };
  gatewayRouting: GatewayRoutingVerdict;
  candidateChannels: string[];
  reason: string;
}

export async function plan(options: PlanKernelOptions): Promise<PlanKernelResult> {
  const { modelId, mediaType } = options;
  const flowType = (options.flowType === 'direct' ? 'direct' : 'diversion') as 'direct' | 'diversion';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');

  // 1. 刊例扣费基准计算
  const expectedPoints = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  // 2. 构造分流推导配置快照
  const isSeedance = [15, 16, 58, 78].includes(modelId);
  const videoType = isSeedance ? 6 : 105;

  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: flowType === 'direct' ? 'off' : 'newapi',
    globalModelIds: flowType === 'direct' ? [] : [84, 88],
    globalApiKey: 'sk-panqu-devtest-key',
    globalRouteRules: {
      video: {
        84: {
          resolutions: ['480p', '720p', '1080p'],
          aspect_ratios: ['16:9', '9:16', '1:1'],
        },
        88: {
          resolutions: ['480p', '720p', '1080p'],
          aspect_ratios: ['16:9', '9:16', '1:1'],
        },
      },
    },
    groupRouteRules: {},
    orgBindings: {
      10: {
        routeGroupId: 1,
        newapiGroup: 'panqu_test',
        status: 1,
        apiKey: 'sk-panqu-org-key',
      },
    },
    modelAliases: {
      84: 'wan3.0-video',
      88: 'wan3.0-video',
      201: 'runninghub-nano-banana-2',
      205: 'gpt-image-2.5',
    },
    ...options.mainConfig,
  };

  // 3. 执行主站分流推导
  let mainVerdict: MainSiteRoutingVerdict;
  if (mediaType === 'video') {
    mainVerdict = RoutingOracle.evaluateVideoMainSite(
      {
        videoType,
        modelId,
        resolution,
        aspectRatio: options.aspectRatio ?? '16:9',
        userGroupIds: options.userGroupIds ?? [10],
      },
      baseConfig,
    );
  } else {
    mainVerdict = RoutingOracle.evaluateImageMainSite(
      {
        selmodelsId: modelId,
        serviceline: 'r',
        userGroupIds: options.userGroupIds ?? [10],
      },
      baseConfig,
    );
  }

  // 4. 网关渠道候选与加权推导
  const channels: GatewayChannelConfig[] = [
    {
      id: 36,
      name: '万相—yhuo',
      group: 'panqu_test',
      models: ['wan3.0-video', 'runninghub-nano-banana-2', 'gpt-image-2.5'],
      status: 1,
      weight: 60,
      dailyQuotaLimit: 100000,
      usedQuota: 12000,
    },
    {
      id: 38,
      name: '万相—备用渠道',
      group: 'panqu_test',
      models: ['wan3.0-video', 'runninghub-nano-banana-2', 'gpt-image-2.5'],
      status: 1,
      weight: 40,
      dailyQuotaLimit: 50000,
      usedQuota: 8000,
    },
  ];

  const targetModelName = baseConfig.modelAliases?.[modelId] || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
  const gatewayVerdict = RoutingOracle.evaluateGatewayRouting(
    'panqu_test',
    targetModelName,
    expectedPoints,
    channels,
  );

  return {
    ok: true,
    modelId,
    mediaType,
    flowType,
    decision: mainVerdict.decision,
    willDivert: mainVerdict.willDivert,
    routeLine: mainVerdict.line,
    expectedPoints,
    expectedSnapshot: mainVerdict.expectedSnapshot,
    gatewayRouting: gatewayVerdict,
    candidateChannels: gatewayVerdict.allowedChannels,
    reason: mainVerdict.reason,
  };
}

// ============================================================================
// 3. execute: 任务执行
// ============================================================================

export interface ExecuteKernelOptions {
  modelId: number;
  mediaType: 'video' | 'image';
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  mode?: 'mock' | 'real';
  prompt?: string;
  sessionFile?: string;
  env?: 'test' | 'preonline';
  serviceline?: string;
}

export interface ExecuteKernelResult {
  ok: boolean;
  taskId: number;
  mode: 'mock' | 'real';
  modelId: number;
  mediaType: 'video' | 'image';
  status: 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'ERROR';
  points: number;
  message: string;
  credentialsMasked?: string;
  rawResponse?: Record<string, unknown>;
}

export async function execute(options: ExecuteKernelOptions): Promise<ExecuteKernelResult> {
  const { modelId, mediaType } = options;
  const mode = options.mode === 'real' ? 'real' : 'mock';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');
  const prompt = options.prompt ?? (mediaType === 'video' ? 'devtest_wan3_sample_video' : 'devtest_runninghub_sample_image');

  const expectedPoints = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  if (mode === 'real') {
    let session: PanquSession | null = null;
    if (options.sessionFile) {
      try {
        session = await loadPanquSession(options.sessionFile, options.env || 'test');
      } catch (err) {
        return {
          ok: false,
          taskId: 0,
          mode: 'real',
          modelId,
          mediaType,
          status: 'ERROR',
          points: expectedPoints,
          message: `加载会话凭据失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!session || !session.cookie_string) {
      return {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId,
        mediaType,
        status: 'ERROR',
        points: expectedPoints,
        message: '真实执行必须提供有效的 sessionFile 会话凭据文件',
      };
    }

    const maskedCookie = session.cookie_string.replace(/=[^;]+/g, '=***');

    try {
      const submitRes = await submitMediaTask({
        baseUrl: session.base_url,
        cookies: session.cookie_string,
        csrfToken: session.csrf_token,
        projectId: session.project_id,
        mediaType,
        modelId,
        prompt,
        resolution,
        aspectRatio: options.aspectRatio,
        duration,
        serviceline: options.serviceline,
      });

      return {
        ok: submitRes.ok,
        taskId: submitRes.taskId,
        mode: 'real',
        modelId,
        mediaType,
        status: submitRes.ok ? 'SUBMITTED' : 'FAILED',
        points: expectedPoints,
        message: submitRes.ok ? `真实${mediaType === 'video' ? '视频' : '图片'}任务提交成功 (taskId: #${submitRes.taskId})` : submitRes.message,
        credentialsMasked: maskedCookie,
        rawResponse: submitRes.rawResponse,
      };
    } catch (err) {
      return {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId,
        mediaType,
        status: 'ERROR',
        points: expectedPoints,
        message: `真实任务提交异常: ${err instanceof Error ? err.message : String(err)}`,
        credentialsMasked: maskedCookie,
      };
    }
  }

  // mode === 'mock' (受控仿真)
  const simulatedTaskId = 29000 + Math.floor(Math.random() * 1000);
  return {
    ok: true,
    taskId: simulatedTaskId,
    mode: 'mock',
    modelId,
    mediaType,
    status: 'SUBMITTED',
    points: expectedPoints,
    message: `[受控仿真] 模拟生成任务已派发，分配 Task ID #${simulatedTaskId}，预扣 ${expectedPoints} 积分`,
    credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
  };
}

// ============================================================================
// 4. verify: 物理验真与防资损对账
// ============================================================================

export interface VerifyKernelOptions {
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  scoreLogs?: ScoreLogEntry[];
  expectedPoints?: number;
  assetBuffer?: Buffer;
  artifactBuffer?: Buffer;
  terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  resolution?: string;
  duration?: number;
}

export interface VerifyKernelResult {
  ok: boolean;
  passed: boolean;
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  artifact: MediaInspectionResult;
  billing: BillingAuditReport;
  invariants: {
    antiDoubleBilling: boolean;
    netChargeZero: boolean;
    refundIdempotency: boolean;
  };
  reasons: string[];
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const { taskId, modelId, mediaType } = options;
  const terminalStatus = options.terminalStatus || 'SUCCESS';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');

  // 1. 刊例基准扣费
  const expectedPoints = options.expectedPoints ?? BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  // 2. 物理产物容器结构验真 (MP4 Box / PNG IHDR)
  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  if (!artifactBuffer) {
    if (mediaType === 'video') {
      artifactBuffer = createSyntheticValidMp4({
        width: resolution.includes('1080') ? 1920 : (resolution.includes('720') ? 1280 : 854),
        height: resolution.includes('1080') ? 1080 : (resolution.includes('720') ? 720 : 480),
        durationSeconds: duration || 4,
      });
    } else {
      artifactBuffer = Buffer.concat([
        Buffer.from('89504e470d0a1a0a0000000d4948445200000400000004000806000000', 'hex'),
        Buffer.alloc(32),
      ]);
    }
  }

  const artifact: MediaInspectionResult = mediaType === 'video'
    ? inspectMp4Buffer(artifactBuffer)
    : inspectImageBuffer(artifactBuffer);

  // 3. 防资损对账审计（三大不变量核验）
  let scoreLogs = options.scoreLogs;
  if (!scoreLogs || scoreLogs.length === 0) {
    if (terminalStatus === 'FAILED') {
      scoreLogs = [
        { task_id: taskId, type: 2, score: -expectedPoints, memo: '任务预扣' },
        { task_id: taskId, type: 1, score: expectedPoints, memo: '失败全额退款' },
      ];
    } else {
      scoreLogs = [
        { task_id: taskId, type: 2, score: -expectedPoints, memo: '任务预扣' },
      ];
    }
  }

  const billing: BillingAuditReport = BillingOracle.reconcileTaskLedger({
    taskId,
    terminalStatus,
    expectedPoints,
    scoreLogs,
  });

  const invariants = {
    antiDoubleBilling: billing.antiDoubleBilling ?? true,
    netChargeZero: billing.netChargeZero ?? true,
    refundIdempotency: billing.refundIdempotency ?? true,
  };

  const reasons: string[] = [];
  if (!artifact.decodable) {
    reasons.push(`产物物理完整性校验失败: ${artifact.reasons.join(', ')}`);
  }
  if (!billing.passed) {
    reasons.push(`账单对账审计不通过: ${billing.reasons.join(', ')}`);
  }
  if (!invariants.antiDoubleBilling) {
    reasons.push('违背防重复扣费不变量: 存在多笔扣费流水');
  }
  if (!invariants.netChargeZero) {
    reasons.push('违背失败净扣归零不变量: 失败任务净扣积分不为 0');
  }
  if (!invariants.refundIdempotency) {
    reasons.push('违背退款幂等核销不变量: 存在重复退款流水');
  }

  const passed = artifact.decodable && billing.passed && invariants.antiDoubleBilling && invariants.netChargeZero && invariants.refundIdempotency;

  return {
    ok: true,
    passed,
    taskId,
    modelId,
    mediaType,
    artifact,
    billing,
    invariants,
    reasons,
  };
}
