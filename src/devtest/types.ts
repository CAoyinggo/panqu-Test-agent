/**
 * Panqu AI DevTest 核心类型契约
 * 仅保留 probe, plan, execute, verify 4 大动作出入参及必要领域类型
 */

export type {
  ProbeKernelOptions, ProbeKernelResult,
  PlanKernelOptions, PlanKernelResult,
  ExecuteKernelOptions, ExecuteKernelResult,
  VerifyKernelOptions, VerifyKernelResult,
  TaskEvidence, MediaEvidence, BillingEvidence, InvariantsEvidence, VerificationEvidence,
} from "./core-kernel.js";

export type {
  KnowledgeCredibility, CredibleFact, BusinessEntity,
  ApiKnowledge, ApiParameterKnowledge,
  OracleKnowledge, OracleFieldKnowledge,
  TaskKnowledge, TaskLifecycleStep,
  Experience, FailurePattern,
  DomainProbeAnalysis, DomainExecutionStep, DomainExecutionPlan,
  BusinessVerificationInput, BusinessVerificationResult,
} from "./domain-knowledge.js";

export type {
  PanquSession, SubmitMediaTaskOptions, SubmitMediaTaskResult,
  TaskStatusSnapshot, PollTaskStatusOptions,
  TaskRuntimeDetails, EndpointQueryRecord,
} from "./media-flow.js";

export type {
  DiversionRouteMode, VideoRoutingInput, ImageRoutingInput,
  MainSiteRoutingVerdict, GatewayRoutingVerdict, FallbackRoutingVerdict,
} from "./routing.js";

export type {
  ScoreLogEntry, BillingAuditReport,
} from "./billing.js";

export type { MediaInspectionResult } from "./media-inspector.js";
export type { EnvProbeOptions, EnvProbeReport, EndpointProbeResult } from "./env-probe.js";

export type FlowMediaType = "VIDEO" | "IMAGE";
export type FlowExecutionMode = "REAL" | "MOCK";
export type FlowStepStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";
export type TaskTerminalStatus = "SUCCEEDED" | "SUCCESS" | "FAILED" | "TIMEOUT" | "UNKNOWN";

export interface MemoryCandidatePayload {
  agent: 'trae' | 'antigravity' | 'codex';
  topic: string;
  content: string;
  dest?: string;
  patternId?: string;
  modelId?: number;
  taskId?: number;
  confidence: 'CONFIRMED' | 'OBSERVED' | 'INFERRED';
  reasons: string[];
  source?: string;
  repository?: string;
}

export interface RecordCandidateResult {
  ok: boolean;
  candidateId?: string;
  status: 'RECORDED_PENDING_CONFIRMATION' | 'DUPLICATE_CANDIDATE_SKIPPED' | 'INVALID_ARGUMENTS' | 'WRITE_ERROR';
  summary: string;
  data?: {
    candidateId?: string;
    recorded: boolean;
    inboxPath?: string;
    status: 'PENDING_CONFIRMATION' | 'SKIPPED' | 'FAILED';
    nextStep: string;
    source?: string;
    repository?: string;
  };
  error?: string;
}

export interface DiversionCheckResult {
  passed: boolean;
  expectedRoute: string;
  actualRoute?: string;
  matchedRule?: string;
  reason?: string;
}

export interface ArtifactCheckResult {
  passed: boolean;
  mediaType: FlowMediaType;
  url?: string;
  fileSizeBytes?: number;
  mimeTypeValid?: boolean;
  structureValid: boolean;
  dimensions?: { width: number; height: number };
  durationSeconds?: number;
  details?: string;
}

export interface BillingReconciliation {
  passed: boolean;
  userCostVerified: boolean;
  supplierCostVerified: boolean;
  userCostActual?: number;
  userCostExpected?: number;
  supplierCostActual?: number;
  supplierCostExpected?: number;
  discrepancyReason?: string;
}

export interface FlowRunEvidence {
  taskId: string;
  mediaType: FlowMediaType;
  mode: FlowExecutionMode;
  diversion: DiversionCheckResult;
  artifact: ArtifactCheckResult;
  billing: BillingReconciliation;
  timings: { submittedAt: string; completedAt: string; totalDurationMs: number };
}

export type FactSource =
  | 'SOURCE_API'
  | 'SOURCE_RUNTIME'
  | 'SOURCE_INPUT'
  | 'SOURCE_STATIC_CONTRACT'
  | 'SOURCE_DEFAULT_FALLBACK'
  | 'MANUAL_REQUIRED';

export type ChangeScenario =
  | 'IMAGE_NEW_MODEL'
  | 'VIDEO_NEW_MODEL'
  | 'IMAGE_DIVERSION_CHANGE'
  | 'VIDEO_DIVERSION_CHANGE';

