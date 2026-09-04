/**
 * DevTest 只定义编排/输出契约。测试用例、Scenario、断言、执行与证据继续使用
 * Acceptance 的 canonical model，禁止在这里建立第二套执行模型。
 */

import type { ApiProcessor } from '../acceptance/api-processor.js';
import type { ScenarioHookHandler, ScenarioProcessor } from '../acceptance/scenario-runner.js';
import type { ScenarioEvidenceKind } from '../acceptance/scenario-contract.js';
import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { ContractResolver } from '../contracts/resolver.js';
import type { ContractPreflight } from '../contracts/contract-gate.js';
import type { DiscoveredOperation } from '../discovery/types.js';
import type {
  CanonicalRequirementFact,
  RequirementEpistemicType,
  RequirementFactCategory,
  RequirementFactProvenance,
  RequirementFactStatus,
  RequirementNormativity,
  RequirementSourceSpan,
} from '../acceptance/requirement-ir.js';
import type { TestEvidenceRequirement } from '../agents/test-design/testcase-schema.js';
import type { DevTestSourceSyncOptions, DevTestSourceSyncResult } from './source-sync.js';

export const DEVTEST_CASE_DIMENSIONS = [
  'API',
  'FUNCTIONAL',
  'UI',
  'DATA_ISOLATION',
  'PARAMETER_VALIDATION',
] as const;

export type DevTestCaseDimension = typeof DEVTEST_CASE_DIMENSIONS[number];
export type DevTestProblemDimension = DevTestCaseDimension | 'CONTRACT' | 'EXECUTION';
export type DevTestMode = 'SAFE' | 'DRY_RUN' | 'LIVE';
export type DevTestFeatureResult = 'READY' | 'NOT_READY' | 'BLOCKED';
export type DevTestDimensionApplicability = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL' | 'NOT_APPLICABLE';
export type DevTestCoreCaseKind = 'HAPPY_PATH' | 'CORE_VALIDATION' | 'AUTHORIZATION' | 'PERSISTENCE' | 'DATA_ISOLATION';
export type DevTestProblemJudgement = 'CONFIRMED_BUG' | 'LIKELY_BUG' | 'TEST_ISSUE'
  | 'ENVIRONMENT_ISSUE' | 'CONTRACT_ISSUE' | 'REQUIREMENT_ISSUE' | 'UNKNOWN';
export type DevTestProblemLifecycle = 'OPEN' | 'REPRODUCED' | 'FIXED' | 'REGRESSION' | 'REOPENED'
  | 'STILL_FAIL' | 'WONT_FIX' | 'BLOCKED';
export type DevTestReproductionStatus = 'REPRODUCED' | 'NOT_REPRODUCED' | 'BLOCKED';
export type DevTestRerunFilter = 'failed' | 'blocked' | 'regression' | string;
export type DevTestExtendedDimension = 'IDEMPOTENCY' | 'STATE_MACHINE' | 'BILLING' | 'PROVIDER' | 'AUDIT';
export type DevTestFlowStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED';
export type DevTestStateSource = 'RESPONSE' | 'DATABASE' | 'TASK' | 'BILLING' | 'AUDIT' | 'RESOURCE';

export interface DevTestBusinessFlowStep {
  id: string;
  order: number;
  name: string;
  operation: string;
  caseIds: string[];
  resource?: string;
  expectedState?: string;
  dependencies: Array<{
    kind: 'INPUT' | 'OUTPUT' | 'RESOURCE' | 'STATE';
    fromStepId: string;
    expression: string;
  }>;
}

export interface DevTestBusinessFlow {
  id: string;
  name: string;
  core: boolean;
  acIds: string[];
  invariantIds: string[];
  steps: DevTestBusinessFlowStep[];
  status: DevTestFlowStatus;
  failedStepId?: string;
  reason?: string;
  beforeState?: unknown;
  actualState?: unknown;
  expectedState?: unknown;
}

export interface DevTestBusinessFlowGraph {
  flows: DevTestBusinessFlow[];
  applicable?: boolean;
  operationCount: number;
  dependencies: Array<{ from: string; to: string; kind: 'INPUT' | 'OUTPUT' | 'RESOURCE' | 'STATE'; expression: string }>;
  coverage: number;
}

