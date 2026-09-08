import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { ContractPreflight } from '../contracts/contract-gate.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import { redactSensitive, redactSensitiveText } from '../core/redact.js';
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
import type { DevTestSourceSyncResult } from './source-sync.js';

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
  sourceSync?: DevTestSourceSyncResult;
}

function escapeHtml(value: unknown): string {
  return String(artifactSafe(value) ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeCsv(value: unknown): string {
  const safe = artifactSafe(value);
  const text = typeof safe === 'string' ? safe : safe === undefined || safe === null ? '' : JSON.stringify(safe);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function scrubRuntimeLocations(value: string): string {
  return value
    .replace(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"')\]}>,]+/gi, '[ENV:DATABASE_URL]')
    .replace(/https?:\/\/[^\s"')\]}>,]+/gi, (matched) => {
      try {
        const parsed = new URL(matched);
        return `[ENV:DEVTEST_BASE_URL]${parsed.pathname === '/' ? '' : parsed.pathname}`;
      } catch { return '[ENV:DEVTEST_BASE_URL]'; }
    })
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"')\]}>,]*)?/gi, '[LOCAL_PATH]');
}

function artifactText(value: string): string {
  return scrubRuntimeLocations(redactSensitiveText(value));
}

/** Artifact 的最后一道安全边界：凭据、真实 Origin、数据库连接和本机路径均不落盘。 */
export function artifactSafe(value: unknown): unknown {
  const redacted = redactSensitive(value);
  const visit = (item: unknown, depth = 0): unknown => {
    if (depth > 8) return '[truncated]';
    if (typeof item === 'string') return scrubRuntimeLocations(redactSensitiveText(item));
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    return item;
  };
  return visit(redacted);
}

function markdownCell(value: unknown): string {
  const redacted = artifactSafe(value);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return (text || 'N/A（不适用）')
    .replace(/<br\s*\/?>/gi, '；')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<a\s+href="([^"]+)">([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/\r?\n+/g, '；')
    .replace(/\s*；\s*/g, '；')
    .replace(/\|/g, '\\|')
    .replace(/</g, '\\<').replace(/>/g, '\\>');
}

function markdownInline(value: unknown): string {
  return markdownCell(value);
}

function labeledValue(label: string, value: unknown): string {
  const redacted = artifactSafe(value);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return `${label}：${(text || 'N/A（不适用）').replace(/\r?\n+/g, '；')}`;
}

function renderFeishuMarkdownTable(headers: string[], rows: unknown[][]): string {
  const compact = /^(编号|Case ID|#|结果|状态|数量|级别|优先级|类型\/优先级|执行状态|Oracle 结论)$/;
  const lines = [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map((header) => compact.test(header) ? ':---:' : ':---').join(' | ')} |`,
  ];
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error(`飞书 Markdown 表格列数不一致：${row.length}/${headers.length}`);
    lines.push(`| ${row.map(markdownCell).join(' | ')} |`);
  }
  return artifactText(lines.join('\n'));
}

/** 按报告所在时区格式化日期，避免 UTC ISO 在东八区凌晨显示成前一天。 */
export function formatReportDate(value: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${read('year')}-${read('month')}-${read('day')}`;
  } catch {
    return value.slice(0, 10);
  }
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
    ...report.coverage.unverifiedFacts.map((fact) => ({ type: 'UNVERIFIED_REQUIREMENT', id: fact.id, message: fact.statement })),
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
  const reportByCase = new Map(input.report.cases.map((item) => [item.caseId, item]));
  const traceByCase = new Map(input.acceptanceTraces.map((trace) => [trace.caseId, trace]));
  // 全量候选是唯一用例台账；未被选择/执行的 Case 也必须有一行和明确原因。
  return input.testCases.map((canonical) => {
    const item = reportByCase.get(canonical.id);
    const execution = executionByCase.get(canonical.id);
    const uiExecution = uiByCase.get(canonical.id);
    const trace = traceByCase.get(canonical.id);
    const assertions = execution?.evidence.assertions ?? [];
    const requiredEvidence = [
      canonical?.executionMode === 'EXECUTABLE' ? 'REQUEST' : undefined,
      canonical?.executionMode === 'EXECUTABLE' ? 'RESPONSE' : undefined,
      canonical?.assertions.length ? 'ASSERTIONS' : undefined,
      ['DATA_ISOLATION', 'FUNCTIONAL'].includes(devTestDimensionOf(canonical.testType ?? item?.testType)) ? 'STATE_OR_SIDE_EFFECT_OBSERVER' : undefined,
    ].filter((value): value is string => Boolean(value));
    return {
      caseId: canonical.id,
      acId: item?.evidence.acceptanceCriteriaIds?.[0] ?? canonical.source?.acceptanceCriteriaIds?.[0] ?? '',
      dimension: devTestDimensionOf(canonical.testType ?? item?.testType),
      title: item?.scenario ?? canonical.businessScenario?.title ?? canonical.name,
      priority: item?.priority ?? canonical.priority,
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
      executionMode: item?.executionMode ?? canonical.executionMode ?? 'DESIGNED_ONLY',
      status: trace?.result === 'NOT_TESTED' ? 'NOT_EXECUTED' : trace?.result ?? 'BLOCKED',
      rawStatus: uiExecution?.status ?? execution?.status ?? item?.executionStatus ?? 'NOT_EXECUTED',
      blockedReason: !trace
        ? 'ACCEPTANCE_TRACE_MISSING：用例未进入可审计验收链'
        : trace.result === 'BLOCKED' || trace.result === 'NOT_TESTED'
          ? trace.explanation.join('；') : uiExecution?.error ?? execution?.attribution.reason ?? item?.qualityIssues.join('；') ?? '',
      executed: uiExecution?.executed ?? execution?.executed === true,
      processor: uiExecution ? 'PlaywrightBrowserProcessor' : execution?.processor ?? '',
      assertionEvidence: uiExecution?.assertions ?? assertions,
      evidence: uiExecution?.evidence ?? execution?.evidence,
      contractStatus: input.contracts.validation.status,
      valueScore: input.testValueScores[canonical.id],
      core: input.caseProfiles[canonical.id]?.core ?? false,
      coreKind: input.caseProfiles[canonical.id]?.coreKind,
      problemIds: input.problems.filter((problem) => problem.affectedCases.includes(canonical.id)).map((problem) => problem.id),
      confidence: input.problems.filter((problem) => problem.affectedCases.includes(canonical.id))
        .reduce((highest, problem) => Math.max(highest, problem.confidence ?? 0), 0),
      actual: uiExecution?.error ?? execution?.error ?? execution?.attribution.reason ?? uiExecution?.status ?? execution?.status ?? item?.executionStatus ?? 'NOT_EXECUTED',
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

function evidenceProof(input: DevTestRenderInput, channels: readonly string[]): { required: number; collected: number; verified: number } {
  const traces = input.acceptanceTraces.filter((trace) => trace.evidence.required.some((channel) => channels.includes(channel)));
  return {
    required: traces.length,
    collected: traces.filter((trace) => trace.evidence.collected.some((channel) => channels.includes(channel))).length,
    verified: traces.filter((trace) => (trace.result === 'PASS' || trace.result === 'FAIL')
      && trace.evidence.collected.some((channel) => channels.includes(channel))).length,
  };
}

export function buildDevTestReportEnvelope(input: DevTestRenderInput): Record<string, unknown> {
  const cases = caseRows(input);
  return artifactSafe({
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
      executable: input.deliveryCoverage.cases.executable,
      executed: input.deliveryCoverage.cases.executed,
      verified: input.deliveryCoverage.cases.verified,
      notTested: input.deliveryCoverage.cases.notTested,
      blocked: input.deliveryCoverage.cases.blocked,
      unknown: unknownsOf(input.report).length,
    },
    evidenceMatrix: {
      response: evidenceProof(input, ['API_RESPONSE']),
      state: evidenceProof(input, ['DATABASE_STATE', 'RESOURCE_STATE', 'STATE_CHANGE', 'DATA_DIFF']),
      nonMutation: {
        required: input.invariants.filter((item) => item.kind === 'NON_MUTATION').length,
        collected: input.invariants.filter((item) => item.kind === 'NON_MUTATION' && item.status !== 'DESIGNED').length,
        verified: input.invariants.filter((item) => item.kind === 'NON_MUTATION' && item.status === 'VERIFIED').length,
      },
      sideEffect: evidenceProof(input, ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG']),
    },
    dimensions: dimensionsObject(input),
    discovery: input.discovery,
    environment: input.environmentPreflight,
    sourceSync: input.sourceSync,
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
  }) as Record<string, unknown>;
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
    lines.push('', 'Request / Response / Evidence:', '', '```json', JSON.stringify(artifactSafe({
      request: problem.request, response: problem.response, evidence: problem.evidence,
      confidenceFactors: problem.confidenceFactors, minimalReproduction: problem.minimalReproduction,
    }), null, 2), '```', '', `Suggested Priority: ${problem.severity}`,
      `Remediation: ${problem.remediation ?? '补齐权威契约/执行/证据后重跑。'}`, '');
  }
  lines.push('## Unknowns', '');
  lines.push(...(meta.unknowns.length ? meta.unknowns.map((item) => `- ${item.type} / ${item.id}: ${item.message}`) : ['- none']));
  lines.push('');
  return artifactText(lines.join('\n'));
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
    '## Source Sync', '',
    ...(input.sourceSync ? [
      `- Status: ${input.sourceSync.status}`,
      `- Root: ${input.sourceSync.root}`,
      `- Repositories: ${input.sourceSync.repositories.length}`,
      `- Updated: ${input.sourceSync.repositories.filter((item) => item.updated).length}`,
      ...input.sourceSync.repositories.map((item) => `- ${item.name}: ${item.branch} -> ${item.upstream} @ ${item.afterCommit}`),
    ] : ['- NOT_REQUIRED（plan/preflight/dry-run）']), '',
    `Dev Confidence: ${input.devConfidence.score}/100${input.devConfidence.failClosed ? ' (Fail-Closed)' : ''}`, '',
    `Test Reliability: ${input.reliability.score}/100`,
    `Requirement Quality: ${input.requirementQuality.score}/100 · Testability: ${input.requirementQuality.testability}/100`, '',
    '## Verification Coverage', '',
    `- GENERATED: ${input.deliveryCoverage.cases.generated}`,
    `- EXECUTABLE: ${input.deliveryCoverage.cases.executable}`,
    `- EXECUTED: ${input.deliveryCoverage.cases.executed}`,
    `- VERIFIED: ${input.deliveryCoverage.cases.verified}`,
    `- NOT_TESTED: ${input.deliveryCoverage.cases.notTested}`,
    `- Requirement: generated ${input.deliveryCoverage.requirements.generatedCoverage}% · executed ${input.deliveryCoverage.requirements.executedCoverage}% · verified ${input.deliveryCoverage.requirements.verifiedCoverage}%`,
    `- Evidence: ${input.deliveryCoverage.evidence.coverage}%`, '',
    '## Evidence Proof', '',
    `- Response: ${JSON.stringify(evidenceProof(input, ['API_RESPONSE']))}`,
    `- State / DB: ${JSON.stringify(evidenceProof(input, ['DATABASE_STATE', 'RESOURCE_STATE', 'STATE_CHANGE', 'DATA_DIFF']))}`,
    `- Non-Mutation: ${input.invariants.filter((item) => item.kind === 'NON_MUTATION' && item.status === 'VERIFIED').length}/${input.invariants.filter((item) => item.kind === 'NON_MUTATION').length} VERIFIED`,
    `- Side Effect / Log / Queue: ${JSON.stringify(evidenceProof(input, ['EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD', 'LOG']))}`,
    '',
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

const HANDOFF_LEVEL_WEIGHT = { P0: 4, P1: 3, P2: 2, P3: 1 } as const;

export function handoffProblemLevel(problem: DevTestProblem, input: Pick<DevTestRenderInput, 'caseProfiles'>): keyof typeof HANDOFF_LEVEL_WEIGHT {
  const product = problem.issueClassification === 'PRODUCT_BUG' || problem.failureClass === 'PRODUCT_BUG';
  const descriptor = `${problem.category ?? ''} ${problem.type} ${problem.scope ?? ''} ${problem.dimension ?? ''} ${problem.message}`;
  const criticalBusiness = /Permission|Authorization|Security|Data Isolation|DATA_ISOLATION|Billing|Financial|DATA_CONSISTENCY|DATA_DAMAGE|DATA_LEAK/i
    .test(descriptor);
  const generalValidationOrUi = /Parameter Validation|PARAMETER_VALIDATION|UI Behavior|\bUI\b/i.test(descriptor);
  const mainFlowAffected = problem.affectedCases.some((caseId) =>
    ['HAPPY_PATH', 'PERSISTENCE'].includes(input.caseProfiles[caseId]?.coreKind ?? ''));
  if (product && (criticalBusiness || mainFlowAffected)) return 'P0';
  if (generalValidationOrUi) return 'P2';
  if (product) return 'P1';
  if (problem.severity === 'CRITICAL' || problem.severity === 'HIGH') return 'P1';
  if (problem.severity === 'MEDIUM') return 'P2';
  return 'P3';
}

function sortedHandoffProblems(input: DevTestRenderInput): DevTestProblem[] {
  return [...input.problems].sort((left, right) => {
    const byLevel = HANDOFF_LEVEL_WEIGHT[handoffProblemLevel(right, input)]
      - HANDOFF_LEVEL_WEIGHT[handoffProblemLevel(left, input)];
    return byLevel || (right.benefitScore ?? 0) - (left.benefitScore ?? 0)
      || (right.confidence ?? 0) - (left.confidence ?? 0) || left.id.localeCompare(right.id);
  });
}

function testTypeLabel(value: string): string {
  return ({ API: '接口', FUNCTIONAL: '功能', UI: 'UI', DATA_ISOLATION: '数据隔离',
    PARAMETER_VALIDATION: '参数校验' } as Record<string, string>)[value] ?? value;
}

function inferredContractNote(testCase: TestCase | undefined): string | undefined {
  if (!testCase) return undefined;
  const sources = (testCase.contractDependencies ?? []).flatMap((dependency) => dependency.sources ?? []);
  const inferred = sources.filter((source) => !['requirement', 'markdown'].includes(source.type));
  if (!inferred.length) return undefined;
  return `推导契约：${inferred.map((source) => `${source.type}:${source.ref}@${source.confidence ?? 'unknown'}`).join('；')}`;
}

function pendingOwner(fact: DevTestRequirementModel['facts'][number]): string {
  if (fact.provenance === 'CONTRACT' || fact.category === 'API') return '后端/接口负责人';
  if (fact.provenance === 'CONFIGURED') return '测试环境/账号负责人';
  return '产品/需求负责人';
}

function pendingQuestion(fact: DevTestRequirementModel['facts'][number]): string {
  const subject = `“${fact.statement}”`;
  const questions: Record<string, string> = {
    ACTOR_UNRESOLVED: `${subject}由哪个角色执行？`,
    TARGET_OR_SCOPE_UNRESOLVED: `${subject}适用的目标用户、租户或资源范围是什么？`,
    ACTION_UNRESOLVED: `${subject}要求执行什么业务动作？`,
    RESOURCE_UNRESOLVED: `${subject}作用于哪个业务资源？`,
    EXPECTED_OUTCOME_UNRESOLVED: `${subject}的可验证成功或失败结果是什么？`,
  };
  const unresolved = fact.canonical.unresolved.map((code) => questions[code] ?? `${subject}缺少 ${code}，请补充可验证定义。`);
  return unresolved.join('；') || `${subject}缺少可验证业务预期，请补充。`;
}

function handoffProblemStatus(problem: DevTestProblem): 'OPEN' | 'RESOLVED（待验证）' | 'VERIFIED（验证通过）' {
  if (problem.lifecycle === 'FIXED') return 'VERIFIED（验证通过）';
  return 'OPEN';
}

/**
 * 开发交接用例资产：展示设计、执行契约、Oracle、Evidence 和最终状态；
 * 不会把设计态 READY 或静态发现渲染成 PASS。
 */
export function renderDeveloperSelfTestCases(input: DevTestRenderInput): string {
  const rows = caseRows(input);
  const rowByCase = new Map(rows.map((row) => [row.caseId, row]));
  const traceByCase = new Map(input.acceptanceTraces.map((trace) => [trace.caseId, trace]));
  const tableRows = input.testCases.map((testCase) => {
    const row = rowByCase.get(testCase.id);
    const trace = traceByCase.get(testCase.id);
    const contractSources = (testCase.contractDependencies ?? []).flatMap((dependency) => dependency.sources ?? []);
    const inferred = contractSources.some((source) => !['requirement', 'markdown'].includes(source.type));
    const type = testTypeLabel(row?.dimension ?? devTestDimensionOf(testCase.testType));
    const scenarioAndOracle = [
      labeledValue('标题', testCase.name),
      labeledValue('Requirement ID', testCase.source?.requirementId ?? input.requirementModel.requirementId),
      labeledValue('AC', testCase.source?.acceptanceCriteriaIds?.join(', ') || 'N/A（不适用）'),
      labeledValue('Fact', testCase.source?.factIds?.join(', ') || 'N/A（不适用）'),
      labeledValue('Business Scenario', testCase.businessScenario
        ?? { title: testCase.name, goal: testCase.design?.expectedOutcome ?? 'UNKNOWN' }),
      labeledValue('Expected Result / Assertion / Oracle', {
        expected: testCase.expected ?? {}, assertions: testCase.assertions,
        oracle: testCase.oracle ?? { status: 'BLOCKED', reason: 'ORACLE_NOT_DECLARED' },
      }),
    ].join('；');
    const executionAndEvidence = [
      labeledValue('Preconditions / Test Data', {
        preconditions: testCase.preconditions ?? [], preconditionPlan: testCase.preconditionPlan ?? [],
        data: testCase.data ?? {}, testData: testCase.testData ?? [],
      }),
      labeledValue('Steps', testCase.steps),
      labeledValue('Evidence Required', {
        required: testCase.evidenceRequirements ?? [], collected: trace?.evidence.collectedItems ?? [],
        missing: trace?.evidence.missingItems ?? [],
      }),
      labeledValue('Cleanup / Dependency', {
        prepare: testCase.prepare ?? [], cleanup: testCase.cleanup ?? [], dependencies: testCase.dependencies ?? [],
        executionContract: testCase.executionContract,
      }),
      labeledValue('备注', [
        `Classification=${trace?.classification ?? 'NOT_TESTED'}`,
        `Execution=${testCase.executionMode ?? 'DESIGNED_ONLY'}/${testCase.readiness?.status ?? 'BLOCKED'}`,
        `Contract=${inferred ? '推导契约' : '需求/配置契约'}${contractSources.length
          ? `（${contractSources.map((source) => `${source.type}:${source.ref}@${source.confidence ?? 'unknown'}`).join('；')}）` : '（来源未解析）'}`,
        `Tags=${testCase.tags.join(', ') || 'N/A（不适用）'}`,
        row?.blockedReason || 'Oracle 与 Evidence 完整性由确定性运行链判定。',
      ].join('；')),
    ].join('；');
    return [
      testCase.id,
      input.report.requirement.title,
      `${type} / ${testCase.priority}`,
      row?.status ?? 'NOT_EXECUTED',
      scenarioAndOracle,
      executionAndEvidence,
    ];
  });
  const lines = [
    `# ${markdownInline(input.report.requirement.title)} 测试用例`, '',
    `- 需求文档：${markdownInline(input.meta.docSource)}`,
    `- Run ID：${markdownInline(input.runId)}`,
    `- 生成时间：${markdownInline(input.meta.finishedAt)}`,
    `- 用例统计：共 ${rows.length} 条｜PASS ${rows.filter((row) => row.status === 'PASS').length}｜FAIL ${rows.filter((row) => row.status === 'FAIL').length}｜BLOCKED ${rows.filter((row) => row.status === 'BLOCKED').length}｜NOT_EXECUTED ${rows.filter((row) => row.status === 'NOT_EXECUTED').length}`,
    '', '## 全部测试用例', '',
    renderFeishuMarkdownTable(['编号', '模块', '类型/优先级', '结果', '场景与 Oracle', '执行、证据与备注'], tableRows), '',
  ];
  return `${artifactText(lines.join('\n'))}\n`;
}

/** 用户约定的固定七段开发自测报告。每个章节只渲染一张飞书兼容 Markdown 表格。 */
export function renderDeveloperSelfTestReport(input: DevTestRenderInput): string {
  const rows = caseRows(input);
  const passed = rows.filter((row) => row.status === 'PASS').length;
  const failed = rows.filter((row) => row.status === 'FAIL').length;
  const blocked = rows.filter((row) => row.status === 'BLOCKED').length;
  const notExecuted = rows.filter((row) => row.status === 'NOT_EXECUTED').length;
  const total = passed + failed + blocked + notExecuted;
  const unknowns = unknownsOf(input.report);
  const orderedProblems = sortedHandoffProblems(input);
  const recommendation = input.conclusion === 'READY' ? '建议发布'
    : input.conclusion === 'NOT_READY' ? '暂不发布（修复后再提）' : '待补测';
  const validationMode = input.deliveryCoverage.cases.executed > 0
    ? `真实调用（[ENV:DEVTEST_BASE_URL]，${input.meta.mode}）`
    : `测试设计（无真实执行证据；未产生静态缺陷分析证据，${input.meta.mode}）`;
  const topRisks = orderedProblems.slice(0, 3).map((problem, index) =>
    `${index + 1}. ${handoffProblemLevel(problem, input)} ${markdownInline(problem.id)} ${markdownInline(problem.message)}`);
  if (!topRisks.length) topRisks.push(...unknowns.slice(0, 3).map((item, index) =>
    `${index + 1}. ${markdownInline(item.type)} ${markdownInline(item.message)}`));

  const pending: Array<{ key: string; question: string; cases: string; owner: string }> = [];
  for (const issue of input.requirementQuality.issues) {
    const cases = input.acceptanceTraces.filter((trace) => !issue.acId
      || trace.requirement.acceptanceCriteriaIds.includes(issue.acId)).map((trace) => trace.caseId);
    pending.push({ key: `QUALITY:${issue.code}:${issue.acId ?? '-'}`, question: issue.message,
      cases: cases.join(', ') || 'N/A（不适用）', owner: issue.code === 'API_MISSING' ? '后端/接口负责人' : '产品/需求负责人' });
  }
  for (const fact of input.requirementModel.facts.filter((fact) => fact.knowledge === 'UNKNOWN'
    && fact.normativity === 'NORMATIVE' && !['CONFIGURED', 'CONTRACT'].includes(fact.provenance)
    && fact.canonical.unresolved.length > 0)) {
    const cases = input.acceptanceTraces.filter((trace) => trace.requirement.factIds.includes(fact.id)).map((trace) => trace.caseId);
    pending.push({ key: `FACT:${fact.id}`, question: `${fact.id}：${pendingQuestion(fact)}`,
      cases: cases.join(', ') || 'N/A（不适用）', owner: pendingOwner(fact) });
  }
  const uniquePending = pending.filter((item, index, all) => all.findIndex((other) => other.key === item.key) === index);

  const caseTableRows = rows.map((row) => {
    const trace = input.acceptanceTraces.find((item) => item.caseId === row.caseId);
    const executionNote = row.status === 'PASS' || row.status === 'FAIL'
      ? `${trace?.oracle.verdict ?? row.rawStatus}；Evidence ${trace?.evidence.collectedItems?.length ?? 0}/${trace?.evidence.requiredItems?.length ?? 0}`
      : row.blockedReason || trace?.explanation.join('；') || '未获得真实执行与证据';
    const contractNote = inferredContractNote(input.testCases.find((item) => item.id === row.caseId));
    const note = [executionNote, contractNote].filter(Boolean).join('；');
    return [row.caseId, input.report.requirement.title, `${testTypeLabel(row.dimension)} / ${row.priority}`,
      row.status, labeledValue('测试点/场景', row.title), labeledValue('证据/备注', note)];
  });

  const problemTableRows = orderedProblems.map((problem) => {
    const reproduction = problem.reproduction?.length ? problem.reproduction.map((step, index) => `${index + 1}.${step}`).join(' ') : '补齐执行条件后按关联 Case 复现';
    const evidence = {
      why: problem.why,
      expected: problem.expected,
      actual: problem.actual,
      evidence: problem.evidence,
      request: problem.request,
      response: problem.response,
    };
    return [problem.id, handoffProblemLevel(problem, input), handoffProblemStatus(problem),
      `${labeledValue('问题', problem.message)}；${labeledValue('复现步骤', reproduction)}`,
      `${labeledValue('证据', evidence)}；${labeledValue('修复/验证要求', problem.remediation ?? 'N/A（不适用）')}`];
  });

  const uncovered: Array<{ item: string; reason: string; material: string }> = [];
  for (const trace of input.acceptanceTraces.filter((item) => item.result === 'BLOCKED' || item.result === 'NOT_TESTED')) {
    uncovered.push({
      item: trace.caseId,
      reason: trace.explanation.join('；'),
      material: [...trace.executableTest.missing, ...(trace.evidence.missingItems ?? [])].join(', ') || '可执行环境、账号或 Observer',
    });
  }
  for (const dimension of input.environmentPreflight.blockedDimensions) {
    uncovered.push({ item: dimension.dimension, reason: dimension.reason, material: '对应执行器、测试环境与账号/数据配置' });
  }
  for (const item of unknowns) {
    uncovered.push({
      item: item.id || item.type,
      reason: `${item.type}：${item.message}`,
      material: item.type === 'UNKNOWN_CONTRACT' ? '权威契约/源码映射与复核'
        : item.type === 'UNVERIFIED_REQUIREMENT' ? '测试环境、账号、执行器与有效 Evidence'
          : '对应 Observer、执行器或环境能力',
    });
  }
  const uniqueUncovered = uncovered.filter((item, index, all) => all.findIndex((other) => other.item === item.item
    && other.reason === item.reason) === index);

  const requirementTableRows: unknown[][] = input.requirementModel.facts.map((fact) => [
    '需求事实', fact.id, fact.statement, `${fact.knowledge}/${fact.provenance}`,
    input.acceptanceTraces.filter((trace) => trace.requirement.factIds.includes(fact.id)).map((trace) => trace.caseId).join(', ') || 'N/A（不适用）',
    fact.canonical.unresolved.join(', ') || 'N/A（不适用）',
  ]);
  requirementTableRows.push(...uniquePending.map((item, index) => [
    '待确认', index + 1, item.question, 'NEED_CONFIRMATION', item.cases, item.owner,
  ]));
  if (!requirementTableRows.length) requirementTableRows.push(['需求核对', 'N/A（不适用）', '无待确认项', 'CONFIRMED', 'N/A（不适用）', 'N/A（不适用）']);

  const evidenceTableRows = input.acceptanceTraces.map((trace) => {
    const row = rows.find((item) => item.caseId === trace.caseId);
    return [trace.caseId, row?.status ?? 'NOT_EXECUTED', trace.oracle.verdict,
      [
        labeledValue('已收集证据', trace.evidence.collectedItems?.join(', ') || 'N/A（不适用）'),
        labeledValue('缺失证据', trace.evidence.missingItems?.join(', ') || 'N/A（不适用）'),
        labeledValue('说明', trace.explanation.join('；') || 'N/A（不适用）'),
      ].join('；')];
  });

  const lines = [
    `# ${markdownInline(input.report.requirement.title)} 开发自测测试报告`, '',
    `- 需求文档：${markdownInline(input.meta.docSource)} / 报告类型：开发自测报告 / 测试人：DevTest Agent / 日期：${markdownInline(formatReportDate(input.meta.finishedAt))} / 验证模式：${markdownInline(validationMode)}`,
    `- 源码同步：${input.sourceSync ? `${input.sourceSync.status}；${input.sourceSync.repositories.length} 个仓库；${input.sourceSync.repositories.filter((item) => item.updated).length} 个完成快进更新` : 'NOT_REQUIRED（plan/preflight/dry-run）'}`, '',
    '## 1. 结论概览', '',
    renderFeishuMarkdownTable(['项目', '结果', '说明'], [
      ['用例统计', total, `PASS ${passed}；FAIL ${failed}；BLOCKED ${blocked}；NOT_EXECUTED ${notExecuted}`],
      ['提测建议', recommendation, input.conclusion],
      ['代码与环境结论', input.conclusion, `Dev Confidence ${input.devConfidence.score}/100${input.devConfidence.failClosed ? '（Fail-Closed）' : ''}`],
      ['Requirement Coverage', `${input.deliveryCoverage.requirements.verifiedCoverage}%`,
        `Generated ${input.deliveryCoverage.requirements.generatedCoverage}%；Executed ${input.deliveryCoverage.requirements.executedCoverage}%；Evidence ${input.deliveryCoverage.evidence.coverage}%`],
      ['Top 风险', topRisks.length, topRisks.join('；') || '当前可观察范围内无已识别风险。'],
    ]),
    '', '## 2. 需求与实现核对', '',
    renderFeishuMarkdownTable(['类型', '编号', '需求/问题', '状态/来源', '关联用例', '负责人/说明'], requirementTableRows),
    '', '## 3. 用例执行清单', '',
    renderFeishuMarkdownTable(['编号', '模块', '类型/优先级', '结果', '场景与 Oracle', '执行、证据与备注'],
      caseTableRows.length ? caseTableRows : [['N/A（不适用）', 'N/A（不适用）', 'N/A（不适用）', 'NOT_EXECUTED', '测试点/场景：无', '证据/备注：用例数为 0']]),
    '', '## 4. 审查中发现的问题', '',
    renderFeishuMarkdownTable(['编号', '级别', '状态', '问题与复现', '证据与处理'],
      problemTableRows.length ? problemTableRows : [['N/A（不适用）', 'N/A（不适用）', 'N/A（不适用）', '问题：当前可观察范围内无已确认缺陷；复现步骤：N/A（不适用）', '证据：N/A（不适用）；修复/验证要求：N/A（不适用）']]),
    '', '## 5. 自动化执行证据', '',
    renderFeishuMarkdownTable(['编号', '执行状态', 'Oracle 结论', '证据与说明'],
      evidenceTableRows.length ? evidenceTableRows : [['N/A（不适用）', 'NOT_EXECUTED', 'N/A（不适用）', '已收集证据：无；缺失证据：N/A（不适用）；说明：无执行证据']]),
    '', '## 6. 未覆盖项与回归建议', '',
    renderFeishuMarkdownTable(['未覆盖项', '原因', '需要补充的材料'],
      uniqueUncovered.length ? uniqueUncovered.map((item) => [item.item, item.reason, item.material]) : [['N/A（不适用）', '无', 'N/A（不适用）']]),
    '', '## 7. 发布判定', '',
    renderFeishuMarkdownTable(['判定项', '结果', '依据'], [
      ['最终判定', recommendation, input.conclusion],
      ['必测项状态', failed + blocked + notExecuted === 0 ? '全部完成' : '未全部完成',
        `FAIL ${failed}；BLOCKED ${blocked}；NOT_EXECUTED ${notExecuted}`],
      ['未解决问题', orderedProblems.length, orderedProblems.map((problem) => problem.id).join(', ') || '无'],
    ]),
    '',
    '> 说明：生成不等于执行，执行不等于验证。PASS/FAIL 只来自真实执行、确定性 Oracle 与完整 Evidence；静态发现和证据不足项保持 BLOCKED/NOT_EXECUTED。',
    '',
  ];
  return artifactText(lines.join('\n'));
}

function statusClass(status: string): string {
  return status === 'READY' || status === 'PASS' ? 'ok' : status === 'NOT_READY' || status === 'FAIL' ? 'bad' : 'warn';
}

export function renderDevTestHtml(input: DevTestRenderInput): string {
  const rows = caseRows(input);
  const unknowns = unknownsOf(input.report);
  const sourceSyncRows = input.sourceSync?.repositories.map((repository) => `<tr><td>${escapeHtml(repository.name)}</td><td>${escapeHtml(repository.branch)}</td><td>${escapeHtml(repository.upstream)}</td><td><code>${escapeHtml(repository.beforeCommit)}</code></td><td><code>${escapeHtml(repository.afterCommit)}</code></td><td>${repository.updated ? 'YES' : 'NO'}</td><td>YES</td></tr>`).join('') ?? '';
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
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DevTest · ${escapeHtml(input.report.requirement.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f8fa;color:#1f2328;margin:0}.wrap{max-width:1500px;margin:auto;padding:24px}section,.problem{background:#fff;border:1px solid #d0d7de;border-radius:8px;margin:16px 0;padding:18px}.banner{border-left:6px solid #9a6700}.ok{color:#1a7f37;font-weight:700}.bad{color:#cf222e;font-weight:700}.warn{color:#9a6700;font-weight:700}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #d0d7de;padding:10px 16px;border-radius:6px}.card b{font-size:22px}table{border-collapse:collapse;width:100%;min-width:900px}th,td{border:1px solid #d0d7de;padding:7px;text-align:left;vertical-align:top}.scroll{overflow:auto}code{font-size:11px;word-break:break-all}</style></head><body><main class="wrap">
<h1>${escapeHtml(input.report.requirement.title)}</h1>
<section class="banner"><h2>开发首页 · Feature Acceptance</h2><p><b>Feature：</b>${escapeHtml(input.report.requirement.title)}</p><p class="${statusClass(input.conclusion)}" style="font-size:30px"><b>最终结论 / Final Result：</b>${input.conclusion}</p><div class="cards"><div class="card"><b>${input.devConfidence.score}</b><br>Dev Confidence</div><div class="card"><b>${input.requirementCoverage.coreCoverage}%</b><br>Core Coverage</div><div class="card"><b>${input.businessFlowGraph.applicable === false ? 'N/A' : `${input.businessFlowGraph.coverage}%`}</b><br>Business Flow Coverage</div><div class="card"><b>${evidenceCoverage}%</b><br>Evidence Coverage</div><div class="card bad"><b>${confirmedBugs.length}</b><br>Confirmed Bugs</div><div class="card warn"><b>${likelyProblems.length}</b><br>Likely Bugs</div><div class="card warn"><b>${blocked + notExecuted}</b><br>Blocked</div><div class="card"><b>${unknowns.length}</b><br>Unknowns</div><div class="card"><b>${input.reliability.score}</b><br>Test Reliability</div></div>${input.reproduction ? `<p><b>Reproduction ${input.reproduction.problemId}：</b>${input.reproduction.status}</p>` : ''}</section>
<section><h2>Worker Source Sync</h2>${input.sourceSync ? `<p class="ok"><b>${escapeHtml(input.sourceSync.status)}</b> · ${escapeHtml(input.sourceSync.root)} · ${input.sourceSync.repositories.length} repositories · ${input.sourceSync.repositories.filter((repository) => repository.updated).length} fast-forward updated</p><div class="scroll"><table><tr><th>Repository</th><th>Branch</th><th>Upstream</th><th>Before SHA</th><th>After SHA</th><th>Updated</th><th>Worktree Clean</th></tr>${sourceSyncRows}</table></div>` : '<p>NOT_REQUIRED（plan/preflight/dry-run）</p>'}</section>
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
  return artifactText(html);
}

export { unknownsOf as buildDevTestUnknowns };