export interface DiscoveredFact<T> {
  value: T;
  source: FactSource;
  determined: boolean;
  allowPass: boolean;
  details?: string;
  warning?: string;
}

export interface DiscoveredModelContract {
  modelId: number;
  mediaType: 'video' | 'image';
  scenario: ChangeScenario;
  alias: DiscoveredFact<string>;
  isGlobal: DiscoveredFact<boolean>;
  capabilities: {
    resolutions: DiscoveredFact<string[]>;
    aspectRatios: DiscoveredFact<string[]>;
    durations?: DiscoveredFact<number[]>;
    supportsReferenceVideo?: DiscoveredFact<boolean>;
    supportsFirstLastFrame?: DiscoveredFact<boolean>;
    maxRefImages?: DiscoveredFact<number>;
  };
  supportedResolutions: DiscoveredFact<string[]>;
  supportedAspectRatios: DiscoveredFact<string[]>;
  supportedDurations?: DiscoveredFact<number[]>;
  supportsReferenceVideo?: DiscoveredFact<boolean>;
  supportsFirstLastFrame?: DiscoveredFact<boolean>;
  serviceline?: DiscoveredFact<string>;
  maxRefImages?: DiscoveredFact<number>;
  routing: DiscoveredFact<{
    routeLine: number;
    willDivert: boolean;
    decision: string;
    isGlobal: boolean;
    group?: string;
  }>;
  pricing: {
    pointsPerSecond?: DiscoveredFact<number>;
    customPoints?: DiscoveredFact<number>;
    isPricingDetermined: boolean;
    allowPass: boolean;
    source: FactSource;
  };
  fallback?: DiscoveredFact<{
    hasPolicy: boolean;
    action: 'VOLCENGINE_RETRY_QUEUE' | 'DIRECT_FAIL_NO_RETRY' | 'NONE';
  }>;
  orgBindings?: DiscoveredFact<Record<number, { routeGroupId: number; newapiGroup: string; status: number; apiKey?: string }>>;
  candidateChannels?: DiscoveredFact<string[]>;
  conflicts: Array<{ field: string; message: string; apiValue?: unknown; staticValue?: unknown }>;
  manualRequiredItems: Array<{ field: string; reason: string; requiredAction: string }>;
}

export interface TestCasePlan {
  id: string;
  layer: 'contract' | 'routing' | 'boundary' | 'execution' | 'artifact' | 'billing' | 'fallback';
  purpose: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  requiredEvidence: string[];
  executionMode: 'plan_only' | 'real_task' | 'offline_simulation';
  status?: 'PENDING' | 'SKIPPED' | 'BLOCKED' | 'READY';
  skipReason?: string;
  rationale?: {
    whyIncluded: string;
    riskAddressed: string;
  };
}

export interface TestPlanBlockedItem {
  field: string;
  missingField?: string;
  reason: string;
  requiredAction: string;
  impact?: string;
  suggestedAction?: string;
}

export interface ChangeContract {
  scenario: ChangeScenario;
  modelId: number;
  mediaType: 'video' | 'image';
  changeType: 'new_model' | 'diversion_change';
  beforeState: {
    flowType: string;
    routeLine: number;
    decision?: string;
    pricing: string;
  };
  afterState: {
    flowType: string;
    routeLine: number;
    decision?: string;
    pricing: string;
  };
  requiredFacts: string[];
  discoveredFacts: Record<string, { value: unknown; source: FactSource; determined: boolean }>;
  missingFacts: string[];
  capabilities: Record<string, unknown>;
  pricing: {
    determined: boolean;
    allowPass?: boolean;
    points?: number;
    pointsPerSecond?: number;
    source: FactSource;
  };
  routingExpectation: {
    mode?: 'DIRECT' | 'DIVERSION';
    willDivert: boolean;
    routeLine: number;
    decision: string;
    isGlobal?: boolean;
    group?: string;
  };
  fallbackPolicy?: string;
  testObjectives: string[];
}

export interface DiversionBaseline {
  flowType: 'direct';
  routeLine: number;
  willDivert: boolean;
  decision: string;
  expectedPoints: number;
  alias: string;
  artifactFormat: string;
}

export interface DiversionRegressionDiff {
  expectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }>;
  observedChanges: Array<{ field: string; before: unknown; after: unknown }>;
  unexpectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }>;
  missingEvidence: string[];
  isRegression: boolean;
  regressionStatus?: 'CLEAN' | 'REGRESSION' | 'UNKNOWN';
}