export interface DevTestStateObservation {
  caseId: string;
  source: DevTestStateSource;
  phase: 'BEFORE' | 'AFTER';
  resourceId?: string;
  state?: string;
  exists?: boolean;
  value?: unknown;
  evidence?: unknown;
}

export interface DevTestStateConsistencyResult {
  caseId: string;
  status: 'CONSISTENT' | 'INCONSISTENT' | 'BLOCKED' | 'NOT_REQUIRED';
  sources: DevTestStateSource[];
  before: DevTestStateObservation[];
  after: DevTestStateObservation[];
  reason?: string;
}

export interface DevTestRegressionGuard {
  enabled: boolean;
  target?: string;
  fixedCaseIds: string[];
  affectedCaseIds: string[];
  sameContractCaseIds: string[];
  sameInvariantCaseIds: string[];
  sameFlowCaseIds: string[];
  selectedCaseIds: string[];
  status: 'NOT_REQUIRED' | 'PASS' | 'FAIL' | 'BLOCKED';
  reason: string;
}

export interface DevTestExecutionEstimate {
  estimatedCases: number;
  estimatedRequests: number;
  estimatedRuntimeMs: number;
  estimatedCost: number;
  costUnit: 'DEVTEST_UNIT';
  limits: { timeoutMs: number; maxRuntimeMs?: number; budget?: number };
  exceeded: Array<'MAX_RUNTIME' | 'BUDGET'>;
}

export type DevTestTier = 'TIER_0' | 'TIER_1' | 'TIER_2';

export interface DevTestAdaptiveTestScore {
  caseId: string;
  tier: DevTestTier;
  score: number;
  baseValue: number;
  historicalFailures: number;
  bugDensity: number;
  codeChangeFrequency: number;
  contractDrift: number;
  recentRegression: number;
  executionCost: number;
  reason: string;
}

export interface DevTestOracleResult {
  caseId: string;
  verdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';
  expected: {
    requirement: string[];
    contract: string[];
    invariants: string[];
    historicalBaseline?: string;
  };
  actual?: unknown;
  evidence: {
    execution: boolean;
    assertion: boolean;
    response: boolean;
    observedState: boolean;
    complete: boolean;
    required?: string[];
    collected?: string[];
    missing?: string[];
    semanticChecks?: Array<{ key: string; verdict: 'PASS' | 'FAIL' | 'BLOCKED'; reason: string }>;
  };
  reason: string;
  transientSignal?: 'HTTP_5XX' | 'TIMEOUT' | 'EMPTY_RESPONSE' | 'SLOW_RESPONSE' | 'BROWSER_ERROR' | 'ENVIRONMENT' | 'AUTH' | 'TEST_DATA' | 'PROCESSOR';
}

export interface DevTestEnvironmentSnapshot {
  caseId: string;
  phase: 'BEFORE' | 'AFTER_EXECUTE' | 'AFTER_CLEANUP';
  value?: unknown;
  fingerprint?: string;
  capturedAt: string;
  error?: string;
}

export interface DevTestPollutionFinding {
  caseId: string;
  previousCaseId?: string;
  classification: 'TEST_POLLUTION' | 'UNEXPECTED_SIDE_EFFECT' | 'SHARED_STATE' | 'ENVIRONMENT_DRIFT';
  severity: DevTestProblemSeverity;
  changedPaths: string[];
  reason: string;
  evidence: {
    before?: DevTestEnvironmentSnapshot;
    after?: DevTestEnvironmentSnapshot;
    afterExecute?: DevTestEnvironmentSnapshot;
    afterCleanup?: DevTestEnvironmentSnapshot;
  };
}

export interface DevTestCaseReliability {
  caseId: string;
  runs: number;
  passRate: number;
  failureRate: number;
  flakeRate: number;
  avgDurationMs: number;
  lastRun?: string;
  status: 'STABLE' | 'FLAKY' | 'UNSTABLE' | 'UNKNOWN';
}

export interface DevTestReliabilitySummary {
  score: number;
  stable: number;
  flaky: number;
  unstable: number;
  unknown: number;
  cases: DevTestCaseReliability[];
}

