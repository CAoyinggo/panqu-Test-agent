/**
 * Panqu AI DevTest 纯净测试副驾导出入口
 */

export {
  probe,
  plan,
  execute,
  executeCanonical,
  verify,
  type ProbeKernelOptions,
  type ProbeKernelResult,
  type PlanKernelOptions,
  type PlanKernelResult,
  type ExecuteKernelOptions,
  type ExecuteKernelResult,
  type ExecuteCanonicalDependencies,
  type VerifyKernelOptions,
  type VerifyKernelResult,
  type TaskEvidence,
  type MediaEvidence,
  type BillingEvidence,
  type InvariantsEvidence,
  type VerificationEvidence,
} from './core-kernel.js';

export {
  submitMediaTask,
  pollTaskStatus,
  loadPanquSession,
  fetchWithRetry,
  queryTaskRuntimeDetails,
  type PanquSession,
  type SubmitMediaTaskOptions,
  type SubmitMediaTaskResult,
  type TaskStatusSnapshot,
  type PollTaskStatusOptions,
  type TaskRuntimeDetails,
  type EndpointQueryRecord,
} from './media-flow.js';

export {
  RoutingOracle,
  DEFAULT_KNOWN_GATEWAY_CHANNELS,
  validateTrustedGatewaySnapshot,
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
  type TrustedGatewaySnapshot,
  type GatewaySnapshotValidationResult,
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

export { EnvironmentProbe, type EnvProbeOptions, type EnvProbeReport, type EndpointProbeResult } from './env-probe.js';

export {
  type FlowMediaType,
  type FlowExecutionMode,
  type FlowStepStatus,
  type TaskTerminalStatus,
  type DiversionCheckResult,
  type ArtifactCheckResult,
  type BillingReconciliation,
  type FlowRunEvidence,
  type MemoryCandidatePayload,
  type RecordCandidateResult,
  DEFAULT_GITHUB_KNOWLEDGE_CONFIG,
  type KnowledgeSyncPayload,
  type BuildSyncPayloadOptions,
  type BuildSyncPayloadResult,
  type MergeKnowledgeResult,
  type TargetKind,
  type TargetDisambiguationInput,
  type TargetDisambiguationResult,
} from './types.js';

export { DevTestMcpService, DEVTEST_MCP_TOOL, DEVTEST_RECORD_CANDIDATE_TOOL } from './mcp-service.js';

export {
  PANQU_BUSINESS_ENTITIES,
  PANQU_API_KNOWLEDGE,
  PANQU_ORACLE_KNOWLEDGE,
  PANQU_TASK_KNOWLEDGE,
  PANQU_FAILURE_PATTERNS,
  resolveDomainContext,
  generateDomainExecutionPlan,
  evaluateBusinessVerification,
  loadConfirmedExperiences,
  resolveDefaultPlanCheck,
  matchRelevantExperiences,
  formatMemoryCandidate,
  recordCandidateToSharedMemory,
  promoteConfirmedExperiences,
  buildKnowledgeSyncPayload,
  mergeKnowledgeIntoRemoteJson,
  type PromoteOptions,
  type PromotionReport,
  type PromotionReportItem,
  createConfirmedFact,
  createObservedFact,
  createInferredFact,
  createUnknownFact,
  type KnowledgeCredibility,
  type CredibleFact,
  type BusinessEntity,
  type ApiKnowledge,
  type ApiParameterKnowledge,
  type OracleKnowledge,
  type OracleFieldKnowledge,
  type TaskKnowledge,
  type TaskLifecycleStep,
  type Experience,
  type FailurePattern,
  type DomainProbeAnalysis,
  type DomainExecutionStep,
  type DomainExecutionPlan,
  type BusinessVerificationInput,
  type BusinessVerificationResult,
} from './domain-knowledge.js';

export { DEVTEST_VERSION, PLATFORM_VERSION } from './version.js';

export {
  PanquExplorationRunner,
  runMutationCandidate,
  type MutationRunOptions,
  type MutationRunResult,
  type MutationRunStatus,
  type NegativeRejectionEvidence,
} from './exploration/runner.js';

export {
  PanquLearningStore,
  extractLearningExperiences,
  buildActionHistoryCounts,
  feedResultIntoLearning,
  type ExtractLearningOptions,
} from './exploration/learning.js';

export {
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
  SUPPORTED_ASSERTION_OPERATORS,
  SUPPORTED_OBSERVATION_STATUSES,
  evaluateRequiredEvidence,
  type AssertionOperator,
  type ExecutionMode,
  type SideEffectPolicy,
  type TargetType,
  type TestCostLimit,
  type TestTarget,
  type DeterministicAssertion,
  type AiAssistedStep,
  type CanonicalTestSpec,
  type EvidenceSourceType,
  type EvidenceCollectionStatus,
  type EvidenceObservationStatus,
  type EvidenceError,
  type CanonicalEvidenceEnvelope,
  type ProtocolValidationError,
  type ProtocolValidationResult,
  type RequiredEvidenceEvaluationItem,
  type RequiredEvidenceEvaluationResult,
} from './canonical-protocol.js';

export {
  FORBIDDEN_VERDICT_FIELDS,
  mapCanonicalEnvironmentToPanquSessionEnv,
  type PanquSessionEnvironment,
  type EnvironmentMappingResult,
  type ExecutionStatus,
  type ExecutionError,
  type ExecutionResult,
  type ForbiddenVerdictField,
  type ExecutionAdapter,
  type EvidenceProducerContext,
  type EvidenceProducer,
} from './execution-ports.js';

export {
  mapPlanToCanonicalTestSpec,
  mapProbeToCanonicalEvidence,
  mapExecuteToExecutionResult,
  mapVerifyToCanonicalEvidence,
  redactSensitiveData,
  isSensitiveKey,
  type MappingIssue,
  type MappingResult,
  type MapPlanOptions,
  type MapProbeOptions,
  type MapExecuteOptions,
  type MapVerifyOptions,
} from './legacy-protocol-mappers.js';

export {
  evaluateCanonicalVerdict,
  evaluateOperator,
  getNestedValue,
  type CanonicalVerdict,
  type CanonicalVerdictResult,
  type AssertionEvaluationResult,
} from './canonical-verdict-engine.js';

/**
 * Tier 2 · 可选可插拔适配器 · UI 浏览器/视觉 AI 证据采集
 * 实现 execution-ports.ts 的 EvidenceProducer 接口。
 * 前提：需要外部 Playwright/Midscene 浏览器运行时环境。
 * 成熟度：DEFERRED_EXTERNAL_RUNTIME（不属于零依赖交付范围）
 * @see docs/ARCHITECTURE_FREEZE.md §1.3 Tier 2
 */
export {
  UIBrowserEvidenceProducer,
  UIVisualAiEvidenceProducer,
  readPngDimensions,
  type BrowserRawCollection,
  type VisualAiRawCollection,
  type DeterministicProducerContext,
} from './ui-adapters.js';

/**
 * Tier 2 · 可选 SDK 纯函数 · Agent 行为离线评测
 * 前提：需要提供 isRealSample=true 的真实 Agent 输出样本。
 * 成熟度：BLOCKED_DATA_MISSING（缺少生产级真实样本）
 * @see docs/ARCHITECTURE_FREEZE.md §1.3 Tier 2
 */
export {
  evaluateAgentOutput,
  type AgentStructuredDecision,
  type AgentToolCall,
  type AgentOutputSample,
  type GoldenEvaluationCriteria,
  type AgentEvaluationInput,
  type AgentVulnerabilityCode,
  type AgentVulnerabilityFinding,
  type AgentEvaluationStatus,
  type AgentEvaluationReport,
  validateAgentSampleImport,
  type AgentSampleImportContract,
  type ValidateSampleImportResult,
} from './agent-evaluation.js';

export {
  mapVerdictToExportRecord,
  NdjsonResultSink,
  type ExportRecordStatus,
  type ExportRecordAttribute,
  type ExportRecordLogEntry,
  type ExportableVerdictRecord,
  type ResultSink,
  type MapVerdictExportOptions,
  type NdjsonResultSinkOptions,
} from './result-sink.js';

export {
  analyzeImpact,
  buildRequirementTraceIndex,
  resolveRequirementTraceForSpec,
  isStableRequirementId,
  collectGitChangedPaths,
  findAuthoritativeRequirementTraces,
  resolveWardenMaturity,
  analyzeGitImpact,
  DEFAULT_REQUIREMENT_TRACE_SEARCH_PATHS,
  type RequirementTrace,
  type RequirementTraceMap,
  type CoverageGap,
  type RiskInputType,
  type RiskInputItem,
  type ImpactAnalysisOptions,
  type ImpactAnalysisResult,
  type ResolvedRequirementTrace,
  type ResolveRequirementTraceOptions,
  type CollectGitChangedPathsOptions,
  type CollectGitChangedPathsResult,
  type FindRequirementTracesOptions,
  type FindRequirementTracesStatus,
  type FindRequirementTracesResult,
  type AnalyzeGitImpactOptions,
  type AnalyzeGitImpactStatus,
  type AnalyzeGitImpactResult,
} from './requirement-trace.js';

export {
  ABSORBED_CAPABILITIES_AUDIT,
  getCapabilityAudit,
  type CapabilityMaturityLevel,
  type AbsorbedCapabilityAudit,
} from './capability-maturity.js';

export {
  DatabaseEvidenceProducer,
  queryDatabasePhysicalFacts,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  type DatabaseRawCollection,
  type DatabaseRecordFound,
  type DatabaseQueryOptions,
} from './database-evidence-producer.js';
