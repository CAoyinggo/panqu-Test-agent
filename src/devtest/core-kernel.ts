/**
 * Panqu AI DevTest 统一核心内核 (Core Kernel)
 *
 * 业务内核核心职责：
 * 1. probe(options)   - 环境探活与端点可达性检测
 * 2. plan(options)    - 分流策略推导、计费预估与轻量验证目标 (Verification Targets) 推导
 * 3. execute(options) - 任务派发（真实线上调用或受控离线仿真）
 * 4. verify(options)  - 真实物理媒体验真 (MP4/PNG)、防资损账务核销与确定性需求覆盖裁决
 */

import { EnvironmentProbe, type EnvProbeReport } from './env-probe.js';
import {
  RoutingOracle,
  type MainSiteConfigSnapshot,
  type GatewayRoutingVerdict,
  type GatewayChannelConfig,
} from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import { submitMediaTask, pollTaskStatus, loadPanquSession, type PanquSession } from './media-flow.js';
import {
  deriveVerificationTargets,
  evaluateRequirementCoverage,
  type VerificationTarget,
  type RequirementCoverageReport,
} from './verification-target.js';

// ============================================================================
// 1. probe (环境探活)
// ============================================================================

export interface ProbeKernelOptions {
  env?: string;
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
  const env = options.env || 'test';
  try {
    const report: EnvProbeReport = await EnvironmentProbe.probe({
      env: env as 'test' | 'preonline',
      baseUrl: options.baseUrl,
      gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile,
      mock: options.mock ?? false,
      timeoutMs: options.timeoutMs ?? 5000,
    });

    return {
      ok: report.ok,
      status: report.status,
      env: report.env,
      baseUrl: report.baseUrl,
      gatewayUrl: report.gatewayUrl,
      probedAt: report.probedAt,
      auth: report.auth,
      endpoints: report.endpoints,
      candidateChannelCount: report.modelReadiness?.candidateChannelCount ?? 2,
      recommendations: report.recommendations,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'BLOCKED',
      env,
      baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown',
      probedAt: new Date().toISOString(),
      auth: {
        status: 'MISSING',
        details: msg,
        hasSession: false,
      },
      endpoints: [],
      candidateChannelCount: 0,
      recommendations: [`探活异常: ${msg}`],
    };
  }
}

// ============================================================================
// 2. plan (分流推导与需求验证规划)
// ============================================================================

export interface PlanKernelOptions {
  modelId: number;
  mediaType: 'video' | 'image';
  flowType?: string;
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
  targets: VerificationTarget[];
}

export async function plan(options: PlanKernelOptions): Promise<PlanKernelResult> {
  const { modelId, mediaType } = options;
  const flowType = options.flowType === 'direct' ? 'direct' : 'diversion';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');

  const expectedPoints = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

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
        apiKey: 'sk-org-key',
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

  const mainVerdict =
    mediaType === 'video'
      ? RoutingOracle.evaluateVideoMainSite(
          {
            videoType,
            modelId,
            resolution,
            aspectRatio: options.aspectRatio ?? '16:9',
            userGroupIds: options.userGroupIds ?? [10],
          },
          baseConfig
        )
      : RoutingOracle.evaluateImageMainSite(
          {
            selmodelsId: modelId,
            serviceline: 'r',
            userGroupIds: options.userGroupIds ?? [10],
          },
          baseConfig
        );

  const targetModel =
    baseConfig.modelAliases?.[modelId] ||
    (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
  const targetGroup = mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test';

  const channels: GatewayChannelConfig[] =
    options.channels ||
    (mainVerdict.willDivert
      ? [
          {
            id: 1,
            name: `${targetModel}主渠道`,
            group: targetGroup,
            models: [targetModel],
            status: 1,
            weight: 100,
            dailyQuotaLimit: 0,
            usedQuota: 0,
          },
        ]
      : []);

  const gwVerdict = RoutingOracle.evaluateGatewayRouting(
    targetGroup,
    targetModel,
    expectedPoints,
    channels
  );

  const targets = deriveVerificationTargets(modelId, mediaType, options.requirement);

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
    gatewayRouting: gwVerdict,
    candidateChannels: gwVerdict.allowedChannels,
    reason: mainVerdict.reason,
    targets,
  };
}

