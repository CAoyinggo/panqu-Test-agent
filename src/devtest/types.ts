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
  PanquSession, SubmitMediaTaskOptions, SubmitMediaTaskResult,
  TaskStatusSnapshot, PollTaskStatusOptions,
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
