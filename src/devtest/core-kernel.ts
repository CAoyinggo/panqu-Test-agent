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
  type MediaInspectionResult,
} from './media-inspector.js';
import {
  submitMediaTask,
  pollTaskStatus,
  loadPanquSession,
  type PanquSession,
  type TaskStatusSnapshot,
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
  channels?: GatewayChannelConfig[];
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

  // 4. 网关渠道候选与加权推导（从真实配置或当前可用渠道推导）
  const targetModelName = mainVerdict.expectedSnapshot?.newapiModel
    || baseConfig.modelAliases?.[modelId]
    || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
  const targetGroup = mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test';

  const channels: GatewayChannelConfig[] = options.channels || (
    mainVerdict.willDivert
      ? [
          {
            id: 1,
            name: `${targetModelName}主渠道`,
            group: targetGroup,
            models: [targetModelName],
            status: 1,
            weight: 100,
            dailyQuotaLimit: 0,
            usedQuota: 0,
          },
        ]
      : []
  );

  const gatewayVerdict = RoutingOracle.evaluateGatewayRouting(
    targetGroup,
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
    message: `[MOCK 离线仿真] 仅生成模拟 ID，未发送主站请求 (模拟任务 ID #${simulatedTaskId}，预扣 ${expectedPoints} 积分)`,
    credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
  };
}

// ============================================================================
// 4. verify: 物理验真与防资损对账
// ============================================================================

/**
 * 流式探测远程媒体二进制头部 (Range: bytes=0-65535)
 */
export async function fetchMediaRangeBuffer(url: string, timeoutMs = 10000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-65535',
        'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    if (res.body && typeof (res.body as any).getReader === 'function') {
      const reader = (res.body as any).getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (totalBytes < 65536) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        totalBytes += value.byteLength;
      }
      try {
        await reader.cancel();
      } catch {
        // ignore cancel error
      }
      const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
      return combined.subarray(0, 65536);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab).subarray(0, 65536);
  } finally {
    clearTimeout(timer);
  }
}

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
  sessionFile?: string;
  env?: 'test' | 'preonline';
  baseUrl?: string;
  cookies?: string;
  videoUrl?: string;
  imageUrl?: string;
  pollTimeoutSec?: number;
}

export interface VerifyKernelResult {
  ok: boolean;
  passed: boolean;
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNVERIFIED' | 'ERROR';
  mode: 'real' | 'mock';
  progress?: number;
  probeDurationMs?: number;
  artifact?: MediaInspectionResult;
  billing?: BillingAuditReport;
  billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS';
  invariants?: {
    antiDoubleBilling: boolean;
    netChargeZero: boolean;
    refundIdempotency: boolean;
  };
  reasons: string[];
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const { taskId, modelId, mediaType } = options;
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');

  // 1. 刊例基准扣费
  const expectedPoints = options.expectedPoints ?? BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  let mode: 'real' | 'mock' = 'mock';
  let targetStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' = options.terminalStatus || 'SUCCESS';
  let resolvedVideoUrl = options.videoUrl;
  let resolvedImageUrl = options.imageUrl;
  let probeDurationMs: number | undefined;
  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  const reasons: string[] = [];

