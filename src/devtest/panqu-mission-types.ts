/** Mission decisions are executable state, not LLM-authored assertions of success. */
export type PanquMissionProfile = 'PHP_VIDEO_V1' | 'NUXT_CANVAS_V1';
export type PanquMissionState = 'PLANNED' | 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'POLLING' | 'VERIFYING' | 'SETTLING' | 'PASSED' | 'FAILED' | 'BLOCKED';
export interface PanquMissionVariant {
  id: string;
  modelId: string;
  mode: string;
  /** Upper bound from an operator-approved current quote, not an LLM estimate. 1000 units = 1 credit. */
  maxMilliCredits: number;
  parameters: { durationSeconds?: number; width: number; height: number; count: number; quality: string };
  /** Complete application payload from the trusted project adapter; no arbitrary URL or method. */
  request: Record<string, unknown>;
  /** Trusted preparer evidence. Refreshing it invalidates the exact execution approval. */
  preparation?: PanquMissionPreparationEvidence;
}
export interface PanquMissionMaterial {
  file: string;
  sha256: string;
  bytes: number;
  kind: 'image' | 'video' | 'audio';
  width?: number;
  height?: number;
  durationSeconds?: number;
  codec: string;
}
export interface PanquMissionSpec {
  schema: 'panqu.mission.v1';
  requirement: { source: string; statement: string; confirmed: true; modelId: string; mode: string; kind: 'image' | 'video'; requiredVariantId?: string };
  /** Optional weak-model recommendation. It cannot add scope, grant access or set a verdict. */
  proposal?: { variantId?: string };
  prompt?: string;
  maxMilliCredits: number;
  materials: PanquMissionMaterial[];
}
export interface PanquMissionCatalog {
  schema: 'panqu.catalog.v1';
  profile: PanquMissionProfile;
  source: string;
  expiresAt: string;
  variants: PanquMissionVariant[];
  promptConstraints?: { source: string; minCodePoints: number; maxCodePoints: number };
  /** Pins are required by the concrete project driver, refreshed after source changes. */
  sourcePins: Array<{ file: string; sha256: string }>;
  projectId: string;
  nodeId: string;
}
export interface PanquMissionPlan {
  schema: 'panqu.mission-plan.v1';
  hash: string;
  requirement: PanquMissionSpec['requirement'];
  profile: PanquMissionProfile;
  projectId: string;
  nodeId: string;
  sourcePins: PanquMissionCatalog['sourcePins'];
  quote: { source: string; expiresAt: string; catalogHash: string };
  variant: PanquMissionVariant;
  maxMilliCredits: number;
  materials: PanquMissionMaterial[];
  decisions: Array<{ code: string; detail: string }>;
}
export interface PanquMissionApproval {
  approvalId: string;
  planHash: string;
  maxMilliCredits: number;
  environment: 'local' | 'test' | 'integration';
  /** Credentials never appear here. Remote execution requires a trusted driver and existing safety policy. */
  allowedOrigin: string;
  expiresAt: string;
  retainTestAssets: true;
}
export interface PanquMissionObservation {
  taskId: string;
  state: 'pending' | 'running' | 'success' | 'failed' | 'unknown';
  projectId?: string;
  progress?: number;
  assetUrl?: string;
  requestId?: string;
  nodeId?: string;
  /** Server version time when explicitly present; never substitute the local polling time. */
  updatedAt?: string;
  /** A task-bound receipt. Missing receipt is not zero cost. */
  chargedMilliCredits?: number;
}
/** A task-bound settlement is not established merely by finding a numeric amount. */
export interface PanquMissionSettlement {
  taskId: string;
  state: 'pending' | 'final' | 'unknown';
  netMilliCredits?: number;
  debitMilliCredits?: number;
  refundedMilliCredits?: number;
  evidenceHash?: string;
  reason?: string;
}

