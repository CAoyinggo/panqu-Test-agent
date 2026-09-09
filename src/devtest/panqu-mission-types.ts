/** Mission decisions are executable state, not LLM-authored assertions of success. */
export type PanquMissionProfile = 'PHP_VIDEO_V1' | 'NUXT_CANVAS_V1';
export type PanquMissionState = 'PLANNED' | 'SUBMITTING' | 'SUBMISSION_UNKNOWN' | 'POLLING' | 'VERIFYING' | 'PASSED' | 'FAILED' | 'BLOCKED';
export interface PanquMissionVariant {
  id: string;
  modelId: string;
  mode: string;
  /** Upper bound from an operator-approved current quote, not an LLM estimate. 1000 units = 1 credit. */
  maxMilliCredits: number;
  parameters: { durationSeconds?: number; width: number; height: number; count: number; quality: string };
  /** Complete application payload from the trusted project adapter; no arbitrary URL or method. */
  request: Record<string, unknown>;
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
  /** A task-bound receipt. Missing receipt is not zero cost. */
  chargedMilliCredits?: number;
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
  preflight(plan: PanquMissionPlan, approval: PanquMissionApproval): Promise<void>;
  /** Never retried after ambiguous delivery. A driver must not implement automatic submission retries. */
  submit(plan: PanquMissionPlan, signal: AbortSignal): Promise<{ taskId: string }>;
  observe(taskId: string, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionObservation>;
  verifyAsset(observation: PanquMissionObservation, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionAssetEvidence>;
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
  events: Array<{ sequence: number; at: string; state: PanquMissionState; code: string; detail: string }>;
  /** Relative journal path, never an arbitrary command or model-selected tool call. */
  nextAction: 'CONFIRM_PLAN' | 'RESUME_OBSERVATION' | 'RECONCILE_SUBMISSION' | 'REVIEW_EVIDENCE' | 'RESOLVE_BLOCKER';
}