export interface TestPlan {
  scenario: ChangeScenario;
  scenarioName: string;
  modelId: number;
  mediaType: 'video' | 'image';
  changeType: 'new_model' | 'diversion_change';
  contract: DiscoveredModelContract;
  changeContract?: ChangeContract;
  tests: TestCasePlan[];
  skippedTests?: Array<{
    id: string;
    name: string;
    whySkipped: string;
    rule: string;
  }>;
  blocked: TestPlanBlockedItem[];
  expectedEvidence: string[];
  summary: string;
  baseline?: DiversionBaseline;
  regressionExpectations?: Array<{ field: string; expectedChange: boolean; description: string }>;
  testerActionSummary?: {
    automatedSummary: string[];
    skippedSummary: string[];
    manualRequiredSummary: string[];
    nextStep: string;
  };
}

export type DiffStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'MANUAL_REQUIRED';

export interface DiffItem {
  field: string;
  expected: unknown;
  actual: unknown;
  layer: string;
  matched: boolean;
  status: DiffStatus;
  diff?: string;
  message?: string;
  critical?: boolean;
  evidence?: string;
}

export type AcceptanceResult = 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'UNVERIFIED';

export interface EvidenceCompleteness {
  requiredEvidence: string[];
  availableEvidence: string[];
  missingEvidence: string[];
  isComplete: boolean;
}

export interface ProductionAcceptanceReport {
  scenario: ChangeScenario;
  acceptance: AcceptanceResult;
  verified: string[];
  unverified: string[];
  manualEvidenceRequired: string[];
  unexpectedChanges: Array<{ field: string; before: unknown; after: unknown; reason: string }>;
  regressionSummary?: {
    isRegression: boolean;
    regressionStatus: 'CLEAN' | 'REGRESSION' | 'UNKNOWN';
    fields: string[];
    details: string[];
  };
  reasons: string[];
  summaryText: string;
}

export interface ExpectedVsActual {
  taskId?: number;
  modelId?: number;
  mediaType?: 'video' | 'image';
  matched: boolean;
  allMatched?: boolean;
  diffs: DiffItem[];
  items?: DiffItem[];
  evidenceStatus: Record<string, 'VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'MANUAL_DB_EVIDENCE_REQUIRED'>;
  missingEvidence: string[];
  limitationNote?: string;
  manualVerificationGuide?: {
    extraQuerySql?: string;
    notice: string;
  };
  regressionDiff?: DiversionRegressionDiff;
  evidenceCompleteness?: EvidenceCompleteness;
}

export const DEFAULT_GITHUB_KNOWLEDGE_CONFIG = {
  repository: 'CAoyinggo/panqu-Test-agent',
  path: '.agents/skills/self-evolving-tester/references/knowledge_candidates.json',
} as const;

export interface KnowledgeSyncPayload {
  repository: string;
  path: string;
  knowledge: import('./domain-knowledge.js').Experience[];
}

export interface BuildSyncPayloadOptions {
  knowledge: import('./domain-knowledge.js').Experience[];
  repository?: string;
  path?: string;
}

export interface BuildSyncPayloadResult {
  ok: boolean;
  syncRequired: boolean;
  payload?: KnowledgeSyncPayload;
  rejectedItems?: Array<{ id: string; reason: string }>;
  error?: string;
}

export interface MergeKnowledgeResult {
  ok: boolean;
  mergedContent?: string;
  mergedCount: number;
  skippedCount: number;
  conflictItems?: Array<{ id: string; reason: string; existingClaim?: string; incomingClaim?: string }>;
  error?: string;
}

export type TargetKind = 'channel' | 'model';

export type ChannelSourceMode = 'SOURCE_STATIC_CONTRACT' | 'SOURCE_REAL_GATEWAY' | 'UNVERIFIED';

export interface TargetDisambiguationInput {
  targetKind?: TargetKind;
  channelId?: number;
  channelName?: string;
  modelId?: number;
  modelAlias?: string;
  projectId?: number;
  rawTarget?: string | number;
  mode?: 'mock' | 'real';
}

export interface TargetDisambiguationResult {
  ok: boolean;
  targetKind: TargetKind;
  channelId?: number;
  channelName?: string;
  modelId: number;
  modelAlias: string;
  projectId?: number;
  isDisambiguated: boolean;
  channelSource?: ChannelSourceMode;
  supportedModels?: Array<{ id: number; alias: string }>;
  warning?: string;
  error?: string;
}

export interface TrustedGatewaySnapshot {
  environment: 'test' | 'preonline' | 'prod' | 'offline' | string;
  capturedAt: string;
  sourceEndpoint: string;
  collectionStatus: 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';
  provenance: 'API_READONLY_COLLECTOR' | 'USER_ASSERTION' | 'FIXTURE';
  channels: any[];
  collectorVersion?: string;
  ttlMs?: number;
}

export interface GatewaySnapshotValidationResult {
  valid: boolean;
  reason?: string;
  snapshot?: TrustedGatewaySnapshot;
}