export interface DevTestNegativeCheck {
  kind: 'MISSING_REQUIRED_FIELD' | 'WRONG_TYPE' | 'UNAUTHORIZED' | 'CROSS_USER' | 'CROSS_TENANT'
    | 'DUPLICATE_REQUEST' | 'REPLAY' | 'INVALID_STATE' | 'STALE_RESOURCE' | 'CONCURRENT_REQUEST';
  operation?: string;
  relatedCaseIds: string[];
  status: 'COVERED' | 'BLOCKED' | 'NOT_APPLICABLE';
  reason: string;
}

export interface DevTestPermissionMatrixRow {
  actor: string;
  tenant?: string;
  project?: string;
  role?: string;
  resource: string;
  operation: string;
  expectedAccess: 'ALLOW' | 'DENY' | 'UNKNOWN';
  caseIds: string[];
}

export interface DevTestRequirementQuality {
  score: number;
  testability: number;
  needsClarification: boolean;
  issues: Array<{ acId?: string; code: 'ACTOR_MISSING' | 'EXPECTED_MISSING' | 'API_MISSING' | 'STATE_MISSING' | 'BOUNDARY_MISSING'; message: string }>;
}

export type DevTestRequirementKnowledge = 'EXPLICIT' | 'DERIVED' | 'UNKNOWN';

/** Acceptance Fact Ledger 的只读交付投影；不会建立第二套需求语义。 */
export interface DevTestRequirementModel {
  requirementId: string;
  title: string;
  facts: Array<{
    id: string;
    statement: string;
    category: RequirementFactCategory;
    knowledge: DevTestRequirementKnowledge;
    provenance: RequirementFactProvenance;
    epistemicType: RequirementEpistemicType;
    normativity: RequirementNormativity;
    status: RequirementFactStatus;
    source: RequirementSourceSpan;
    canonical: CanonicalRequirementFact;
  }>;
  explicitFactIds: string[];
  derivedFactIds: string[];
  unknownFactIds: string[];
}

export type DevTestIssueClassification = 'PRODUCT_BUG' | 'REQUIREMENT_GAP' | 'TEST_DESIGN_ERROR'
  | 'ENVIRONMENT_ERROR' | 'EXECUTION_ERROR' | 'NOT_TESTED' | 'NONE';

export type DevTestAcceptanceResult = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_TESTED';

/** 单 Case 的端到端可审计链，由现有 canonical 模型与真实执行结果投影生成。 */
export interface DevTestAcceptanceTrace {
  caseId: string;
  requirement: {
    acceptanceCriteriaIds: string[];
    factIds: string[];
    explicitFactIds: string[];
    derivedFactIds: string[];
    unknownFactIds: string[];
    assertedFactIds?: string[];
    verifiedFactIds?: string[];
  };
  testModel: {
    objectiveIds: string[];
    scenarioId?: string;
    dimension: string;
    provenance?: string;
    selection?: 'SELECTED' | 'NOT_SELECTED';
    selectionReason?: string;
  };
  executableTest: {
    status: 'READY' | 'DESIGNED_ONLY' | 'BLOCKED';
    preconditions: string[];
    testData?: Record<string, unknown>;
    steps: unknown[];
    assertions: unknown[];
    evidencePlan: TestEvidenceRequirement[];
    missing: string[];
  };
  execution: {
    status: 'EXECUTED' | 'BLOCKED' | 'NOT_EXECUTED';
    rawStatus: string;
    executed: boolean;
    processorInvoked: boolean;
    processor?: string;
    reason?: string;
  };
  evidence: {
    required: TestEvidenceRequirement['channel'][];
    collected: TestEvidenceRequirement['channel'][];
    missing: TestEvidenceRequirement['channel'][];
    requiredItems?: string[];
    collectedItems?: string[];
    missingItems?: string[];
    complete: boolean;
  };
  oracle: Pick<DevTestOracleResult, 'verdict' | 'reason' | 'expected' | 'actual'>;
  result: DevTestAcceptanceResult;
  classification: DevTestIssueClassification;
  problemIds: string[];
  explanation: string[];
}

export interface DevTestDeliveryCoverage {
  requirements: {
    total: number;
    generated: number;
    executed: number;
    verified: number;
    untested: number;
    blocked: number;
    generatedCoverage: number;
    executedCoverage: number;
    verifiedCoverage: number;
    untestedFactIds: string[];
    blockedFactIds: string[];
  };
  cases: {
    generated: number;
    executable: number;
    executed: number;
    verified: number;
    passed: number;
    failed: number;
    blocked: number;
    notTested: number;
  };
  evidence: {
    required: number;
    collected: number;
    coverage: number;
    completeCaseIds: string[];
    incompleteCaseIds: string[];
  };
}

