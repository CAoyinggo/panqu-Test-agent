import { existsSync } from 'node:fs';
import { EnvironmentProbe, type EnvProbeReport } from './env-probe.js';
import { RoutingOracle, type MainSiteConfigSnapshot, type GatewayRoutingVerdict, type GatewayChannelConfig } from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import { submitMediaTask, pollTaskStatus, loadPanquSession, queryTaskBillingLogs, type PanquSession } from './media-flow.js';

export interface ProbeKernelOptions {
  env?: string; baseUrl?: string; gatewayUrl?: string; sessionFile?: string; mock?: boolean; timeoutMs?: number;
}
export interface ProbeKernelResult {
  ok: boolean; status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED'; env: string; baseUrl: string; gatewayUrl: string;
  probedAt: string; auth: { status: 'VALID' | 'EXPIRED' | 'MISSING'; details: string; hasSession: boolean };
  endpoints: Array<{ name: string; url: string; reachable: boolean; statusCode?: number; latencyMs?: number; message: string }>;
  candidateChannelCount: number; recommendations: string[];
}

export async function probe(options: ProbeKernelOptions = {}): Promise<ProbeKernelResult> {
  const env = options.env || 'test';
  try {
    const r: EnvProbeReport = await EnvironmentProbe.probe({
      env: env as 'test' | 'preonline', baseUrl: options.baseUrl, gatewayUrl: options.gatewayUrl,
      sessionFile: options.sessionFile, mock: options.mock ?? false, timeoutMs: options.timeoutMs ?? 5000,
    });
    return {
      ok: r.ok, status: r.status, env: r.env, baseUrl: r.baseUrl, gatewayUrl: r.gatewayUrl,
      probedAt: r.probedAt, auth: r.auth, endpoints: r.endpoints,
      candidateChannelCount: r.modelReadiness?.candidateChannelCount ?? 2, recommendations: r.recommendations,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false, status: 'BLOCKED', env, baseUrl: options.baseUrl || 'https://unknown',
      gatewayUrl: options.gatewayUrl || 'https://unknown', probedAt: new Date().toISOString(),
      auth: { status: 'MISSING', details: msg, hasSession: false }, endpoints: [], candidateChannelCount: 0,
      recommendations: [`探活异常: ${msg}`],
    };
  }
}

export interface PlanKernelOptions {
  modelId: number; mediaType: 'video' | 'image'; flowType?: string; requirement?: string;
  resolution?: string; duration?: number; aspectRatio?: string; userGroupIds?: number[];
  mainConfig?: Partial<MainSiteConfigSnapshot>; channels?: GatewayChannelConfig[];
}
export interface PlanKernelResult {
  ok: boolean; modelId: number; mediaType: 'video' | 'image'; flowType: 'direct' | 'diversion';
  decision: string; willDivert: boolean; routeLine: number; expectedPoints: number;
  expectedSnapshot?: { orgId: number; routeGroupId: number; newapiGroup: string; newapiModel: string };
  gatewayRouting: GatewayRoutingVerdict; candidateChannels: string[]; reason: string;
}

