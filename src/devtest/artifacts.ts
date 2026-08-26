import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { ContractPreflight } from '../contracts/contract-gate.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import { devTestDimensionOf } from './dimension-selector.js';
import type {
  DevTestDimensionDecision,
  DevTestBaselineDiff,
  DevTestDiscoveryResult,
  DevTestEnvironmentPreflight,
  DevTestDimensionStat,
  DevTestFeatureModel,
  DevTestFeatureResult,
  DevTestMode,
  DevTestPlan,
  DevTestProblem,
  DevTestCaseProfile,
  DevTestReproductionStatus,
  DevTestTestValueScore,
  DevTestUiExecutionResult,
  DevTestRequirementCoverageMatrix,
  DevTestInvariant,
  DevTestConfidenceScore,
  DevTestVersionComparison,
  DevTestDataLifecycleRecord,
  DevTestBusinessFlowGraph,
  DevTestStateConsistencyResult,
  DevTestRegressionGuard,
  DevTestExecutionEstimate,
  DevTestOracleResult,
  DevTestAdaptiveTestScore,
  DevTestNegativeCheck,
  DevTestPermissionMatrixRow,
  DevTestPollutionFinding,
  DevTestReliabilitySummary,
  DevTestRequirementQuality,
  DevTestRootCauseNode,
  DevTestRequirementModel,
  DevTestAcceptanceTrace,
  DevTestDeliveryCoverage,
} from './types.js';

export const DEVTEST_REPORT_SCHEMA = 'devtest.report.v8';

export interface DevTestRenderMeta {
  docSource: string;
  baseUrl: string;
  environment: string;
  mode: DevTestMode;
  project: string;
  startedAt: string;
  finishedAt: string;
}