  // 2. 真实网络链路：检查是否提供会话以查询真实主站
  let session: PanquSession | null = null;
  if (options.sessionFile) {
    mode = 'real';
    try {
      session = await loadPanquSession(options.sessionFile, options.env || 'test');
    } catch (err) {
      return {
        ok: false,
        passed: false,
        taskId,
        modelId,
        mediaType,
        status: 'ERROR',
        mode: 'real',
        billingAudit: 'SKIPPED_NO_LOGS',
        reasons: [`加载会话凭据失败: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  } else if (options.cookies && options.baseUrl) {
    mode = 'real';
    session = {
      env: options.env || 'test',
      base_url: options.baseUrl,
      cookie_string: options.cookies,
    };
  }

  // 3. 若已连接会话，调用 pollTaskStatus 获取主站实时状态
  if (session) {
    try {
      const { finalSnapshot } = await pollTaskStatus(taskId, {
        baseUrl: session.base_url,
        cookies: session.cookie_string,
        mediaType,
        pollTimeoutSec: options.pollTimeoutSec ?? 10,
      });

      const taskStatus = finalSnapshot.taskStatus;

      // 3.1 状态 1: 排队中 / 处理中
      if (taskStatus === 1) {
        return {
          ok: true,
          passed: false,
          taskId,
          modelId,
          mediaType,
          status: 'PROCESSING',
          progress: finalSnapshot.progress,
          mode: 'real',
          billingAudit: 'SKIPPED_NO_LOGS',
          reasons: [`任务 #${taskId} 仍在排队/生成中 (进度: ${finalSnapshot.progress}%)，未到达终态`],
        };
      }

      // 3.2 状态 3 或 4: 失败或异常
      if (taskStatus === 3 || taskStatus === 4) {
        targetStatus = 'FAILED';
        let billing: BillingAuditReport | undefined;
        let billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS' = 'SKIPPED_NO_LOGS';
        let invariants: VerifyKernelResult['invariants'];

        if (options.scoreLogs && options.scoreLogs.length > 0) {
          billing = BillingOracle.reconcileTaskLedger({
            taskId,
            terminalStatus: 'FAILED',
            expectedPoints,
            scoreLogs: options.scoreLogs,
          });
          billingAudit = 'AUDITED';
          invariants = {
            antiDoubleBilling: billing.antiDoubleBilling ?? true,
            netChargeZero: billing.netChargeZero ?? true,
            refundIdempotency: billing.refundIdempotency ?? true,
          };
          if (!billing.passed) {
            reasons.push(`账单对账审计不通过: ${billing.reasons.join(', ')}`);
          }
        } else {
          reasons.push('未提供账单流水，跳过账务对账 [SKIPPED_NO_LOGS]');
        }

        reasons.unshift(`任务 #${taskId} 执行失败: ${finalSnapshot.error || `主站状态为 ${finalSnapshot.statusLabel}`}`);

        return {
          ok: true,
          passed: false,
          taskId,
          modelId,
          mediaType,
          status: 'FAILED',
          progress: finalSnapshot.progress,
          mode: 'real',
          billing,
          billingAudit,
          invariants,
          reasons,
        };
      }

      // 3.3 状态 2: 成功
      if (taskStatus === 2) {
        targetStatus = 'SUCCESS';
        resolvedVideoUrl = finalSnapshot.videoUrl;
        resolvedImageUrl = finalSnapshot.imageUrl;
      }
    } catch (err) {
      return {
        ok: false,
        passed: false,
        taskId,
        modelId,
        mediaType,
        status: 'ERROR',
        mode: 'real',
        billingAudit: 'SKIPPED_NO_LOGS',
        reasons: [`轮询任务状态异常: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  // 4. 真实二进制流式探测 (Range: bytes=0-65535)
  const targetUrl = mediaType === 'video' ? resolvedVideoUrl : (resolvedImageUrl || resolvedVideoUrl);
  if (!artifactBuffer && targetUrl) {
    mode = 'real';
    const probeStart = Date.now();
    try {
      artifactBuffer = await fetchMediaRangeBuffer(targetUrl);
      probeDurationMs = Date.now() - probeStart;
    } catch (err) {
      reasons.push(`流式探测产物二进制失败 (${targetUrl}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. 产物物理结构验真 (MP4 Box / PNG IHDR)
  let artifact: MediaInspectionResult | undefined;
  if (artifactBuffer) {
    artifact = mediaType === 'video'
      ? inspectMp4Buffer(artifactBuffer)
      : inspectImageBuffer(artifactBuffer);

    if (!artifact.decodable) {
      reasons.push(`产物物理完整性校验失败: ${artifact.reasons.join(', ')}`);
    }
  } else {
    reasons.push('缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真');
  }

  // 6. 防资损对账审计（三大不变量核验）
  let billing: BillingAuditReport | undefined;
  let billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS' = 'SKIPPED_NO_LOGS';
  let invariants: VerifyKernelResult['invariants'];

  if (options.scoreLogs && options.scoreLogs.length > 0) {
    billing = BillingOracle.reconcileTaskLedger({
      taskId,
      terminalStatus: targetStatus,
      expectedPoints,
      scoreLogs: options.scoreLogs,
    });
    billingAudit = 'AUDITED';
    invariants = {
      antiDoubleBilling: billing.antiDoubleBilling ?? true,
      netChargeZero: billing.netChargeZero ?? true,
      refundIdempotency: billing.refundIdempotency ?? true,
    };

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
  } else {
    reasons.push('未提供账单流水，跳过账务对账 [SKIPPED_NO_LOGS]');
  }

  // 7. 终极真实验收裁决：物理产物必须解码通过，账务必须经审计且不变量全部通过
  const passed = Boolean(
    artifact &&
    artifact.decodable &&
    billingAudit === 'AUDITED' &&
    billing &&
    billing.passed &&
    invariants &&
    invariants.antiDoubleBilling &&
    invariants.netChargeZero &&
    invariants.refundIdempotency
  );

  const status: VerifyKernelResult['status'] = passed
    ? 'SUCCESS'
    : targetStatus === 'FAILED'
    ? 'FAILED'
    : (!artifact && billingAudit === 'SKIPPED_NO_LOGS')
    ? 'UNVERIFIED'
    : 'FAILED';

  return {
    ok: true,
    passed,
    taskId,
    modelId,
    mediaType,
    status,
    mode,
    probeDurationMs,
    artifact,
    billing,
    billingAudit,
    invariants,
    reasons,
  };
}
