import type { AcceptanceCaseExecutionResult, ApiProcessor } from './api-processor.js';
import { buildAcceptanceDefects, runAcceptanceApiCases } from './api-processor.js';
import { buildAcceptanceReport, renderAcceptanceReportHtml, renderAcceptanceReportJson, renderAcceptanceReportMarkdown } from './acceptance-report.js';
import { generateAcceptanceApiCases } from './test-case-generator.js';
import { parseAcceptanceRequirement } from './requirement-parser.js';
import { generateTestPoints } from './test-point.js';
import { isDesignedOnlyCase } from '../agents/test-design/testcase-schema.js';
import { buildAcceptanceTestDesign, finalizeRequirementFactLedger } from './test-objective.js';
import { generateRunId } from '../utils/run-id.js';
import { redactSensitiveText } from '../core/redact.js';
import type { AcceptanceRisk } from './acceptance-report.js';
import { validateAcceptanceTrace } from './traceability.js';
import {
  evaluateAcceptanceExecutionSafety,
  type AcceptanceExecutionSafetyPolicy,
} from './acceptance-safety-policy.js';
import {
  buildAcceptanceExecutionPlanIdentity,
  assignStableAcceptanceCaseIds,
  validateAcceptanceExecutionPlanIdentity,
  type AcceptanceExecutionPlanIdentity,
} from './acceptance-execution-plan.js';
import { applyTestCaseQualityGate } from './test-case-quality-gate.js';
import type { FactBasedRegressionPlan } from './acceptance-regression.js';
import { contractDependency } from '../contracts/dependency-index.js';
import { preflightContracts, registerAcceptanceApiContracts, type ContractPreflight } from '../contracts/contract-gate.js';
import { createPhase1ContractResolver } from '../contracts/seed-contracts.js';
import { contractSource } from '../contracts/source-priority.js';
import type { ContractResolver } from '../contracts/resolver.js';
import type { ContractDependency } from '../contracts/types.js';
import { reviewTestDesign } from './test-design-intelligence.js';
import { computeOutcome } from '../agents/execution/execution-schema.js';
import {
  runTestCaseV2WithScenarioRunner,
  type TestCaseScenarioAdapterOptions,
  type TestCaseScenarioExecution,
} from './test-case-scenario-adapter.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';

