/**
 * Panqu AI DevTest — verify 证据流水线 (Phase 4 物理分解)
 *
 * 本模块依据 docs/ARCHITECTURE_FREEZE.md §2.2「Phase 4 core-kernel 物理分解授权」
 * (2026-09-23 人工明确授权) 从 core-kernel.ts 原样抽出,承载 verify 动作的证据采集与
 * 裁决投影流水线:resolveVerifyContext / collectTaskEvidence / collectMediaEvidence /
 * collectBillingEvidence / computeRegressionDiff / buildDiffItems / computeFinalVerdict。
 * 行为与原实现完全等价,未新增任何裁决语义或中间层。
 *
 * 依赖方向:core-kernel → verify-pipeline → 下层能力模块。严禁反向 import core-kernel。
 * 单一裁决权威仍为 canonical-verdict-engine;本模块只做证据搬运与投影。
 */
import { existsSync } from 'node:fs';
import { discoverModelContract } from './env-probe.js';
import {
  RoutingOracle,
  validateTrustedGatewaySnapshot,
  type GatewayChannelConfig,
  type TrustedGatewaySnapshot,
} from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import { inspectMp4Buffer, inspectImageBuffer, type MediaInspectionResult } from './media-inspector.js';
import {
  pollTaskStatus,
  loadPanquSession,
  queryTaskBillingLogs,
  queryTaskRuntimeDetails,
  type PanquSession,
  type TaskStatusSnapshot,
  type TaskRuntimeDetails,
} from './media-flow.js';
import type {
  DiscoveredModelContract,
  ExpectedVsActual,
  DiffItem,
  DiversionBaseline,
  DiversionRegressionDiff,
  AcceptanceResult,
  EvidenceCompleteness,
  ProductionAcceptanceReport,
  MemoryCandidatePayload,
  TargetKind,
} from './types.js';
import {
  evaluateBusinessVerification,
  formatMemoryCandidate,
  type BusinessVerificationResult,
} from './domain-knowledge.js';
import type {
  CanonicalTestSpec,
  CanonicalEvidenceEnvelope,
  ExecutionMode,
  DeterministicAssertion,
} from './canonical-protocol.js';
import { evaluateCanonicalVerdict, type CanonicalVerdictResult } from './canonical-verdict-engine.js';
import {
  buildCanonicalEvidenceFromVerifyFacts,
  projectCanonicalVerdictToLegacy,
  type CanonicalVerifyFacts,
  type LegacyLifecycleContext,
} from './legacy-protocol-mappers.js';
import type { EvidenceProducer, EvidenceProducerContext } from './execution-ports.js';
import { mapVerdictToExportRecord, type ResultSink } from './result-sink.js';
import { resolveRequirementTraceForSpec, type RequirementTrace } from './requirement-trace.js';
import {
  DatabaseEvidenceProducer,
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  type DatabaseRawCollection,
} from './database-evidence-producer.js';
import {
  loadDiversionPricing,
  resolveListPrice,
  type PricingScope,
} from './diversion-pricing-authority.js';
import {
  DiversionEligibilityProducer,
  type DiversionEligibilityInput,
} from './diversion-eligibility-producer.js';
import {
  readDiversionConfig,
  toEligibilityRules,
  type DiversionConfigRawCollection,
} from './diversion-config-reader.js';
import { classifyDbForensics, type DbForensicsCategory } from './db-preflight.js';
export {
  DatabaseEvidenceProducer,
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  type DatabaseRawCollection,
};

async function fetchFirst64K(
  url: string,
  timeoutMs = 8000,
): Promise<{ buffer: Buffer; tailBuffer?: Buffer; durationMs: number } | null> {
  const start = Date.now();
  let headBuf: Buffer;
  let tailBuf: Buffer | undefined;
  let totalSize = 0;
  let isFullDownload = false;

  // 阶段一：头部切片探测 (独立超时控制)
  const headCtrl = new AbortController();
  const headTimer = setTimeout(() => headCtrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-65535', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
      signal: headCtrl.signal,
    });
    if (!res.ok && res.status !== 206) return null;
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    if (res.status === 200) {
      isFullDownload = true;
      if (buf.length > 65536) {
        headBuf = buf.subarray(0, 65536);
        tailBuf = buf.subarray(Math.max(0, buf.length - 65536));
      } else {
        headBuf = buf;
      }
    } else {
      headBuf = buf.subarray(0, 65536);
      if (res.headers && typeof res.headers.get === 'function') {
        const contentRange = res.headers.get('content-range');
        const match = contentRange ? /\/(\d+)$/.exec(contentRange) : null;
        totalSize = match ? parseInt(match[1], 10) : 0;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(headTimer);
  }

  if (isFullDownload) {
    return { buffer: headBuf, tailBuffer: tailBuf, durationMs: Date.now() - start };
  }

  const quickInspection = inspectMp4Buffer(headBuf);
  if (quickInspection.decodable) {
    return { buffer: headBuf, durationMs: Date.now() - start };
  }

  // 阶段二：尾部切片探测 (独立超时控制，分配独立保护预算)
  if (totalSize > headBuf.length) {
    const tailSize = Math.min(65536, totalSize);
    const tailStart = Math.max(0, totalSize - tailSize);
    const tailTimeoutMs = Math.max(4000, timeoutMs);
    const tailCtrl = new AbortController();
    const tailTimer = setTimeout(() => tailCtrl.abort(), tailTimeoutMs);
    try {
      const tailRes = await fetch(url, {
        headers: { Range: `bytes=${tailStart}-${totalSize - 1}`, 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
        signal: tailCtrl.signal,
      });
      if (tailRes.ok || tailRes.status === 206) {
        tailBuf = Buffer.from(await tailRes.arrayBuffer());
      }
    } catch {
      // 保留 headBuf 继续走既有 fail-closed 校验
    } finally {
      clearTimeout(tailTimer);
    }
  }

  return { buffer: headBuf, tailBuffer: tailBuf, durationMs: Date.now() - start };
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
  business?: BusinessVerificationResult;
}

export interface VerifyKernelOptions {
  taskId: number;
  modelId?: number;
  mediaType?: 'video' | 'image';
  scoreLogs?: ScoreLogEntry[];
  expectedPoints?: number;
  assetBuffer?: Buffer;
  artifactBuffer?: Buffer;
  tailBuffer?: Buffer;
  terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  resolution?: string;
  duration?: number;
  sessionFile?: string;
  env?: 'test' | 'preonline';
  baseUrl?: string;
  cookies?: string;
  videoUrl?: string;
  imageUrl?: string;
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  onProgress?: (snapshot: TaskStatusSnapshot) => void;
  artifactOwnership?: 'VERIFIED' | 'UNVERIFIED' | 'UNBOUND';
  isSimulated?: boolean;
  mode?: 'real' | 'mock' | 'fixture' | 'offline';
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  contract?: DiscoveredModelContract;
  expectedResolution?: string;
  expectedDuration?: number;
  expectedWillDivert?: boolean;
  baseline?: DiversionBaseline;
  dbExtraConfirmed?: boolean;
  dbExtra?: Record<string, unknown>;
  gatewayChannelConfirmed?: boolean;
  channels?: GatewayChannelConfig[];
  gatewaySnapshot?: TrustedGatewaySnapshot;
  unconfirmedStatic?: boolean;
  customPoints?: number;
  pointsPerSecond?: number;
  price?: number;
  apiResult?: { ok: boolean; code?: number; message?: string };
  projectId?: number;
  folderId?: number;
  isFolderInProject?: boolean;
  alias?: string;
  channelId?: number;
  channelName?: string;
  targetKind?: TargetKind;
  actualChannelId?: number;
  actualChannelName?: string;
  fallbackChannel?: string;
  retryProvider?: string;
  extra?: Record<string, unknown>;
  session?: PanquSession;
  taskDetail?: Record<string, unknown>;
  retryLog?: Record<string, unknown>;
  exceptionalTask?: Record<string, unknown>;
  changeType?: 'new_model' | 'diversion_change';
  spec?: CanonicalTestSpec;
  requirement?: string;
  requirementId?: string;
  requirementText?: string;
  changedPaths?: readonly string[];
  traces?: readonly RequirementTrace[];
  resultSink?: ResultSink;
  evidenceProducers?: EvidenceProducer[];
  uiRawCollection?: unknown;
  uiVisualRawCollection?: unknown;
  progress?: number;
  capturedAt?: string;
  testId?: string;
  environment?: string;
  executionMode?: 'real' | 'offline' | 'fixture' | 'REAL' | 'OFFLINE' | 'FIXTURE';
  extraEnvelopes?: CanonicalEvidenceEnvelope[];
  isProcessing?: boolean;
  dbVerify?: boolean;
  dbCredPath?: string;
  dbTimeoutMs?: number;
  dbRawCollection?: DatabaseRawCollection;
  /** 从飞书《分流渠道表》权威快照自动取刊例价作为计费基准（opt-in）。 */
  pricingAuthority?: { model: string; resolution: string; refVideo?: boolean; scope?: PricingScope; cachePath?: string };
  /** NewAPI 分流运行时资格断言输入（模型×分辨率×画面比例×启用），opt-in 挂载 producer。 */
  diversionEligibility?: DiversionEligibilityInput;
  /** 一键化：自动读 line=10 配置(pq_aivideo_diversion_config)并构造 diversionEligibility。
   *  传 config 用它（离线/测试），否则真实环境经 readDiversionConfig 读库（VITEST 下跳过）。 */
  autoDiversionEligibility?: AutoDiversionEligibilityOptions;
}

/** verify() 一键分流资格断言的入参（DB 侧规则/模型上下文自动补全，仅需给请求参数）。 */
export interface AutoDiversionEligibilityOptions {
  mediaType?: 'video' | 'image';
  eligible?: boolean; // 视频硬性资格(isVideoRequestEligible)结果，默认 true
  resolution?: string; // 默认取 options.resolution
  aspect?: string; // 默认 'auto'
  routeGroup?: { newapi_group: string; usable: boolean } | null;
  serviceline?: string; // 图片，默认 'r'
  sizeType?: string;
  refImageCount?: number;
  modelClass?: 'normal' | 'image2_lowcost' | 'image25' | 'mj_v82';
  credPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
  config?: DiversionConfigRawCollection; // 预读配置（给了就不读库）
}

/**
 * 一键构造分流资格断言输入：DB 侧规则/模型上下文经 readDiversionConfig+toEligibilityRules 自动补全，
 * 与调用方给的请求参数（分辨率/画面比例/路由组等）合并。fail-closed：配置读不到→返回 undefined（不产断言）。
 * VITEST 下若未给 config 则跳过真实读库，避免测试触网。
 */
export async function buildAutoDiversionEligibility(
  options: VerifyKernelOptions,
  modelId: number,
): Promise<DiversionEligibilityInput | undefined> {
  const a = options.autoDiversionEligibility;
  if (!a) return undefined;
  const mediaType = a.mediaType ?? options.mediaType ?? 'video';
  let cfg = a.config;
  if (!cfg) {
    if (process.env.VITEST) return undefined;
    cfg = await readDiversionConfig({ credPath: a.credPath, scriptPath: a.scriptPath, timeoutMs: a.timeoutMs });
  }
  if (cfg.status !== 'VERIFIED') return undefined;
  const b = toEligibilityRules(cfg, modelId);
  const resolution = a.resolution ?? options.resolution ?? '';
  const aspect = a.aspect ?? 'auto';
  if (mediaType === 'image') {
    return {
      mediaType: 'image',
      image: {
        selmodelsId: modelId,
        modelClass: a.modelClass,
        isGlobalModel: b.isGlobalModel,
        alias: b.alias,
        hasGlobalApiKey: b.hasGlobalApiKey,
        serviceline: a.serviceline ?? 'r',
        sizeType: a.sizeType,
        refImageCount: a.refImageCount,
        resolution,
        aspect,
        routeGroup: a.routeGroup ?? null,
        routeRules: b.routeRules,
        groupRules: b.groupRules,
      },
    };
  }
  return {
    mediaType: 'video',
    video: {
      routeMode: b.routeMode,
      eligible: a.eligible ?? true,
      modelId,
      isGlobalModel: b.isGlobalModel,
      alias: b.alias,
      hasGlobalApiKey: b.hasGlobalApiKey,
      resolution,
      aspect,
      routeGroup: a.routeGroup ?? null,
      routeRules: b.routeRules,
      groupRules: b.groupRules,
    },
  };
}
export interface VerifyKernelResult {
  ok: boolean;
  passed: boolean;
  taskId: number;
  modelId: number;
  mediaType: 'video' | 'image';
  status: 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'UNVERIFIED' | 'ERROR';
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'PROCESSING';
  acceptance: AcceptanceResult;
  evidenceCompleteness: EvidenceCompleteness;
  acceptanceReport: ProductionAcceptanceReport;
  mode: 'real' | 'mock';
  executionMode: 'real' | 'offline' | 'fixture';
  progress?: number;
  probeDurationMs?: number;
  artifact?: MediaInspectionResult;
  billing?: BillingAuditReport;
  billingAudit: 'AUDITED' | 'SKIPPED_NO_LOGS';
  invariants?: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean };
  evidence: VerificationEvidence;
  reasons: string[];
  expectedVsActual?: ExpectedVsActual;
  contract?: DiscoveredModelContract;
  businessValidation?: BusinessVerificationResult;
  memoryCandidate?: MemoryCandidatePayload;
  hasEvidenceConflict?: boolean;
  conflictReasons?: string[];
  isActualChannelAssertedOnly?: boolean;
  channelDetail?: BusinessVerificationResult['channelDetail'];
  provenance?: {
    actualChannelId: string;
    fallbackChannel: string;
    retryProvider: string;
    extra: string;
    gatewayChannel?: string;
  };
  channelBoundaryClarification?: {
    mainSiteDiversionTag: {
      status: string;
      value?: unknown;
      provenance: string;
      boundaryNotice: string;
    };
    gatewayUpstreamChannel: {
      verified: boolean;
      actualChannelId?: number;
      provenance: string;
      boundaryNotice: string;
    };
  };
  canonicalVerdict?: CanonicalVerdictResult;
  canonicalEnvelopes?: CanonicalEvidenceEnvelope[];
  canonicalSpec?: CanonicalTestSpec;
  exportDelivery?: {
    success: boolean;
    sinkName: string;
    recordId: string;
    error?: string;
  };
  dbEvidence?: DatabaseRawCollection;
  /** DB 取证失败的诚实分类（区分「工具链/连通性未连上」与「记录确实不存在」）。 */
  dbForensicsCategory?: DbForensicsCategory;
}