export interface DevTestRootCauseNode {
  id: string;
  rootCause: string;
  problemIds: string[];
  affectedContracts: string[];
  affectedScenarios: string[];
  affectedBusinessFlows: string[];
  affectedCases: string[];
  benefitScore: number;
}

export interface DevTestExpectedBehavior {
  acId: string;
  statement: string;
  actor: string;
  action: string;
  input: string[];
  expectedResponse?: string;
  expectedState?: string;
  expectedSideEffects: string[];
  linkedCaseIds: string[];
  core: boolean;
  status: 'COVERED' | 'UNCOVERED' | 'AMBIGUOUS' | 'BLOCKED';
  missingAssertions: string[];
  supplementalAssertions: Array<{ kind: 'NON_MUTATION' | 'STATE' | 'SIDE_EFFECT'; description: string }>;
}

export interface DevTestRequirementCoverageMatrix {
  behaviors: DevTestExpectedBehavior[];
  coveredAc: string[];
  uncoveredAc: string[];
  ambiguousAc: string[];
  blockedAc: string[];
  coreCoverage: number;
}

export interface DevTestInvariant {
  id: string;
  kind: 'NON_NEGATIVE' | 'ISOLATION' | 'NON_MUTATION' | 'IDEMPOTENCY' | 'DELETION' | 'STATE_TRANSITION' | 'BILLING' | 'AUDIT' | 'CUSTOM';
  statement: string;
  sourceFactIds: string[];
  linkedCaseIds: string[];
  requiredEvidence: Array<'RESPONSE' | 'STATE' | 'SIDE_EFFECT' | 'EVENT' | 'AUDIT'>;
  status: 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'DESIGNED';
  entryPointCaseIds?: string[];
  passedCaseIds?: string[];
  failedCaseIds?: string[];
  blockedCaseIds?: string[];
}

export interface DevTestDataLifecycleRecord {
  runId: string;
  owner?: string;
  tenant?: string;
  project?: string;
  resource?: string;
  createdBy: 'DEVTEST' | 'EXISTING_FIXTURE' | 'UNKNOWN';
  prepareStatus: 'NOT_REQUIRED' | 'READY' | 'FAILED' | 'NOT_CONFIGURED';
  cleanupStatus: 'NOT_REQUIRED' | 'CLEANED' | 'FAILED' | 'NOT_CONFIGURED';
  traceable: boolean;
}

export interface DevTestConfidenceScore {
  score: number;
  factors: { coreCoverage: number; executionCoverage: number; evidenceCoverage: number; problemConfidence: number; unknownPenalty: number; blockedP0Penalty: number };
  failClosed: boolean;
}

export interface DevTestVersionComparison {
  requirementVersion: string;
  codeVersion: string;
  contractVersion: string;
  baselineRunId?: string;
  addedRequirements: string[];
  removedRequirements: string[];
  contractDrift: boolean;
  addedCases: string[];
  removedCases: string[];
  newProblems: string[];
  fixedProblems: string[];
  regressions: string[];
}

export interface DevTestDimensionDecision {
  dimension: DevTestCaseDimension;
  applicability: DevTestDimensionApplicability;
  enabled: boolean;
  reason: string;
  candidateCases: number;
  selectedCases: number;
}

export interface DevTestTestValueScore {
  total: number;
  risk: number;
  businessImpact: number;
  likelihood: number;
  detectability: number;
  executionCost: number;
  reason: string;
}

export interface DevTestCaseProfile {
  caseId: string;
  signature: string;
  informationScore: number;
  core: boolean;
  coreKind?: DevTestCoreCaseKind;
}