export interface DevTestRenderInput {
  runId: string;
  meta: DevTestRenderMeta;
  conclusion: DevTestFeatureResult;
  report: AcceptanceReport;
  results: AcceptanceCaseExecutionResult[];
  testCases: TestCase[];
  contracts: ContractPreflight;
  problems: DevTestProblem[];
  dimensionStats: DevTestDimensionStat[];
  dimensionApplicability: DevTestDimensionDecision[];
  featureModel: DevTestFeatureModel;
  discovery: DevTestDiscoveryResult;
  testValueScores: Record<string, DevTestTestValueScore>;
  caseProfiles: Record<string, DevTestCaseProfile>;
  plan: DevTestPlan;
  baseline: DevTestBaselineDiff;
  reproduction?: { problemId: string; status: DevTestReproductionStatus; caseIds: string[] };
  environmentPreflight: DevTestEnvironmentPreflight;
  uiExecutions: DevTestUiExecutionResult[];
  pendingMutationCaseIds: string[];
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
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function unknownsOf(report: AcceptanceReport): Array<{ type: string; id: string; message: string }> {
  const observationUnknowns = report.observationGaps.flatMap((gap) => {
    const context = `${gap.testType} ${gap.requiredCapability} ${gap.missingObservation} ${gap.requirement.join(' ')}`.toUpperCase();
    const types: string[] = [];
    if (context.includes('UI') || context.includes('BROWSER') || context.includes('页面')) types.push('UNKNOWN_UI');
    if (context.includes('BILLING') || context.includes('BILLABLE') || context.includes('COST') || context.includes('扣费')) types.push('UNKNOWN_BILLING');
    if (context.includes('PROVIDER') || context.includes('GENERATE') || context.includes('RENDER') || context.includes('生成')) types.push('UNKNOWN_PROVIDER');
    if (!types.length) types.push('UNKNOWN_STATE');
    return types.map((type) => ({
      type,
      id: gap.id,
      message: `${gap.missingObservation}；需要 ${gap.requiredCapability}`,
    }));
  });
  return [
    ...report.coverage.unverifiedFacts.map((fact) => ({ type: 'UNKNOWN_REQUIREMENT', id: fact.id, message: fact.statement })),
    ...observationUnknowns,
    ...report.bindingIssues.map((issue) => ({ type: 'UNKNOWN_CONTRACT', id: issue.code, message: issue.message })),
  ];
}

function contractRowsOf(input: DevTestRenderInput) {
  const dependencyById = new Map(input.contracts.dependencies.map((dependency) => [dependency.contractId, dependency]));
  return input.contracts.resolutions.map((resolution) => {
    const id = resolution.contract?.id ?? resolution.query.id ?? resolution.candidates[0]?.id;
    const dependency = id ? dependencyById.get(id) : undefined;
    const candidate = resolution.contract ?? resolution.candidates.find((item) => item.fingerprint === dependency?.fingerprint)
      ?? resolution.candidates[0];
    return {
      id,
      subject: candidate?.subject ?? resolution.query.subject,
      version: candidate?.version ?? dependency?.version,
      fingerprint: candidate?.fingerprint ?? dependency?.fingerprint,
      status: resolution.status,
      reason: resolution.reason,
      sources: resolution.sources.length ? resolution.sources : dependency?.sources,
    };
  });
}

function caseRows(input: DevTestRenderInput) {
  const executionByCase = new Map(input.results.map((execution) => [execution.caseId, execution]));
  const uiByCase = new Map(input.uiExecutions.map((execution) => [execution.caseId, execution]));
  const canonicalByCase = new Map(input.testCases.map((testCase) => [testCase.id, testCase]));
  const traceByCase = new Map(input.acceptanceTraces.map((trace) => [trace.caseId, trace]));
  return input.report.cases.map((item) => {
    const execution = executionByCase.get(item.caseId);
    const uiExecution = uiByCase.get(item.caseId);
    const canonical = canonicalByCase.get(item.caseId);
    const trace = traceByCase.get(item.caseId);
    const assertions = execution?.evidence.assertions ?? [];
    const requiredEvidence = [
      canonical?.executionMode === 'EXECUTABLE' ? 'REQUEST' : undefined,
      canonical?.executionMode === 'EXECUTABLE' ? 'RESPONSE' : undefined,
      canonical?.assertions.length ? 'ASSERTIONS' : undefined,
      ['DATA_ISOLATION', 'FUNCTIONAL'].includes(devTestDimensionOf(item.testType)) ? 'STATE_OR_SIDE_EFFECT_OBSERVER' : undefined,
    ].filter((value): value is string => Boolean(value));
    return {
      caseId: item.caseId,
      acId: item.evidence.acceptanceCriteriaIds?.[0] ?? '',
      dimension: devTestDimensionOf(item.testType),
      title: item.scenario,
      priority: item.priority,
      risk: canonical?.design?.expectedOutcome ?? canonical?.metadata?.risk ?? '',
      actor: canonical?.actor?.id ?? '',
      role: canonical?.actor?.role ?? '',
      tenant: canonical?.actor?.tenantId ?? '',
      project: input.meta.project,
      contractDependencies: canonical?.contractDependencies ?? [],
      preconditions: canonical?.preconditions ?? [],
      steps: canonical?.steps ?? [],
      expectedResponse: canonical?.expected ?? {},
      expectedState: canonical?.design?.expectedOutcome ?? '',
      assertions: canonical?.assertions ?? [],
      requiredEvidence,
      executionMode: item.executionMode,
      status: trace?.result === 'NOT_TESTED' ? 'NOT_EXECUTED' : trace?.result ?? 'BLOCKED',
      rawStatus: uiExecution?.status ?? execution?.status ?? item.executionStatus,
      blockedReason: trace?.result === 'BLOCKED' || trace?.result === 'NOT_TESTED'
        ? trace.explanation.join('；') : uiExecution?.error ?? execution?.attribution.reason ?? item.qualityIssues.join('；'),
      executed: uiExecution?.executed ?? execution?.executed === true,
      processor: uiExecution ? 'PlaywrightBrowserProcessor' : execution?.processor ?? '',
      assertionEvidence: uiExecution?.assertions ?? assertions,
      evidence: uiExecution?.evidence ?? execution?.evidence,
      contractStatus: input.contracts.validation.status,
      valueScore: input.testValueScores[item.caseId],
      core: input.caseProfiles[item.caseId]?.core ?? false,
      coreKind: input.caseProfiles[item.caseId]?.coreKind,
      problemIds: input.problems.filter((problem) => problem.affectedCases.includes(item.caseId)).map((problem) => problem.id),
      confidence: input.problems.filter((problem) => problem.affectedCases.includes(item.caseId))
        .reduce((highest, problem) => Math.max(highest, problem.confidence ?? 0), 0),
      actual: uiExecution?.error ?? execution?.error ?? execution?.attribution.reason ?? uiExecution?.status ?? execution?.status ?? item.executionStatus,
    };
  });
}

function dimensionsObject(input: DevTestRenderInput): Record<string, unknown> {
  const key = {
    API: 'api', FUNCTIONAL: 'functional', UI: 'ui',
    DATA_ISOLATION: 'dataIsolation', PARAMETER_VALIDATION: 'parameterValidation',
  } as const;
  return Object.fromEntries(input.dimensionStats.map((stat) => {
    const applicability = input.dimensionApplicability.find((item) => item.dimension === stat.dimension);
    return [key[stat.dimension], { ...stat, applicability }];
  }));
}

export function buildDevTestReportEnvelope(input: DevTestRenderInput): Record<string, unknown> {
  const cases = caseRows(input);
  return {
    schema: DEVTEST_REPORT_SCHEMA,
    run: {
      id: input.runId,
      startedAt: input.meta.startedAt,
      finishedAt: input.meta.finishedAt,
      environment: input.meta.environment,
      mode: input.meta.mode,
    },
    feature: {
      name: input.report.requirement.title,
      requirement: input.meta.docSource,
      project: input.meta.project,
      model: input.featureModel,
    },
    summary: {
      status: input.conclusion,
      devConfidence: input.devConfidence,
      coreAcCoverage: input.requirementCoverage.coreCoverage,
      businessFlowCoverage: input.businessFlowGraph.applicable === false ? null : input.businessFlowGraph.coverage,
      totalCases: input.deliveryCoverage.cases.generated,
      pass: input.deliveryCoverage.cases.passed,
      fail: input.deliveryCoverage.cases.failed,
      blocked: input.deliveryCoverage.cases.blocked,
      notExecuted: input.deliveryCoverage.cases.notTested,
      confirmedBugs: input.problems.filter((item) => item.judgement === 'CONFIRMED_BUG').length,
      likelyProblems: input.problems.filter((item) => item.judgement === 'LIKELY_BUG').length,
      testReliability: input.reliability.score,
      requirementQuality: input.requirementQuality.score,
      testability: input.requirementQuality.testability,
    },
    plan: input.plan,
    requirementCoverage: input.requirementCoverage,
    requirementModel: input.requirementModel,
    acceptanceTraces: input.acceptanceTraces,
    deliveryCoverage: input.deliveryCoverage,
    invariants: input.invariants,
    dataLifecycle: input.dataLifecycle,
    versionComparison: input.versionComparison,
    businessFlows: input.businessFlowGraph,
    stateConsistency: input.stateConsistency,
    regressionGuard: input.regressionGuard,
    executionEstimate: input.executionEstimate,
    oracleResults: input.oracleResults,
    adaptiveScores: input.adaptiveScores,
    negativeChecks: input.negativeChecks,
    permissionMatrix: input.permissionMatrix,
    pollutionFindings: input.pollutionFindings,
    reliability: input.reliability,
    requirementQuality: input.requirementQuality,
    rootCauseGraph: input.rootCauseGraph,
    reproduction: input.reproduction,
    coverageConfidence: {
      requirementCoverage: input.deliveryCoverage.requirements.generatedCoverage,
      executableCoverage: input.deliveryCoverage.cases.generated
        ? Math.round(input.deliveryCoverage.cases.executable / input.deliveryCoverage.cases.generated * 100) : 0,
      executedCoverage: input.deliveryCoverage.requirements.executedCoverage,
      verifiedCoverage: input.deliveryCoverage.requirements.verifiedCoverage,
      evidenceCoverage: input.deliveryCoverage.evidence.coverage,
      realVerified: input.deliveryCoverage.cases.verified,
      generated: input.deliveryCoverage.cases.generated,
      executed: input.deliveryCoverage.cases.executed,
      verified: input.deliveryCoverage.cases.verified,
      notTested: input.deliveryCoverage.cases.notTested,
      blocked: input.deliveryCoverage.cases.blocked,
      unknown: unknownsOf(input.report).length,
    },
    dimensions: dimensionsObject(input),
    discovery: input.discovery,
    environment: input.environmentPreflight,
    uiExecutions: input.uiExecutions,
    contracts: contractRowsOf(input),
    cases,
    problems: input.problems,
    baseline: input.baseline,
    unknowns: unknownsOf(input.report),
    acceptanceTrust: input.report.trust,
    trust: {
      resultScope: 'DEVTEST_DELIVERY_ACCEPTANCE',
      requirementVerification: input.deliveryCoverage.requirements.total > 0
        && input.deliveryCoverage.requirements.verified === input.deliveryCoverage.requirements.total
        ? 'VERIFIED' : input.deliveryCoverage.requirements.verified > 0 ? 'PARTIALLY_VERIFIED' : 'NOT_VERIFIED',
      evidenceQuality: input.deliveryCoverage.evidence.coverage === 100 ? 'COMPLETE'
        : input.deliveryCoverage.evidence.collected > 0 ? 'PARTIAL' : 'NONE',
      interpretation: '最终交付结论仅消费 Acceptance Trace：真实执行、必需 Evidence 和 Deterministic Oracle 缺一不可。',
    },
  };
}

export function renderCasesCsv(input: DevTestRenderInput): string {
  const header = [
    'caseId', 'dimension', 'priority', 'core', 'coreKind', 'title', 'status', 'acceptanceResult', 'issueClassification',
    'oracle', 'evidenceMissing', 'expected', 'actual', 'problemId',
    'confidence', 'contract', 'executed', 'evidence', 'valueScore', 'selectionReason',
  ];
  const traceByCase = new Map(input.acceptanceTraces.map((trace) => [trace.caseId, trace]));
  const rows = caseRows(input).map((item) => {
    const trace = traceByCase.get(item.caseId);
    return [
      item.caseId, item.dimension, item.priority, item.core, item.coreKind ?? '', item.title, item.status,
      trace?.result ?? 'NOT_TESTED', trace?.classification ?? 'NOT_TESTED', trace?.oracle.verdict ?? 'BLOCKED',
      trace?.evidence.missing.join(';') ?? '',
      JSON.stringify({ response: item.expectedResponse, state: item.expectedState, assertions: item.assertions }),
      item.actual, item.problemIds.join(';'), item.confidence || '', item.contractStatus, item.executed,
      `${Array.isArray(item.evidence) ? item.evidence.map((evidence) => `${evidence.kind};`).join('')
        : `${item.evidence?.request ? 'REQUEST;' : ''}${item.evidence?.response ? 'RESPONSE;' : ''}`}${item.assertionEvidence.length ? `ASSERTIONS:${item.assertionEvidence.length}` : ''}`,
      item.valueScore?.total ?? '', item.valueScore?.reason ?? '',
    ];
  });
  return `\uFEFF${[header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`;
}

export function renderProblemsMarkdown(
  problems: readonly DevTestProblem[],
  meta: { conclusion: DevTestFeatureResult; unknowns: readonly { type: string; id: string; message: string }[] },
): string {
  const count = (severity: DevTestProblem['severity']) => problems.filter((problem) => problem.severity === severity).length;
  const lines = [
    '# DevTest Problems', '', '## Summary', '',
    `Feature Result: ${meta.conclusion}`,
    `Critical: ${count('CRITICAL')}`,
    `High: ${count('HIGH')}`,
    `Medium: ${count('MEDIUM')}`,
    `Low: ${count('LOW')}`, '', '## Root Problems', '',
  ];
  if (!problems.length) lines.push('No root problems in the currently observable scope.', '');
  for (const problem of problems) {
    lines.push(`### ${problem.id} ${problem.message}`, '', `Severity: ${problem.severity}`,
      `Confidence: ${(problem.confidence ?? 0).toFixed(2)} (${problem.confidenceLabel ?? 'UNKNOWN'})`,
      `Classification: ${problem.issueClassification ?? 'EXECUTION_ERROR'}`,
      `Judgement: ${problem.judgement ?? 'UNKNOWN'}`, `Lifecycle: ${problem.lifecycle ?? 'OPEN'}`,
      `Category: ${problem.category ?? problem.type}`, `Feature: ${problem.affectedFeature ?? '当前功能'}`,
      `Why: ${problem.why ?? '证据不足，保持 UNKNOWN'}`, '', 'Reproduction:', '');
    lines.push(`Failure Class: ${problem.failureClass ?? 'UNSUPPORTED'}`, `Reproducible: ${String(problem.reproducible === true)}`, '');
    lines.push(`Root Cause: ${problem.rootCause ?? 'UNKNOWN'}`, '');
    lines.push(...(problem.reproduction?.length ? problem.reproduction.map((step, index) => `${index + 1}. ${step}`) : ['1. 执行 DevTest 并查看关联 Case。']));
    lines.push('', `Expected: ${problem.expected ?? '满足 Requirement/Contract'}`, `Actual: ${problem.actual ?? problem.message}`, '', 'Affected Cases:', '');
    lines.push(...(problem.affectedCases.length ? problem.affectedCases.map((caseId) => `- ${caseId}`) : ['- none']));
    lines.push('', 'Request / Response / Evidence:', '', '```json', JSON.stringify({
      request: problem.request, response: problem.response, evidence: problem.evidence,
      confidenceFactors: problem.confidenceFactors, minimalReproduction: problem.minimalReproduction,
    }, null, 2), '```', '', `Suggested Priority: ${problem.severity}`,
      `Remediation: ${problem.remediation ?? '补齐权威契约/执行/证据后重跑。'}`, '');
  }
  lines.push('## Unknowns', '');
  lines.push(...(meta.unknowns.length ? meta.unknowns.map((item) => `- ${item.type} / ${item.id}: ${item.message}`) : ['- none']));
  lines.push('');
  return lines.join('\n');
}

export function renderAcceptanceSummary(input: DevTestRenderInput): string {
  const unknowns = unknownsOf(input.report);
  const risks = input.problems.filter((problem) => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(problem.severity));
  const confirmed = input.problems.filter((problem) => problem.judgement === 'CONFIRMED_BUG');
  const likely = input.problems.filter((problem) => problem.judgement === 'LIKELY_BUG');
  const blocked = input.problems.filter((problem) => ['ENVIRONMENT_ISSUE', 'CONTRACT_ISSUE', 'TEST_ISSUE', 'REQUIREMENT_ISSUE'].includes(problem.judgement ?? ''));
  const actions = [
    ...input.problems.slice(0, 5).map((problem) => `${problem.id}: ${problem.remediation ?? problem.message}`),
    ...unknowns.slice(0, 3).map((item) => `${item.type}: ${item.message}`),
  ];
  const lines = [
    '# Feature Acceptance', '', '## Result', '', input.conclusion, '',
    `Dev Confidence: ${input.devConfidence.score}/100${input.devConfidence.failClosed ? ' (Fail-Closed)' : ''}`, '',
    `Test Reliability: ${input.reliability.score}/100`,
    `Requirement Quality: ${input.requirementQuality.score}/100 · Testability: ${input.requirementQuality.testability}/100`, '',
    '## Verification Coverage', '',
    `- GENERATED: ${input.deliveryCoverage.cases.generated}`,
    `- EXECUTED: ${input.deliveryCoverage.cases.executed}`,
    `- VERIFIED: ${input.deliveryCoverage.cases.verified}`,
    `- NOT_TESTED: ${input.deliveryCoverage.cases.notTested}`,
    `- Requirement: generated ${input.deliveryCoverage.requirements.generatedCoverage}% · executed ${input.deliveryCoverage.requirements.executedCoverage}% · verified ${input.deliveryCoverage.requirements.verifiedCoverage}%`,
    `- Evidence: ${input.deliveryCoverage.evidence.coverage}%`, '',
    '## Confirmed Problems', '',
    ...(confirmed.length ? confirmed.slice(0, 5).map((problem) => `- ${problem.id}: ${problem.message}`) : ['- none']),
    '', '## Likely Problems', '',
    ...(likely.length ? likely.slice(0, 5).map((problem) => `- ${problem.id}: ${problem.message}`) : ['- none']),
    '', '## Blocked', '',
    ...(blocked.length ? blocked.slice(0, 5).map((problem) => `- ${problem.id}: ${problem.message}`) : ['- none']),
    '', '## Unknowns', '',
    ...(unknowns.length ? unknowns.slice(0, 5).map((item) => `- ${item.type}: ${item.message}`) : ['- none']),
    '## Core Requirements', '',
    ...input.requirementCoverage.behaviors.map((behavior) => `- [${behavior.status === 'COVERED' ? 'x' : ' '}] ${behavior.acId} — ${behavior.status}`),
    '', '## Business Flows', '',
    ...(input.businessFlowGraph.flows.length ? input.businessFlowGraph.flows.map((flow) =>
      `- [${flow.status === 'PASS' ? 'x' : ' '}] ${flow.name} — ${flow.status}${flow.reason ? `: ${flow.reason}` : ''}`) : ['- [x] No multi-operation core flow required']),
    '', '## Invariants', '',
    ...(input.invariants.length ? input.invariants.map((invariant) =>
      `- [${invariant.status === 'VERIFIED' ? 'x' : ' '}] ${invariant.statement} — ${invariant.status}`) : ['- [x] No requirement-derived invariant']),
    '', '## Regression Guard', '',
    `- [${input.regressionGuard.status === 'PASS' || input.regressionGuard.status === 'NOT_REQUIRED' ? 'x' : ' '}] ${input.regressionGuard.status} — ${input.regressionGuard.reason}`,
    '', '## Risks', '',
    ...(risks.length ? risks.map((problem) => `- ${problem.severity}: ${problem.id} ${problem.message}`) : ['- none']),
    '', '## Developer Action', '',
    ...(actions.length ? actions.map((action, index) => `${index + 1}. ${action}`) : ['1. No blocking developer action.']),
    '', '## Execution Budget', '',
    `- Estimated Cases: ${input.executionEstimate.estimatedCases}`,
    `- Estimated Requests: ${input.executionEstimate.estimatedRequests}`,
    `- Estimated Runtime: ${input.executionEstimate.estimatedRuntimeMs} ms`,
    `- Estimated Cost: ${input.executionEstimate.estimatedCost} ${input.executionEstimate.costUnit}`,
    `- Limit Status: ${input.executionEstimate.exceeded.length ? `BLOCKED (${input.executionEstimate.exceeded.join(', ')})` : 'WITHIN_LIMIT'}`,
    '',
  ];
  return lines.join('\n');
}

function statusClass(status: string): string {
  return status === 'READY' || status === 'PASS' ? 'ok' : status === 'NOT_READY' || status === 'FAIL' ? 'bad' : 'warn';
}

export function renderDevTestHtml(input: DevTestRenderInput): string {
  const rows = caseRows(input);
  const unknowns = unknownsOf(input.report);
  const contractRows = contractRowsOf(input).map((contract) => `<tr><td>${escapeHtml(contract.id)}</td><td>${escapeHtml(contract.status)}</td><td>${escapeHtml(contract.version ?? '-')}</td><td><code>${escapeHtml(contract.fingerprint ?? '-')}</code></td><td>${escapeHtml(contract.reason ?? '-')}</td></tr>`).join('');
  const dimensionRows = input.dimensionStats.map((stat) => {
    const decision = input.dimensionApplicability.find((item) => item.dimension === stat.dimension);
    return `<tr><td>${stat.dimension}</td><td>${escapeHtml(decision?.applicability)}</td><td>${stat.total}</td><td class="ok">${stat.passed}</td><td class="bad">${stat.failed}</td><td class="warn">${stat.blocked}</td><td>${stat.notExecuted}</td><td>${escapeHtml(decision?.reason)}</td></tr>`;
  }).join('');
  const caseHtml = rows.map((item) => `<tr><td>${item.caseId}</td><td>${item.dimension}</td><td>${item.priority}</td><td>${escapeHtml(item.title)}</td><td class="${statusClass(item.status)}">${item.status}</td><td>${String(item.executed)}</td><td>${escapeHtml(item.processor || '-')}</td><td>${escapeHtml(item.blockedReason || '-')}</td></tr>`).join('');
  const problemHtml = input.problems.map((problem) => `<tr><td>${problem.id}</td><td>${problem.severity}</td><td>${escapeHtml(problem.issueClassification ?? 'EXECUTION_ERROR')}</td><td>${escapeHtml(problem.judgement ?? 'UNKNOWN')}</td><td>${escapeHtml(problem.lifecycle ?? 'OPEN')}</td><td>${escapeHtml(problem.confidenceLabel ?? 'UNKNOWN')} ${problem.confidence?.toFixed(2) ?? '-'}</td><td>${escapeHtml(problem.failureClass ?? 'UNSUPPORTED')}</td><td>${escapeHtml(problem.rootCause ?? 'UNKNOWN')}</td><td>${escapeHtml(problem.message)}</td><td>${String(problem.reproducible === true)}</td><td>${escapeHtml(problem.affectedCases.join(', ') || '-')}</td><td><code>${escapeHtml(JSON.stringify(problem.minimalReproduction ?? {}))}</code></td><td>${escapeHtml(problem.remediation ?? '-')}</td></tr>`).join('');
  const discoveryRows = input.discovery.mappedOperations.map((operation) => `<tr><td>${operation.method}</td><td><code>${escapeHtml(operation.path)}</code></td><td>${escapeHtml(operation.source.map((item) => item.type).join(', '))}</td><td>${operation.confidence.toFixed(2)}</td><td>${escapeHtml(operation.source.map((item) => item.ref).join(', '))}</td></tr>`).join('');
  const model = input.featureModel;
  const baseline = input.baseline;
  const pass = input.deliveryCoverage.cases.passed;
  const fail = input.deliveryCoverage.cases.failed;
  const blocked = input.deliveryCoverage.cases.blocked;
  const notExecuted = input.deliveryCoverage.cases.notTested;
  const confirmedBugs = input.problems.filter((item) => item.judgement === 'CONFIRMED_BUG');
  const likelyProblems = input.problems.filter((item) => item.judgement === 'LIKELY_BUG');
  const requirementCoverage = input.deliveryCoverage.requirements.generatedCoverage;
  const executableCoverage = input.deliveryCoverage.cases.generated
    ? Math.round(input.deliveryCoverage.cases.executable / input.deliveryCoverage.cases.generated * 100) : 0;
  const evidenceCoverage = input.deliveryCoverage.evidence.coverage;
  const severityRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
  const topProblems = [...input.problems].sort((left, right) => (right.benefitScore ?? 0) - (left.benefitScore ?? 0)
    || severityRank[right.severity] - severityRank[left.severity] || (right.confidence ?? 0) - (left.confidence ?? 0)).slice(0, 5);
  const topProblemHtml = topProblems.map((problem) => `<article class="problem"><h3>${problem.id} · ${problem.severity} · ${escapeHtml(problem.judgement ?? 'UNKNOWN')}</h3><p><b>Root Cause：</b>${escapeHtml(problem.rootCause ?? 'UNKNOWN')}　<b>Affected Cases：</b>${problem.affectedCases.length}</p><p><b>问题：</b>${escapeHtml(problem.message)}</p><p><b>为什么判断：</b>${escapeHtml(problem.why ?? '-')}</p><p><b>怎么复现：</b>${escapeHtml(problem.reproduction?.join(' → ') ?? '-')}</p><p><b>预期：</b>${escapeHtml(problem.expected ?? '-')}<br><b>实际：</b>${escapeHtml(problem.actual ?? '-')}</p><p><b>Minimal Reproduction：</b><code>${escapeHtml(JSON.stringify(problem.minimalReproduction ?? {}))}</code></p><p><b>建议：</b>${escapeHtml(problem.remediation ?? '-')}</p></article>`).join('');
  const blockedWhyHtml = rows.filter((item) => item.status === 'BLOCKED' || item.status === 'NOT_EXECUTED').map((item) => {
    const problem = input.problems.find((candidate) => candidate.affectedCases.includes(item.caseId));
    return `<tr><td>${item.caseId}</td><td>${escapeHtml(item.blockedReason || problem?.message || '执行条件不完整')}</td><td>${escapeHtml(`${item.core ? '核心功能' : item.dimension} 未被真实验证`)}</td><td>${escapeHtml(problem?.remediation ?? '补齐执行环境、契约或证据能力后重跑')}</td></tr>`;
  }).join('');
  const checkMark = (status: string): string => status === 'READY' || status === 'NOT_REQUIRED' ? '✓' : status === 'UNKNOWN' ? '?' : '✗';
  const coverageRows = input.requirementCoverage.behaviors.map((behavior) => `<tr><td>${escapeHtml(behavior.acId)}</td><td>${escapeHtml(behavior.statement)}</td><td>${escapeHtml(behavior.actor)}</td><td>${escapeHtml(behavior.action)}</td><td>${escapeHtml(behavior.input.join(', ') || '-')}</td><td>${escapeHtml(behavior.expectedResponse ?? '-')}</td><td>${escapeHtml(behavior.expectedState ?? '-')}</td><td>${escapeHtml(behavior.expectedSideEffects.join(', ') || '-')}</td><td class="${statusClass(behavior.status === 'COVERED' ? 'PASS' : behavior.status)}">${behavior.status}</td><td>${escapeHtml(behavior.linkedCaseIds.join(', ') || '-')}</td><td>${escapeHtml(behavior.missingAssertions.join(', ') || '-')}</td></tr>`).join('');
  const invariantRows = input.invariants.map((invariant) => `<tr><td>${invariant.id}</td><td>${invariant.kind}</td><td>${escapeHtml(invariant.statement)}</td><td>${escapeHtml(invariant.requiredEvidence.join(', '))}</td><td>${escapeHtml(invariant.linkedCaseIds.join(', ') || '-')}</td><td class="${statusClass(invariant.status === 'VERIFIED' ? 'PASS' : invariant.status)}">${invariant.status}</td></tr>`).join('');
  const extendedRows = input.plan.extendedDimensions.map((item) => `<tr><td>${item.dimension}</td><td>${item.applicable ? 'REQUIRED' : 'NOT_APPLICABLE'}</td><td>${escapeHtml(item.caseIds.join(', ') || '-')}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('');
  const flowRows = input.businessFlowGraph.flows.map((flow) => `<tr><td>${flow.id}</td><td>${escapeHtml(flow.name)}</td><td>${flow.steps.length}</td><td class="${statusClass(flow.status)}">${flow.status}</td><td>${escapeHtml(flow.failedStepId ?? '-')}</td><td>${escapeHtml(flow.reason ?? '-')}</td></tr>`).join('');
  const consistencyRows = input.stateConsistency.filter((item) => item.status !== 'NOT_REQUIRED').map((item) => `<tr><td>${item.caseId}</td><td>${escapeHtml(item.sources.join(', ') || '-')}</td><td class="${statusClass(item.status === 'CONSISTENT' ? 'PASS' : item.status === 'INCONSISTENT' ? 'FAIL' : item.status)}">${item.status}</td><td>${escapeHtml(item.reason ?? '-')}</td></tr>`).join('');
  const topRiskHtml = topProblems.map((problem, index) => `<li><b>${index + 1}. ${escapeHtml(problem.category ?? problem.type)}</b> — ${escapeHtml(problem.message)}</li>`).join('')
    || unknowns.slice(0, 5).map((item, index) => `<li><b>${index + 1}. ${item.type}</b> — ${escapeHtml(item.message)}</li>`).join('');
  const reliabilityRows = input.reliability.cases.filter((item) => item.status !== 'STABLE').map((item) => `<tr><td>${item.caseId}</td><td>${item.status}</td><td>${item.passRate.toFixed(2)}</td><td>${item.failureRate.toFixed(2)}</td><td>${item.flakeRate.toFixed(2)}</td><td>${item.avgDurationMs}</td></tr>`).join('');
  const pollutionRows = input.pollutionFindings.map((item) => `<tr><td>${item.caseId}</td><td>${item.classification}</td><td>${item.severity}</td><td>${escapeHtml(item.changedPaths.join(', ') || '-')}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('');
  const environmentProblems = input.problems.filter((item) => item.judgement === 'ENVIRONMENT_ISSUE').map((item) => `<li>${item.id}: ${escapeHtml(item.message)}</li>`).join('');
  const rootCauseRows = input.rootCauseGraph.slice(0, 10).map((item) => `<tr><td>${item.id}</td><td>${escapeHtml(item.rootCause)}</td><td>${item.benefitScore}</td><td>${escapeHtml(item.problemIds.join(', '))}</td><td>${escapeHtml(item.affectedContracts.join(', ') || '-')}</td><td>${escapeHtml(item.affectedScenarios.join(', ') || '-')}</td><td>${escapeHtml(item.affectedBusinessFlows.join(', ') || '-')}</td><td>${escapeHtml(item.affectedCases.join(', ') || '-')}</td></tr>`).join('');
  const negativeRows = input.negativeChecks.filter((item) => item.status !== 'NOT_APPLICABLE').map((item) => `<tr><td>${item.kind}</td><td>${item.status}</td><td>${escapeHtml(item.operation ?? '-')}</td><td>${escapeHtml(item.relatedCaseIds.join(', ') || '-')}</td><td>${escapeHtml(item.reason)}</td></tr>`).join('');
  const requirementModelRows = input.requirementModel.facts.map((fact) => `<tr><td>${fact.id}</td><td>${fact.knowledge}</td><td>${fact.category}</td><td>${fact.provenance}</td><td>${fact.epistemicType}</td><td>${escapeHtml(fact.statement)}</td><td>${fact.canonical.normalizationStatus}</td><td>${escapeHtml(`${fact.source.section ?? '-'}:${fact.source.lineStart}-${fact.source.lineEnd}`)}</td></tr>`).join('');
  const traceRows = input.acceptanceTraces.map((trace) => `<tr><td>${trace.caseId}</td><td>${trace.testModel.selection}${trace.testModel.selectionReason ? `: ${trace.testModel.selectionReason}` : ''}</td><td>${trace.testModel.dimension}</td><td>${trace.execution.status}</td><td>${escapeHtml(`${trace.evidence.collected.join(', ') || '-'}${trace.evidence.missing.length ? `; missing ${trace.evidence.missing.join(', ')}` : ''}`)}</td><td>${trace.oracle.verdict}</td><td class="${statusClass(trace.result)}">${trace.result}</td><td>${trace.classification}</td><td>${escapeHtml(trace.requirement.factIds.join(', ') || '-')}</td><td>${escapeHtml(trace.problemIds.join(', ') || '-')}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DevTest · ${escapeHtml(input.report.requirement.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f8fa;color:#1f2328;margin:0}.wrap{max-width:1500px;margin:auto;padding:24px}section,.problem{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin:16px 0;padding:18px}.banner{border-left:6px solid #9a6700}.ok{color:#1a7f37;font-weight:700}.bad{color:#cf222e;font-weight:700}.warn{color:#9a6700;font-weight:700}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #d0d7de;padding:10px 16px;border-radius:6px}.card b{font-size:22px}table{border-collapse:collapse;width:100%;min-width:900px}th,td{border:1px solid #d0d7de;padding:7px;text-align:left;vertical-align:top}.scroll{overflow:auto}code{font-size:11px;word-break:break-all}</style></head><body><main class="wrap">
<h1>${escapeHtml(input.report.requirement.title)}</h1>
<section class="banner"><h2>开发首页 · Feature Acceptance</h2><p><b>Feature：</b>${escapeHtml(input.report.requirement.title)}</p><p class="${statusClass(input.conclusion)}" style="font-size:30px"><b>最终结论 / Final Result：</b>${input.conclusion}</p><div class="cards"><div class="card"><b>${input.devConfidence.score}</b><br>Dev Confidence</div><div class="card"><b>${input.requirementCoverage.coreCoverage}%</b><br>Core Coverage</div><div class="card"><b>${input.businessFlowGraph.applicable === false ? 'N/A' : `${input.businessFlowGraph.coverage}%`}</b><br>Business Flow Coverage</div><div class="card"><b>${evidenceCoverage}%</b><br>Evidence Coverage</div><div class="card bad"><b>${confirmedBugs.length}</b><br>Confirmed Bugs</div><div class="card warn"><b>${likelyProblems.length}</b><br>Likely Bugs</div><div class="card warn"><b>${blocked + notExecuted}</b><br>Blocked</div><div class="card"><b>${unknowns.length}</b><br>Unknowns</div><div class="card"><b>${input.reliability.score}</b><br>Test Reliability</div></div>${input.reproduction ? `<p><b>Reproduction ${input.reproduction.problemId}：</b>${input.reproduction.status}</p>` : ''}</section>
<section><h2>Top Business Risks</h2>${topRiskHtml ? `<ol>${topRiskHtml}</ol>` : '<p>none</p>'}</section>
<section><h2>Test Reliability</h2><p><b>Score：</b>${input.reliability.score}/100　Stable ${input.reliability.stable}　Flaky ${input.reliability.flaky}　Unstable ${input.reliability.unstable}</p>${reliabilityRows ? `<div class="scroll"><table><tr><th>Case</th><th>Status</th><th>Pass Rate</th><th>Failure Rate</th><th>Flake Rate</th><th>Avg Duration ms</th></tr>${reliabilityRows}</table></div>` : '<p>No flaky or unstable test.</p>'}<h3>Environment Problems</h3>${environmentProblems ? `<ul>${environmentProblems}</ul>` : '<p>none</p>'}<h3>Test Pollution</h3>${pollutionRows ? `<div class="scroll"><table><tr><th>Case</th><th>Classification</th><th>Severity</th><th>Changed State</th><th>Reason</th></tr>${pollutionRows}</table></div>` : '<p>none</p>'}</section>
<section><h2>Requirement Quality</h2><p><b>Requirement Quality：</b>${input.requirementQuality.score}/100　<b>Testability：</b>${input.requirementQuality.testability}/100　${input.requirementQuality.needsClarification ? '<b class="warn">Requirement needs clarification</b>' : ''}</p><ul>${input.requirementQuality.issues.map((item) => `<li>${item.acId ?? 'Requirement'} · ${item.code}: ${escapeHtml(item.message)}</li>`).join('') || '<li>none</li>'}</ul></section>
<section><h2>Requirement Understanding</h2><p><b>Explicit：</b>${input.requirementModel.explicitFactIds.length}　<b>Derived：</b>${input.requirementModel.derivedFactIds.length}　<b>Unknown：</b>${input.requirementModel.unknownFactIds.length}</p><div class="scroll"><table><tr><th>Fact</th><th>Knowledge</th><th>Category</th><th>Provenance</th><th>Epistemic</th><th>Statement</th><th>Normalization</th><th>Source</th></tr>${requirementModelRows}</table></div></section>
<section><h2>Test Plan Preview</h2><p><b>Risk：</b>${input.plan.risk}　<b>Cases：</b>${input.executionEstimate.estimatedCases}　<b>Requests：</b>${input.executionEstimate.estimatedRequests}　<b>Runtime：</b>${input.executionEstimate.estimatedRuntimeMs}ms　<b>Cost：</b>${input.executionEstimate.estimatedCost} ${input.executionEstimate.costUnit}</p><p><b>Limits：</b>${input.executionEstimate.exceeded.join(', ') || 'WITHIN_LIMIT'}　<b>Cache：</b>${input.plan.cache.status}<br><b>Git Impact：</b>${escapeHtml(input.plan.impact.reason)}；Flows=${escapeHtml(input.plan.impact.affectedFlowIds.join(', ') || 'none')}</p></section>
<section><h2>Adaptive Selection & Negative Intelligence</h2><p>Default tiers: Tier 0 + Tier 1；Deep=${String(input.plan.deep)}. Tier 0=${input.plan.tiers.TIER_0.length}, Tier 1=${input.plan.tiers.TIER_1.length}, Tier 2=${input.plan.tiers.TIER_2.length}</p>${negativeRows ? `<div class="scroll"><table><tr><th>Risk</th><th>Status</th><th>Operation</th><th>Cases</th><th>Reason</th></tr>${negativeRows}</table></div>` : '<p>No requirement-related negative risk.</p>'}</section>
<section><h2>Top Problems</h2>${topProblemHtml || '<p>No Critical/High problems.</p>'}</section>
<section><h2>Root Cause Graph</h2>${rootCauseRows ? `<div class="scroll"><table><tr><th>Root</th><th>Cause</th><th>Benefit</th><th>Problems</th><th>Contracts</th><th>Scenarios</th><th>Flows</th><th>Cases</th></tr>${rootCauseRows}</table></div>` : '<p>none</p>'}</section>
<section><h2>Delivery Acceptance Ledger</h2><div class="cards"><div class="card"><b>${input.deliveryCoverage.cases.generated}</b><br>GENERATED</div><div class="card"><b>${input.deliveryCoverage.cases.executed}</b><br>EXECUTED</div><div class="card ok"><b>${input.deliveryCoverage.cases.verified}</b><br>VERIFIED</div><div class="card warn"><b>${input.deliveryCoverage.cases.notTested}</b><br>NOT_TESTED</div></div><p><b>Requirement Coverage：</b>Generated ${input.deliveryCoverage.requirements.generatedCoverage}% · Executed ${input.deliveryCoverage.requirements.executedCoverage}% · Verified ${input.deliveryCoverage.requirements.verifiedCoverage}%　<b>Evidence：</b>${input.deliveryCoverage.evidence.coverage}%</p><div class="scroll"><table><tr><th>Case</th><th>Selection</th><th>Dimension</th><th>Execution</th><th>Evidence</th><th>Oracle</th><th>Result</th><th>Classification</th><th>Requirement Facts</th><th>Problems</th></tr>${traceRows}</table></div></section>
<section><h2>Requirement Coverage Matrix</h2><p>Covered AC: ${input.requirementCoverage.coveredAc.length}　Uncovered AC: ${input.requirementCoverage.uncoveredAc.length}　Ambiguous AC: ${input.requirementCoverage.ambiguousAc.length}　Blocked AC: ${input.requirementCoverage.blockedAc.length}</p><div class="scroll"><table><tr><th>AC</th><th>Requirement</th><th>Actor</th><th>Action</th><th>Input</th><th>Expected Response</th><th>Expected State</th><th>Expected Side Effect</th><th>Status</th><th>Cases</th><th>Missing Assertions</th></tr>${coverageRows}</table></div></section>
<section><h2>Business Invariants</h2>${invariantRows ? `<div class="scroll"><table><tr><th>ID</th><th>Kind</th><th>Rule</th><th>Required Evidence</th><th>Cases</th><th>Status</th></tr>${invariantRows}</table></div>` : '<p>No requirement-derived invariant.</p>'}</section>
<section><h2>Business Flow Graph</h2>${flowRows ? `<div class="scroll"><table><tr><th>Flow</th><th>Path</th><th>Steps</th><th>Status</th><th>Failed Step</th><th>Reason</th></tr>${flowRows}</table></div>` : '<p>No multi-operation core flow required.</p>'}<h3>State Consistency</h3>${consistencyRows ? `<div class="scroll"><table><tr><th>Case</th><th>Sources</th><th>Status</th><th>Reason</th></tr>${consistencyRows}</table></div>` : '<p>No cross-source state check required.</p>'}<h3>Regression Guard</h3><p class="${statusClass(input.regressionGuard.status === 'PASS' || input.regressionGuard.status === 'NOT_REQUIRED' ? 'PASS' : input.regressionGuard.status)}">${input.regressionGuard.status} — ${escapeHtml(input.regressionGuard.reason)}</p></section>
<section><h2>Environment Preflight</h2><p class="${statusClass(input.environmentPreflight.status === 'READY' ? 'READY' : 'BLOCKED')}">${input.environmentPreflight.status} · ${escapeHtml(input.environmentPreflight.selectedBaseUrl ?? input.environmentPreflight.reason ?? 'no selected environment')}</p><table><tr><th>Base URL</th><th>Health</th><th>Authentication</th><th>API</th><th>Browser</th><th>Database</th></tr><tr><td>${checkMark(input.environmentPreflight.checks.baseUrl)} ${input.environmentPreflight.checks.baseUrl}</td><td>${checkMark(input.environmentPreflight.checks.health)} ${input.environmentPreflight.checks.health}</td><td>${checkMark(input.environmentPreflight.checks.authentication)} ${input.environmentPreflight.checks.authentication}</td><td>${checkMark(input.environmentPreflight.checks.api)} ${input.environmentPreflight.checks.api}</td><td>${checkMark(input.environmentPreflight.checks.browser)} ${input.environmentPreflight.checks.browser}</td><td>${checkMark(input.environmentPreflight.checks.database)} ${input.environmentPreflight.checks.database}</td></tr></table><p><b>可执行：</b>${escapeHtml(input.environmentPreflight.executableDimensions.join(', ') || 'none')}<br><b>阻断：</b>${escapeHtml(input.environmentPreflight.blockedDimensions.map((item) => `${item.dimension}: ${item.reason}`).join('；') || 'none')}</p></section>
<section><h2>为什么没测</h2>${blockedWhyHtml ? `<div class="scroll"><table><tr><th>Case</th><th>原因</th><th>影响</th><th>解除条件</th></tr>${blockedWhyHtml}</table></div>` : '<p>没有阻断项。</p>'}</section>
<section><h2>Problems</h2>${problemHtml ? `<div class="scroll"><table><tr><th>ID</th><th>Severity</th><th>Classification</th><th>Judgement</th><th>Lifecycle</th><th>Confidence</th><th>Internal Class</th><th>Root Cause</th><th>Problem</th><th>Reproducible</th><th>Affected Cases</th><th>Minimal Reproduction</th><th>建议动作</th></tr>${problemHtml}</table></div>` : '<p>No problems in the currently observable scope.</p>'}</section>
<section><h2>Test Cases</h2><div class="cards"><div class="card"><b>${rows.length}</b><br>Total</div><div class="card ok"><b>${pass}</b><br>PASS</div><div class="card bad"><b>${fail}</b><br>FAIL</div><div class="card warn"><b>${blocked}</b><br>BLOCKED</div><div class="card"><b>${notExecuted}</b><br>NOT EXECUTED</div></div><div class="scroll"><table><tr><th>caseId</th><th>Dimension</th><th>Priority</th><th>Title</th><th>Status</th><th>Executed</th><th>Processor</th><th>Blocked Reason</th></tr>${caseHtml}</table></div></section>
<section><h2>测试覆盖可信度</h2><div class="cards"><div class="card"><b>${requirementCoverage}%</b><br>Generated Requirement</div><div class="card"><b>${input.deliveryCoverage.requirements.executedCoverage}%</b><br>Executed Requirement</div><div class="card ok"><b>${input.deliveryCoverage.requirements.verifiedCoverage}%</b><br>Verified Requirement</div><div class="card"><b>${executableCoverage}%</b><br>Executable Case</div><div class="card"><b>${evidenceCoverage}%</b><br>Evidence Coverage</div><div class="card"><b>${input.devConfidence.score}</b><br>Dev Confidence</div></div><h3>五维覆盖</h3><div class="scroll"><table><tr><th>Dimension</th><th>Applicability</th><th>Total</th><th>PASS</th><th>FAIL</th><th>BLOCKED</th><th>NOT_EXECUTED</th><th>Why selected/skipped</th></tr>${dimensionRows}</table></div><h3>动态扩展维度</h3><div class="scroll"><table><tr><th>Dimension</th><th>Applicability</th><th>Cases</th><th>Reason</th></tr>${extendedRows}</table></div></section>
<section><h2>Baseline Diff</h2><p>${baseline.baselineRunId ? `Compared with ${escapeHtml(baseline.baselineRunId)}` : 'First baseline'}</p><div class="cards"><div class="card bad"><b>${baseline.newProblems.length}</b><br>NEW</div><div class="card ok"><b>${baseline.resolvedProblems.length}</b><br>FIXED</div><div class="card warn"><b>${baseline.persistentProblems.length}</b><br>STILL FAIL</div><div class="card bad"><b>${baseline.regressions.length}</b><br>REGRESSION</div><div class="card warn"><b>${baseline.newlyBlocked.length}</b><br>NEWLY BLOCKED</div><div class="card"><b>${baseline.unchanged.length}</b><br>UNCHANGED</div></div></section>
<section><h2>Versions & Data Lifecycle</h2><p><b>Requirement：</b><code>${input.versionComparison.requirementVersion}</code>　<b>Code：</b><code>${input.versionComparison.codeVersion}</code>　<b>Contract：</b><code>${input.versionComparison.contractVersion}</code>　<b>Contract Drift：</b>${String(input.versionComparison.contractDrift)}</p><p><b>新增/删除需求：</b>${escapeHtml(input.versionComparison.addedRequirements.join(', ') || '-')} / ${escapeHtml(input.versionComparison.removedRequirements.join(', ') || '-')}　<b>新增/删除 Case：</b>${input.versionComparison.addedCases.length} / ${input.versionComparison.removedCases.length}</p><p><b>Owner：</b>${escapeHtml(input.dataLifecycle.owner ?? '-')}　<b>Tenant：</b>${escapeHtml(input.dataLifecycle.tenant ?? '-')}　<b>Project：</b>${escapeHtml(input.dataLifecycle.project ?? '-')}　<b>Resource：</b>${escapeHtml(input.dataLifecycle.resource ?? '-')}　<b>createdBy：</b>${input.dataLifecycle.createdBy}</p><p><b>Prepare：</b>${input.dataLifecycle.prepareStatus}　<b>Cleanup：</b>${input.dataLifecycle.cleanupStatus}　<b>Traceable：</b>${String(input.dataLifecycle.traceable)}</p></section>
<section><h2>Unknowns</h2>${unknowns.length ? `<ul>${unknowns.map((item) => `<li><b>${item.type}</b> / ${escapeHtml(item.id)}: ${escapeHtml(item.message)}</li>`).join('')}</ul>` : '<p>none</p>'}</section>
<details><summary><b>Technical Details</b></summary><section><h2>Feature Model</h2><p><b>Actors:</b> ${escapeHtml(model.roles.join(', ') || '-')} · <b>Resources:</b> ${escapeHtml(model.resources.join(', ') || '-')} · <b>States:</b> ${escapeHtml(model.states.join(', ') || '-')}</p><p><b>Constraints:</b> ${escapeHtml(model.constraints.join('；') || '-')}</p></section><section><h2>API / UI Discovery</h2><p>${escapeHtml(input.discovery.scope)} · inspected ${input.discovery.inspectedFiles} files</p><div class="scroll"><table><tr><th>Method</th><th>Path</th><th>Source Type</th><th>Confidence</th><th>Source</th></tr>${discoveryRows}</table></div><ul>${input.discovery.mappingReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></section><section><h2>Contract Status</h2><p>Gate: <b class="${statusClass(input.contracts.validation.status === 'VALID' ? 'READY' : 'BLOCKED')}">${input.contracts.validation.status}</b></p><div class="scroll"><table><tr><th>ID</th><th>Status</th><th>Version</th><th>Fingerprint</th><th>Reason</th></tr>${contractRows}</table></div></section></details>
</main></body></html>`;
}

export { unknownsOf as buildDevTestUnknowns };