export interface VerifyContext {
  taskId: number;
  mediaType: 'video' | 'image';
  modelId: number;
  customPoints?: number;
  pointsPerSecond?: number;
  contract: ReturnType<typeof discoverModelContract>;
  duration?: number;
  resolution?: string;
  expectedPoints: number;
  expectedChargeSource: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  session: PanquSession | null;
  sessionLoadError?: string;
  executionMode: 'real' | 'offline' | 'fixture';
}

export interface RoutingFacts {
  targetChannelId?: number;
  targetChannelName?: string;
  actualChannelId?: number;
  actualChannelName?: string;
  isActualChannelAssertedOnly: boolean;
  hasEvidenceConflict: boolean;
  conflictReasons: string[];
  isFallbackExecution: boolean;
  channelMatched?: boolean;
  channelProvenance: string;
  fallbackProvenance: string;
  retryProvenance: string;
  extraProvenance: string;
  gatewayChannelProvenance: string;
  isDbExtraVerified: boolean;
  isGatewayChannelRequired: boolean;
  isGatewayChannelVerified: boolean;
  targetChannelFailed: boolean;
  targetChannelUnverified: boolean;
  snapshotValidation?: ReturnType<typeof validateTrustedGatewaySnapshot>;
  hasRealGatewaySnapshot: boolean;
  hasServerActualChannelFact: boolean;
  serverActualChannelId?: number;
  isRealMode: boolean;
  gatewayChannelEvidence: string;
  extraObj?: Record<string, unknown>;
  channelMismatchReason?: string;
  fallbackChannel?: string;
  retryProvider?: string;
}

export interface TaskEvidenceResult {
  terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  taskEvidence: TaskEvidence;
  artifactBuffer?: Buffer;
  artifactTailBuffer?: Buffer;
  mediaArtifactSource: string;
  artifactOwnership: 'VERIFIED' | 'UNVERIFIED';
  probeDurationMs?: number;
  runtimeDetails?: TaskRuntimeDetails;
  routingFacts: RoutingFacts;
  dbEvidence?: DatabaseRawCollection;
}

export interface MediaEvidenceResult {
  artifact?: ReturnType<typeof inspectMp4Buffer>;
  mediaEvidence: MediaEvidence;
}

export interface BillingEvidenceResult {
  billing: ReturnType<typeof BillingOracle.reconcileTaskLedger> | undefined;
  billingEvidence: BillingEvidence;
  invariantsEvidence: InvariantsEvidence;
  invariants: { antiDoubleBilling: boolean; netChargeZero: boolean; refundIdempotency: boolean } | undefined;
  billingSource: string;
  scoreLogsToReconcile?: ScoreLogEntry[];
}

export interface BuildDiffItemsOptions {
  options: VerifyKernelOptions;
  ctx: VerifyContext;
  taskResult: TaskEvidenceResult;
  mediaResult: MediaEvidenceResult;
  billingResult: BillingEvidenceResult;
  regressionDiff?: DiversionRegressionDiff;
  businessValidation?: ReturnType<typeof evaluateBusinessVerification>;
}

export interface ComputeFinalVerdictArgs {
  options: VerifyKernelOptions;
  ctx: VerifyContext;
  taskResult: TaskEvidenceResult;
  mediaResult: MediaEvidenceResult;
  billingResult: BillingEvidenceResult;
  regressionDiff?: DiversionRegressionDiff;
  diffItems: DiffItem[];
  businessValidation?: ReturnType<typeof evaluateBusinessVerification>;
}

