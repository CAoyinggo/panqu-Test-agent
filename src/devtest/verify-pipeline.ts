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
import type { validateTrustedGatewaySnapshot } from './routing.js';
import { type GatewayChannelConfig, type TrustedGatewaySnapshot } from './routing.js';
import { BillingOracle, type ScoreLogEntry, type BillingAuditReport } from './billing.js';
import type { inspectMp4Buffer } from './media-inspector.js';
import { type MediaInspectionResult } from './media-inspector.js';
import { loadPanquSession, type PanquSession, type TaskStatusSnapshot, type TaskRuntimeDetails } from './media-flow.js';
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
import type { evaluateBusinessVerification } from './domain-knowledge.js';
import { type BusinessVerificationResult } from './domain-knowledge.js';
import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from './canonical-protocol.js';
import { type CanonicalVerdictResult } from './canonical-verdict-engine.js';

import type { EvidenceProducer } from './execution-ports.js';
import { type ResultSink } from './result-sink.js';
import { type RequirementTrace } from './requirement-trace.js';
import {
  DatabaseEvidenceProducer,
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  type DatabaseRawCollection,
  type ImageSource,
} from './database-evidence-producer.js';
import { loadDiversionPricing, resolveListPrice, type PricingScope } from './diversion-pricing-authority.js';
import { type DiversionEligibilityInput } from './diversion-eligibility-producer.js';
import { type DiversionConfigRawCollection } from './diversion-config-reader.js';
import { type DbForensicsCategory } from './db-preflight.js';
import { readAbsettingPrices, resolveAbsettingListPrice, type AbsettingRow } from './absetting-price-reader.js';
export {
  DatabaseEvidenceProducer,
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  type DatabaseRawCollection,
};

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
  /** 图片四源表 id 空间重叠消歧（opt-in）：指明真实源表(goods/character/scene/fusion)后,
   *  DB 取证只查 pq_aivideo_<该值>、解析只落该表；未指定维持既有四表顺序首命中(默认零改变)。 */
  imageSource?: ImageSource;
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
  /** 从飞书《分流渠道表》权威快照自动取刊例价作为计费基准（opt-in）。仅视频；图片见 absettingPricing。 */
  pricingAuthority?: {
    model: string;
    resolution: string;
    refVideo?: boolean;
    scope?: PricingScope;
    cachePath?: string;
  };
  /** 从 pq_absetting（运行时真源）取刊例价作为计费基准（opt-in，支持图片）。
   *  给 rows 用之（离线/测试），否则真实环境经 readAbsettingPrices 读库（VITEST 下跳过）。 */
  absettingPricing?: {
    model?: number;
    abDb?: string;
    taskType?: number;
    resolutionCode?: number;
    resolution?: string;
    rows?: AbsettingRow[];
    credPath?: string;
    scriptPath?: string;
    timeoutMs?: number;
  };
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
  /** R3: 计费期望来源。OPERATOR_SUPPLIED = 由 --expected-points 显式注入并覆盖了系统刊例推导值。 */
  expectedPointsSource: 'OPERATOR_SUPPLIED' | 'DEVTEST_CALCULATED';
  /** R3: 系统刊例推导的期望积分（无论是否被操作者覆盖都保留，用于来源对账与降权提示）。 */
  systemCalculatedExpectedPoints: number;
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
  /** 真实落库派生的"实际是否经 NewAPI 网关分流" (true=经网关/false=直连/undefined=无DB证据)。 */
  actualDivertedFromDb?: boolean;
  /** 网关渠道快照来源: OPTIONS=显式传入 / DB_NEWAPI_TASK_LOG=DB 只读采集器 / undefined=无。 */
  gatewaySnapshotSource?: 'OPTIONS' | 'DB_NEWAPI_TASK_LOG';
  /** 契约预测分流但真实直连的路由不一致说明 (ROUTING_PREDICTION_MISMATCH)。 */
  routingPredictionMismatch?: string;
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
  // 计费基准可选取自权威源（opt-in）：刊例价不随分流变化，视频=积分/秒、图片=每张。
  // 优先级：absettingPricing（运行时真源，支持图片）> pricingAuthority（飞书分流表，仅视频）；取数失败静默回退调用方入参。
  let authorityListPrice: number | undefined;
  if (options.absettingPricing) {
    try {
      let rows = options.absettingPricing.rows;
      if (!rows && !process.env.VITEST) {
        const raw = await readAbsettingPrices({
          model: options.absettingPricing.model ?? modelId,
          abDb: options.absettingPricing.abDb,
          credPath: options.absettingPricing.credPath,
          scriptPath: options.absettingPricing.scriptPath,
          timeoutMs: options.absettingPricing.timeoutMs,
        });
        rows = raw.status === 'VERIFIED' ? raw.rows : [];
      }
      if (rows) {
        const p = resolveAbsettingListPrice(rows, {
          taskType: options.absettingPricing.taskType,
          resolutionCode: options.absettingPricing.resolutionCode,
          resolution: options.absettingPricing.resolution,
        });
        if (p != null) authorityListPrice = p;
      }
    } catch {
      /* fail-open：回退 pricingAuthority / 显式入参 */
    }
  }
  if (authorityListPrice === undefined && options.pricingAuthority) {
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

  // R3: 始终计算系统刊例推导值并保留 provenance。--expected-points（options.expectedPoints）
  // 会覆盖系统推导值；覆盖时标记 OPERATOR_SUPPLIED，供裁决层如实呈现「账务期望来源」，
  // 避免操作者填错期望值导致账务断言「自证其说」而无人察觉。
  const systemCalculatedExpectedPoints = BillingOracle.calculateExpectedPoints({
    mediaType,
    modelId,
    duration,
    resolution,
    customPoints: customPoints ?? contract.pricing.customPoints?.value,
    pointsPerSecond: pointsPerSecond ?? contract.pricing.pointsPerSecond?.value,
  });
  const expectedPointsSource: 'OPERATOR_SUPPLIED' | 'DEVTEST_CALCULATED' =
    options.expectedPoints !== undefined ? 'OPERATOR_SUPPLIED' : 'DEVTEST_CALCULATED';
  const expectedPoints = options.expectedPoints ?? systemCalculatedExpectedPoints;
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
    expectedPointsSource,
    systemCalculatedExpectedPoints,
    session,
    sessionLoadError,
    executionMode,
  };
}

// ── 物理分解 re-export（保持公共导出面零变化，ARCHITECTURE_FREEZE §2.2 Phase 6）──
export { collectTaskEvidence, collectMediaEvidence, collectBillingEvidence } from './evidence-collectors.js';
export {
  buildAutoDiversionEligibility,
  computeRegressionDiff,
  buildDiffItems,
  computeFinalVerdict,
} from './verdict-projection.js';