export async function plan(options: PlanKernelOptions): Promise<PlanKernelResult> {
  const { modelId, mediaType } = options;
  const flowType = options.flowType === 'direct' ? 'direct' : 'diversion';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints = BillingOracle.calculateExpectedPoints({ mediaType, modelId, duration, resolution });
  const isSeedance = [15, 16, 58, 78].includes(modelId);
  const videoType = isSeedance ? 6 : 105;
  const baseConfig: MainSiteConfigSnapshot = {
    routeMode: flowType === 'direct' ? 'off' : 'newapi',
    globalModelIds: flowType === 'direct' ? [] : [84, 88],
    globalApiKey: 'sk-panqu-devtest-key',
    globalRouteRules: {
      video: {
        84: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        88: { resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
      },
    },
    groupRouteRules: {},
    orgBindings: { 10: { routeGroupId: 1, newapiGroup: 'panqu_test', status: 1, apiKey: 'sk-org-key' } },
    modelAliases: { 84: 'wan3.0-video', 88: 'wan3.0-video', 201: 'runninghub-nano-banana-2', 205: 'gpt-image-2.5' },
    ...options.mainConfig,
  };
  const mainVerdict = mediaType === 'video'
    ? RoutingOracle.evaluateVideoMainSite({ videoType, modelId, resolution, aspectRatio: options.aspectRatio ?? '16:9', userGroupIds: options.userGroupIds ?? [10] }, baseConfig)
    : RoutingOracle.evaluateImageMainSite({ selmodelsId: modelId, serviceline: 'r', userGroupIds: options.userGroupIds ?? [10] }, baseConfig);
  const targetModel = baseConfig.modelAliases?.[modelId] || (mediaType === 'video' ? 'wan3.0-video' : 'runninghub-nano-banana-2');
  const targetGroup = mainVerdict.expectedSnapshot?.newapiGroup || 'panqu_test';
  const channels: GatewayChannelConfig[] = options.channels || (mainVerdict.willDivert ? [{ id: 1, name: `${targetModel}主渠道`, group: targetGroup, models: [targetModel], status: 1, weight: 100, dailyQuotaLimit: 0, usedQuota: 0 }] : []);
  const gwVerdict = RoutingOracle.evaluateGatewayRouting(targetGroup, targetModel, expectedPoints, channels);
  return {
    ok: true, modelId, mediaType, flowType, decision: mainVerdict.decision, willDivert: mainVerdict.willDivert,
    routeLine: mainVerdict.line, expectedPoints, expectedSnapshot: mainVerdict.expectedSnapshot,
    gatewayRouting: gwVerdict, candidateChannels: gwVerdict.allowedChannels, reason: mainVerdict.reason,
  };
}

export interface ExecuteKernelOptions {
  modelId: number; mediaType: 'video' | 'image'; resolution?: string; duration?: number;
  aspectRatio?: string; mode?: 'mock' | 'real'; prompt?: string; sessionFile?: string;
  env?: 'test' | 'preonline'; serviceline?: string;
}
export interface ExecuteKernelResult {
  ok: boolean; taskId: number; simulationId?: string; isSimulated?: boolean; mode: 'mock' | 'real'; modelId: number; mediaType: 'video' | 'image';
  status: 'SUBMITTED' | 'SUCCESS' | 'FAILED' | 'ERROR'; points: number; message: string;
  credentialsMasked?: string; rawResponse?: Record<string, unknown>;
}

export async function execute(options: ExecuteKernelOptions): Promise<ExecuteKernelResult> {
  const { modelId, mediaType } = options;
  const mode = options.mode === 'real' ? 'real' : 'mock';
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');
  const points = BillingOracle.calculateExpectedPoints({ mediaType, modelId, duration, resolution });
  if (mode === 'real') {
    if (!options.sessionFile) {
      return { ok: false, taskId: 0, mode: 'real', modelId, mediaType, status: 'ERROR', points, message: '真实执行必须提供有效的 sessionFile 会话凭据文件' };
    }
    try {
      const session = await loadPanquSession(options.sessionFile, options.env || 'test');
      const res = await submitMediaTask({
        baseUrl: session.base_url, cookies: session.cookie_string, csrfToken: session.csrf_token,
        projectId: session.project_id, mediaType, modelId, prompt: options.prompt, resolution,
        aspectRatio: options.aspectRatio, duration, serviceline: options.serviceline,
      });
      return {
        ok: res.ok, taskId: res.taskId, mode: 'real', modelId, mediaType, status: res.ok ? 'SUBMITTED' : 'FAILED',
        points, message: res.ok ? `真实${mediaType === 'video' ? '视频' : '图片'}任务提交成功 (taskId: #${res.taskId})` : res.message,
        credentialsMasked: session.cookie_string.replace(/=[^;]+/g, '=***'), rawResponse: res.rawResponse,
      };
    } catch (err) {
      return { ok: false, taskId: 0, mode: 'real', modelId, mediaType, status: 'ERROR', points, message: `提交异常: ${err instanceof Error ? err.message : String(err)}`, };
    }
  }
  const simulatedTaskId = 29000 + Math.floor(Math.random() * 1000);
  const simulationId = `sim-offline-${Date.now().toString(36)}-${simulatedTaskId}`;
  return {
    ok: true, taskId: simulatedTaskId, simulationId, isSimulated: true, mode: 'mock', modelId, mediaType, status: 'SUBMITTED', points,
    message: `[OFFLINE 离线仿真] 仅生成离线模拟 ID (${simulationId})，未向主站发起真实请求 (模拟任务 ID #${simulatedTaskId}，预扣 ${points} 积分)`,
    credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
  };
}

async function fetchFirst64K(url: string, timeoutMs = 8000): Promise<{ buffer: Buffer; durationMs: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-65535', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' }, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, 65536);
    return { buffer: buf, durationMs: Date.now() - start };
  } catch { return null; } finally { clearTimeout(timer); }
}