export interface AcceptanceDataLifecycle {
  prepare?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface AcceptancePipelineOptions {
  markdown: string;
  project: string;
  documentId?: string;
  baseUrl: string;
  actorHeaders?: Record<string, Record<string, string>>;
  environment?: string;
  /** execute 必须显式提供；Pipeline 会在 Data Prepare/HTTP 前重新校验。 */
  safetyPolicy?: AcceptanceExecutionSafetyPolicy;
  processor?: ApiProcessor | null;
  timeoutMs?: number;
  /** 真实执行的 Case 安全上限；超过时整个 Run 在网络请求前阻断。 */
  maxCases?: number;
  /** HTTP Execution 阶段时限；不覆盖 Parser、自定义 Data Prepare/Cleanup 与 Artifact 写入。 */
  deadlineMs?: number;
  concurrency?: number;
  failFast?: boolean;
  signal?: AbortSignal;
  runId?: string;
  parentRunId?: string;
  mode?: 'execute' | 'dry-run';
  scope?: string[];
  caseIds?: string[];
  /** Required for execute + caseIds; obtained from a prior dry-run or archived Run. */
  expectedExecutionPlan?: AcceptanceExecutionPlanIdentity;
  /** 修复回归的 Fact/Policy 影响范围；报告必须保留选择依据。 */
  regressionPlan?: FactBasedRegressionPlan;
  lifecycle?: AcceptanceDataLifecycle;
  /** Agent/Acceptance/Legacy 共用的 canonical Resolver 实现；可注入同一实例做跨入口治理。 */
  contractResolver?: ContractResolver;
  /** 调用入口显式解析出的额外 Contract 依赖；会进入同一 Dependency/Drift Gate。 */
  additionalContractDependencies?: ContractDependency[];
  /** Optional runtime capabilities for canonical TEST_CASE_V2 → Scenario Runner execution. */
  scenarioRunnerOptions?: TestCaseScenarioAdapterOptions;
}

export const DEFAULT_ACCEPTANCE_MAX_CASES = 500;
export const DEFAULT_ACCEPTANCE_DEADLINE_MS = 15 * 60 * 1000;

function resultFromScenarioExecution(
  testCase: TestCase,
  execution: TestCaseScenarioExecution,
): AcceptanceCaseExecutionResult {
  const result = execution.outcome.result;
  const request = result.evidence.find((item) => item.kind === 'REQUEST')?.data;
  const response = result.evidence.find((item) => item.kind === 'RESPONSE')?.data;
  const passed = result.status === 'PASS';
  const failed = result.status === 'FAIL';
  const status = (['PASS', 'FAIL', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED'] as const)
    .includes(result.status as 'PASS' | 'FAIL' | 'NOT_EXECUTED' | 'TIMEOUT' | 'CANCELLED')
    ? result.status as 'PASS' | 'FAIL' | 'NOT_EXECUTED' | 'TIMEOUT' | 'CANCELLED'
    : 'BLOCKED' as const;
  const classification = passed ? 'SUCCESS' as const
    : failed ? 'PRODUCT_FAILURE' as const
      : result.status === 'NOT_EXECUTED' ? 'NOT_EXECUTED' as const : 'EXECUTION_BLOCKED' as const;
  const operationFailures = result.operationResults
    .filter((item) => item.status !== 'PASS')
    .map((item) => `${item.operationId}:${item.status}:${item.error
      ?? item.blockedReasons.map((reason) => reason.code).join(',')
      ?? 'UNKNOWN'}`);
  const assertions = execution.adapted.scenario.assertions.map((assertion) => {
    const observed = result.evidence.find((item) => item.assertionId === assertion.id
      || item.id === `ASSERTION-${assertion.id}`);
    const observation = observed?.data && typeof observed.data === 'object' && !Array.isArray(observed.data)
      ? observed.data as Record<string, unknown> : undefined;
    const assertionPass = typeof observation?.pass === 'boolean' ? observation.pass : passed;
    return {
      assertionId: assertion.id,
      evidenceRequirementIds: [...assertion.evidenceRequirementIds],
      type: `${assertion.channel}:${assertion.operator}`,
      path: assertion.target,
      factIds: testCase.source?.factIds,
      objectiveIds: testCase.source?.objectiveIds,
      sourceType: testCase.source?.sourceType,
      provenance: testCase.source?.provenance,
      expected: observation && 'expected' in observation ? observation.expected : assertion.expected,
      actual: observation?.actual,
      pass: assertionPass,
      detail: observed
        ? `Scenario Runner ${assertionPass ? '验证通过' : '验证失败'}：${assertion.channel}:${assertion.target}`
        : result.summary ?? result.status,
    };
  });
  return {
    runId: result.runId,
    caseId: testCase.id,
    name: testCase.name,
    feature: testCase.feature,
    scene: 'api',
    processor: result.processors.join(',') || undefined,
    processorInvoked: result.processorInvoked,
    timestamp: new Date().toISOString(),
    priority: testCase.priority,
    tags: testCase.tags,
    executed: result.executed,
    status,
    pass: passed,
    passRate: passed ? 100 : 0,
    assertions: result.assertions,
    passedAssertions: result.passedAssertions,
    failedAssertions: result.failedAssertions,
    durationMs: result.durationMs,
    error: passed ? undefined : [result.summary, ...operationFailures,
      ...result.blockedReasons.map((item) => `${item.code}：${item.message}`)]
      .filter(Boolean).join('；'),
    blockedReason: result.blockedReasons[0] ?? null,
    classification,
    attribution: {
      classification,
      confidence: passed || result.executed === false ? 'HIGH' : 'MEDIUM',
      reason: passed ? 'Scenario Runner 的全部 Assertion 与 required Evidence 通过'
        : failed ? 'Scenario Runner 的确定性 Oracle 失败'
          : 'Runtime Readiness 或 Scenario Gate 未满足',
      evidenceSources: ['SCENARIO_RUNNER', 'RUNTIME_READINESS', 'EVIDENCE_ORACLE'],
    },
    evidence: {
      requirementId: testCase.source?.requirementId,
      acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: testCase.source?.factIds ?? [],
      objectiveIds: testCase.source?.objectiveIds ?? [],
      scenarioId: execution.adapted.scenario.id,
      sourceType: testCase.source?.sourceType,
      testPointId: testCase.source?.testPointId,
      request: request && typeof request === 'object' ? request as NonNullable<AcceptanceCaseExecutionResult['evidence']['request']> : undefined,
      response: response && typeof response === 'object' ? response as NonNullable<AcceptanceCaseExecutionResult['evidence']['response']> : undefined,
      assertions,
      evidenceItems: execution.adapted.scenario.evidenceRequirements.filter((item) => item.requiredForPass).map((requirement) => {
        const observed = result.evidence.find((item) => item.id === requirement.id || item.requirementId === requirement.id);
        return {
          requirementId: requirement.id,
          channel: requirement.kind,
          sourceStepId: requirement.sourceRef,
          collected: Boolean(observed),
          verified: observed?.verified === true,
          observedAt: observed?.observedAt,
          missingReason: observed ? undefined : 'Scenario Runner 未采集 required Evidence',
        };
      }),
      oracleResult: {
        verdict: passed ? 'PASS' : failed ? 'FAIL' : 'BLOCKED',
        assertionIds: execution.adapted.scenario.assertions.map((item) => item.id),
        evidenceRequirementIds: execution.adapted.scenario.evidenceRequirements
          .filter((item) => item.requiredForPass).map((item) => item.id),
        reasons: passed ? [] : [result.summary ?? result.status],
      },
      transport: {
        requestDispatched: result.operationResults.some((item) => item.processorInvoked),
        responseCompleted: Boolean(response),
        outcome: result.executed ? 'CONFIRMED' : 'UNKNOWN',
        sideEffect: result.operationResults.some((item) => item.processorInvoked
          && execution.adapted.scenario.operations.some((operation) => operation.id === item.operationId
            && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method ?? '')))
          ? 'POSSIBLY_COMMITTED' : 'NOT_APPLICABLE',
      },
    },
  };
}

async function runAcceptanceScenarioCases(
  testCases: TestCase[],
  options: TestCaseScenarioAdapterOptions,
) {
  const results: AcceptanceCaseExecutionResult[] = [];
  for (const testCase of testCases) {
    const execution = await runTestCaseV2WithScenarioRunner(testCase, options);
    results.push(resultFromScenarioExecution(testCase, execution));
  }
  return {
    results,
    outcome: computeOutcome(testCases[0]?.feature ?? 'acceptance', results, {
      executed: results.length > 0 && results.every((item) => item.executed
        && (item.status === 'PASS' || item.status === 'FAIL')),
      summary: `Scenario Runner 验收：${results.length} 条 TEST_CASE_V2`,
    }),
  };
}

/** Requirement → Fact Ledger → Objective/Scenario → Case → Initial Execution → Evidence/Defect → fixed reports. */
export async function runAcceptancePipeline(options: AcceptancePipelineOptions) {
  const runId = options.runId ?? `RUN-${generateRunId()}`;
  const mode = options.mode ?? 'execute';
  const requirement = parseAcceptanceRequirement(options.markdown, { documentId: options.documentId });
  const contractResolver = options.contractResolver ?? createPhase1ContractResolver();
  const requirementContract = contractResolver.registry.register({
    id: `resource.acceptance.${requirement.id.toLowerCase()}`,
    kind: 'resource',
    subject: requirement.id,
    version: 'v1',
    status: requirement.warnings.some((warning) => warning.blocking) ? 'CONFLICT' : 'ACTIVE',
    value: { title: requirement.title, acceptanceCriteria: requirement.acceptanceCriteria, facts: requirement.factLedger },
    sources: [contractSource('markdown', options.documentId ?? `acceptance:${requirement.id}`)],
    createdAt: new Date().toISOString(),
  });
  const apiContractDependencies = registerAcceptanceApiContracts(
    requirement.apis,
    contractResolver,
    options.documentId ?? `acceptance:${requirement.id}`,
  );
  const contractPreflight: ContractPreflight = preflightContracts(contractResolver, [
    contractDependency(requirementContract),
    ...apiContractDependencies.values(),
    ...(options.additionalContractDependencies ?? []),
  ]);
  const design = buildAcceptanceTestDesign(requirement);
  const allTestPoints = generateTestPoints(requirement, design);
  const caseQuality = applyTestCaseQualityGate({
    requirement,
    objectives: design.objectives,
    testCases: generateAcceptanceApiCases(requirement, allTestPoints),
  });
  const allTestCases = caseQuality.testCases;
  for (const testCase of allTestCases) {
    const dependency = testCase.source?.apiSpecId ? apiContractDependencies.get(testCase.source.apiSpecId) : undefined;
    testCase.contractDependencies = [
      dependency ?? contractDependency(requirementContract),
      ...(options.additionalContractDependencies ?? []),
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.contractId === item.contractId
      && candidate.version === item.version && candidate.fingerprint === item.fingerprint) === index);
    if (testCase.source && dependency) {
      testCase.source.contractRef = dependency.contractId;
      testCase.source.contractVersion = dependency.version;
      testCase.source.contractFingerprint = dependency.fingerprint;
    }
  }
  // Contract refs/fingerprints are execution semantics. Finalize Case IDs only
  // after those bindings exist so Baseline/Rerun never reuse a pre-contract ID.
  assignStableAcceptanceCaseIds(allTestCases);
  for (let index = 0; index < caseQuality.assessments.length; index++) {
    caseQuality.assessments[index].caseId = allTestCases[index].id;
  }
  const requestedScope = new Set((options.scope ?? []).map((item) => item.trim().toUpperCase()).filter(Boolean));
  const requestedCases = new Set(options.caseIds ?? []);
  const testCases = allTestCases.filter((testCase) => {
    if (requestedCases.size && !requestedCases.has(testCase.id)) return false;
    if (!requestedScope.size) return true;
    return requestedScope.has(String(testCase.testType ?? '').toUpperCase())
      || testCase.source?.factIds?.some((id) => requestedScope.has(id.toUpperCase())) === true
      || testCase.source?.objectiveIds?.some((id) => requestedScope.has(id.toUpperCase())) === true
      || testCase.source?.acceptanceCriteriaIds.some((id) => requestedScope.has(id.toUpperCase())) === true;
  });
  if ((requestedCases.size || requestedScope.size) && !testCases.length) {
    const prefix = mode === 'execute' && requestedCases.size ? 'STALE_PLAN：' : '';
    throw new Error(`${prefix}指定测试范围没有匹配用例：${[...requestedCases, ...requestedScope].join(', ')}`);
  }
  const executionPlan = buildAcceptanceExecutionPlanIdentity({
    markdown: options.markdown,
    allTestCases,
    selectedCaseIds: testCases.map((testCase) => testCase.id),
  });
  const mustValidatePriorPlan = mode === 'execute'
    && (requestedCases.size > 0 || options.expectedExecutionPlan !== undefined || options.parentRunId !== undefined);
  const scopedPlanDecision = mustValidatePriorPlan
    ? validateAcceptanceExecutionPlanIdentity({
      expected: options.expectedExecutionPlan,
      current: executionPlan,
      requestedCaseIds: testCases.map((testCase) => testCase.id),
    })
    : { valid: true as const };
  const stalePlanReason = scopedPlanDecision.valid ? undefined : scopedPlanDecision.reason;
  const pointIds = new Set(testCases.map((testCase) => testCase.source?.testPointId));
  const testPoints = allTestPoints.filter((point) => pointIds.has(point.id));
  const objectiveIds = new Set(testCases.flatMap((testCase) => testCase.source?.objectiveIds ?? []));
  const objectives = design.objectives.filter((objective) => objectiveIds.has(objective.id));
  const scenarioIds = new Set(objectives.map((objective) => objective.scenarioId).filter(Boolean));
  const scenarios = design.scenarios.filter((scenario) => scenarioIds.has(scenario.id)
    || scenario.objectiveIds.some((id) => objectiveIds.has(id)));
  const scenarioCandidates = design.scenarioCandidates.filter((scenario) =>
    scenario.objectiveIds.some((id) => objectiveIds.has(id)));
  const testDesignReview = reviewTestDesign({
    requirement,
    businessModel: design.businessModel,
    strategy: design.testStrategy,
    scenarioCandidates,
    testCases,
  });
  finalizeRequirementFactLedger(requirement, objectives, testCases);
  const traceIssues = validateAcceptanceTrace(requirement, testPoints, testCases, objectives);
  if (traceIssues.length) throw new Error(`Acceptance Trace 校验失败：${traceIssues.map((issue) => issue.message).join('；')}`);

  const maxCases = options.maxCases ?? DEFAULT_ACCEPTANCE_MAX_CASES;
  // Parser/Fact validation is the authority for blocking semantics. A second
  // code allowlist here can silently downgrade new blocking constraints.
  const blockingRequirementWarnings = requirement.warnings.filter((warning) => warning.blocking);
  const requirementBlockReason = blockingRequirementWarnings.length
    ? `REQUIREMENT_CONTRACT_INCOMPLETE：${blockingRequirementWarnings.map((warning) => warning.code).join(', ')}`
    : undefined;
  const contractBlockReason = contractPreflight.validation.status === 'VALID' ? undefined
    : `CONTRACT_GATE_${contractPreflight.validation.status}：${contractPreflight.validation.reasons.join('；')}`;
  const runtimeCandidate = (testCase: TestCase): boolean => options.scenarioRunnerOptions !== undefined
    && testCase.schemaVersion === 'TEST_CASE_V2'
    && testCase.steps.some((step) => step.type === 'HTTP_REQUEST');
  const executableCaseCount = testCases.filter((testCase) => !isDesignedOnlyCase(testCase) || runtimeCandidate(testCase)).length;
  const caseLimitReason = mode === 'execute' && executableCaseCount > maxCases
    ? `CASE_LIMIT_EXCEEDED：生成 ${executableCaseCount} 条可执行 Case，超过 maxCases=${maxCases}`
    : undefined;
  const executableOperationKeys = testCases
    // Policy must see every concrete HTTP operation even when generated
    // Readiness is DESIGNED_ONLY. Runtime capability resolution may upgrade it,
    // but can never bypass SAFE/BILLABLE/approval policy.
    .filter((testCase) => !isDesignedOnlyCase(testCase)
      || testCase.schemaVersion === 'TEST_CASE_V2' && testCase.steps.some((step) => step.type === 'HTTP_REQUEST'))
    .map((testCase) => testCase.source?.apiOperationKey)
    .filter((operationKey): operationKey is string => Boolean(operationKey));
  const safetyDecision = mode === 'execute' && executableOperationKeys.length
    ? evaluateAcceptanceExecutionSafety({
      policy: options.safetyPolicy,
      environment: options.environment,
      baseUrl: options.baseUrl,
      operationKeys: executableOperationKeys,
      hasCleanup: typeof options.lifecycle?.cleanup === 'function',
    })
    : { allowed: true as const };
  const safetyBlockReason = safetyDecision.allowed ? undefined : safetyDecision.reason;

  let prepareError: string | undefined;
  let cleanupError: string | undefined;
  const hasExecutableCases = !stalePlanReason && !safetyBlockReason && !caseLimitReason && !requirementBlockReason && !contractBlockReason
    && testCases.some((testCase) => !isDesignedOnlyCase(testCase) || runtimeCandidate(testCase));
  if (mode === 'execute' && hasExecutableCases && options.lifecycle?.prepare) {
    try {
      await options.lifecycle.prepare();
    } catch (error) {
      prepareError = redactSensitiveText((error as Error).message);
    }
  }

  let run;
  try {
    run = options.scenarioRunnerOptions && mode === 'execute'
      && !contractBlockReason && !stalePlanReason && !safetyBlockReason && !requirementBlockReason
      && !caseLimitReason && !prepareError
      ? await runAcceptanceScenarioCases(testCases, {
        ...options.scenarioRunnerOptions,
        runId,
        signal: options.signal,
        contractResolver,
      })
      : await runAcceptanceApiCases(testCases, {
      baseUrl: options.baseUrl,
      actorHeaders: options.actorHeaders,
      processor: options.processor,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs ?? DEFAULT_ACCEPTANCE_DEADLINE_MS,
      concurrency: options.concurrency,
      failFast: options.failFast,
      signal: options.signal,
      apiSpecs: requirement.apis,
      contractResolver,
      lifecycleReady: typeof options.lifecycle?.cleanup === 'function' || options.safetyPolicy?.allowNoCleanup === true,
      runId,
      executionEnabled: mode === 'execute',
      blockedReason: contractBlockReason ?? stalePlanReason ?? safetyBlockReason ?? requirementBlockReason ?? caseLimitReason ?? (prepareError ? `测试数据准备失败：${prepareError}` : undefined),
      blockedClassification: contractBlockReason || stalePlanReason || safetyBlockReason || requirementBlockReason || caseLimitReason ? 'EXECUTION_BLOCKED' : undefined,
    });
  } finally {
    if (mode === 'execute' && hasExecutableCases && options.lifecycle?.cleanup) {
      try {
        await options.lifecycle.cleanup();
      } catch (error) {
        cleanupError = redactSensitiveText((error as Error).message);
      }
    }
  }
  const externalRisks: AcceptanceRisk[] = [];
  if (cleanupError) externalRisks.push({
    caseId: runId,
    status: 'CLEANUP_FAILED',
    classification: 'DATA_LIFECYCLE',
    description: `测试数据清理失败：${cleanupError}`,
  });
  const defects = buildAcceptanceDefects(run.results, options.environment, { runId, testCases });
  const report = buildAcceptanceReport({
    runId,
    parentRunId: options.parentRunId,
    project: options.project,
    environment: options.environment,
    mode,
    requirement,
    objectives,
    dimensionDecisions: design.dimensionDecisions.filter((decision) => requirement.factLedger.some((fact) => fact.id === decision.factId)),
    scenarios,
    testPoints,
    testCases,
    caseQuality,
    regressionPlan: options.regressionPlan,
    results: run.results,
    defects,
    externalRisks,
  });
  const outcome = cleanupError
    ? {
      ...run.outcome,
      executed: false,
      passRate: 0,
      summary: `${run.outcome.summary ?? 'API 开发验收'}；DATA_LIFECYCLE_INCOMPLETE：Cleanup 失败`,
    }
    : run.outcome;
  return {
    runId,
    executionPlan,
    requirement,
    businessModel: design.businessModel,
    businessUnderstanding: design.businessUnderstanding,
    testStrategy: design.testStrategy,
    scenarioCandidates,
    testDesignReview,
    contracts: contractPreflight,
    objectives,
    dimensionDecisions: design.dimensionDecisions.filter((decision) => requirement.factLedger.some((fact) => fact.id === decision.factId)),
    scenarios,
    testPoints,
    testCases,
    caseQuality: {
      ...caseQuality,
      assessments: caseQuality.assessments.filter((assessment) => testCases.some((testCase) => testCase.id === assessment.caseId)),
      testCases,
    },
    outcome,
    results: run.results,
    defects,
    report,
    rendered: {
      json: renderAcceptanceReportJson(report),
      markdown: renderAcceptanceReportMarkdown(report),
      html: renderAcceptanceReportHtml(report),
    },
  };
}
