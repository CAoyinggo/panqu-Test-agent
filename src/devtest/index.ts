/**
 * DevTest 公共 API。
 * 业务与测试只允许从本 barrel 引入；内部文件结构可能调整。
 */

export { runDevTest } from './devtest-runner.js';
export { buildDevTestProblems, deriveDevTestConclusion, suggestionForReasonCode } from './problem-engine.js';
export {
  coreKindOf,
  deduplicateDevTestCases,
  devTestCaseSimilarity,
  devTestDimensionOf,
  scoreDevTestCase,
  selectDevTestCases,
  tierOf,
} from './dimension-selector.js';
export { analyzeDevTestImpact, buildDevTestPlan } from './planning.js';
export { buildRequirementCoverageMatrix, buildDevTestInvariants, extendedDimensionsOf } from './requirement-intelligence.js';
export { computeDevConfidence, buildVersionComparison } from './final-assessment.js';
export { buildBusinessFlowGraph, evaluateBusinessFlows, evaluateCrossCaseInvariants,
  buildBusinessLevelProblems } from './business-flow-engine.js';
export { buildExecutionEstimate, buildRegressionGuard, evaluateRegressionGuard,
  relatedRegressionCaseIds } from './acceptance-governance.js';
export { buildTestOracleResults } from './oracle-engine.js';
export { buildTestReliability } from './reliability-engine.js';
export { SnapshottingProcessor, detectTestPollution, buildPollutionProblems } from './pollution-engine.js';
export { adaptiveScore, buildNegativeIntelligence, buildPermissionMatrix, assessRequirementQuality,
  buildRequirementQualityProblems, buildRootCauseGraph } from './test-intelligence.js';
export { buildDevTestRequirementModel, buildDevTestAcceptanceTraces,
  buildDevTestDeliveryCoverage } from './delivery-acceptance.js';
export { discoverReferencedContractDependencies } from './contract-dependencies.js';
export { buildDevTestFeatureModel } from './feature-model.js';
export { appendDiscoveredContracts, discoverDevTestProject } from './project-discovery.js';
export { discoverDevTestEnvironment } from './environment-discovery.js';
export { executeDevTestUiCases } from './ui-executor.js';
export { synchronizeDevTestSource } from './source-sync.js';
export type { DevTestSourceSyncOptions, DevTestSourceSyncResult, DevTestSourceRepositorySync } from './source-sync.js';
export {
  SafeMutationHoldProcessor,
  buildOperationPolicies,
  caseHttpMethod,
  heldMutationResult,
  isMutatingMethod,
} from './safe-mode.js';
export {
  DEVTEST_REPORT_SCHEMA,
  buildDevTestUnknowns,
  buildDevTestReportEnvelope,
  renderCasesCsv,
  renderDevTestHtml,
  renderProblemsMarkdown,
  renderAcceptanceSummary,
  renderDeveloperSelfTestCases,
  renderDeveloperSelfTestReport,
  type DevTestRenderInput,
  type DevTestRenderMeta,
} from './artifacts.js';
export { fetchFeishuDoc, loadFeishuCredentials, parseFeishuUrl } from './feishu-fetch.js';
export type {
  DevTestArtifacts,
  DevTestBaselineDiff,
  DevTestCaseProfile,
  DevTestCaseDimension,
  DevTestCoreCaseKind,
  DevTestDimensionApplicability,
  DevTestDimensionDecision,
  DevTestDiscoveryResult,
  DevTestEnvironmentCandidate,
  DevTestEnvironmentPreflight,
  DevTestEnvironmentStatus,
  DevTestCapabilityStatus,
  DevTestFailureClass,
  DevTestDimensionStat,
  DevTestFeatureModel,
  DevTestFeatureResult,
  DevTestMode,
  DevTestOptions,
  DevTestPlan,
  DevTestProblem,
  DevTestProblemJudgement,
  DevTestProblemLifecycle,
  DevTestProblemDimension,
  DevTestProblemSeverity,
  DevTestProblemType,
  DevTestRunResult,
  DevTestReproductionStatus,
  DevTestRerunFilter,
  DevTestTestValueScore,
  DevTestUiElement,
  DevTestUiExecutionResult,
  DevTestExpectedBehavior,
  DevTestRequirementCoverageMatrix,
  DevTestInvariant,
  DevTestExtendedDimension,
  DevTestConfidenceScore,
  DevTestVersionComparison,
  DevTestDataLifecycleRecord,
  DevTestBusinessFlow,
  DevTestBusinessFlowGraph,
  DevTestBusinessFlowStep,
  DevTestFlowStatus,
  DevTestStateObservation,
  DevTestStateConsistencyResult,
  DevTestRegressionGuard,
  DevTestExecutionEstimate,
  DevTestTier,
  DevTestAdaptiveTestScore,
  DevTestOracleResult,
  DevTestEnvironmentSnapshot,
  DevTestPollutionFinding,
  DevTestCaseReliability,
  DevTestReliabilitySummary,
  DevTestNegativeCheck,
  DevTestPermissionMatrixRow,
  DevTestRequirementQuality,
  DevTestRootCauseNode,
  DevTestRequirementKnowledge,
  DevTestRequirementModel,
  DevTestIssueClassification,
  DevTestAcceptanceResult,
  DevTestAcceptanceTrace,
  DevTestDeliveryCoverage,
} from './types.js';