export interface DevTestPlan {
  feature: string;
  risk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  dimensions: Array<{ dimension: DevTestCaseDimension; applicability: DevTestDimensionApplicability; cases: number }>;
  estimatedCases: number;
  estimatedExecutable: number;
  estimatedBlocked: number;
  estimatedSideEffects: Array<{ caseId: string; effect: 'READ' | 'WRITE' | 'DELETE' | 'BILLING' | 'PROVIDER'; blocked: boolean }>;
  coreCases: Array<{ caseId: string; kind: DevTestCoreCaseKind }>;
  deduplication: { generated: number; retained: number; removed: number; groups: Array<{ kept: string; removed: string[] }> };
  impact: { changedFiles: string[]; affectedCaseIds: string[]; expandedCaseIds: string[]; affectedFlowIds: string[];
    applied: boolean; scopeConfidence: 'HIGH' | 'LOW'; reason: string };
  cache: { status: 'HIT' | 'MISS' | 'INVALIDATED'; reason: string };
  extendedDimensions: Array<{ dimension: DevTestExtendedDimension; applicable: boolean; reason: string; caseIds: string[] }>;
  executionGroups: Array<{ mode: 'SERIAL' | 'PARALLEL'; caseIds: string[]; reason: string }>;
  businessFlowIds: string[];
  regressionGuardCaseIds: string[];
  estimate: DevTestExecutionEstimate;
  tiers: Record<DevTestTier, string[]>;
  deep: boolean;
}

export interface DevTestUiElement {
  kind: 'PAGE' | 'BUTTON' | 'FORM' | 'INPUT' | 'DIALOG' | 'LIST' | 'DETAIL';
  name: string;
  source: string;
  confidence: number;
  /** 只有源码中存在稳定 id/name/data-testid 时才提供；文本不是可靠定位器。 */
  selector?: string;
}

export type DevTestEnvironmentStatus = 'READY' | 'PARTIAL' | 'BLOCKED';
export type DevTestCapabilityStatus = 'READY' | 'BLOCKED' | 'NOT_REQUIRED' | 'UNKNOWN';
export type DevTestFailureClass = 'PRODUCT_BUG' | 'TEST_ISSUE' | 'ENVIRONMENT_ISSUE' | 'CONTRACT_ISSUE'
  | 'REQUIREMENT_ISSUE' | 'DATA_ISSUE' | 'AUTH_ISSUE' | 'UNSUPPORTED';

export interface DevTestEnvironmentCandidate {
  url: string;
  source: 'CLI' | 'ENV' | 'PROJECT_CONFIG' | 'LOCAL_DEFAULT';
  sourceRef: string;
  reachable: boolean;
  healthStatus?: number;
  apiStatus?: number;
  error?: string;
}

export interface DevTestEnvironmentPreflight {
  status: DevTestEnvironmentStatus;
  selectedBaseUrl?: string;
  reason?: string;
  ambiguous: boolean;
  candidates: DevTestEnvironmentCandidate[];
  checks: {
    baseUrl: DevTestCapabilityStatus;
    health: DevTestCapabilityStatus;
    authentication: DevTestCapabilityStatus;
    api: DevTestCapabilityStatus;
    browser: DevTestCapabilityStatus;
    database: DevTestCapabilityStatus;
  };
  executableDimensions: DevTestCaseDimension[];
  blockedDimensions: Array<{ dimension: DevTestCaseDimension; reason: string }>;
}

export interface DevTestUiExecutionResult {
  caseId: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED';
  executed: boolean;
  processorInvoked: boolean;
  url?: string;
  steps: string[];
  assertions: Array<{
    selector?: string;
    expected: string;
    actual: string;
    pass: boolean;
    kind?: 'ELEMENT_EXISTS' | 'VALUE_EQUALS' | 'TEXT_CONTAINS' | 'VISIBLE';
    factIds?: string[];
  }>;
  evidence: Array<{ kind: 'PAGE' | 'DOM' | 'NETWORK' | 'SCREENSHOT'; value: unknown }>;
  /** DevTest UI compiler 已从显式 Fact + 稳定 Locator 形成可执行契约；不是执行结果反向推断。 */
  executionContractReady?: boolean;
  error?: string;
  classification?: DevTestFailureClass;
}

export interface DevTestDiscoveryResult {
  projectRoot: string;
  scope: 'CHANGED_FILES' | 'PROJECT_FILES' | 'DISABLED';
  inspectedFiles: number;
  operations: DiscoveredOperation[];
  mappedOperations: DiscoveredOperation[];
  ui: DevTestUiElement[];
  mappedUi: DevTestUiElement[];
  warnings: string[];
  mappingReasons: string[];
}