// ============================================================================
// Helper 1: resolveVerifyContext
// ============================================================================
export async function resolveVerifyContext(
  options: VerifyKernelOptions,
  contractOverride?: ReturnType<typeof discoverModelContract>,
): Promise<VerifyContext> {
  const { taskId } = options;
  const mediaType = options.mediaType || 'video';
  const modelId = options.modelId ?? (mediaType === 'video' ? 84 : 201);
  // 计费基准可选取自飞书《分流渠道表》权威快照（opt-in）：刊例价不随分流变化，
  // 视频=积分/秒(pointsPerSecond)，图片=每张(customPoints)。取数失败静默回退调用方入参。
  let authorityListPrice: number | undefined;
  if (options.pricingAuthority) {
    try {
      const cache = loadDiversionPricing(options.pricingAuthority.cachePath);
      const p = resolveListPrice(cache, {
        model: options.pricingAuthority.model,
        resolution: options.pricingAuthority.resolution,
        refVideo: options.pricingAuthority.refVideo,
        scope: options.pricingAuthority.scope,
      });
      authorityListPrice = p ?? undefined;
    } catch {
      authorityListPrice = undefined;
    }
  }
  const customPoints =
    options.customPoints ?? (mediaType === 'image' ? (options.price ?? authorityListPrice) : undefined);
  const pointsPerSecond =
    options.pointsPerSecond ?? (mediaType === 'video' ? (options.price ?? authorityListPrice) : undefined);

  const contract =
    options.contract ||
    contractOverride ||
    discoverModelContract(modelId, mediaType, {
      duration: options.duration,
      resolution: options.resolution,
      customPoints: customPoints ?? (mediaType === 'image' ? options.expectedPoints : undefined),
      pointsPerSecond,
      price: options.price,
      alias: options.alias,
    });

  const duration =
    options.duration ?? contract.supportedDurations?.value?.[0] ?? (mediaType === 'video' ? 4 : undefined);
  const resolution =
    options.resolution ?? contract.supportedResolutions.value[0] ?? (mediaType === 'video' ? '720p' : '1k');

  const expectedPoints =
    options.expectedPoints ??
    BillingOracle.calculateExpectedPoints({
      mediaType,
      modelId,
      duration,
      resolution,
      customPoints: customPoints ?? contract.pricing.customPoints?.value,
      pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
    });
  const expectedChargeSource: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION' =
    options.expectedChargeSource ?? 'DEVTEST_EXPECTATION';

  let session: PanquSession | null = null;
  let sessionFromAuto = false;
  let sessionLoadError: string | undefined;
  const env = options.env || (options.environment as 'test' | 'preonline' | undefined) || 'test';
  const autoSession =
    options.sessionFile ||
    (!process.env.VITEST
      ? process.env.PANQU_SESSION_COOKIES_FILE ||
        (existsSync('session.json')
          ? 'session.json'
          : existsSync('.panqu/session.json')
            ? '.panqu/session.json'
            : undefined)
      : undefined);
  if (options.session) {
    session = options.session;
  } else if (options.sessionFile) {
    try {
      session = await loadPanquSession(options.sessionFile, env);
    } catch (err) {
      sessionLoadError = `加载凭据失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (autoSession) {
    try {
      session = await loadPanquSession(autoSession, env);
      sessionFromAuto = true;
    } catch {
      /* ignore auto session */
    }
  } else if (options.cookies && options.baseUrl) {
    session = { env, base_url: options.baseUrl, cookie_string: options.cookies };
  }

  const explicitMode = options.executionMode?.toLowerCase() as 'real' | 'offline' | 'fixture' | undefined;
  const isMockExecution = options.isSimulated || options.mode === 'mock' || explicitMode === 'offline';
  const isExplicitFixture = explicitMode === 'fixture';
  const hasFixturePayload =
    Boolean(options.assetBuffer || options.artifactBuffer) &&
    Boolean(options.scoreLogs && options.scoreLogs.length > 0);
  // 调用方提供了取证数据（dbRawCollection 或 asset+scoreLogs）即为 fixture 意图：
  // 磁盘上偶然存在的 .panqu/session.json 不应把这类调用悄悄提升为真实轮询运行（否则会卡到 poll 超时）。
  const hasFixtureData = hasFixturePayload || options.dbRawCollection !== undefined;

  const executionMode: 'real' | 'offline' | 'fixture' = isMockExecution
    ? 'offline'
    : isExplicitFixture
      ? 'fixture'
      : explicitMode === 'real'
        ? 'real'
        : session && !(sessionFromAuto && hasFixtureData)
          ? 'real'
          : hasFixturePayload
            ? 'fixture'
            : 'offline';

  // 有 fixture 数据时，丢弃磁盘上自动发现的会话，避免下游把它当真实运行去轮询任务（poll 超时导致的卡死）。
  if (sessionFromAuto && hasFixtureData) {
    session = null;
  }

  return {
    taskId,
    mediaType,
    modelId,
    customPoints,
    pointsPerSecond,
    contract,
    duration,
    resolution,
    expectedPoints,
    expectedChargeSource,
    session,
    sessionLoadError,
    executionMode,
  };
}

// ============================================================================
// Helper 2: collectTaskEvidence
// ============================================================================
export async function collectTaskEvidence(
  ctx: VerifyContext,
  options: VerifyKernelOptions,
): Promise<TaskEvidenceResult> {
  const { taskId, session, sessionLoadError, mediaType, modelId } = ctx;
  let artifactBuffer = options.assetBuffer ?? options.artifactBuffer;
  let artifactTailBuffer = options.tailBuffer;
  let probeDurationMs: number | undefined;
  let terminalStatus: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  let taskEvidence: TaskEvidence;
  let mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_buffer';
  let artifactOwnership: 'VERIFIED' | 'UNVERIFIED' =
    options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND' ? 'UNVERIFIED' : 'VERIFIED';

  if (session) {
    const defaultTimeoutSec = mediaType === 'image' ? 60 : 180;
    const pollTimeoutSec = options.pollTimeoutSec ?? defaultTimeoutSec;
    const { finalSnapshot } = await pollTaskStatus(taskId, {
      baseUrl: session.base_url,
      cookies: session.cookie_string,
      mediaType,
      pollTimeoutSec,
      pollIntervalMs: options.pollIntervalMs,
      onProgress: options.onProgress,
    });
    if (finalSnapshot.taskStatus === 1) {
      terminalStatus = 'PROCESSING';
      taskEvidence = {
        status: 'PROCESSING',
        source: 'live_polling',
        terminalStatus: 'UNKNOWN',
        taskStatus: 1,
        progress: finalSnapshot.progress,
      };
    } else if (finalSnapshot.taskStatus === 3 || finalSnapshot.taskStatus === 4) {
      terminalStatus = 'FAILED';
      taskEvidence = {
        status: 'FAIL',
        source: 'live_polling',
        terminalStatus: 'FAILED',
        taskStatus: finalSnapshot.taskStatus,
        error: finalSnapshot.error || '未知服务端错误',
        progress: finalSnapshot.progress,
      };
    } else if (finalSnapshot.taskStatus === 2) {
      terminalStatus = 'SUCCESS';
      taskEvidence = {
        status: 'PASS',
        source: 'live_polling',
        terminalStatus: 'SUCCESS',
        taskStatus: 2,
        progress: finalSnapshot.progress,
        videoUrl: finalSnapshot.videoUrl,
        imageUrl: finalSnapshot.imageUrl,
      };
      const mediaUrl = finalSnapshot.videoUrl || finalSnapshot.imageUrl;
      if (mediaUrl) {
        mediaArtifactSource = 'TASK_SNAPSHOT';
        artifactOwnership = 'VERIFIED';
        if (!artifactBuffer) {
          const probeRes = await fetchFirst64K(mediaUrl);
          if (probeRes) {
            artifactBuffer = probeRes.buffer;
            artifactTailBuffer = probeRes.tailBuffer;
            probeDurationMs = probeRes.durationMs;
          }
        }
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = {
        status: 'UNVERIFIED',
        source: 'task_not_found',
        terminalStatus: 'UNKNOWN',
        taskStatus: 0,
        error: `未能从主站获取到任务 #${taskId} 状态 (任务不存在或超时) [UNVERIFIED]`,
        progress: 0,
      };
      const targetMediaUrl = options.videoUrl || options.imageUrl;
      if (targetMediaUrl && !artifactBuffer) {
        mediaArtifactSource = 'EXTERNAL_URL';
        artifactOwnership = options.artifactOwnership === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
        const probeRes = await fetchFirst64K(targetMediaUrl);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    }
  } else if (sessionLoadError) {
    terminalStatus = 'UNKNOWN';
    taskEvidence = {
      status: 'UNVERIFIED',
      source: 'session_error',
      terminalStatus: 'UNKNOWN',
      error: `${sessionLoadError} [UNVERIFIED]`,
    };
    mediaArtifactSource = artifactBuffer ? 'FIXTURE_BUFFER' : 'missing_session';
    if (!artifactBuffer) {
      artifactOwnership = 'UNVERIFIED';
    }
  } else {
    if (options.terminalStatus) {
      if (options.terminalStatus === 'PROCESSING') {
        terminalStatus = 'PROCESSING';
        taskEvidence = {
          status: 'PROCESSING',
          source: 'provided',
          terminalStatus: 'UNKNOWN',
          taskStatus: 1,
          progress: options.progress ?? 50,
        };
      } else {
        terminalStatus = options.terminalStatus;
        taskEvidence = {
          status: terminalStatus === 'FAILED' ? 'FAIL' : terminalStatus === 'SUCCESS' ? 'PASS' : 'UNVERIFIED',
          source: 'provided',
          terminalStatus,
        };
      }
    } else {
      terminalStatus = 'UNKNOWN';
      taskEvidence = {
        status: 'UNVERIFIED',
        source: 'unqueried',
        terminalStatus: 'UNKNOWN',
        error: `未连接真实主站查询且未显式传入终态，任务 #${taskId} 终态未知 [UNVERIFIED]`,
      };
    }

    const targetMediaUrl = options.videoUrl || options.imageUrl;
    if (targetMediaUrl) {
      taskEvidence.videoUrl = options.videoUrl;
      taskEvidence.imageUrl = options.imageUrl;
      mediaArtifactSource = 'EXTERNAL_URL';
      if (options.artifactOwnership !== 'VERIFIED') {
        artifactOwnership = 'UNVERIFIED';
      }
      if (!artifactBuffer) {
        const probeRes = await fetchFirst64K(targetMediaUrl);
        if (probeRes) {
          artifactBuffer = probeRes.buffer;
          artifactTailBuffer = probeRes.tailBuffer;
          probeDurationMs = probeRes.durationMs;
        }
      }
    } else if (artifactBuffer) {
      mediaArtifactSource =
        options.artifactOwnership === 'UNVERIFIED' || options.artifactOwnership === 'UNBOUND'
          ? 'EXTERNAL_BUFFER'
          : 'FIXTURE_BUFFER';
    }
  }

  // 服务端运行时详情查询 (只读)
  let runtimeDetails: TaskRuntimeDetails | undefined;
  if (session && !session.base_url.includes('example.com')) {
    try {
      runtimeDetails = await queryTaskRuntimeDetails(taskId, session, {
        projectId: options.projectId ?? session.project_id,
      });
    } catch {
      /* 容忍只读查询非致命抖动 */
    }
  }

  // 数据库物理事实查询 (只读，按项目规则自动加载 db-credentials.json 并走 SSH 隧道)
  let dbRawCollection: DatabaseRawCollection | undefined = options.dbRawCollection;
  const isRealRun = ctx.executionMode === 'real';
  const isOfflineFixture = ctx.executionMode === 'fixture' || ctx.executionMode === 'offline';

  // 真实数据变更场景强制执行数据库只读取证，不能被 CLI 参数或直接调用库的方式关闭。离线 fixture 与 VITEST 单测环境不触发真实连库。
  const shouldQueryDb =
    !dbRawCollection &&
    ((isRealRun && !process.env.VITEST) ||
      options.dbVerify === true ||
      (options.dbVerify !== false && !process.env.VITEST && !isOfflineFixture));

  if (shouldQueryDb) {
    const credPath = resolveDatabaseCredentialsPath(options.dbCredPath);
    if (credPath) {
      try {
        dbRawCollection = await queryDatabasePhysicalFacts({
          taskId,
          credPath,
          // DB 取证使用独立短超时，绝不随 --poll-timeout 放大；库不可达时快速 fail-closed 为 UNVERIFIED，避免真实流程长时间卡死
          timeoutMs: options.dbTimeoutMs ?? 10000,
        });
      } catch {
        /* 容忍只读取证非致命异常，失败关闭交给后续判定 */
      }
    } else if (isRealRun) {
      // 真实模式下凭据缺失，不可伪造或忽略，记录明确失败原因供唯一裁决引擎做失败关闭判定
      dbRawCollection = {
        status: 'UNVERIFIED',
        taskId,
        reason: 'MISSING_CREDENTIALS',
        error: '找不到 db-credentials.json 数据库凭据文件，无法通过 SSH 隧道执行物理取证 [UNVERIFIED]',
        recordsFound: {},
      };
    }
  }

  // 若通过数据库物理落库获得了明确终态且此前未知，自动提升终态事实
  if (dbRawCollection?.recordsFound?.pq_aivideo_new) {
    const dbTask = dbRawCollection.recordsFound.pq_aivideo_new;
    const dbTaskStatus = Number(dbTask.task_status);
    if (
      terminalStatus === 'UNKNOWN' ||
      taskEvidence.source === 'unqueried' ||
      taskEvidence.source === 'task_not_found'
    ) {
      if (dbTaskStatus === 2) {
        terminalStatus = 'SUCCESS';
        taskEvidence = {
          status: 'PASS',
          source: 'DATABASE_PHYSICAL_RECORD:pq_aivideo_new',
          terminalStatus: 'SUCCESS',
          taskStatus: 2,
          progress: 100,
          videoUrl: dbTask.video_url
            ? String(dbTask.video_url).startsWith('http')
              ? String(dbTask.video_url)
              : `https://v.panqu.com.cn${String(dbTask.video_url)}`
            : undefined,
        };
      } else if (dbTaskStatus === 3 || dbTaskStatus === 4) {
        terminalStatus = 'FAILED';
        taskEvidence = {
          status: 'FAIL',
          source: 'DATABASE_PHYSICAL_RECORD:pq_aivideo_new',
          terminalStatus: 'FAILED',
          taskStatus: dbTaskStatus,
          error: dbTask.err ? String(dbTask.err) : '数据库记录任务已失败 [DATABASE_PHYSICAL_RECORD]',
          progress: -1,
        };
      }
    }
    // 若成片 URL 可从数据库物理记录获取且尚未探测
    if (!artifactBuffer && (taskEvidence.videoUrl || dbTask.video_url)) {
      const dbMediaUrl =
        taskEvidence.videoUrl ||
        (String(dbTask.video_url).startsWith('http')
          ? String(dbTask.video_url)
          : `https://v.panqu.com.cn${String(dbTask.video_url)}`);
      mediaArtifactSource = 'DATABASE_PHYSICAL_RECORD:pq_aivideo_new';
      artifactOwnership = 'VERIFIED';
      const probeRes = await fetchFirst64K(dbMediaUrl);
      if (probeRes) {
        artifactBuffer = probeRes.buffer;
        artifactTailBuffer = probeRes.tailBuffer;
        probeDurationMs = probeRes.durationMs;
      }
    }
  }

  // 目标渠道消歧与判定
  const targetDisambiguation =
    options.channelId !== undefined || options.channelName !== undefined || options.targetKind === 'channel'
      ? RoutingOracle.disambiguateTarget({
          targetKind: options.targetKind,
          channelId: options.channelId,
          channelName: options.channelName,
          modelId,
          modelAlias: options.alias,
          projectId: options.projectId,
          mode: options.isSimulated ? 'mock' : session ? 'real' : 'mock',
        })
      : undefined;

  const targetChannelId = targetDisambiguation?.channelId ?? options.channelId;
  const targetChannelName = targetDisambiguation?.channelName ?? options.channelName;

  const rawExceptionalExtra = runtimeDetails?.rawExceptionalTask?.extra as Record<string, unknown> | undefined;
  const optionsExceptionalExtra = options.exceptionalTask?.extra as Record<string, unknown> | undefined;

  // 1. 服务端只读事实提取 (Server Facts)
  const serverActualChannelId =
    runtimeDetails?.actualChannelId ??
    (options.retryLog?.newapi_channel_id ? Number(options.retryLog.newapi_channel_id) : undefined);
  const serverActualChannelName =
    runtimeDetails?.actualChannelName ??
    (options.retryLog?.newapi_provider_name ? String(options.retryLog.newapi_provider_name) : undefined) ??
    (runtimeDetails?.rawExceptionalTask?.line_name ? String(runtimeDetails.rawExceptionalTask.line_name) : undefined);
  const serverFallbackChannel =
    runtimeDetails?.fallbackChannel ??
    (options.retryLog?.fallback_channel ? String(options.retryLog.fallback_channel) : undefined);
  const serverRetryProvider =
    runtimeDetails?.retryProvider ??
    (rawExceptionalExtra?.retry_provider ? String(rawExceptionalExtra.retry_provider) : undefined) ??
    (optionsExceptionalExtra?.retry_provider ? String(optionsExceptionalExtra.retry_provider) : undefined);

  // 2. 调用者入参手填断言 (Asserted Inputs)
  const assertedActualChannelId = options.actualChannelId;
  const assertedActualChannelName = options.actualChannelName;
  const assertedFallbackChannel = options.fallbackChannel;
  const assertedRetryProvider = options.retryProvider;

  // 3. 证据冲突检测 (EVIDENCE_CONFLICT)
  let hasEvidenceConflict = false;
  const conflictReasons: string[] = [];

  // 3.1 运行环境重叠参数冲突校验 (env vs environment vs spec.environment)
  const effectiveEnv = options.environment || options.env;
  if (options.env && options.environment && options.env !== options.environment) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `运行环境参数冲突 [EVIDENCE_CONFLICT]: 传入 env='${options.env}' 与 environment='${options.environment}' 不一致。`,
    );
  }
  if (options.spec?.environment && effectiveEnv && options.spec.environment !== effectiveEnv) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `规范与运行环境冲突 [EVIDENCE_CONFLICT]: canonicalSpec.environment='${options.spec.environment}' 与传入环境 '${effectiveEnv}' 不一致。`,
    );
  }

  // 3.2 执行模式互斥冲突校验 (isSimulated vs executionMode)
  const normOptExecutionMode = options.executionMode?.toLowerCase();
  if (options.isSimulated === true && normOptExecutionMode === 'real') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `执行模式参数冲突 [EVIDENCE_CONFLICT]: isSimulated=true (离线仿真) 与 executionMode='real' (真实执行) 互斥。`,
    );
  }
  if (normOptExecutionMode === 'real' && !ctx.session && !ctx.sessionLoadError) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `执行模式凭据缺失 [EVIDENCE_CONFLICT]: 声明 executionMode='real' 但未形成有效服务端会话 (缺少有效 session 或完整 baseUrl+cookies)，凭据声明不得等同于鉴权成功。`,
    );
  }
  if (options.cookies && !options.baseUrl && !options.session && !options.sessionFile) {
    hasEvidenceConflict = true;
    conflictReasons.push(`凭据不完整 [EVIDENCE_CONFLICT]: 仅传入 cookies 但缺少 baseUrl，未形成有效服务端会话凭据。`);
  }

  // 3.3 媒体类型与地址错配冲突校验 (mediaType vs videoUrl/imageUrl)
  if (ctx.mediaType === 'image' && options.videoUrl && !options.imageUrl) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `媒体类型与地址冲突 [EVIDENCE_CONFLICT]: mediaType 为 image 但仅传入 videoUrl (${options.videoUrl})。`,
    );
  } else if (ctx.mediaType === 'video' && options.imageUrl && !options.videoUrl) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `媒体类型与地址冲突 [EVIDENCE_CONFLICT]: mediaType 为 video 但仅传入 imageUrl (${options.imageUrl})。`,
    );
  }

  // 3.4 计费参数显式冲突校验 (price vs customPoints/pointsPerSecond)
  if (
    ctx.mediaType === 'image' &&
    options.price !== undefined &&
    options.customPoints !== undefined &&
    options.price !== options.customPoints
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `计费参数冲突 [EVIDENCE_CONFLICT]: image 场景下 price (${options.price}) 与 customPoints (${options.customPoints}) 数值不一致。`,
    );
  } else if (
    ctx.mediaType === 'video' &&
    options.price !== undefined &&
    options.pointsPerSecond !== undefined &&
    options.price !== options.pointsPerSecond
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `计费参数冲突 [EVIDENCE_CONFLICT]: video 场景下 price (${options.price}) 与 pointsPerSecond (${options.pointsPerSecond}) 数值不一致。`,
    );
  }

  // 3.5 产物 Buffer 冲突校验 (assetBuffer vs artifactBuffer)
  if (options.assetBuffer && options.artifactBuffer && !options.assetBuffer.equals(options.artifactBuffer)) {
    hasEvidenceConflict = true;
    conflictReasons.push(`产物 Buffer 冲突 [EVIDENCE_CONFLICT]: assetBuffer 与 artifactBuffer 二进制内容不一致。`);
  }

  // 3.6 规范目标身份与执行模式冲突校验 (spec.target.taskId / spec.inputs.taskId / spec.executionMode vs verify inputs)
  if (options.spec) {
    const specTargetTaskId = options.spec.target?.taskId;
    const specInputsTaskId = options.spec.inputs?.taskId;
    if (specTargetTaskId !== undefined && Number(specTargetTaskId) !== Number(ctx.taskId)) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标身份冲突 [EVIDENCE_CONFLICT]: 传入 taskId=${ctx.taskId} 与 canonicalSpec.target.taskId=${specTargetTaskId} 不一致，不同任务的证据不得用于当前目标的通过裁决。`,
      );
    }
    if (specInputsTaskId !== undefined && Number(specInputsTaskId) !== Number(ctx.taskId)) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标身份冲突 [EVIDENCE_CONFLICT]: 传入 taskId=${ctx.taskId} 与 canonicalSpec.inputs.taskId=${specInputsTaskId} 不一致，不同任务的证据不得用于当前目标的通过裁决。`,
      );
    }
    if (
      options.spec.target?.modelId !== undefined &&
      ctx.modelId !== undefined &&
      Number(options.spec.target.modelId) !== Number(ctx.modelId)
    ) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `目标模型冲突 [EVIDENCE_CONFLICT]: 传入 modelId=${ctx.modelId} 与 canonicalSpec.target.modelId=${options.spec.target.modelId} 不一致。`,
      );
    }
    if (options.spec.executionMode && options.spec.executionMode.toLowerCase() !== ctx.executionMode) {
      hasEvidenceConflict = true;
      conflictReasons.push(
        `执行模式冲突 [EVIDENCE_CONFLICT]: canonicalSpec.executionMode='${options.spec.executionMode}' 与实际执行模式 '${ctx.executionMode}' 不一致。`,
      );
    }
  }

  if (
    serverActualChannelId !== undefined &&
    assertedActualChannelId !== undefined &&
    serverActualChannelId !== assertedActualChannelId
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `实际渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 Channel #${serverActualChannelId} ('${serverActualChannelName || serverActualChannelId}'), 调用者手填断言为 Channel #${assertedActualChannelId} ('${assertedActualChannelName || assertedActualChannelId}')。必须优先采用服务端事实。`,
    );
  }

  const normServerFallback =
    serverFallbackChannel && serverFallbackChannel !== 'none' ? serverFallbackChannel : undefined;
  const normAssertedFallback =
    assertedFallbackChannel && assertedFallbackChannel !== 'none' ? assertedFallbackChannel : undefined;
  if (normServerFallback !== undefined && assertedFallbackChannel === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在兜底 '${normServerFallback}', 调用者断言为无兜底 (none)。必须优先采用服务端事实。`,
    );
  } else if (
    normServerFallback !== undefined &&
    normAssertedFallback !== undefined &&
    normServerFallback !== normAssertedFallback
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `兜底渠道证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 fallback='${normServerFallback}', 调用者断言为 '${normAssertedFallback}'。必须优先采用服务端事实。`,
    );
  }

  const normServerRetry = serverRetryProvider && serverRetryProvider !== 'none' ? serverRetryProvider : undefined;
  const normAssertedRetry =
    assertedRetryProvider && assertedRetryProvider !== 'none' ? assertedRetryProvider : undefined;
  if (normServerRetry !== undefined && assertedRetryProvider === 'none') {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实存在重试 provider '${normServerRetry}', 调用者断言为无重试 (none)。必须优先采用服务端事实。`,
    );
  } else if (
    normServerRetry !== undefined &&
    normAssertedRetry !== undefined &&
    normServerRetry !== normAssertedRetry
  ) {
    hasEvidenceConflict = true;
    conflictReasons.push(
      `重试 Provider 证据冲突 [EVIDENCE_CONFLICT]: 服务端事实为 retryProvider='${normServerRetry}', 调用者断言为 '${normAssertedRetry}'。必须优先采用服务端事实。`,
    );
  }

  // 4. 事实仲裁：服务端只读事实强制优先于手填输入！
  const actualChannelId = serverActualChannelId ?? assertedActualChannelId;
  const actualChannelName =
    (serverActualChannelId !== undefined ? serverActualChannelName : undefined) ??
    assertedActualChannelName ??
    serverActualChannelName;
  const fallbackChannel = serverFallbackChannel ?? assertedFallbackChannel;
  const retryProvider = serverRetryProvider ?? assertedRetryProvider;

  const isActualChannelAssertedOnly =
    Boolean(ctx.session && !options.isSimulated) &&
    serverActualChannelId === undefined &&
    assertedActualChannelId !== undefined;

  // 5. 记录字段精确 Provenance
  let channelProvenance: string;
  if (runtimeDetails?.actualChannelId !== undefined) {
    channelProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.newapi_channel_id !== undefined) {
    channelProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedActualChannelId !== undefined) {
    channelProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    channelProvenance = 'UNVERIFIED';
  }

  let fallbackProvenance: string;
  if (runtimeDetails?.fallbackChannel !== undefined) {
    fallbackProvenance = 'HTTP_API:retrylog';
  } else if (options.retryLog?.fallback_channel !== undefined) {
    fallbackProvenance = 'SERVER_RETRYLOG_FIXTURE';
  } else if (assertedFallbackChannel !== undefined) {
    fallbackProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    fallbackProvenance = 'UNVERIFIED';
  }

  let retryProvenance: string;
  if (runtimeDetails?.retryProvider !== undefined) {
    retryProvenance = 'HTTP_API:exceptional-task';
  } else if (
    rawExceptionalExtra?.retry_provider !== undefined ||
    optionsExceptionalExtra?.retry_provider !== undefined
  ) {
    retryProvenance = 'SERVER_EXCEPTIONAL_FIXTURE';
  } else if (assertedRetryProvider !== undefined) {
    retryProvenance =
      ctx.session && !options.isSimulated ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    retryProvenance = 'UNVERIFIED';
  }

  // 6. extra 对象与来源追踪 (绝不把 exceptional-task 的 extra 冒充为 HTTP_API:getEditData)
  let extraObj: Record<string, unknown> | undefined;
  let extraProvenance: string;

  if (runtimeDetails?.extra && runtimeDetails.extraSource === 'HTTP_API:getEditData') {
    extraObj = runtimeDetails.extra;
    extraProvenance = 'HTTP_API:getEditData';
  } else if (dbRawCollection?.recordsFound?.pq_aivideo_new?.extra) {
    const rawDbExtra = dbRawCollection.recordsFound.pq_aivideo_new.extra;
    try {
      extraObj =
        typeof rawDbExtra === 'string' ? JSON.parse(rawDbExtra) : (rawDbExtra as Record<string, unknown>);
    } catch {
      extraObj = undefined;
    }
    extraProvenance = 'DATABASE_PHYSICAL_RECORD:pq_aivideo_new';
  } else if (runtimeDetails?.extra) {
    extraObj = runtimeDetails.extra;
    extraProvenance = runtimeDetails.extraSource || 'HTTP_API:exceptional-task';
  } else if (runtimeDetails?.rawExceptionalTask?.extra) {
    const rowExtra =
      typeof runtimeDetails.rawExceptionalTask.extra === 'string'
        ? JSON.parse(runtimeDetails.rawExceptionalTask.extra)
        : runtimeDetails.rawExceptionalTask.extra;
    extraObj = rowExtra as Record<string, unknown>;
    extraProvenance = 'HTTP_API:exceptional-task';
  } else if (options.dbExtra) {
    extraObj = options.dbExtra;
    extraProvenance = 'DB_READONLY_QUERY';
  } else if (options.extra) {
    extraObj = options.extra;
    extraProvenance = 'CLI_MANUAL_INPUT';
  } else if (options.exceptionalTask?.extra) {
    extraObj = options.exceptionalTask.extra as Record<string, unknown>;
    extraProvenance = 'FIXTURE:exceptional-task';
  } else if (options.taskDetail?.extra) {
    extraObj = options.taskDetail.extra as Record<string, unknown>;
    extraProvenance = 'TASK_DETAIL';
  } else {
    extraProvenance = 'UNVERIFIED';
  }

  const isDbExtraVerified = Boolean(
    options.dbExtraConfirmed ||
    options.dbExtra ||
    (extraObj &&
      typeof extraObj === 'object' &&
      (extraObj.diversion !== undefined || extraObj.newapi_image !== undefined)),
  );

  let channelMatched: boolean | undefined;
  let isFallbackExecution = false;
  let channelMismatchReason: string | undefined;

  if (targetChannelId !== undefined) {
    if (hasEvidenceConflict) {
      channelMatched = false;
      channelMismatchReason = `渠道或兜底证据存在冲突 [EVIDENCE_CONFLICT]: ${conflictReasons.join('; ')}`;
    } else if (isActualChannelAssertedOnly) {
      channelMatched = undefined;
      channelMismatchReason = `实际渠道仅来自调用者断言 (#${assertedActualChannelId})，缺少服务端只读运行时凭据证实 [UNVERIFIED]`;
    } else if (actualChannelId !== undefined) {
      if (actualChannelId === targetChannelId) {
        channelMatched = true;
      } else {
        channelMatched = false;
        channelMismatchReason = `目标渠道不匹配: 预期渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}'), 服务端实际执行渠道为 #${actualChannelId} ('${actualChannelName || actualChannelId}') [CHANNEL_MISMATCH]`;
      }
    } else {
      channelMismatchReason = `缺少服务端执行渠道证据，无法核验是否由目标渠道 #${targetChannelId} ('${targetChannelName || targetChannelId}') 履约 [UNVERIFIED]`;
    }

    const effectiveFallback =
      fallbackChannel && fallbackChannel !== 'none'
        ? fallbackChannel
        : retryProvider && retryProvider !== 'none'
          ? retryProvider
          : undefined;
    if (effectiveFallback) {
      isFallbackExecution = true;
      const fallbackReason = `目标渠道未产出成片，成片由兜底通道 (${effectiveFallback}) 生成，不得误判为目标渠道合格 [FALLBACK_ARTIFACT_NOT_ACCEPTED]`;
      channelMismatchReason = channelMismatchReason ? `${channelMismatchReason}; ${fallbackReason}` : fallbackReason;
    }
  }

  const isRealMode = Boolean(session && !options.isSimulated);
  const isGatewayChannelRequired = mediaType === 'video' && ctx.contract.routing.value.willDivert;

  const snapshotValidation = options.gatewaySnapshot
    ? validateTrustedGatewaySnapshot(options.gatewaySnapshot, {
        expectedEnv: options.env || (options.environment as 'test' | 'preonline' | undefined),
      })
    : undefined;

  const hasRealGatewaySnapshot = isRealMode
    ? Boolean(snapshotValidation?.valid)
    : Boolean(
        snapshotValidation?.valid ||
        (options.channels &&
          options.channels.length > 0 &&
          options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')),
      );

  const hasServerActualChannelFact = serverActualChannelId !== undefined && !isActualChannelAssertedOnly;

  // 渠道核验边界澄清 (Requirement 3):
  // 1. 主站 extra.diversion 仅能证明主站分流标记落库，不能证明网关实际履约渠道。
  // 2. 真实模式下，外部断言 (--gateway-channel-confirmed) 严禁作为网关履约事实；必须具备真实的网关可信快照。
  const isGatewayChannelVerified = isRealMode
    ? Boolean(hasRealGatewaySnapshot)
    : Boolean(options.gatewayChannelConfirmed || hasRealGatewaySnapshot || serverActualChannelId !== undefined);

  let gatewayChannelEvidence: string;
  let gatewayChannelProvenance: string;

  if (hasRealGatewaySnapshot) {
    gatewayChannelEvidence = 'SOURCE_REAL_GATEWAY';
    gatewayChannelProvenance = snapshotValidation?.snapshot
      ? `API_READONLY_COLLECTOR (${snapshotValidation.snapshot.sourceEndpoint})`
      : 'SOURCE_REAL_GATEWAY';
  } else if (!isRealMode && hasServerActualChannelFact) {
    gatewayChannelEvidence = 'SERVER_RUN_FACT';
    gatewayChannelProvenance = channelProvenance;
  } else if (options.gatewaySnapshot && !snapshotValidation?.valid) {
    gatewayChannelEvidence = 'INVALID_GATEWAY_SNAPSHOT';
    gatewayChannelProvenance = `FAIL_CLOSED (${snapshotValidation?.reason || 'INVALID_SNAPSHOT'})`;
  } else if (isRealMode && options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')) {
    gatewayChannelEvidence = 'USER_ASSERTION_REJECTED';
    gatewayChannelProvenance = 'CLI_ASSERTED_INPUT (BLOCKED_MISSING_TRUSTED_COLLECTOR: REAL 模式禁止外部断言作为渠道事实)';
  } else if (options.gatewayChannelConfirmed) {
    gatewayChannelEvidence = isRealMode ? 'USER_ASSERTION_REJECTED' : 'USER_ASSERTION (FIXTURE)';
    gatewayChannelProvenance = isRealMode ? 'CLI_ASSERTED_INPUT (UNVERIFIED_FOR_REAL)' : 'FIXTURE_ASSERTED';
  } else {
    gatewayChannelEvidence = 'MANUAL_REQUIRED';
    gatewayChannelProvenance = 'UNVERIFIED (BLOCKED_MISSING_TRUSTED_COLLECTOR)';
  }

  const targetChannelFailed = targetChannelId !== undefined && (channelMatched === false || isFallbackExecution);
  const targetChannelUnverified = targetChannelId !== undefined && channelMatched === undefined;

  const routingFacts: RoutingFacts = {
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    fallbackProvenance,
    retryProvenance,
    extraProvenance,
    gatewayChannelProvenance,
    isDbExtraVerified,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    targetChannelFailed,
    targetChannelUnverified,
    snapshotValidation,
    hasRealGatewaySnapshot,
    hasServerActualChannelFact,
    serverActualChannelId,
    isRealMode,
    gatewayChannelEvidence,
    extraObj,
    channelMismatchReason,
    fallbackChannel,
    retryProvider,
  };

  return {
    terminalStatus,
    taskEvidence,
    artifactBuffer,
    artifactTailBuffer,
    mediaArtifactSource,
    artifactOwnership,
    probeDurationMs,
    runtimeDetails,
    routingFacts,
    dbEvidence: dbRawCollection,
  };
}

