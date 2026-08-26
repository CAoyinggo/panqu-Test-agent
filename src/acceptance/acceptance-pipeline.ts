import type { ApiProcessor } from './api-processor.js';
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
}

export const DEFAULT_ACCEPTANCE_MAX_CASES = 500;
export const DEFAULT_ACCEPTANCE_DEADLINE_MS = 15 * 60 * 1000;

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
  const executableCaseCount = testCases.filter((testCase) => !isDesignedOnlyCase(testCase)).length;
  const caseLimitReason = mode === 'execute' && executableCaseCount > maxCases
    ? `CASE_LIMIT_EXCEEDED：生成 ${executableCaseCount} 条可执行 Case，超过 maxCases=${maxCases}`
    : undefined;
  const executableOperationKeys = testCases
    .filter((testCase) => !isDesignedOnlyCase(testCase))
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
    && testCases.some((testCase) => !isDesignedOnlyCase(testCase));
  if (mode === 'execute' && hasExecutableCases && options.lifecycle?.prepare) {
    try {
      await options.lifecycle.prepare();
    } catch (error) {
      prepareError = redactSensitiveText((error as Error).message);
    }
  }

  let run;
  try {
    run = await runAcceptanceApiCases(testCases, {
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