export interface DevTestFeatureModel {
  feature: { id: string; name: string; description?: string };
  actors: Array<{ id?: string; role?: string; kind: string; source: string }>;
  roles: string[];
  tenants: string[];
  projects: string[];
  resources: string[];
  operations: Array<{ action: string; expression?: string; operationKey?: string }>;
  apis: Array<{ id: string; method: string; path: string; authPolicy: string; source: 'REQUIREMENT' | 'DISCOVERY' }>;
  ui: Array<{ path?: string; element?: string; kind: string; source: string }>;
  states: string[];
  inputs: Array<{ api: string; name: string; type: string; location: string; required: boolean; constraints: string[] }>;
  outputs: Array<{ api: string; status: number; description?: string }>;
  permissions: Array<{ role: string; action: string; resource: string; effect: string }>;
  sideEffects: Array<{ kind: string; action: string; observation: string; expression: string }>;
  billing: string[];
  externalDependencies: string[];
  constraints: string[];
  unresolved: string[];
}

export interface DevTestBaselineDiff {
  baselineRunId?: string;
  currentRunId: string;
  newProblems: string[];
  resolvedProblems: string[];
  persistentProblems: string[];
  newBlocked: string[];
  newlyBlocked: string[];
  regressions: string[];
  unchanged: string[];
  rerunCaseIds: string[];
  problemLifecycle: Array<{ problemId: string; status: DevTestProblemLifecycle }>;
  rerunOutcomes: Array<{ target: string; status: 'FIXED' | 'STILL_FAIL' | 'REGRESSION' | 'BLOCKED' }>;
}

export type DevTestProblemType =
  | 'REQUIREMENT_CONFLICT'
  | 'UNKNOWN_CONTRACT'
  | 'CONTRACT_DRIFT'
  | 'STALE_CONTRACT'
  | 'API_MISSING'
  | 'PROCESSOR_MISSING'
  | 'ASSERTION_MISSING'
  | 'EVIDENCE_MISSING'
  | 'ENVIRONMENT_MISSING'
  | 'AUTH_MISSING'
  | 'DATA_PREP_FAILED'
  | 'SAFE_BLOCKED'
  | 'TEST_FAILED'
  | 'DISCOVERY_FAILED'
  | 'FEATURE_BUG'
  | 'BUSINESS_RULE_BUG'
  | 'DATA_CONSISTENCY_BUG'
  | 'REGRESSION_BUG'
  | 'TEST_POLLUTION'
  | 'FLAKY_TEST'
  | 'REQUIREMENT_QUALITY';

export type DevTestProblemSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** 同一根因只生成一项，affectedCases 关联所有受影响 Case。 */
export interface DevTestProblem {
  id: string;
  type: DevTestProblemType;
  severity: DevTestProblemSeverity;
  dimension: DevTestProblemDimension;
  caseId?: string;
  acId?: string;
  message: string;
  evidence?: unknown;
  remediation?: string;
  affectedCases: string[];
  /** 原始门禁原因码，便于机器审计和问题去重。 */
  reasonCode?: string;
  /** 面向开发者的稳定分类；type/reasonCode 保留给机器审计。 */
  category?: 'Requirement Conflict' | 'API Contract Error' | 'API Behavior Error' | 'UI Behavior Error'
    | 'Permission Error' | 'Data Isolation Error' | 'Parameter Validation Error' | 'State Error'
    | 'Billing Error' | 'Provider Error' | 'Environment Block' | 'Test Reliability'
    | 'Requirement Quality' | 'Unknown';
  confidence?: number;
  confidenceLabel?: 'CONFIRMED' | 'LIKELY' | 'UNKNOWN';
  affectedFeature?: string;
  reproduction?: string[];
  expected?: string;
  actual?: string;
  failureClass?: DevTestFailureClass;
  /** 面向交付报告的六类 Evidence-first 分类；旧 failureClass 保留内部兼容。 */
  issueClassification?: DevTestIssueClassification;
  reproducible?: boolean;
  request?: unknown;
  response?: unknown;
  environment?: { name?: string; baseUrl?: string };
  judgement?: DevTestProblemJudgement;
  lifecycle?: DevTestProblemLifecycle;
  why?: string;
  confidenceFactors?: {
    execution: number;
    assertion: number;
    evidence: number;
    contract: number;
    environment: number;
    reproducibility: number;
  };
  rootCause?: string;
  scope?: 'CASE' | 'FEATURE' | 'BUSINESS_RULE' | 'DATA_CONSISTENCY' | 'REGRESSION';
  businessFlowId?: string;
  affectedContracts?: string[];
  affectedScenarios?: string[];
  affectedBusinessFlows?: string[];
  benefitScore?: number;
  minimalReproduction?: {
    preconditions: string[];
    request?: unknown;
    input?: unknown;
    actor?: unknown;
    expected?: unknown;
    actual?: unknown;
    evidence?: unknown;
  };
}