export type EvidenceStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface InvariantDetail {
  status: EvidenceStatus;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface TaskEvidence {
  status: 'PASS' | 'FAIL' | 'PROCESSING' | 'UNVERIFIED';
  source: string;
  terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  taskStatus?: number;
  progress?: number;
  error?: string;
  videoUrl?: string;
  imageUrl?: string;
  isSimulated?: boolean;
}

export interface MediaEvidence {
  status: EvidenceStatus;
  source: string;
  ownership: 'VERIFIED' | 'UNVERIFIED';
  format?: string;
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  hasMdat?: boolean;
  decodable?: boolean;
  reason?: string;
}

export interface BillingEvidence {
  status: EvidenceStatus;
  source: string;
  expectedPoints?: number;
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  preDeductedPoints?: number;
  settledPoints?: number;
  refundedPoints?: number;
  netDeductedPoints?: number;
  reason?: string;
}

export interface InvariantsEvidence {
  status: EvidenceStatus;
  antiDoubleBilling?: boolean;
  netChargeZero?: boolean;
  refundIdempotency?: boolean;
  details?: {
    antiDoubleBilling: InvariantDetail;
    netChargeZero: InvariantDetail;
    refundIdempotency: InvariantDetail;
  };
  reason?: string;
}

export interface VerificationEvidence {
  task: TaskEvidence;
  media: MediaEvidence;
  billing: BillingEvidence;
  invariants: InvariantsEvidence;
}

export interface VerifyKernelOptions {
  taskId: number; modelId?: number; mediaType?: 'video' | 'image'; scoreLogs?: ScoreLogEntry[];
  expectedPoints?: number; assetBuffer?: Buffer; artifactBuffer?: Buffer; terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  resolution?: string; duration?: number; sessionFile?: string; env?: 'test' | 'preonline';
  baseUrl?: string; cookies?: string; videoUrl?: string; imageUrl?: string; pollTimeoutSec?: number;
  artifactOwnership?: 'VERIFIED' | 'UNVERIFIED' | 'UNBOUND';
  isSimulated?: boolean;
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
}
export interface VerifyKernelResult {
  ok: boolean; passed: boolean; taskId: number; modelId: number; mediaType: 'video' | 'image';
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNVERIFIED' | 'ERROR';
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'PROCESSING';
  mode: 'real' | 'mock';
  executionMode: 'real' | 'offline' | 'fixture';
  progress?: number; probeDurationMs?: number; artifact?: MediaInspectionResult; billing?: BillingAuditReport;
  billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS';
  invariants?: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean };
  evidence: VerificationEvidence;
  reasons: string[];
}