// ============================================================================
// Helper 3: collectMediaEvidence
// ============================================================================
export function collectMediaEvidence(taskResult: TaskEvidenceResult, ctx: VerifyContext): MediaEvidenceResult {
  const { artifactBuffer, artifactTailBuffer, terminalStatus, mediaArtifactSource, artifactOwnership } = taskResult;
  const { mediaType, taskId } = ctx;

  const artifact = artifactBuffer
    ? mediaType === 'video'
      ? inspectMp4Buffer(artifactBuffer, artifactTailBuffer)
      : inspectImageBuffer(artifactBuffer)
    : undefined;
  let mediaEvidence: MediaEvidence;
  if (terminalStatus === 'FAILED' && !artifactBuffer) {
    mediaEvidence = {
      status: 'UNVERIFIED',
      source: 'task_failed',
      ownership: 'UNVERIFIED',
      reason: '任务执行失败，无媒体产物',
    };
  } else if (artifact) {
    if (artifactOwnership === 'UNVERIFIED') {
      mediaEvidence = {
        status: 'UNVERIFIED',
        source: mediaArtifactSource,
        ownership: 'UNVERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: artifact.decodable,
        reason: `媒体容器物理结构有效 (${(artifact.format || 'mp4').toUpperCase()} container structure PASS)，但缺少与 Task #${taskId} 的归属绑定证据 [UNVERIFIED]`,
      };
    } else if (artifact.decodable) {
      mediaEvidence = {
        status: 'PASS',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: artifact.decodable,
      };
    } else {
      mediaEvidence = {
        status: 'FAIL',
        source: mediaArtifactSource,
        ownership: 'VERIFIED',
        format: artifact.format,
        dimensions: artifact.dimensions,
        durationSeconds: artifact.durationSeconds,
        hasMdat: artifact.hasMdat,
        decodable: false,
        reason: artifact.reasons.join(', ') || '产物物理完整性校验失败',
      };
    }
  } else {
    mediaEvidence = {
      status: 'UNVERIFIED',
      source: 'missing_buffer',
      ownership: 'UNVERIFIED',
      reason: '缺失真实媒体产物（未提供 assetBuffer 且未获取到有效的产物下载 URL），物理结构未验真 [UNVERIFIED]',
    };
  }

  return { artifact, mediaEvidence };
}