export interface DevTestDimensionStat {
  dimension: DevTestCaseDimension;
  total: number;
  executable: number;
  passed: number;
  failed: number;
  blocked: number;
  notExecuted: number;
}

export interface DevTestOptions {
  markdown?: string;
  docPath?: string;
  feishuUrl?: string;
  feishuCredentialsPath?: string;
  documentId?: string;
  project?: string;
  /** 可选；缺省读取专用 Base URL 环境变量，仍缺失时只做测试设计并 fail-close。 */
  baseUrl?: string;
  /** 缺省 local；production 始终 fail-closed。 */
  environment?: string;
  /** 缺省 SAFE。LIVE 没有 approvalId 时只生成 BLOCKED 报告，零请求。 */
  mode?: DevTestMode;
  approvalId?: string;
  /** SAFE 写路径仍需本机 Sandbox 或 Cleanup；该开关不绕过 Acceptance Safety Gate。 */
  confirmMutations?: boolean;
  /** 明确声明本次目标是隔离 Sandbox/Fixture；与 confirmMutations 联合使用。 */
  sandbox?: boolean;
  /** 默认只运行 Tier 0 + Tier 1；true 才纳入低频边界 Tier 2。 */
  deep?: boolean;
  /** CLI 仅打印一页开发结论；完整报告资产仍生成。 */
  summary?: boolean;
  /** 兼容旧调用；true 等价于 mode=DRY_RUN。 */
  dryRun?: boolean;
  /** 固定产物根目录，缺省 devtest-results。 */
  outDir?: string;
  /** 缺省 20，风险优先选择而不是超限后整体放行/整体假通过。 */
  maxCases?: number;
  enabledDimensions?: Partial<Record<DevTestCaseDimension, boolean>>;
  /** 默认当前工作目录；用于只读发现 Route/Controller/OpenAPI/前端页面。 */
  projectRoot?: string;
  /** CLI 执行前强制安全同步远端最新代码；仅允许 clean worktree 上 fast-forward。 */
  sourceSync?: DevTestSourceSyncOptions & { enabled: boolean };
  /** false 可完全关闭源码发现；不影响 Requirement 中显式 Contract。 */
  discoverProject?: boolean;
  /** 优先重跑上一 baseline 的 FAIL/BLOCKED/受影响 Case。 */
  rerun?: boolean;
  /** 精准复测问题 ID 或 failed/blocked/regression；仅与 rerun 联合使用。 */
  rerunTarget?: DevTestRerunFilter;
  /** 只复现 Baseline 中指定 Problem，不执行其他 Case。 */
  reproProblemId?: string;
  /** 只生成执行计划与报告，不发送业务请求，也不覆盖 Baseline。 */
  plan?: boolean;
  /** 完整最终验收；强制执行 Preflight/Coverage/Core/Comparison 并生成 v8 报告。 */
  final?: boolean;
  /** 默认 true；P0/Critical 真实失败后停止启动后续 Case。 */
  failFast?: boolean;
  /** 只读且无共享写状态的 Case 最大并发；写/状态机/共享资源仍串行。 */
  concurrency?: number;
  /** 单请求超时，默认 10 秒。 */
  timeoutMs?: number;
  /** 整个 DevTest 执行上限。 */
  maxRuntimeMs?: number;
  /** DevTest 估算成本上限，单位 DEVTEST_UNIT。 */
  budget?: number;
  /** 只执行环境发现/能力检查；仍生成固定五类报告。 */
  preflight?: boolean;
  /** 测试注入点；普通 CLI 使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  actorHeaders?: Record<string, Record<string, string>>;
  lifecyclePrepare?: () => Promise<void>;
  lifecycleCleanup?: () => Promise<void>;
  /** 可选业务状态观察器；Response 证据始终由 DevTest 自动加入。 */
  stateObserver?: (input: {
    caseId: string;
    request?: unknown;
    response?: unknown;
    previousState?: unknown;
  }) => Promise<DevTestStateObservation[]>;
  /** 每个 API Case 前与 Cleanup 后捕获环境状态，用于隐藏副作用与污染判定。 */
  caseSnapshotObserver?: (input: { caseId: string; phase: 'BEFORE' | 'AFTER_EXECUTE' | 'AFTER_CLEANUP' }) => Promise<unknown>;
  casePrepare?: (caseId: string) => Promise<void>;
  caseCleanup?: (caseId: string) => Promise<void>;
  /**
   * 项目侧运行时只注入现有 Scenario Processor/Hook/Evidence 能力；不会定义
   * 新 Case 或 Runner 协议。CLI 仅从 DEVTEST_RUNTIME_MODULE 指向的仓库内模块加载。
   */
  scenarioRuntime?: {
    processors: readonly ScenarioProcessor[];
    prepareHooks?: ReadonlyMap<string, ScenarioHookHandler>;
    cleanupHooks?: ReadonlyMap<string, ScenarioHookHandler>;
    variables?: Record<string, unknown>;
    availableDependencies?: ReadonlySet<string>;
    additionalEvidenceKinds?: ReadonlySet<ScenarioEvidenceKind>;
    availablePreflights?: ReadonlySet<string>;
    availableTestData?: ReadonlySet<string>;
  };
  /** 平台/测试注入点；普通 CLI 不暴露，不改变默认 SAFE 门禁。 */
  processor?: ApiProcessor | null;
  contractResolver?: ContractResolver;
}