// ============================================================================
// 3. execute (任务执行)
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
  const points = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
  });

  if (mode === 'real') {
    if (!options.sessionFile) {
      return {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId,
        mediaType,
        status: 'ERROR',
        points,
        message: '真实执行必须提供有效的 sessionFile 会话凭据文件',
      };
    }

    try {
      const session = await loadPanquSession(options.sessionFile, options.env || 'test');
      const res = await submitMediaTask({
        baseUrl: session.base_url,
        cookies: session.cookie_string,
        csrfToken: session.csrf_token,
        projectId: session.project_id,
        mediaType,
        modelId,
        prompt: options.prompt,
        resolution,
        aspectRatio: options.aspectRatio,
        duration,
        serviceline: options.serviceline,
      });

      return {
        ok: res.ok,
        taskId: res.taskId,
        mode: 'real',
        modelId,
        mediaType,
        status: res.ok ? 'SUBMITTED' : 'FAILED',
        points,
        message: res.ok
          ? `真实${mediaType === 'video' ? '视频' : '图片'}任务提交成功 (taskId: #${res.taskId})`
          : res.message,
        credentialsMasked: session.cookie_string.replace(/=[^;]+/g, '=***'),
        rawResponse: res.rawResponse,
      };
    } catch (err) {
      return {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId,
        mediaType,
        status: 'ERROR',
        points,
        message: `提交异常: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 受控仿真 (Mock) 派发
  const simulatedTaskId = 29000 + Math.floor(Math.random() * 1000);
  return {
    ok: true,
    taskId: simulatedTaskId,
    mode: 'mock',
    modelId,
    mediaType,
    status: 'SUBMITTED',
    points,
    message: `[MOCK 离线仿真] 仅生成模拟 ID，未发送主站请求 (模拟任务 ID #${simulatedTaskId}，预扣 ${points} 积分)`,
    credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
  };
}

// ============================================================================
// 4. verify (物理验真、对账与需求覆盖裁决)
// ============================================================================

async function fetchFirst64K(
  url: string,
  timeoutMs = 8000
): Promise<{ buffer: Buffer; durationMs: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        Range: 'bytes=0-65535',
        'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
      },
      signal: ctrl.signal,
    });
    if (!res.ok && res.status !== 206) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 65536);
    return { buffer: buf, durationMs: Date.now() - start };
  } catch {
    return null;
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
  coverageReport?: RequirementCoverageReport;
  reasons: string[];
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const { taskId, modelId, mediaType } = options;
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints =
    options.expectedPoints ??
    BillingOracle.calculateExpectedPoints({ mediaType, modelId, duration, resolution });

  let session: PanquSession | null = null;
  if (options.sessionFile) {
    try {
      session = await loadPanquSession(options.sessionFile, options.env || 'test');
    } catch (err) {
      const errRes: VerifyKernelResult = {
        ok: false,
        passed: false,
        taskId,
        modelId,
        mediaType,
        status: 'ERROR',
        mode: 'real',
        billingAudit: 'SKIPPED_NO_LOGS',
        reasons: [`加载凭据失败: ${err instanceof Error ? err.message : String(err)}`],
      };
      errRes.coverageReport = evaluateRequirementCoverage(
        deriveVerificationTargets(modelId, mediaType),
        errRes
      );
      return errRes;
    }
  } else if (options.cookies && options.baseUrl) {
    session = {
      env: options.env || 'test',
      base_url: options.baseUrl,
      cookie_string: options.cookies,
    };
  }

  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' = options.terminalStatus || 'SUCCESS';
  let probeDurationMs: number | undefined;

  // 1. 如果存在有效会话，真实轮询任务终态
  if (session) {
    const { finalSnapshot } = await pollTaskStatus(taskId, {
      baseUrl: session.base_url,
      cookies: session.cookie_string,
      mediaType,
      pollTimeoutSec: options.pollTimeoutSec ?? 10,
    });

    // 仍在处理中
    if (finalSnapshot.taskStatus === 1) {
      const procRes: VerifyKernelResult = {
        ok: true,
        passed: false,
        taskId,
        modelId,
        mediaType,
        status: 'PROCESSING',
        progress: finalSnapshot.progress,
        mode: 'real',
        billingAudit: 'SKIPPED_NO_LOGS',
        reasons: [
          `任务 #${taskId} 仍在排队/生成中 (进度: ${finalSnapshot.progress}%)，未到达终态`,
        ],
      };
      procRes.coverageReport = evaluateRequirementCoverage(
        deriveVerificationTargets(modelId, mediaType),
        procRes
      );
      return procRes;
    }

    // 任务失败终态
    if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
      terminalStatus = 'FAILED';
      const bRes = options.scoreLogs?.length
        ? BillingOracle.reconcileTaskLedger({
            taskId,
            terminalStatus: 'FAILED',
            expectedPoints,
            scoreLogs: options.scoreLogs,
          })
        : undefined;

      const failRes: VerifyKernelResult = {
        ok: true,
        passed: false,
        taskId,
        modelId,
        mediaType,
        status: 'FAILED',
        mode: 'real',
        billing: bRes,
        billingAudit: bRes ? 'AUDITED' : 'SKIPPED_NO_LOGS',
        invariants: bRes
          ? {
              antiDoubleBilling: bRes.antiDoubleBilling ?? true,
              netChargeZero: bRes.netChargeZero ?? true,
              refundIdempotency: bRes.refundIdempotency ?? true,
            }
          : undefined,
        reasons: [
          `任务执行失败: ${finalSnapshot.error || '未知服务端错误'}`,
          ...(bRes && !bRes.passed ? bRes.reasons : []),
        ],
      };
      failRes.coverageReport = evaluateRequirementCoverage(
        deriveVerificationTargets(modelId, mediaType),
        failRes
      );
      return failRes;
    }

    // 成功终态，尝试获取产物下载 URL
    const mediaUrl =
      finalSnapshot.videoUrl || finalSnapshot.imageUrl || options.videoUrl || options.imageUrl;
    if (mediaUrl && !artifactBuffer) {
      const probeRes = await fetchFirst64K(mediaUrl);
      if (probeRes) {
        artifactBuffer = probeRes.buffer;
        probeDurationMs = probeRes.durationMs;
      }
    }
  } else if ((options.videoUrl || options.imageUrl) && !artifactBuffer) {
    const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
    if (probeRes) {
      artifactBuffer = probeRes.buffer;
      probeDurationMs = probeRes.durationMs;
    }
  }

  // 2. 缺失真实媒体产物与账单流水时的如实提示 (UNVERIFIED)
  if (!artifactBuffer && !options.scoreLogs?.length) {
    const unverifiedRes: VerifyKernelResult = {
      ok: true,
      passed: false,
      taskId,
      modelId,
      mediaType,
      status: 'UNVERIFIED',
      mode: session ? 'real' : 'mock',
      billingAudit: 'SKIPPED_NO_LOGS',
      reasons: [
        '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]',
        '未提供账单流水，跳过账务对账 [SKIPPED_NO_LOGS]',
      ],
    };
    unverifiedRes.coverageReport = evaluateRequirementCoverage(
      deriveVerificationTargets(modelId, mediaType),
      unverifiedRes
    );
    return unverifiedRes;
  }

  // 3. 产物物理结构解析与验真 (MP4 / PNG)
  const artifact = artifactBuffer
    ? mediaType === 'video'
      ? inspectMp4Buffer(artifactBuffer)
      : inspectImageBuffer(artifactBuffer)
    : undefined;

  // 4. 账务流水对账与三大不变量核销
  const billing = options.scoreLogs?.length
    ? BillingOracle.reconcileTaskLedger({
        taskId,
        terminalStatus,
        expectedPoints,
        scoreLogs: options.scoreLogs,
      })
    : undefined;

  const invariants = billing
    ? {
        antiDoubleBilling: billing.antiDoubleBilling ?? true,
        netChargeZero: billing.netChargeZero ?? true,
        refundIdempotency: billing.refundIdempotency ?? true,
      }
    : undefined;

  const reasons: string[] = [];

  if (artifact && !artifact.decodable) {
    reasons.push(`产物物理完整性校验失败: ${artifact.reasons.join(', ')}`);
  }
  if (!artifact) {
    reasons.push(
      '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]'
    );
  }

  if (billing && !billing.passed) {
    reasons.push(`账单审计失败: ${billing.reasons.join(', ')}`);
  }
  if (!billing) {
    reasons.push('未提供账单流水，跳过账务对账 [SKIPPED_NO_LOGS]');
  }

  if (invariants && !invariants.antiDoubleBilling) {
    reasons.push('违背防重复扣费不变量: 存在多笔扣费');
  }
  if (invariants && !invariants.netChargeZero) {
    reasons.push('违背失败净扣归零不变量: 失败任务净扣不为 0');
  }
  if (invariants && !invariants.refundIdempotency) {
    reasons.push('违背退款幂等核销不变量: 存在重复退款');
  }

  const passed = Boolean(
    artifact &&
      artifact.decodable &&
      billing &&
      billing.passed &&
      invariants &&
      invariants.antiDoubleBilling &&
      invariants.netChargeZero &&
      invariants.refundIdempotency
  );

  const baseResult: VerifyKernelResult = {
    ok: true,
    passed,
    taskId,
    modelId,
    mediaType,
    status: passed ? 'SUCCESS' : 'FAILED',
    mode: session ? 'real' : 'mock',
    probeDurationMs,
    artifact,
    billing,
    billingAudit: billing ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    invariants,
    reasons,
  };

  // 需求与验证目标全链路覆盖率确定性归因
  baseResult.coverageReport = evaluateRequirementCoverage(
    deriveVerificationTargets(modelId, mediaType),
    baseResult
  );

  return baseResult;
}