// ============================================================================
// Helper 4: collectBillingEvidence
// ============================================================================
export async function collectBillingEvidence(
  ctx: VerifyContext,
  taskResult: TaskEvidenceResult,
  options: VerifyKernelOptions,
): Promise<BillingEvidenceResult> {
  const { taskId, session, sessionLoadError, expectedPoints, expectedChargeSource, contract } = ctx;
  const { terminalStatus } = taskResult;

  let scoreLogsToReconcile: ScoreLogEntry[] | undefined = options.scoreLogs;
  let billingSource = options.scoreLogs ? 'score_logs' : 'missing_logs';
  let billingQueryError: string | undefined;

  // 优先采用数据库物理落库流水 (Physical Database Records from pq_score_log)
  if (!scoreLogsToReconcile && taskResult.dbEvidence?.recordsFound?.pq_score_log) {
    const dbLogs = taskResult.dbEvidence.recordsFound.pq_score_log;
    const backendId =
      taskResult.dbEvidence.recordsFound.pq_volcengine_ai_task?.id !== undefined
        ? Number(taskResult.dbEvidence.recordsFound.pq_volcengine_ai_task.id)
        : undefined;
    const mapped = mapDbScoreLogsToScoreLogEntries(dbLogs, taskId, backendId);
    if (mapped.length > 0) {
      scoreLogsToReconcile = mapped;
      billingSource = 'DATABASE_PHYSICAL_RECORD:pq_score_log';
      billingQueryError = undefined;
    }
  }

  // 兜底回退：当无数据库流水且存在 session 时，调用 FastAdmin HTTP 接口查询
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
  const billingTerminalStatus = terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus;
  const billing = hasScoreLogs
    ? BillingOracle.reconcileTaskLedger({
        taskId,
        terminalStatus: billingTerminalStatus,
        expectedPoints,
        expectedChargeSource,
        scoreLogs: scoreLogsToReconcile!,
      })
    : undefined;

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
      billing.refundIdempotency === false,
    );
    const billingStatus: EvidenceStatus = hasBillingViolations ? 'FAIL' : billing.passed ? 'PASS' : 'UNVERIFIED';

    const isSuccessEmpty = scoreLogsToReconcile && scoreLogsToReconcile.length === 0;
    const reason = !billing.passed
      ? isSuccessEmpty
        ? '真实数据源明确确认该任务在查询范围内无流水记录 [QUERY_SUCCESS + 0 records]'
        : billing.reasons.join(', ')
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

    const antiDoubleItem: InvariantDetail =
      antiDouble === true
        ? { status: 'PASS', evidence: { preDeductCount: billing.preDeductCount } }
        : antiDouble === false
          ? { status: 'FAIL', reason: '违背防重复扣费不变量: 存在多笔扣费或重复扣款' }
          : { status: 'UNVERIFIED', reason: '缺少有效预扣流水，防重复扣费不变量未核验 [UNVERIFIED]' };

    const netZeroItem: InvariantDetail =
      netZero === true
        ? { status: 'PASS', evidence: { netDeductedPoints: billing.netDeductedPoints } }
        : netZero === false
          ? {
              status: 'FAIL',
              reason:
                terminalStatus === 'FAILED'
                  ? '违背失败净扣归零不变量: 失败任务净扣不为 0 或少/超额退款'
                  : '计费不匹配预期扣费',
            }
          : { status: 'UNVERIFIED', reason: '任务终态未知或缺少有效账务记录，失败净扣归零不变量未核验 [UNVERIFIED]' };

    const refundIdemItem: InvariantDetail =
      refundIdem === true
        ? { status: 'PASS', evidence: { refundCount: billing.refundCount } }
        : refundIdem === false
          ? { status: 'FAIL', reason: '违背退款幂等核销不变量: 存在重复退款、异常退款或失败未退款' }
          : { status: 'UNVERIFIED', reason: '缺少有效预扣或退款流水，退款幂等核销不变量未核验 [UNVERIFIED]' };

    const anyInvFailed =
      antiDoubleItem.status === 'FAIL' || netZeroItem.status === 'FAIL' || refundIdemItem.status === 'FAIL';
    const allInvPassed =
      antiDoubleItem.status === 'PASS' && netZeroItem.status === 'PASS' && refundIdemItem.status === 'PASS';
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
      reason: anyInvFailed
        ? [antiDoubleItem.reason, netZeroItem.reason, refundIdemItem.reason].filter(Boolean).join('; ')
        : undefined,
    };

    invariants = billing
      ? {
          antiDoubleBilling: antiDouble === true,
          netChargeZero: netZero === true,
          refundIdempotency: refundIdem === true,
        }
      : undefined;
  } else {
    const skipReason = sessionLoadError
      ? `凭据加载失败 (${sessionLoadError})，缺少真实账务证据 [UNVERIFIED]`
      : billingQueryError
        ? `账单流水查询异常 (${billingQueryError})，缺少真实账务证据 [UNVERIFIED]`
        : terminalStatus === 'FAILED'
          ? '未提供账单流水，无法核验失败退款净扣归零，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]'
          : '未提供账单流水，缺少真实账务证据获取能力 [SKIPPED_NO_LOGS]';
    billingEvidence = {
      status: 'UNVERIFIED',
      source: billingSource,
      expectedPoints,
      expectedChargeSource,
      reason: skipReason,
    };
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

  if (!contract.pricing.allowPass) {
    billingEvidence = {
      ...billingEvidence,
      status: 'UNVERIFIED',
      reason: `真实刊例定价未确定 (${contract.pricing.source})，不可用于生产 PASS 验收 [BLOCKED_FALLBACK_PRICING]`,
    };
  }

  return {
    billing,
    billingEvidence,
    invariantsEvidence,
    invariants,
    billingSource,
    scoreLogsToReconcile,
  };
}

// ============================================================================
// Helper 5: computeRegressionDiff
// ============================================================================
export function computeRegressionDiff(
  baseline: DiversionBaseline | undefined,
  contract: ReturnType<typeof discoverModelContract>,
  billing: ReturnType<typeof BillingOracle.reconcileTaskLedger> | undefined,
  expectedPoints: number,
  artifact: ReturnType<typeof inspectMp4Buffer> | undefined,
  billingEvidence: BillingEvidence,
  mediaEvidence: MediaEvidence,
  isDbExtraVerified: boolean,
  isGatewayChannelRequired: boolean,
  isGatewayChannelVerified: boolean,
  terminalStatus?: string,
): DiversionRegressionDiff | undefined {
  if (!baseline) return undefined;

  const expectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }> = [];
  const observedChanges: Array<{ field: string; before: unknown; after: unknown }> = [];
  const unexpectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }> = [];
  const missingEvidence: string[] = [];

  // 1. 路由变化比对
  const currentRouting = contract.routing.value;
  const willDivertChanged = baseline.willDivert !== currentRouting.willDivert;
  const routeLineChanged = baseline.routeLine !== currentRouting.routeLine;
  if (willDivertChanged || routeLineChanged) {
    observedChanges.push({
      field: 'routing',
      before: `${baseline.decision} (line:${baseline.routeLine}, divert:${baseline.willDivert})`,
      after: `${currentRouting.decision} (line:${currentRouting.routeLine}, divert:${currentRouting.willDivert})`,
    });
    if (currentRouting.willDivert) {
      expectedChanges.push({
        field: 'routing',
        before: `${baseline.decision} (line:${baseline.routeLine})`,
        after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
        reason: '分流规则变更按预期切换至 NewAPI 路由',
      });
    } else {
      unexpectedChanges.push({
        field: 'routing',
        before: `${baseline.decision} (line:${baseline.routeLine})`,
        after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
        reason: '分流变更未能成功使流量切换至 NewAPI，仍为 Direct',
      });
    }
  } else if (!currentRouting.willDivert) {
    unexpectedChanges.push({
      field: 'routing',
      before: `${baseline.decision} (line:${baseline.routeLine})`,
      after: `${currentRouting.decision} (line:${currentRouting.routeLine})`,
      reason: '分流变更未生效，路由未发生预期切换 (未分流至 NewAPI)',
    });
  }

  // 2. 积分对账漂移比对
  const actualPoints = billing ? billing.netDeductedPoints : expectedPoints;
  if (actualPoints !== baseline.expectedPoints) {
    unexpectedChanges.push({
      field: 'billingPoints',
      before: baseline.expectedPoints,
      after: actualPoints,
      reason: `分流变更导致扣费积分发生非预期漂移 (基线: ${baseline.expectedPoints} pt, 实际: ${actualPoints} pt)`,
    });
    observedChanges.push({
      field: 'billingPoints',
      before: baseline.expectedPoints,
      after: actualPoints,
    });
  }

  // 3. 产物完整性与格式比对
  if (artifact) {
    if (!artifact.decodable) {
      unexpectedChanges.push({
        field: 'artifactDecodability',
        before: true,
        after: false,
        reason: '分流变更后产物损坏不可解码',
      });
      observedChanges.push({
        field: 'artifactDecodability',
        before: true,
        after: false,
      });
    }
    if (artifact.format && baseline.artifactFormat) {
      const actualFmt = artifact.format.toLowerCase();
      const baseFmt = baseline.artifactFormat.toLowerCase();
      const matches =
        (baseFmt === 'png/jpg' &&
          (actualFmt.includes('png') || actualFmt.includes('jpg') || actualFmt.includes('jpeg'))) ||
        (baseFmt === 'mp4' && actualFmt.includes('mp4')) ||
        actualFmt.includes(baseFmt) ||
        baseFmt.includes(actualFmt);
      if (!matches) {
        unexpectedChanges.push({
          field: 'artifactFormat',
          before: baseline.artifactFormat,
          after: artifact.format,
          reason: `分流变更后产物格式与基线不一致 (基线: ${baseline.artifactFormat}, 实际: ${artifact.format})`,
        });
        observedChanges.push({
          field: 'artifactFormat',
          before: baseline.artifactFormat,
          after: artifact.format,
        });
      }
    }
  }

  // 4. 别名一致性比对
  if (baseline.alias && contract.alias.value && baseline.alias !== contract.alias.value) {
    unexpectedChanges.push({
      field: 'alias',
      before: baseline.alias,
      after: contract.alias.value,
      reason: `模型别名与基线不一致 (基线: ${baseline.alias}, 实际: ${contract.alias.value})，可能导致既有业务调用失效`,
    });
    observedChanges.push({
      field: 'alias',
      before: baseline.alias,
      after: contract.alias.value,
    });
  }

  // 5. 关键证据缺失记录
  if (billingEvidence.status === 'UNVERIFIED') {
    missingEvidence.push('billingEvidence: 缺失实际账单流水证据');
  }
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') {
    missingEvidence.push('mediaEvidence: 缺失物理产物验证证据');
  }
  if (!isDbExtraVerified) {
    missingEvidence.push('MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion (需DB只读核查 extra.diversion=10)');
  }
  if (isGatewayChannelRequired && !isGatewayChannelVerified) {
    missingEvidence.push('MANUAL_GATEWAY_CHANNEL_REQUIRED:缺少 NewAPI 视频模型网关渠道证据');
  }

  const isRegression = unexpectedChanges.length > 0;
  let regressionStatus: 'CLEAN' | 'REGRESSION' | 'UNKNOWN';
  if (unexpectedChanges.length > 0) {
    regressionStatus = 'REGRESSION';
  } else if (missingEvidence.length > 0) {
    regressionStatus = 'UNKNOWN';
  } else {
    regressionStatus = 'CLEAN';
  }

  return {
    expectedChanges,
    observedChanges,
    unexpectedChanges,
    missingEvidence,
    isRegression,
    regressionStatus,
  };
}