export interface DevTestArtifacts {
  dir: string;
  reportHtml: string;
  reportJson: string;
  casesCsv: string;
  problemsMd: string;
  evidenceJson: string;
  acceptanceSummaryMd: string;
  /** 面向开发交接的完整结构化测试用例。 */
  testCasesMd: string;
  /** 用户约定的固定七段开发自测报告。 */
  developerSelfTestReportMd: string;
  sourceSyncJson?: string;
}

export interface DevTestRunResult {
  runId: string;
  conclusion: DevTestFeatureResult;
  mode: DevTestMode;
  sourceSync?: DevTestSourceSyncResult;
  pendingMutationCaseIds: string[];
  problems: DevTestProblem[];
  dimensionStats: DevTestDimensionStat[];
  dimensionApplicability: DevTestDimensionDecision[];
  featureModel: DevTestFeatureModel;
  discovery: DevTestDiscoveryResult;
  testValueScores: Record<string, DevTestTestValueScore>;
  caseProfiles: Record<string, DevTestCaseProfile>;
  plan: DevTestPlan;
  requirementCoverage: DevTestRequirementCoverageMatrix;
  invariants: DevTestInvariant[];
  devConfidence: DevTestConfidenceScore;
  versionComparison: DevTestVersionComparison;
  dataLifecycle: DevTestDataLifecycleRecord;
  businessFlowGraph: DevTestBusinessFlowGraph;
  stateConsistency: DevTestStateConsistencyResult[];
  regressionGuard: DevTestRegressionGuard;
  executionEstimate: DevTestExecutionEstimate;
  oracleResults: DevTestOracleResult[];
  adaptiveScores: Record<string, DevTestAdaptiveTestScore>;
  negativeChecks: DevTestNegativeCheck[];
  permissionMatrix: DevTestPermissionMatrixRow[];
  pollutionFindings: DevTestPollutionFinding[];
  reliability: DevTestReliabilitySummary;
  requirementQuality: DevTestRequirementQuality;
  rootCauseGraph: DevTestRootCauseNode[];
  requirementModel: DevTestRequirementModel;
  acceptanceTraces: DevTestAcceptanceTrace[];
  deliveryCoverage: DevTestDeliveryCoverage;
  baseline: DevTestBaselineDiff;
  reproduction?: { problemId: string; status: DevTestReproductionStatus; caseIds: string[] };
  environmentPreflight: DevTestEnvironmentPreflight;
  uiExecutions: DevTestUiExecutionResult[];
  artifacts: DevTestArtifacts;
  pipeline: {
    summary: AcceptanceReport['summary'];
    trust: AcceptanceReport['trust'];
    mode: 'execute' | 'dry-run';
    report: AcceptanceReport;
    contracts: ContractPreflight;
  };
}