export async function verify(options: VerifyKernelOptions): Promise<VerifyKernelResult> {
  const { taskId } = options;
  const mediaType = options.mediaType || 'video';
  const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
  const duration = options.duration ?? (mediaType === 'video' ? 4 : undefined);
  const resolution = options.resolution ?? (mediaType === 'video' ? '720p' : '1k');
  const expectedPoints = options.expectedPoints ?? BillingOracle.calculateExpectedPoints({ mediaType, modelId, duration, resolution });
  const expectedChargeSource: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION' = options.expectedChargeSource ?? 'DEVTEST_EXPECTATION';

  let session: PanquSession | null = null;
  const autoSession = options.sessionFile || process.env.PANQU_SESSION_COOKIES_FILE || (existsSync('session.json') ? 'session.json' : existsSync('.panqu/session.json') ? '.panqu/session.json' : undefined);
  if (options.sessionFile) {
    try { session = await loadPanquSession(options.sessionFile, options.env || 'test'); }
    catch (err) {
      const msg = `加载凭据失败: ${err instanceof Error ? err.message : String(err)}`;
      return {
        ok: false, passed: false, taskId, modelId, mediaType, status: 'ERROR', verdict: 'FAIL', mode: 'real', executionMode: 'real', billingAudit: 'SKIPPED_NO_LOGS',
        evidence: {
          task: { status: 'FAIL', source: 'session_error', error: msg },
          media: { status: 'UNVERIFIED', source: 'missing_session', ownership: 'UNVERIFIED', reason: msg },
          billing: { status: 'UNVERIFIED', source: 'missing_session', expectedPoints, expectedChargeSource, reason: msg },
          invariants: { status: 'UNVERIFIED', reason: msg },
        },
        reasons: [msg],
      };
    }
  } else if (autoSession) {
    try { session = await loadPanquSession(autoSession, options.env || 'test'); } catch { /* ignore auto session */ }
  } else if (options.cookies && options.baseUrl) {
    session = { env: options.env || 'test', base_url: options.baseUrl, cookie_string: options.cookies };
  }

  const executionMode: 'real' | 'offline' | 'fixture' = options.isSimulated
    ? 'offline'
    : session
    ? 'real'
    : ((options.scoreLogs && options.scoreLogs.length > 0) || Boolean(options.assetBuffer || options.artifactBuffer))
    ? 'fixture'
    : 'offline';

  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let probeDurationMs: number | undefined;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';
  let taskEvidence: TaskEvidence;
  let mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_buffer';
  let artifactOwnership: 'VERIFIED' | 'UNVERIFIED' = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'UNVERIFIED' : 'VERIFIED';

  if (session) {
    const { finalSnapshot } = await pollTaskStatus(taskId, { baseUrl: session.base_url, cookies: session.cookie_string, mediaType, pollTimeoutSec: options.pollTimeoutSec ?? 10 });
    if (finalSnapshot.taskStatus === 1) {
      return {
        ok: true, passed: false, taskId, modelId, mediaType, status: 'PROCESSING', verdict: 'PROCESSING', progress: finalSnapshot.progress, mode: 'real', executionMode: 'real', billingAudit: 'SKIPPED_NO_LOGS',
        evidence: {
          task: { status: 'PROCESSING', source: 'live_polling', terminalStatus: 'UNKNOWN', taskStatus: 1, progress: finalSnapshot.progress },
          media: { status: 'UNVERIFIED', source: 'in_flight', ownership: 'UNVERIFIED', reason: '任务生成中，尚无产物' },
          billing: { status: 'UNVERIFIED', source: 'in_flight', expectedPoints, expectedChargeSource, reason: '任务生成中，终态账单未对账' },
          invariants: { status: 'UNVERIFIED', reason: '任务未到达终态' },
        },
        reasons: [`任务 #${taskId} 仍在排队/生成中 (进度: ${finalSnapshot.progress}%)，未到达终态`],
      };
    }
    if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
      terminalStatus = 'FAILED';
      taskEvidence = { status: 'FAIL', source: 'live_polling', terminalStatus: 'FAILED', taskStatus: finalSnapshot.taskStatus, error: finalSnapshot.error || '未知服务端错误', progress: finalSnapshot.progress };
    } else if (finalSnapshot.taskStatus === 2) {
      terminalStatus = 'SUCCESS';
      taskEvidence = { status: 'PASS', source: 'live_polling', terminalStatus: 'SUCCESS', taskStatus: 2, progress: finalSnapshot.progress, videoUrl: finalSnapshot.videoUrl, imageUrl: finalSnapshot.imageUrl };
      const mediaUrl = finalSnapshot.videoUrl || finalSnapshot.imageUrl;
      if (mediaUrl) {
        mediaArtifactSource = 'TASK_SNAPSHOT';
        artifactOwnership = 'VERIFIED';
        if (!artifactBuffer) {
          const probeRes = await fetchFirst64K(mediaUrl);
          if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
        }
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = { status: 'UNVERIFIED', source: 'task_not_found', terminalStatus: 'UNKNOWN', taskStatus: 0, error: `未能从主站获取到任务 #${taskId} 状态 (任务不存在或超时) [UNVERIFIED]`, progress: 0 };
      if ((options.videoUrl || options.imageUrl) && !artifactBuffer) {
        mediaArtifactSource = 'EXTERNAL_URL';
        artifactOwnership = options.artifactOwnership === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
        const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
        if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
      }
    }
  } else {
    if (options.terminalStatus) {
      terminalStatus = options.terminalStatus;
      taskEvidence = { status: terminalStatus === 'FAILED' ? 'FAIL' : terminalStatus === 'SUCCESS' ? 'PASS' : 'UNVERIFIED', source: 'provided', terminalStatus };
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = { status: 'UNVERIFIED', source: 'unqueried', terminalStatus: 'UNKNOWN', error: `未连接真实主站查询且未显式传入终态，任务 #${taskId} 终态未知 [UNVERIFIED]` };
    }

    if (options.videoUrl || options.imageUrl) {
      taskEvidence.videoUrl = options.videoUrl;
      taskEvidence.imageUrl = options.imageUrl;
      mediaArtifactSource = 'EXTERNAL_URL';
      if (options.artifactOwnership !== 'VERIFIED') {
        artifactOwnership = 'UNVERIFIED';
      }
      if (!artifactBuffer) {
        const probeRes = await fetchFirst64K(options.videoUrl || options.imageUrl!);
        if (probeRes) { artifactBuffer = probeRes.buffer; probeDurationMs = probeRes.durationMs; }
      }
    } else if (artifactBuffer) {
      mediaArtifactSource = options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'EXTERNAL_BUFFER' : 'FIXTURE_BUFFER';
    }
  }

  const artifact = artifactBuffer ? (mediaType === 'video' ? inspectMp4Buffer(artifactBuffer) : inspectImageBuffer(artifactBuffer)) : undefined;
  let mediaEvidence: MediaEvidence;
  if (terminalStatus === 'FAILED' && !artifactBuffer) {
    mediaEvidence = { status: 'UNVERIFIED', source: 'task_failed', ownership: 'UNVERIFIED', reason: '任务执行失败，无媒体产物' };
  } else if (artifact) {
    if (artifactOwnership === 'UNVERIFIED') {
      mediaEvidence = {
        status: 'UNVERIFIED',
        source: mediaArtifactSource,
        ownership: 'UNVERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: artifact.decodable,
        reason: `媒体容器物理结构有效 (${(artifact.format || 'mp4').toUpperCase()} container structure PASS)，但缺少与 Task #${taskId} 的归属绑定证据 [UNVERIFIED]`,
      };
    } else if (artifact.decodable) {
      mediaEvidence = {
        status: 'PASS',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: artifact.decodable,
      };
    } else {
      mediaEvidence = {
        status: 'FAIL',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format, dimensions: artifact.dimensions, durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat, decodable: false,
        reason: artifact.reasons.join(', ') || '产物物理完整性校验失败',
      };
    }
  } else {
    mediaEvidence = {
      status: 'UNVERIFIED', source: 'missing_buffer', ownership: 'UNVERIFIED',
      reason: '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]',
    };
  }

  let scoreLogsToReconcile: ScoreLogEntry[] | undefined = options.scoreLogs;
  let billingSource = options.scoreLogs ? 'score_logs' : 'missing_logs';
  let billingQueryError: string | undefined;

  if (!scoreLogsToReconcile && session) {
    const queryRes = await queryTaskBillingLogs(taskId, session);
    if (queryRes.status === 'QUERY_SUCCESS') {
      scoreLogsToReconcile = queryRes.scoreLogs;
      billingSource = queryRes.source;
    } else {
      billingQueryError = queryRes.error || `账单查询异常 [${queryRes.status}]`;
      billingSource = queryRes.source;
    }
  }

  const hasScoreLogs = Array.isArray(scoreLogsToReconcile);
  const billing = hasScoreLogs ? BillingOracle.reconcileTaskLedger({ taskId, terminalStatus: terminalStatus as any, expectedPoints, expectedChargeSource, scoreLogs: scoreLogsToReconcile! }) : undefined;

  let billingEvidence: BillingEvidence;
  let invariantsEvidence: InvariantsEvidence;
  let invariants: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean } | undefined;

  if (billing) {
    const hasBillingViolations = Boolean(
      billing.duplicateCharged ||
      billing.duplicateRefunded ||
      billing.missingRefund ||
      billing.underCharged ||
      billing.overCharged ||
      billing.antiDoubleBilling === false ||
      billing.netChargeZero === false ||
      billing.refundIdempotency === false
    );
    const billingStatus: EvidenceStatus = hasBillingViolations ? 'FAIL' : billing.passed ? 'PASS' : 'UNVERIFIED';

    const isSuccessEmpty = scoreLogsToReconcile && scoreLogsToReconcile.length === 0;
    const reason = !billing.passed
      ? (isSuccessEmpty
          ? '真实数据源明确确认该任务在查询范围内无流水记录 [QUERY_SUCCESS + 0 records]'
          : billing.reasons.join(', '))
      : undefined;

    billingEvidence = {
      status: billingStatus,
      source: billingSource,
      expectedPoints,
      expectedChargeSource,
      preDeductedPoints: billing.preDeductedPoints,
      settledPoints: billing.settledPoints,
      refundedPoints: billing.refundedPoints,
      netDeductedPoints: billing.netDeductedPoints,
      reason,
    };

    const antiDouble = billing.antiDoubleBilling;
    const netZero = billing.netChargeZero;
    const refundIdem = billing.refundIdempotency;

    const antiDoubleItem: InvariantDetail = antiDouble === true
      ? { status: 'PASS', evidence: { preDeductCount: billing.preDeductCount } }
      : antiDouble === false
      ? { status: 'FAIL', reason: '违背防重复扣费不变量: 存在多笔扣费或重复扣款' }
      : { status: 'UNVERIFIED', reason: '缺少有效预扣流水，防重复扣费不变量未核验 [UNVERIFIED]' };

    const netZeroItem: InvariantDetail = netZero === true
      ? { status: 'PASS', evidence: { netDeductedPoints: billing.netDeductedPoints } }
      : netZero === false
      ? { status: 'FAIL', reason: terminalStatus === 'FAILED' ? '违背失败净扣归零不变量: 失败任务净扣不为 0 或少/超额退款' : '计费不匹配预期扣费' }
      : { status: 'UNVERIFIED', reason: '任务终态未知或缺少有效账务记录，失败净扣归零不变量未核验 [UNVERIFIED]' };

    const refundIdemItem: InvariantDetail = refundIdem === true
      ? { status: 'PASS', evidence: { refundCount: billing.refundCount } }
      : refundIdem === false
      ? { status: 'FAIL', reason: '违背退款幂等核销不变量: 存在重复退款、异常退款或失败未退款' }
      : { status: 'UNVERIFIED', reason: '缺少有效预扣或退款流水，退款幂等核销不变量未核验 [UNVERIFIED]' };

    const anyInvFailed = antiDoubleItem.status === 'FAIL' || netZeroItem.status === 'FAIL' || refundIdemItem.status === 'FAIL';
    const allInvPassed = antiDoubleItem.status === 'PASS' && netZeroItem.status === 'PASS' && refundIdemItem.status === 'PASS';
    const invStatus: EvidenceStatus = anyInvFailed ? 'FAIL' : allInvPassed ? 'PASS' : 'UNVERIFIED';

    invariantsEvidence = {
      status: invStatus,
      antiDoubleBilling: antiDouble,
      netChargeZero: netZero,
      refundIdempotency: refundIdem,
      details: {
        antiDoubleBilling: antiDoubleItem,
        netChargeZero: netZeroItem,
        refundIdempotency: refundIdemItem,
      },
      reason: anyInvFailed ? [antiDoubleItem.reason, netZeroItem.reason, refundIdemItem.reason].filter(Boolean).join('; ') : undefined,
    };

    invariants = billing ? {
      antiDoubleBilling: antiDouble === true,
      netChargeZero: netZero === true,
      refundIdempotency: refundIdem === true,
    } : undefined;
  } else {
    const skipReason = billingQueryError
      ? `账单流水查询异常 (${billingQueryError})，缺少真实账务证据 [UNVERIFIED]`
      : terminalStatus === 'FAILED'
      ? '未提供账单流水，无法核验失败退款净扣归零，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]'
      : '未提供账单流水，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]';
    billingEvidence = { status: 'UNVERIFIED', source: billingSource, expectedPoints, expectedChargeSource, reason: skipReason };
    invariantsEvidence = {
      status: 'UNVERIFIED',
      details: {
        antiDoubleBilling: { status: 'UNVERIFIED', reason: skipReason },
        netChargeZero: { status: 'UNVERIFIED', reason: skipReason },
        refundIdempotency: { status: 'UNVERIFIED', reason: skipReason },
      },
      reason: skipReason,
    };
  }

  const reasons: string[] = [];
  if (taskEvidence.status === 'FAIL') reasons.push(`任务执行失败: ${taskEvidence.error || '任务状态异常'}`);
  if (taskEvidence.status === 'UNVERIFIED') reasons.push(taskEvidence.error || '任务状态未确认 [UNVERIFIED]');
  if (mediaEvidence.status === 'FAIL') reasons.push(`产物物理完整性校验失败: ${mediaEvidence.reason || '文件损坏'}`);
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') reasons.push(mediaEvidence.reason!);
  if (billingEvidence.status === 'FAIL') reasons.push(`账单审计失败: ${billingEvidence.reason}`);
  if (billingEvidence.status === 'UNVERIFIED') reasons.push(billingEvidence.reason!);
  if (invariantsEvidence.status === 'FAIL') reasons.push(invariantsEvidence.reason!);

  const hasFailures = taskEvidence.status === 'FAIL' || mediaEvidence.status === 'FAIL' || billingEvidence.status === 'FAIL' || invariantsEvidence.status === 'FAIL';
  const allPassed = taskEvidence.status === 'PASS' && mediaEvidence.status === 'PASS' && billingEvidence.status === 'PASS' && invariantsEvidence.status === 'PASS';

  let verdictStatus: 'SUCCESS' | 'FAILED' | 'UNVERIFIED';
  let verdict: 'PASS' | 'FAIL' | 'UNVERIFIED';

  if (hasFailures) {
    verdictStatus = 'FAILED';
    verdict = 'FAIL';
  } else if (allPassed) {
    verdictStatus = 'SUCCESS';
    verdict = 'PASS';
  } else {
    verdictStatus = 'UNVERIFIED';
    verdict = 'UNVERIFIED';
  }

  return {
    ok: true, passed: verdictStatus === 'SUCCESS', taskId, modelId, mediaType, status: verdictStatus, verdict, mode: session ? 'real' : 'mock', executionMode,
    probeDurationMs, artifact, billing, billingAudit: (billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ? 'AUDITED' : 'SKIPPED_NO_LOGS', invariants,
    evidence: { task: taskEvidence, media: mediaEvidence, billing: billingEvidence, invariants: invariantsEvidence },
    reasons,
  };
}