// ============================================================================
// Helper 6: buildDiffItems
// ============================================================================
export function buildDiffItems(args: BuildDiffItemsOptions): DiffItem[] {
  const { options, ctx, taskResult, mediaResult, billingResult, regressionDiff } = args;
  const { mediaType, expectedPoints, contract, resolution } = ctx;
  const { terminalStatus, taskEvidence, artifactBuffer, mediaArtifactSource, runtimeDetails, routingFacts } =
    taskResult;
  const { artifact } = mediaResult;
  const { billing, billingSource } = billingResult;
  const {
    isDbExtraVerified,
    extraObj,
    extraProvenance,
    hasEvidenceConflict,
    conflictReasons,
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    channelMismatchReason,
    isActualChannelAssertedOnly,
    fallbackChannel,
    retryProvider,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    hasRealGatewaySnapshot,
    hasServerActualChannelFact,
    serverActualChannelId,
    snapshotValidation,
    isRealMode,
    gatewayChannelEvidence,
  } = routingFacts;

  const businessValidation =
    args.businessValidation ||
    evaluateBusinessVerification({
      taskId: ctx.taskId,
      modelId: ctx.modelId,
      mediaType: ctx.mediaType,
      apiResult: options.apiResult,
      taskTerminalStatus: terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus,
      mediaEvidence: {
        status: mediaResult.mediaEvidence.status,
        format: mediaResult.mediaEvidence.format,
        decodable: mediaResult.mediaEvidence.decodable,
        ownership: mediaResult.mediaEvidence.ownership,
        reason: mediaResult.mediaEvidence.reason,
      },
      billingEvidence: {
        status: billingResult.billingEvidence.status,
        netDeductedPoints: billingResult.billingEvidence.netDeductedPoints,
        expectedPoints: billingResult.billingEvidence.expectedPoints,
        reason: billingResult.billingEvidence.reason,
      },
      invariantsEvidence: {
        status: billingResult.invariantsEvidence.status,
        antiDoubleBilling: billingResult.invariantsEvidence.antiDoubleBilling,
        netChargeZero: billingResult.invariantsEvidence.netChargeZero,
        refundIdempotency: billingResult.invariantsEvidence.refundIdempotency,
        reason: billingResult.invariantsEvidence.reason,
      },
      paramRelations:
        options.projectId !== undefined || options.folderId !== undefined || options.isFolderInProject !== undefined
          ? {
              projectId: options.projectId,
              folderId: options.folderId,
              isFolderInProject: options.isFolderInProject,
            }
          : undefined,
      channelAssertion:
        targetChannelId !== undefined
          ? {
              targetChannelId,
              targetChannelName,
              actualChannelId,
              actualChannelName,
              fallbackChannel,
              retryProvider,
              hasEvidenceConflict,
              conflictReasons,
              isActualChannelAssertedOnly,
            }
          : undefined,
    });

  const diffItems: DiffItem[] = [
    {
      field: 'taskStatus',
      layer: 'execution',
      expected: options.terminalStatus ?? 'SUCCESS',
      actual: terminalStatus,
      matched: terminalStatus === (options.terminalStatus ?? 'SUCCESS'),
      status:
        terminalStatus === (options.terminalStatus ?? 'SUCCESS')
          ? 'PASS'
          : terminalStatus === 'UNKNOWN'
            ? 'BLOCKED'
            : 'FAIL',
      diff:
        terminalStatus === (options.terminalStatus ?? 'SUCCESS')
          ? 'MATCH'
          : `Expected ${options.terminalStatus ?? 'SUCCESS'}, got ${terminalStatus}`,
      critical: true,
      evidence: taskEvidence.source,
    },
    {
      field: 'mediaFormat',
      layer: 'artifact',
      expected: mediaType === 'video' ? 'mp4' : 'png/jpg',
      actual: artifact?.format || (terminalStatus === 'FAILED' ? 'NONE_TASK_FAILED' : 'MISSING_MEDIA'),
      matched: terminalStatus === 'FAILED' ? true : Boolean(artifact?.decodable),
      status: terminalStatus === 'FAILED' ? 'PASS' : artifact?.decodable ? 'PASS' : artifactBuffer ? 'FAIL' : 'BLOCKED',
      diff:
        terminalStatus === 'FAILED'
          ? 'MATCH (失败任务无产物)'
          : artifact?.decodable
            ? 'MATCH'
            : artifactBuffer
              ? `产物无法解码: ${artifact?.format || 'CORRUPTED'}`
              : '缺少媒体产物证据 [BLOCKED]',
      critical: true,
      evidence: mediaArtifactSource,
    },
    {
      field: 'billingPoints',
      layer: 'billing',
      expected: terminalStatus === 'FAILED' ? 0 : expectedPoints,
      actual: billing ? billing.netDeductedPoints : 'NO_SCORE_LOGS',
      matched: billing
        ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints) && contract.pricing.allowPass
        : false,
      status: !contract.pricing.allowPass
        ? 'BLOCKED'
        : billing
          ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints)
            ? 'PASS'
            : 'FAIL'
          : 'BLOCKED',
      diff: !contract.pricing.allowPass
        ? `刊例定价未确定 (${contract.pricing.source}) [BLOCKED]`
        : billing
          ? billing.netDeductedPoints === (terminalStatus === 'FAILED' ? 0 : expectedPoints)
            ? 'MATCH'
            : `Expected ${terminalStatus === 'FAILED' ? 0 : expectedPoints} pts, got ${billing.netDeductedPoints} pts`
          : '未提供账单流水，缺少真实账务证据 [BLOCKED_NO_LOGS]',
      critical: true,
      evidence: billingSource,
    },
    {
      field: 'diversionExtra',
      layer: 'routing',
      expected: contract.isGlobal.value
        ? 'extra.diversion=10 (global)'
        : 'extra.diversion=10 (org) / extra.newapi_image=1',
      actual: isDbExtraVerified
        ? `CONFIRMED_VIA_READONLY_HTTP_API (${JSON.stringify(extraObj)})`
        : runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? 'UNVERIFIED_MISSING_PROJECT_ID'
          : 'NOT_FOUND_IN_HTTP_API_OR_DB (MANUAL_REQUIRED)',
      matched: isDbExtraVerified,
      status: isDbExtraVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isDbExtraVerified
        ? 'MATCH'
        : runtimeDetails?.endpoints?.getEditData?.queryStatus === 'UNVERIFIED_MISSING_PROJECT_ID'
          ? '缺少 projectId，无法查询 /aivideo/v2/video/getEditData 接口 [UNVERIFIED_MISSING_PROJECT_ID]'
          : '未从只读 HTTP 接口获取到 extra.diversion，需以只读权限查询 DB 验证落库 [MANUAL_REQUIRED]',
      critical: false,
      evidence: extraProvenance,
    },
    {
      field: 'businessValidation',
      layer: 'domain',
      expected: 'BUSINESS_SUCCESS',
      actual: businessValidation.businessSuccess
        ? 'BUSINESS_SUCCESS'
        : businessValidation.status === 'FAIL'
          ? 'BUSINESS_FAIL'
          : 'BUSINESS_UNVERIFIED',
      matched: businessValidation.businessSuccess,
      status: businessValidation.businessSuccess ? 'PASS' : businessValidation.status === 'FAIL' ? 'FAIL' : 'BLOCKED',
      diff: businessValidation.businessSuccess
        ? 'MATCH'
        : businessValidation.reasons.join('; ') || '业务级验证未全部满足',
      critical: true,
      evidence: 'evaluateBusinessVerification',
    },
  ];

  if (hasEvidenceConflict) {
    diffItems.push({
      field: 'evidenceConflict',
      layer: 'routing',
      expected: 'Caller assertions match server facts',
      actual: 'EVIDENCE_CONFLICT',
      matched: false,
      status: 'FAIL',
      diff: conflictReasons.join('; '),
      critical: true,
      evidence: 'EVIDENCE_CONFLICT',
    });
  }

  if (targetChannelId !== undefined) {
    diffItems.push({
      field: 'channelAttribution',
      layer: 'routing',
      expected: `Channel #${targetChannelId} ('${targetChannelName || targetChannelId}')`,
      actual:
        actualChannelId !== undefined
          ? `Channel #${actualChannelId} ('${actualChannelName || actualChannelId}')${isFallbackExecution ? ` [Fallback: ${fallbackChannel || retryProvider}]` : ''}`
          : 'UNVERIFIED_RUNTIME_CHANNEL',
      matched: channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly,
      status:
        channelMatched === true && !isFallbackExecution && !hasEvidenceConflict && !isActualChannelAssertedOnly
          ? 'PASS'
          : channelMatched === false || isFallbackExecution || hasEvidenceConflict
            ? 'FAIL'
            : 'BLOCKED',
      diff: hasEvidenceConflict
        ? `存在证据冲突: ${conflictReasons.join('; ')}`
        : isActualChannelAssertedOnly
          ? '实际执行渠道仅来自调用者入参断言，无服务端运行时证据证实 [UNVERIFIED_ASSERTED_INPUT]'
          : channelMismatchReason || 'MATCH',
      critical: true,
      evidence: channelProvenance,
    });
  }

  if (isGatewayChannelRequired) {
    const isCallerAssertedReal =
      isRealMode &&
      (Boolean(options.gatewayChannelConfirmed) ||
        Boolean(options.channels && options.channels.some((c) => c.sourceMode === 'SOURCE_REAL_GATEWAY')));
    const snapshotFailure = options.gatewaySnapshot && !snapshotValidation?.valid;

    diffItems.push({
      field: 'gatewayChannel',
      layer: 'routing',
      expected: 'NewAPI upstream channel configured',
      actual: isGatewayChannelVerified
        ? hasRealGatewaySnapshot
          ? `${(options.gatewaySnapshot?.channels || options.channels)?.length} channel(s) (REAL_GATEWAY_SNAPSHOT)`
          : hasServerActualChannelFact
            ? `Channel #${serverActualChannelId}`
            : 'CONFIRMED (FIXTURE)'
        : snapshotFailure
          ? `FAIL_CLOSED (${snapshotValidation?.reason})`
          : isCallerAssertedReal
            ? 'UNVERIFIED_USER_ASSERTION (REAL 模式禁止外部断言作为网关实际渠道履约证据)'
            : 'MISSING_GATEWAY_CHANNEL_EVIDENCE [BLOCKED_MISSING_TRUSTED_COLLECTOR]',
      matched: isGatewayChannelVerified,
      status: isGatewayChannelVerified ? 'PASS' : 'MANUAL_REQUIRED',
      diff: isGatewayChannelVerified
        ? 'MATCH (网关实际履约渠道已核验)'
        : snapshotFailure
          ? `网关渠道快照未通过可信校验: ${snapshotValidation?.reason} [FAIL_CLOSED]`
          : isCallerAssertedReal
            ? 'REAL 模式下禁止仅凭外部断言 (--gateway-channel-confirmed) 满足网关渠道验证，必须提供 NewAPI 网关真实快照 (SOURCE_REAL_GATEWAY) [BLOCKED_MISSING_TRUSTED_COLLECTOR]'
            : '缺少 NewAPI 网关上游通道确认证据 [MANUAL_GATEWAY_CHANNEL_REQUIRED:BLOCKED_MISSING_TRUSTED_COLLECTOR]',
      critical: true,
      evidence: gatewayChannelEvidence,
    });
  }

  if (options.unconfirmedStatic) {
    diffItems.push({
      field: 'staticContractConfirmation',
      layer: 'contract',
      expected: 'Static contract confirmed by real data/manual input',
      actual: 'UNCONFIRMED_STATIC',
      matched: false,
      status: 'BLOCKED',
      diff: '静态契约未经过线上事实或人工输入验真 [BLOCKED]',
      critical: true,
      evidence: 'SOURCE_STATIC_CONTRACT',
    });
  }

  if (artifact?.dimensions) {
    const expectedRes = options.expectedResolution || resolution || '720p';
    diffItems.push({
      field: 'dimensions',
      layer: 'artifact',
      expected: expectedRes,
      actual: `${artifact.dimensions.width}x${artifact.dimensions.height}`,
      matched: true,
      status: 'PASS',
      diff: 'MATCH',
      critical: false,
      evidence: `${mediaArtifactSource}:${artifact.format}`,
    });
  }

  if (regressionDiff) {
    diffItems.push({
      field: 'diversionRegression',
      layer: 'regression',
      expected: 'No unexpected changes',
      actual: regressionDiff.isRegression
        ? `${regressionDiff.unexpectedChanges.length} unexpected change(s)`
        : regressionDiff.regressionStatus === 'UNKNOWN'
          ? 'Regression status unknown (missing evidence)'
          : 'Clean (no regression)',
      matched: !regressionDiff.isRegression && regressionDiff.regressionStatus === 'CLEAN',
      status: regressionDiff.isRegression ? 'FAIL' : regressionDiff.regressionStatus === 'UNKNOWN' ? 'BLOCKED' : 'PASS',
      diff: regressionDiff.isRegression
        ? regressionDiff.unexpectedChanges.map((u) => u.reason).join('; ')
        : regressionDiff.regressionStatus === 'UNKNOWN'
          ? '缺少基线比对关键证据，无法确定无回归 [regressionStatus: UNKNOWN]'
          : 'MATCH',
      critical: true,
      evidence: 'BaselineComparison',
    });
  }

  if (contract.conflicts.length > 0) {
    diffItems.push({
      field: 'configurationConsistency',
      layer: 'contract',
      expected: 'No config conflicts',
      actual: `${contract.conflicts.length} conflict(s): ${contract.conflicts.map((c) => c.message).join('; ')}`,
      matched: false,
      status: 'FAIL',
      diff: contract.conflicts.map((c) => c.message).join('; '),
      critical: true,
      evidence: 'CONFIG_MISMATCH',
    });
  }

  return diffItems;
}