/** Durable independent business facts. No raw response, signed URL, prompt or credential is retained. */
export interface PanquMissionEvidence {
  schema: 'panqu.mission-evidence.v1';
  task?: { state: PanquMissionObservation['state']; requestId?: string; nodeId?: string; updatedAt?: string; observedAt: string };
  media: { state: 'unverified' | 'verified' | 'failed'; assetIdentityHash?: string; code?: string };
  settlement: PanquMissionSettlement;
  /** Confirmed failures and evidence contradictions cannot be erased by a later successful read. */
  failures: string[];
  conflicts: string[];
  requests: { task: number; media: number; settlement: number };
  next: { action: 'OBSERVE_TASK' | 'VERIFY_MEDIA' | 'OBSERVE_SETTLEMENT' | 'RESOLVE_EVIDENCE_CONFLICT' | 'REVIEW_EVIDENCE'; missing: string[] };
}
export interface PanquMissionAssetEvidence {
  sha256: string;
  bytes: number;
  kind: 'image' | 'video';
  width: number;
  height: number;
  durationSeconds?: number;
  decoded: true;
}
export interface PanquMissionDriver {
  identity: string;
  origin: string;
  profile: PanquMissionProfile;
  /** Called before any network; must check source pins, environment, adapters and auth availability. */
  preflight(plan: PanquMissionPlan, approval: PanquMissionApproval, context?: { resumeOnly: boolean }): Promise<void>;
  /** Bounded read/estimate-only freshness check before the first generation submission. */
  revalidate?(plan: PanquMissionPlan, signal: AbortSignal): Promise<void>;
  /** Never retried after ambiguous delivery. A driver must not implement automatic submission retries. */
  submit(plan: PanquMissionPlan, signal: AbortSignal): Promise<{ taskId: string }>;
  observe(taskId: string, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionObservation>;
  /** Independent read; transport failures must not discard already observed task or media facts. */
  observeSettlement?(taskId: string, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionSettlement>;
  verifyAsset(observation: PanquMissionObservation, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionAssetEvidence>;
}

/** A stable logical intent survives refreshed prices and plans; it is not a new run permission. */
export interface PanquMissionIntent {
  schema: 'panqu.mission-intent.v1';
  intentId: string;
  requirement: PanquMissionSpec['requirement'];
  projectId: string;
  nodeId: string;
  maxMilliCredits: number;
  /** Only confirmed output oracles, never guessed pixel sizes from a display label. */
  outputProfiles: Array<{ source: string; quality: string; aspectRatio: string; width: number; height: number }>;
  /** Optional explicit test scope. Omission uses the complete finite capability domain. */
  required?: { quality?: string; durationSeconds?: number };
  /** Omit to use the existing target node's prompt; no arbitrary prompt is silently substituted. */
  prompt?: string;
  audio: boolean;
  proposal?: { variantId?: string };
}

/** Operator-supplied permission for fixed model/design reads and cost estimation, never generation. */
export interface PanquMissionReadAccess {
  schema: 'panqu.mission-read-access.v1';
  accessId: string;
  allowedOrigin: string;
  projectId: string;
  environment: PanquMissionApproval['environment'];
  actorRef: string;
  expiresAt: string;
  scope: 'MODELS_CANVAS_ESTIMATE_ONLY';
  /** Confirm the configured proxy estimates Panqu credits, not an upstream currency amount. */
  estimateUnit: 'PANQU_CREDIT';
  maxEstimateRequests: number;
}

export interface PanquMissionPreparationEvidence {
  schema: 'panqu.nuxt-video-preparation.v1';
  intentId: string;
  intentHash: string;
  intent: PanquMissionIntent;
  contextHash: string;
  origin: string;
  actorRef: string;
  apiBasePath: string;
  observedAt: string;
  canvasHash: string;
  modelHash: string;
  /** All candidates were priced. Partial/failed quotes cannot justify a minimum-price claim. */
  quotes: Array<{ variantId: string; params: Record<string, unknown>; milliCredits: number }>;
}
export interface PanquMissionJournal {
  schema: 'panqu.mission-journal.v1';
  planHash: string;
  driverIdentity: string;
  origin: string;
  approvalId: string;
  state: PanquMissionState;
  taskId?: string;
  submissionAttempts: number;
  reservedMilliCredits: number;
  chargedMilliCredits?: number;
  asset?: PanquMissionAssetEvidence;
  evidence?: PanquMissionEvidence;
  events: Array<{ sequence: number; at: string; state: PanquMissionState; code: string; detail: string }>;
  /** Relative journal path, never an arbitrary command or model-selected tool call. */
  nextAction: 'CONFIRM_PLAN' | 'RESUME_OBSERVATION' | 'RECONCILE_SUBMISSION' | 'REVIEW_EVIDENCE' | 'RESOLVE_BLOCKER';
}
