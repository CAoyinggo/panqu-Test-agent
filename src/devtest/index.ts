/**
 * Panqu AI DevTest 公共 API
 *
 * 固化纯净双模内核（Core Kernel），直接由本入口统一导出：
 * 1. probe(options)   - 环境探活
 * 2. plan(options)    - 分流推导与测试规划
 * 3. execute(options) - 任务执行
 * 4. verify(options)  - 物理验真与防资损对账
 */

export {
  probe,
  plan,
  execute,
  verify,
  type ProbeKernelOptions,
  type ProbeKernelResult,
  type PlanKernelOptions,
  type PlanKernelResult,
  type ExecuteKernelOptions,
  type ExecuteKernelResult,
  type VerifyKernelOptions,
  type VerifyKernelResult,
} from './core-kernel.js';

export {
  submitMediaTask,
  pollTaskStatus,
  loadPanquSession,
  fetchWithRetry,
  type PanquSession,
  type SubmitMediaTaskOptions,
  type SubmitMediaTaskResult,
  type TaskStatusSnapshot,
  type PollTaskStatusOptions,
} from './media-flow.js';

export {
  RoutingOracle,
  type DiversionRouteMode,
  type VideoRoutingInput,
  type ImageRoutingInput,
  type MainSiteRouteRules,
  type GroupRouteRules,
  type OrgBindingConfig,
  type MainSiteConfigSnapshot,
  type MainSiteRoutingVerdict,
  type GatewayChannelConfig,
  type GatewayRoutingVerdict,
  type BatchDistributionResult,
  type FallbackRoutingVerdict,
} from './routing.js';

export {
  BillingOracle,
  FALLBACK_POINTS_PER_CNY,
  FALLBACK_CNY_PER_POINT,
  type ScoreLogEntry,
  type BillingAuditReport,
} from './billing.js';

export {
  inspectMp4Buffer,
  inspectImageBuffer,
  inspectBufferMedia,
  createSyntheticValidMp4,
  type MediaInspectionResult,
} from './media-inspector.js';

export {
  EnvironmentProbe,
  type EnvProbeOptions,
  type EnvProbeReport,
  type EndpointProbeResult,
} from './env-probe.js';

export {
  type FlowMediaType,
  type FlowExecutionMode,
  type FlowStepStatus,
  type TaskTerminalStatus,
  type DiversionCheckResult,
  type ArtifactCheckResult,
  type BillingReconciliation,
  type FlowRunEvidence,
} from './types.js';

export {
  deriveVerificationTargets,
  evaluateRequirementCoverage,
  type CoverageStatus,
  type VerificationTarget,
  type TargetCoverageVerdict,
  type RequirementCoverageReport,
} from './verification-target.js';

export { DEVTEST_VERSION, PLATFORM_VERSION } from './version.js';