// ============================================================================
// Helper 7: computeFinalVerdict
// ============================================================================
export async function computeFinalVerdict(args: ComputeFinalVerdictArgs): Promise<VerifyKernelResult> {
  const { options, ctx, taskResult, mediaResult, billingResult, regressionDiff, diffItems } = args;

  const { taskId, modelId, mediaType, contract, expectedPoints, session, executionMode } = ctx;
  const { terminalStatus, taskEvidence, artifactBuffer, artifactOwnership, routingFacts } = taskResult;
  const { artifact, mediaEvidence } = mediaResult;
  const { billing, billingEvidence, invariants, scoreLogsToReconcile } = billingResult;
  const {
    targetChannelId,
    targetChannelName,
    actualChannelId,
    actualChannelName,
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    isFallbackExecution,
    channelMatched,
    channelProvenance,
    fallbackProvenance,
    retryProvenance,
    extraProvenance,
    gatewayChannelProvenance,
    isDbExtraVerified,
    isGatewayChannelRequired,
    isGatewayChannelVerified,
    targetChannelFailed,
    targetChannelUnverified: _targetChannelUnverified,
    snapshotValidation,
    fallbackChannel,
    retryProvider,
    channelMismatchReason,
    extraObj,
    hasRealGatewaySnapshot,
    isRealMode,
  } = routingFacts;

  const businessValidation =
    args.businessValidation ||
    evaluateBusinessVerification({
      taskId,
      modelId,
      mediaType,
      apiResult: options.apiResult,
      taskTerminalStatus: terminalStatus === 'PROCESSING' ? 'UNKNOWN' : terminalStatus,
      mediaEvidence: {
        status: mediaEvidence.status,
        format: mediaEvidence.format,
        decodable: mediaEvidence.decodable,
        ownership: mediaEvidence.ownership,
        reason: mediaEvidence.reason,
      },
      billingEvidence: {
        status: billingEvidence.status,
        netDeductedPoints: billingEvidence.netDeductedPoints,
        expectedPoints: billingEvidence.expectedPoints,
        reason: billingEvidence.reason,
      },
      invariantsEvidence: {
        status: billingResult.invariantsEvidence.status,
        antiDoubleBilling: billingResult.invariantsEvidence.antiDoubleBilling,
        netChargeZero: billingResult.invariantsEvidence.netChargeZero,
        refundIdempotency: billingResult.invariantsEvidence.refundIdempotency,
        reason: billingResult.invariantsEvidence.reason,
      },
      paramRelations:
        options.projectId !== undefined || options.folderId !== undefined || options.isFolderInProject !== undefined
          ? {
              projectId: options.projectId,
              folderId: options.folderId,
              isFolderInProject: options.isFolderInProject,
            }
          : undefined,
      channelAssertion:
        targetChannelId !== undefined
          ? {
              targetChannelId,
              targetChannelName,
              actualChannelId,
              actualChannelName,
              fallbackChannel,
              retryProvider,
              hasEvidenceConflict,
              conflictReasons,
              isActualChannelAssertedOnly,
            }
          : undefined,
    });

  const reasons: string[] = [];
  if (taskEvidence.status === 'PROCESSING' || terminalStatus === 'PROCESSING') {
    reasons.push(
      `任务 #${taskId} 仍在排队/生成中 (进度: ${taskEvidence.progress ?? options.progress ?? 0}%)，未到达终态。`,
    );
  }
  if (taskEvidence.status === 'FAIL') reasons.push(`任务执行失败: ${taskEvidence.error || '任务状态异常'}`);
  if (taskEvidence.status === 'UNVERIFIED') reasons.push(taskEvidence.error || '任务状态未确认 [UNVERIFIED]');
  if (mediaEvidence.status === 'FAIL') reasons.push(`产物物理完整性校验失败: ${mediaEvidence.reason || '文件损坏'}`);
  if (mediaEvidence.status === 'UNVERIFIED' && terminalStatus !== 'FAILED') {
    reasons.push(mediaEvidence.reason || '媒体产物状态未确认 [UNVERIFIED]');
  }
  if (billingEvidence.status === 'FAIL') reasons.push(`账单审计失败: ${billingEvidence.reason}`);
  if (billingEvidence.status === 'UNVERIFIED') {
    reasons.push(billingEvidence.reason || '账单流水证据未确认 [UNVERIFIED]');
  }
  if (billingResult.invariantsEvidence.status === 'FAIL') {
    reasons.push(billingResult.invariantsEvidence.reason || '违背金融安全不变量 [FAIL]');
  }
  if (regressionDiff?.isRegression) {
    for (const u of regressionDiff.unexpectedChanges) {
      reasons.push(`[分流回归阻断] ${u.reason}`);
    }
  }
  if (contract.conflicts.length > 0) {
    for (const c of contract.conflicts) {
      reasons.push(`[配置冲突] ${c.message}`);
    }
  }
  if (hasEvidenceConflict) {
    for (const c of conflictReasons) {
      if (!reasons.includes(c)) reasons.push(c);
    }
  }
  if (isActualChannelAssertedOnly) {
    reasons.push('实际执行渠道仅来自调用者入参断言，无服务端运行时证据证实 [PROVISIONAL_EVIDENCE]');
  }
  if (channelMismatchReason) {
    reasons.push(`[渠道履约失败] ${channelMismatchReason}`);
  }
  if (businessValidation.status === 'FAIL') {
    for (const r of businessValidation.reasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  // 证据完整度计算
  const requiredEvidence: string[] = [
    'taskTerminalStatus',
    'mediaArtifactDecodable',
    'billingLedgerReconciled',
    'pricingDetermined',
    'diversionDbExtra',
  ];
  if (isGatewayChannelRequired) {
    requiredEvidence.push('gatewayChannelConfirmed');
  }
  if (targetChannelId !== undefined) {
    requiredEvidence.push('targetChannelFulfilled');
  }
  if (options.baseline) {
    requiredEvidence.push('baselineRegressionVerified');
  }

  const availableEvidence: string[] = [];
  const missingEvidence: string[] = [];

  if (taskEvidence.status === 'PASS' || (terminalStatus === 'FAILED' && options.terminalStatus === 'FAILED')) {
    availableEvidence.push('taskTerminalStatus');
  } else {
    missingEvidence.push(
      taskEvidence.status === 'FAIL' ? 'taskTerminalStatus:FAILED' : 'taskTerminalStatus:UNVERIFIED',
    );
  }

  if (mediaEvidence.status === 'PASS' || (terminalStatus === 'FAILED' && !artifactBuffer)) {
    availableEvidence.push('mediaArtifactDecodable');
  } else {
    missingEvidence.push(
      mediaEvidence.status === 'FAIL' ? 'mediaArtifactDecodable:CORRUPTED' : 'mediaArtifactDecodable:UNVERIFIED',
    );
  }

  if (billingEvidence.status === 'PASS') {
    availableEvidence.push('billingLedgerReconciled');
  } else {
    missingEvidence.push(
      billingEvidence.status === 'FAIL' ? 'billingLedgerReconciled:AUDIT_FAILED' : 'billingLedgerReconciled:NO_LOGS',
    );
  }

  if (
    contract.pricing.allowPass &&
    contract.pricing.isPricingDetermined &&
    contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK'
  ) {
    availableEvidence.push('pricingDetermined');
  } else {
    missingEvidence.push(`pricingDetermined:${contract.pricing.source}`);
  }

  if (isDbExtraVerified) {
    availableEvidence.push('diversionDbExtra');
  } else {
    missingEvidence.push('MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion');
  }

  if (isGatewayChannelRequired) {
    if (isGatewayChannelVerified) {
      availableEvidence.push('gatewayChannelConfirmed');
    } else {
      missingEvidence.push('MANUAL_GATEWAY_CHANNEL_REQUIRED:gatewayChannel');
    }
  }

  if (targetChannelId !== undefined) {
    if (channelMatched === true && !isFallbackExecution) {
      availableEvidence.push('targetChannelFulfilled');
    } else if (targetChannelFailed) {
      missingEvidence.push('targetChannelFulfilled:FAILED');
    } else {
      missingEvidence.push('targetChannelFulfilled:UNVERIFIED');
    }
  }

  if (options.baseline) {
    if (regressionDiff && regressionDiff.regressionStatus === 'CLEAN') {
      availableEvidence.push('baselineRegressionVerified');
    } else if (regressionDiff && regressionDiff.regressionStatus === 'REGRESSION') {
      missingEvidence.push('baselineRegressionVerified:REGRESSION_DETECTED');
    } else {
      missingEvidence.push('baselineRegressionVerified:UNKNOWN_DUE_TO_MISSING_EVIDENCE');
    }
  }

  const isComplete = missingEvidence.length === 0;
  const evidenceCompleteness: EvidenceCompleteness = {
    requiredEvidence,
    availableEvidence,
    missingEvidence,
    isComplete,
  };

  // ==========================================================================
  // Canonical Verdict Engine 唯一最终业务裁决求值
  // ==========================================================================
  const capturedAt = options.capturedAt || new Date().toISOString();
  const testId = options.testId || options.spec?.testId || `verify-${taskId}`;
  const environment = options.environment || options.spec?.environment || options.env || 'test';
  const rawMode: 'real' | 'offline' | 'fixture' =
    options.mode === 'mock' || options.isSimulated || executionMode === 'offline'
      ? 'offline'
      : executionMode === 'fixture'
        ? 'fixture'
        : executionMode === 'real' || options.executionMode?.toLowerCase() === 'real'
          ? 'real'
          : session
            ? 'real'
            : 'fixture';
  const canonicalExecutionMode: ExecutionMode =
    rawMode === 'real' ? 'REAL' : rawMode === 'offline' ? 'OFFLINE' : 'FIXTURE';

  const facts: CanonicalVerifyFacts = {
    testId,
    capturedAt,
    environment,
    executionMode: rawMode,
    taskId,
    modelId,
    mediaType,
    progress: options.progress,
    task: taskEvidence,
    artifact: artifact
      ? {
          ...artifact,
          ownership: artifactOwnership,
          status: mediaEvidence.status,
        }
      : undefined,
    artifactOwnership,
    billing: billing
      ? {
          status: billingEvidence.status,
          passed: billing.passed,
          settledPoints: billing.settledPoints,
          netDeductedPoints: billing.netDeductedPoints,
          preDeductedPoints: billing.preDeductedPoints,
          expectedPoints,
          hasViolations: Boolean(
            billing.duplicateCharged ||
            billing.duplicateRefunded ||
            billing.missingRefund ||
            billing.underCharged ||
            billing.overCharged ||
            billing.antiDoubleBilling === false ||
            billing.netChargeZero === false ||
            billing.refundIdempotency === false,
          ),
        }
      : undefined,
    billingAudit: billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0 ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    expectedChargeSource: billingEvidence?.expectedChargeSource,
    pricingAllowPass: contract?.pricing?.allowPass,
    invariants,
    channelDetail: businessValidation?.channelDetail,
    provenance: {
      actualChannelId: channelProvenance,
      fallbackChannel: fallbackProvenance,
      retryProvider: retryProvenance,
      extra: extraProvenance,
      gatewayChannel: gatewayChannelProvenance,
    },
    isActualChannelAssertedOnly,
    hasEvidenceConflict,
    conflictReasons,
    regressionDiff: regressionDiff
      ? {
          isRegression: regressionDiff.isRegression,
          regressionStatus: regressionDiff.regressionStatus,
          unexpectedChanges: regressionDiff.unexpectedChanges,
        }
      : undefined,
    contractConflicts: contract.conflicts.length > 0 ? contract.conflicts : undefined,
    businessValidationStatus: businessValidation.status,
    gatewayChannelFact:
      isGatewayChannelRequired && (options.gatewaySnapshot || options.gatewayChannelConfirmed || options.channels)
        ? {
            verified: isGatewayChannelVerified,
            required: true,
            failureReason:
              options.gatewaySnapshot && !snapshotValidation?.valid
                ? snapshotValidation?.reason
                : isRealMode && !hasRealGatewaySnapshot
                  ? '真实模式下外部断言 (--gateway-channel-confirmed) 严禁作为网关履约事实，缺少 NewAPI 网关真实快照'
                  : undefined,
          }
        : undefined,
    isDbExtraVerified,
  };

  const evidenceRes = buildCanonicalEvidenceFromVerifyFacts(facts);
  let envelopes: CanonicalEvidenceEnvelope[] = evidenceRes.success && evidenceRes.value ? evidenceRes.value : [];
  if (Array.isArray(options.extraEnvelopes)) {
    envelopes = [...envelopes, ...options.extraEnvelopes];
  }

  // 聚合 options.evidenceProducers 产出的真实观察信封
  const producers = [...(options.evidenceProducers ?? [])];
  const dbCollectionToUse = taskResult.dbEvidence ?? options.dbRawCollection;
  const hasDbProducer = producers.some((p) => p.producerName === 'database-evidence-producer');
  const shouldAttachDbProducer =
    !hasDbProducer &&
    (dbCollectionToUse !== undefined ||
      options.dbVerify === true ||
      (options.dbVerify !== false && !process.env.VITEST && Boolean(resolveDatabaseCredentialsPath(options.dbCredPath))));

  if (shouldAttachDbProducer) {
    producers.push(new DatabaseEvidenceProducer());
  }

  // opt-in：分流运行时资格断言（预测 vs 落库分流标记）。diversionEligibility 直传优先；
  // 否则 autoDiversionEligibility 一键读 line=10 配置自动构造（VITEST 下不触网）。
  const hasDiversionProducer = producers.some((p) => p.producerName === 'diversion-eligibility-producer');
  const effectiveDiversionEligibility =
    options.diversionEligibility ?? (options.autoDiversionEligibility ? await buildAutoDiversionEligibility(options, modelId) : undefined);
  if (!hasDiversionProducer && effectiveDiversionEligibility) {
    producers.push(new DiversionEligibilityProducer(effectiveDiversionEligibility, dbCollectionToUse));
  }

  if (producers.length > 0) {
    const producerContext: EvidenceProducerContext = {
      testId,
      environment,
      subjectType: 'task',
      subjectId: taskId,
      executionMode: canonicalExecutionMode,
      taskId,
      modelId,
      mediaType,
      capturedAt,
    };
    for (const producer of producers) {
      try {
        const raw =
          producer.producerName === 'database-evidence-producer'
            ? dbCollectionToUse
            : producer.producerName.includes('visual') || producer.sourceType === 'AI_OBSERVATION'
              ? (options.uiVisualRawCollection ?? options.uiRawCollection)
              : (options.uiRawCollection ?? options);
        const produced = await producer.produce(raw, producerContext);
        if (Array.isArray(produced)) {
          envelopes.push(...produced);
        }
      } catch (err) {
        envelopes.push({
          evidenceId: `${testId}-${producer.producerName}-err`,
          testId,
          sourceTool: producer.producerName,
          sourceType: producer.sourceType,
          evidenceKey: `${producer.sourceType}:PRODUCER_ERROR`,
          observationStatus: 'UNVERIFIED',
          capturedAt,
          environment,
          subjectType: 'task',
          subjectId: taskId,
          normalizedFields: {
            error: err instanceof Error ? err.message : String(err),
          },
          provenance: `${producer.producerName}:FALLBACK`,
          confidence: 0,
          immutable: true,
          redacted: true,
          collectionStatus: 'COLLECTION_FAILED',
        });
      }
    }
  }

  let canonicalSpec: CanonicalTestSpec;
  if (options.spec) {
    canonicalSpec = options.spec;
    if (hasEvidenceConflict) {
      const isRealSpec = canonicalExecutionMode === 'REAL';
      const conflictKey = isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT';
      const hasConflictReq = canonicalSpec.requiredEvidence.includes(conflictKey);
      const hasConflictAssertion = canonicalSpec.deterministicAssertions.some(
        (a) => a.evidenceKey === conflictKey || a.actualField === 'hasConflict',
      );
      if (!hasConflictReq || !hasConflictAssertion) {
        canonicalSpec = {
          ...canonicalSpec,
          requiredEvidence: hasConflictReq
            ? canonicalSpec.requiredEvidence
            : [...canonicalSpec.requiredEvidence, conflictKey],
          deterministicAssertions: hasConflictAssertion
            ? canonicalSpec.deterministicAssertions
            : [
                ...canonicalSpec.deterministicAssertions,
                {
                  field: 'hasConflict',
                  operator: 'EQUALS',
                  expectedValue: false,
                  description: '无多方证据冲突',
                  critical: true,
                  evidenceKey: conflictKey,
                  actualField: 'hasConflict',
                },
              ],
        };
      }
    }
  } else {
    const isRealSpec = canonicalExecutionMode === 'REAL';
    const taskKey = isRealSpec ? 'SERVER_API:TASK_STATUS' : 'FIXTURE:TASK_STATUS';
    const routingKey = isRealSpec ? 'SERVER_API:ROUTING_CHANNEL' : 'FIXTURE:ROUTING_CHANNEL';

    const reqEvidence: string[] = [taskKey];
    if (mediaType === 'video' || mediaType === 'image') {
      reqEvidence.push('MEDIA_BINARY:CONTAINER_CHECK');
    }
    const isBillingInScope =
      (contract.pricing.allowPass &&
        contract.pricing.isPricingDetermined &&
        contract.pricing.source !== 'SOURCE_DEFAULT_FALLBACK') ||
      (expectedPoints !== undefined && expectedPoints > 0) ||
      (scoreLogsToReconcile && scoreLogsToReconcile.length > 0) ||
      !contract.pricing.allowPass ||
      !contract.pricing.isPricingDetermined;
    if (isBillingInScope) {
      reqEvidence.push('BILLING_LEDGER:TASK_RECORDS');
    }
    if (isRealSpec && (dbCollectionToUse !== undefined || options.dbVerify === true || !process.env.VITEST)) {
      reqEvidence.push('SERVER_API:DB_TASK_RECORD');
      if (isBillingInScope || terminalStatus !== 'UNKNOWN' || (expectedPoints !== undefined && expectedPoints > 0)) {
        reqEvidence.push('BILLING_LEDGER:DB_SCORE_LOGS');
      }
    }
    if (targetChannelId !== undefined) {
      reqEvidence.push(routingKey);
    }
    if (options.baseline) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:REGRESSION_BASELINE' : 'FIXTURE:REGRESSION_BASELINE');
    }
    // 业务一致性、证据冲突、领域校验总是加入必需证据 (禁止仅在失败时加入)
    reqEvidence.push(isRealSpec ? 'SERVER_API:CONTRACT_CONSISTENCY' : 'FIXTURE:CONTRACT_CONSISTENCY');
    reqEvidence.push(isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT');
    reqEvidence.push(isRealSpec ? 'SERVER_API:BUSINESS_VALIDATION' : 'FIXTURE:BUSINESS_VALIDATION');

    // 网关渠道证据要求 (REAL 模式或显式传入网关配置/确认时要求)
    const isGatewayInScope =
      isRealSpec ||
      options.gatewayChannelConfirmed !== undefined ||
      options.gatewaySnapshot !== undefined ||
      options.channels !== undefined;
    if (isGatewayChannelRequired && isGatewayInScope) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:GATEWAY_CHANNEL' : 'FIXTURE:GATEWAY_CHANNEL');
    }

    // 需要核验 extra.diversion 时，即使没有 DB/API 证据也必须要求对应 evidenceKey
    const isDiversionScenario =
      contract.scenario === 'IMAGE_DIVERSION_CHANGE' ||
      contract.scenario === 'VIDEO_DIVERSION_CHANGE' ||
      options.changeType === 'diversion_change';
    const isExtraRequired = !contract.isGlobal.value && isDiversionScenario;
    if (isExtraRequired) {
      reqEvidence.push(isRealSpec ? 'SERVER_API:EXTRA_DIVERSION' : 'FIXTURE:EXTRA_DIVERSION');
    }

    const deterministicAssertions: DeterministicAssertion[] = [];

    // 计费断言
    if (
      typeof expectedPoints === 'number' &&
      contract.pricing.allowPass &&
      contract.pricing.isPricingDetermined &&
      terminalStatus !== 'UNKNOWN'
    ) {
      deterministicAssertions.push({
        field: 'billing.actualCharge',
        operator: 'EQUALS',
        expectedValue: expectedPoints,
        description: '预期刊例积分扣减值与实际计费一致',
        critical: true,
        evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
        actualField: 'actualCharge',
      });
    }

    // 路由承接渠道断言
    if (typeof targetChannelId === 'number' && targetChannelId > 0) {
      deterministicAssertions.push({
        field: 'routing.expectedChannelId',
        operator: 'EQUALS',
        expectedValue: targetChannelId,
        description: '预期承接网关渠道 ID',
        critical: true,
        evidenceKey: routingKey,
        actualField: 'actualValue',
      });
    }

    // 回归基线断言
    if (options.baseline) {
      deterministicAssertions.push({
        field: 'regression.isRegression',
        operator: 'EQUALS',
        expectedValue: false,
        description: '基线比对无非预期回归',
        critical: true,
        evidenceKey: isRealSpec ? 'SERVER_API:REGRESSION_BASELINE' : 'FIXTURE:REGRESSION_BASELINE',
        actualField: 'isRegression',
      });
    }

    // 契约一致性断言 (总是加入)
    deterministicAssertions.push({
      field: 'contract.conflictsCount',
      operator: 'EQUALS',
      expectedValue: 0,
      description: '配置无冲突',
      critical: true,
      evidenceKey: isRealSpec ? 'SERVER_API:CONTRACT_CONSISTENCY' : 'FIXTURE:CONTRACT_CONSISTENCY',
      actualField: 'conflictsCount',
    });

    // 证据冲突断言 (总是加入)
    deterministicAssertions.push({
      field: 'evidence.hasConflict',
      operator: 'EQUALS',
      expectedValue: false,
      description: '无多方证据冲突',
      critical: true,
      evidenceKey: isRealSpec ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT',
      actualField: 'hasConflict',
    });

    // 真实数据变更场景强制执行数据库物理落库与账务对账断言
    if (isRealSpec && (dbCollectionToUse !== undefined || options.dbVerify === true || !process.env.VITEST)) {
      deterministicAssertions.push({
        field: 'db.taskFound',
        operator: 'EQUALS',
        expectedValue: true,
        description: '前台任务表 pq_aivideo_new 物理记录存在',
        critical: true,
        evidenceKey: 'SERVER_API:DB_TASK_RECORD',
        actualField: 'taskFound',
      });
      deterministicAssertions.push({
        field: 'db.backendTaskFound',
        operator: 'EQUALS',
        expectedValue: true,
        description: '后台调度表 pq_volcengine_ai_task 关联记录存在',
        critical: true,
        evidenceKey: 'SERVER_API:DB_TASK_RECORD',
        actualField: 'backendTaskFound',
      });
      if (terminalStatus === 'SUCCESS') {
        deterministicAssertions.push({
          field: 'db.frontendStatus',
          operator: 'EQUALS',
          expectedValue: 2,
          description: '前台任务表 task_status 为 2 (SUCCESS)',
          critical: true,
          evidenceKey: 'SERVER_API:DB_TASK_RECORD',
          actualField: 'frontendStatus',
        });
        if (
          typeof expectedPoints === 'number' &&
          expectedPoints > 0 &&
          contract.pricing.allowPass &&
          contract.pricing.isPricingDetermined
        ) {
          deterministicAssertions.push({
            field: 'db.billingNetPoints',
            operator: 'EQUALS',
            expectedValue: expectedPoints,
            description: '成功任务数据库积分净扣等于刊例定价',
            critical: true,
            evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
            actualField: 'netPoints',
          });
        }
      } else if (terminalStatus === 'FAILED') {
        deterministicAssertions.push({
          field: 'db.billingNetPoints',
          operator: 'EQUALS',
          expectedValue: 0,
          description: '失败任务数据库积分净扣必须归零 (预扣与退款一致)',
          critical: true,
          evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
          actualField: 'netPoints',
        });
      }
    }

    const resolvedReq = resolveRequirementTraceForSpec({
      requirementId: options.requirementId,
      requirementText: options.requirementText,
      requirement: options.requirement,
      changedPaths: options.changedPaths,
      traces: options.traces,
      testId,
    });

    canonicalSpec = {
      testId,
      requirementId: resolvedReq.requirementId,
      scenario: contract.scenario || 'VERIFY_ACCEPTANCE',
      environment,
      executionMode: canonicalExecutionMode,
      target: {
        targetType: 'model',
        modelId,
        expectedChannelId: targetChannelId,
        taskId,
      },
      inputs: {
        taskId,
        expectedPoints,
        targetChannelId,
        pricingDetermined: contract.pricing.isPricingDetermined,
        pricingAllowPass: contract.pricing.allowPass,
      },
      deterministicAssertions,
      costLimit: {
        maxCostPoints: 0,
        allowZeroCostOnly: true,
      },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: reqEvidence,
      metadata: {
        allowPassPricing: contract.pricing.allowPass,
        requirementTrace: resolvedReq.trace || {
          requirementId: resolvedReq.requirementId,
          requirementText: resolvedReq.requirementText,
          impactAnalysis: resolvedReq.impactAnalysis,
        },
        impactAnalysis: resolvedReq.impactAnalysis,
      },
    };
  }

  // 生产环境唯一业务裁决求值
  const canonicalResult = evaluateCanonicalVerdict(canonicalSpec, envelopes);

  // 导出单向写入 (ResultSink: 只写不读，绝不篡改 canonicalResult 与 presentation)
  let exportDelivery:
    | {
        success: boolean;
        sinkName: string;
        recordId: string;
        error?: string;
      }
    | undefined;
  if (options.resultSink) {
    try {
      const record = mapVerdictToExportRecord(canonicalResult, {
        spec: canonicalSpec,
        exportedAt: capturedAt,
      });
      await options.resultSink.sink(record);
      exportDelivery = {
        success: true,
        sinkName: options.resultSink.sinkName,
        recordId: record.recordId,
      };
    } catch (sinkErr) {
      exportDelivery = {
        success: false,
        sinkName: options.resultSink.sinkName,
        recordId: `rec-${testId}`,
        error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      };
    }
  }

  const isProcessing =
    Boolean(options.isProcessing) || options.terminalStatus === 'PROCESSING' || taskEvidence.status === 'PROCESSING';

  // 单向兼容投影为下游消费展示结构：仅传入生命周期展示上下文，严禁传入业务验收事实
  const displayContext: LegacyLifecycleContext = {
    terminalStatus,
    isProcessing,
    progress: options.progress,
  };

  const presentation = projectCanonicalVerdictToLegacy(canonicalResult, displayContext);
  const acceptance: AcceptanceResult = presentation.acceptance;
  const verdict = presentation.verdict;

  const verifiedList: string[] = availableEvidence.slice();
  const unverifiedList: string[] = missingEvidence.filter((e) => !e.startsWith('MANUAL_'));
  const manualList: string[] = missingEvidence.filter((e) => e.startsWith('MANUAL_'));

  const unexpectedChanges = regressionDiff?.unexpectedChanges || [];

  let regressionSummary: ProductionAcceptanceReport['regressionSummary'] | undefined;
  if (regressionDiff) {
    regressionSummary = {
      isRegression: regressionDiff.isRegression,
      regressionStatus: regressionDiff.regressionStatus || (regressionDiff.isRegression ? 'REGRESSION' : 'UNKNOWN'),
      fields: Array.from(
        new Set([
          ...regressionDiff.unexpectedChanges.map((u) => u.field),
          ...regressionDiff.observedChanges.map((o) => o.field),
        ]),
      ),
      details: regressionDiff.unexpectedChanges.map((u) => u.reason),
    };
  }

  const reportReasons: string[] = Array.from(new Set([...reasons, ...presentation.reasons]));
  if (acceptance === 'UNVERIFIED' || acceptance === 'BLOCKED') {
    if (!isDbExtraVerified) {
      reportReasons.push(
        '[证据不足] 无法确认 extra 字段落库，需只读查询 /aivideo/v2/video/getEditData 或只读 DB 验证 extra.diversion=10 [MANUAL_DB_EVIDENCE_REQUIRED]',
      );
    }
    if (isGatewayChannelRequired && !isGatewayChannelVerified) {
      reportReasons.push('[证据不足] 缺少 NewAPI 视频模型网关渠道与上游通道确认 [MANUAL_GATEWAY_CHANNEL_REQUIRED]');
    }
    if (regressionDiff?.regressionStatus === 'UNKNOWN') {
      reportReasons.push('[回归分析未定] 因基线验证证据不完整，分流回归状态为 UNKNOWN，无法确认 CLEAN');
    }
  }

  const acceptanceReport: ProductionAcceptanceReport = {
    scenario: contract.scenario,
    acceptance,
    verified: verifiedList,
    unverified: unverifiedList,
    manualEvidenceRequired: manualList,
    unexpectedChanges,
    regressionSummary,
    reasons: reportReasons,
    summaryText: `[${acceptance}] 场景: ${contract.scenario} | 终态: ${terminalStatus} | 证据完整度: ${availableEvidence.length}/${requiredEvidence.length}${isComplete ? ' (COMPLETE)' : ' (INCOMPLETE)'}`,
  };

  const expectedVsActual: ExpectedVsActual = {
    taskId,
    modelId,
    mediaType,
    matched: presentation.passed,
    allMatched: presentation.passed,
    diffs: diffItems,
    items: diffItems,
    missingEvidence: isDbExtraVerified
      ? regressionDiff?.missingEvidence || []
      : ['MANUAL_DB_EVIDENCE_REQUIRED:extra.diversion', ...(regressionDiff?.missingEvidence || [])],
    evidenceStatus: {
      extraSnapshot: isDbExtraVerified ? 'VERIFIED' : 'MANUAL_DB_EVIDENCE_REQUIRED',
      taskStatus: taskEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      mediaArtifact: mediaEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
      billingLedger: billingEvidence.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIED',
    },
    manualVerificationGuide: {
      extraQuerySql: `SELECT id, extra, user_group_id, created_at FROM ai_tasks WHERE id = ${taskId} LIMIT 1;`,
      notice: isDbExtraVerified
        ? '已通过只读 HTTP API (/aivideo/v2/video/getEditData) 成功获取 extra 分流落库证据，无需手动查询数据库。'
        : '主站 HTTP 查询接口（/apiGetStatus 或常规任务详情接口）不返回 extra 字段。如需核实真实分流落库 (extra.diversion=10)，可优先通过只读 HTTP API (/aivideo/v2/video/getEditData) 或以只读权限查询 DB ai_tasks 表。',
    },
    regressionDiff,
    evidenceCompleteness,
  };

  const memoryCandidate =
    presentation.status === 'FAILED' ||
    presentation.verdict === 'FAIL' ||
    businessValidation.matchedFailurePatterns.length > 0
      ? formatMemoryCandidate({
          taskId,
          modelId,
          mediaType,
          matchedFailurePatterns: businessValidation.matchedFailurePatterns,
          reasons: reportReasons,
          terminalStatus,
        })
      : undefined;

  return {
    ok: !ctx.sessionLoadError,
    passed: presentation.passed,
    taskId,
    modelId,
    mediaType,
    status: ctx.sessionLoadError ? 'ERROR' : presentation.status,
    verdict,
    acceptance,
    mode: session ? 'real' : 'mock',
    executionMode,
    progress: options.progress ?? taskEvidence.progress,
    probeDurationMs: taskResult.probeDurationMs,
    artifact,
    billing,
    billingAudit: billing && scoreLogsToReconcile && scoreLogsToReconcile.length > 0 ? 'AUDITED' : 'SKIPPED_NO_LOGS',
    invariants,
    evidence: {
      task: taskEvidence,
      media: mediaEvidence,
      billing: billingEvidence,
      invariants: billingResult.invariantsEvidence,
      business: businessValidation,
    },
    evidenceCompleteness,
    reasons: reportReasons,
    expectedVsActual,
    acceptanceReport,
    contract,
    businessValidation,
    memoryCandidate,
    hasEvidenceConflict,
    conflictReasons,
    isActualChannelAssertedOnly,
    channelDetail: businessValidation.channelDetail,
    provenance: {
      actualChannelId: channelProvenance,
      fallbackChannel: fallbackProvenance,
      retryProvider: retryProvenance,
      extra: extraProvenance,
      gatewayChannel: gatewayChannelProvenance,
    },
    channelBoundaryClarification: {
      mainSiteDiversionTag: {
        status: isDbExtraVerified ? 'CONFIRMED' : 'UNVERIFIED',
        value: extraObj?.diversion,
        provenance: extraProvenance,
        boundaryNotice: '主站数据库中的 diversion 字段仅能证明主站分流标记落库，不能证明网关实际履约渠道',
      },
      gatewayUpstreamChannel: {
        verified: isGatewayChannelVerified,
        actualChannelId: isGatewayChannelVerified ? actualChannelId : undefined,
        provenance: gatewayChannelProvenance,
        boundaryNotice: isRealMode
          ? '真实模式下不得把外部断言（如 --gateway-channel-confirmed）提升为事实；必须通过网关可信快照'
          : '仿真模式下允许通过外部声明确认渠道',
      },
    },
    canonicalVerdict: canonicalResult,
    canonicalEnvelopes: envelopes,
    canonicalSpec,
    exportDelivery,
    dbEvidence: dbCollectionToUse,
    dbForensicsCategory: classifyDbForensics(dbCollectionToUse).category,
  };
}
