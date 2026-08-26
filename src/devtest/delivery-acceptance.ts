import type { TestCase, TestEvidenceRequirement } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { AcceptanceRequirement, RequirementFact } from '../acceptance/requirement-ir.js';
import { devTestDimensionOf } from './dimension-selector.js';
import type {
  DevTestAcceptanceResult,
  DevTestAcceptanceTrace,
  DevTestDeliveryCoverage,
  DevTestEnvironmentSnapshot,
  DevTestIssueClassification,
  DevTestOracleResult,
  DevTestProblem,
  DevTestRequirementKnowledge,
  DevTestRequirementModel,
  DevTestStateObservation,
  DevTestUiExecutionResult,
} from './types.js';

function knowledgeOf(fact: RequirementFact): DevTestRequirementKnowledge {
  if (fact.provenance === 'UNKNOWN' || fact.canonical.normalizationStatus === 'UNRESOLVED') return 'UNKNOWN';
  if (fact.epistemicType !== 'FACT' || fact.provenance === 'INFERRED') return 'DERIVED';
  return 'EXPLICIT';
}

/** Requirement Understanding 的交付投影，保留原 Fact Ledger 和认知边界。 */
export function buildDevTestRequirementModel(requirement: AcceptanceRequirement): DevTestRequirementModel {
  const facts = requirement.factLedger.map((fact) => ({
    id: fact.id,
    statement: fact.statement,
    category: fact.category,
    knowledge: knowledgeOf(fact),
    provenance: fact.provenance,
    epistemicType: fact.epistemicType,
    normativity: fact.normativity,
    status: fact.status,
    source: fact.source,
    canonical: fact.canonical,
  }));
  return {
    requirementId: requirement.id,
    title: requirement.title,
    facts,
    explicitFactIds: facts.filter((fact) => fact.knowledge === 'EXPLICIT').map((fact) => fact.id),
    derivedFactIds: facts.filter((fact) => fact.knowledge === 'DERIVED').map((fact) => fact.id),
    unknownFactIds: facts.filter((fact) => fact.knowledge === 'UNKNOWN').map((fact) => fact.id),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function evidenceKey(item: Pick<TestEvidenceRequirement, 'id' | 'channel' | 'phase' | 'expectation'>): string {
  return item.id ?? `${item.channel}@${item.phase}:${item.expectation ?? 'PRESENT'}`;
}

function collectedEvidence(input: {
  testCase: TestCase;
  result?: AcceptanceCaseExecutionResult;
  ui?: DevTestUiExecutionResult;
  observations: readonly DevTestStateObservation[];
  snapshots: readonly DevTestEnvironmentSnapshot[];
}): TestEvidenceRequirement['channel'][] {
  const collected: TestEvidenceRequirement['channel'][] = [];
  if (input.result?.evidence.request) collected.push('API_REQUEST');
  if (input.result?.evidence.response) collected.push('API_RESPONSE');
  const uiKinds = new Set(input.ui?.evidence.map((item) => item.kind) ?? []);
  if (uiKinds.has('PAGE') || uiKinds.has('DOM')) collected.push('UI_STATE');
  if (uiKinds.has('SCREENSHOT')) collected.push('UI_SCREENSHOT');
  const observations = input.observations.filter((item) => item.caseId === input.testCase.id);
  if (observations.some((item) => ['DATABASE', 'RESOURCE', 'TASK', 'BILLING', 'AUDIT'].includes(item.source)
    && typeof item.evidence !== 'string')) collected.push('DATABASE_STATE');
  if (observations.some((item) => item.phase === 'AFTER' && item.source !== 'RESPONSE'
    && typeof item.evidence !== 'string')) collected.push('STATE_CHANGE');
  if (input.snapshots.some((item) => item.caseId === input.testCase.id && item.phase === 'BEFORE' && !item.error)
    && input.snapshots.some((item) => item.caseId === input.testCase.id && item.phase === 'AFTER_EXECUTE' && !item.error)) {
    collected.push('DATA_DIFF');
  }
  if (observations.some((item) => item.source === 'AUDIT' && typeof item.evidence !== 'string')) collected.push('LOG');
  return unique(collected);
}

function qualityStatus(testCase: TestCase, ui: DevTestUiExecutionResult | undefined): DevTestAcceptanceTrace['executableTest']['status'] {
  const quality = testCase.metadata?.caseQuality as { status?: string } | undefined;
  if (quality?.status === 'BLOCKED') return 'BLOCKED';
  if (ui?.executionContractReady === true) return 'READY';
  return testCase.executionMode === 'EXECUTABLE' ? 'READY' : 'DESIGNED_ONLY';
}

function executableMissing(testCase: TestCase, ui?: DevTestUiExecutionResult): string[] {
  const missing: string[] = [];
  if (!(testCase.source?.factIds?.length)) missing.push('REQUIREMENT_TRACE_MISSING');
  if (!(testCase.source?.objectiveIds?.length)) missing.push('TEST_MODEL_TRACE_MISSING');
  if (!testCase.steps.length && !(ui?.executionContractReady && ui.steps.length)) missing.push('EXECUTABLE_ACTION_MISSING');
  const assertionFactIds = unique([
    ...testCase.assertions.filter((item) => item.type !== 'DESIGN_EXPECTATION').flatMap((item) => item.factIds ?? []),
    ...(ui?.executionContractReady ? ui.assertions.flatMap((item) => item.factIds ?? []) : []),
  ]);
  if (!assertionFactIds.length) {
    missing.push('DETERMINISTIC_ASSERTION_MISSING');
  }
  for (const factId of testCase.source?.factIds ?? []) {
    if (!assertionFactIds.includes(factId)) missing.push(`FACT_ASSERTION_MISSING:${factId}`);
  }
  if (!(testCase.evidenceRequirements?.length)) missing.push('EVIDENCE_PLAN_MISSING');
  return missing;
}

function traceResult(input: {
  result?: AcceptanceCaseExecutionResult;
  ui?: DevTestUiExecutionResult;
  oracle?: DevTestOracleResult;
  executableReady: boolean;
  evidenceComplete: boolean;
  missing: readonly string[];
  selected: boolean;
}): DevTestAcceptanceResult {
  if (!input.selected) return 'NOT_TESTED';
  if (input.executableReady && input.evidenceComplete && input.missing.length === 0
    && input.oracle?.verdict === 'PASS' && input.oracle.evidence.complete) return 'PASS';
  if (input.executableReady && input.evidenceComplete && input.missing.length === 0
    && input.oracle?.verdict === 'FAIL' && input.oracle.evidence.complete) return 'FAIL';
  const raw = input.ui?.status ?? input.result?.status;
  if (!raw || raw === 'NOT_EXECUTED' || raw === 'CANCELLED') return 'NOT_TESTED';
  return 'BLOCKED';
}

const REQUIREMENT_GAP = /EXPECTED_OUTCOME_UNKNOWN|AUTH_POLICY_UNKNOWN|REQUIREMENT_CONTRACT_INCOMPLETE|BINDING_INCOMPLETE|SUCCESS_RESPONSE_AMBIGUOUS|REQUIREMENT|UNKNOWN_CONTRACT|CONTRACT_/i;
const TEST_DESIGN_ERROR = /MISSING_ASSERTION|ASSERTION_MISSING|SOURCE_(?:FACT|OBJECTIVE)_MISSING|EXECUTION_CONTRACT_INCOMPLETE|EVIDENCE_PLAN_MISSING|BUSINESS_OBSERVABILITY_MISSING|FLAKY_TEST|TEST_POLLUTION/i;
const ENVIRONMENT_ERROR = /ENVIRONMENT|NETWORK|ECONN|ENOTFOUND|FETCH FAILED|BROWSER_UNAVAILABLE|AUTH_CONTEXT|TEST_DATA|DATA_PREP|TIMEOUT|SLOW_RESPONSE/i;
const EXECUTION_ERROR = /PROCESSOR|EXECUTOR|RUNNER|OBSERVER|EVIDENCE_MISSING|ORACLE_INCOMPLETE|HTTP_5XX|EMPTY_RESPONSE/i;

function classifyTrace(input: {
  result: DevTestAcceptanceResult;
  oracle?: DevTestOracleResult;
  executionReason: string;
  missing: string[];
  problems: readonly DevTestProblem[];
}): DevTestIssueClassification {
  if (input.result === 'PASS') return 'NONE';
  if (input.result === 'NOT_TESTED') return 'NOT_TESTED';
  if (input.result === 'FAIL' && input.oracle?.verdict === 'FAIL' && input.oracle.evidence.complete
    && input.problems.some((item) => item.failureClass === 'PRODUCT_BUG')) return 'PRODUCT_BUG';
  const problemText = input.problems.map((item) => `${item.reasonCode ?? ''} ${item.type} ${item.message}`).join(' ');
  const text = `${input.executionReason} ${input.oracle?.transientSignal ?? ''} ${input.missing.join(' ')} ${problemText}`;
  if (REQUIREMENT_GAP.test(text) || input.problems.some((item) => item.failureClass === 'REQUIREMENT_ISSUE'
    || item.failureClass === 'CONTRACT_ISSUE')) return 'REQUIREMENT_GAP';
  if (TEST_DESIGN_ERROR.test(text) || input.missing.some((item) => item.includes('TRACE')
    || item.includes('ASSERTION') || item.includes('EVIDENCE_PLAN'))) return 'TEST_DESIGN_ERROR';
  if (ENVIRONMENT_ERROR.test(text) || input.problems.some((item) => ['ENVIRONMENT_ISSUE', 'AUTH_ISSUE', 'DATA_ISSUE'].includes(item.failureClass ?? ''))) {
    return 'ENVIRONMENT_ERROR';
  }
  if (EXECUTION_ERROR.test(text) || input.oracle?.verdict === 'UNKNOWN') return 'EXECUTION_ERROR';
  return 'EXECUTION_ERROR';
}

export function buildDevTestAcceptanceTraces(input: {
  requirementModel: DevTestRequirementModel;
  testCases: readonly TestCase[];
  results: readonly AcceptanceCaseExecutionResult[];
  uiResults: readonly DevTestUiExecutionResult[];
  oracleResults: readonly DevTestOracleResult[];
  observations?: readonly DevTestStateObservation[];
  snapshots?: readonly DevTestEnvironmentSnapshot[];
  problems: readonly DevTestProblem[];
  selectedCaseIds?: readonly string[];
  unselected?: ReadonlyArray<{ caseId: string; reason: string }>;
}): DevTestAcceptanceTrace[] {
  const factKnowledge = new Map(input.requirementModel.facts.map((fact) => [fact.id, fact.knowledge]));
  const resultByCase = new Map(input.results.map((item) => [item.caseId, item]));
  const uiByCase = new Map(input.uiResults.map((item) => [item.caseId, item]));
  const oracleByCase = new Map(input.oracleResults.map((item) => [item.caseId, item]));
  const selectedCaseIds = new Set(input.selectedCaseIds ?? input.testCases.map((item) => item.id));
  const unselectedReason = new Map((input.unselected ?? []).map((item) => [item.caseId, item.reason]));
  return input.testCases.map((testCase): DevTestAcceptanceTrace => {
    const runtime = resultByCase.get(testCase.id);
    const ui = uiByCase.get(testCase.id);
    const oracle = oracleByCase.get(testCase.id);
    const relatedProblems = input.problems.filter((item) => item.affectedCases.includes(testCase.id));
    const factIds = unique(testCase.source?.factIds ?? []);
    const plan = testCase.evidenceRequirements ?? [];
    const required = unique(plan.filter((item) => item.required).map((item) => item.channel));
    const fallbackCollected = collectedEvidence({ testCase, result: runtime, ui,
      observations: input.observations ?? [], snapshots: input.snapshots ?? [] });
    const requiredItems = plan.filter((item) => item.required).map(evidenceKey);
    const collectedItems = oracle?.evidence.collected ?? fallbackCollected.flatMap((channel) => plan
      .filter((item) => item.channel === channel).map(evidenceKey));
    const missingItems = oracle?.evidence.missing ?? requiredItems.filter((item) => !collectedItems.includes(item));
    const collected = unique(plan.filter((item) => collectedItems.includes(evidenceKey(item))).map((item) => item.channel));
    const missingEvidence = unique(plan.filter((item) => missingItems.includes(evidenceKey(item))).map((item) => item.channel));
    const missing = executableMissing(testCase, ui);
    const rawStatus = ui?.status ?? runtime?.status ?? 'NOT_EXECUTED';
    const reason = ui?.error ?? runtime?.error ?? runtime?.attribution?.reason;
    const executableStatus = qualityStatus(testCase, ui);
    const evidenceComplete = requiredItems.length > 0 && missingItems.length === 0
      && !oracle?.evidence.semanticChecks?.some((item) => item.verdict === 'BLOCKED');
    const reliabilityBlocked = relatedProblems.some((item) => item.type === 'FLAKY_TEST' || item.type === 'TEST_POLLUTION');
    const result = reliabilityBlocked ? 'BLOCKED' as const
      : traceResult({ result: runtime, ui, oracle, executableReady: executableStatus === 'READY', evidenceComplete, missing,
        selected: selectedCaseIds.has(testCase.id) });
    const executionStatus: DevTestAcceptanceTrace['execution']['status'] = ui?.executed || runtime?.executed
      ? 'EXECUTED' : rawStatus === 'BLOCKED' || rawStatus === 'TIMEOUT' ? 'BLOCKED' : 'NOT_EXECUTED';
    const classification = classifyTrace({ result, oracle, executionReason: reason ?? rawStatus,
      missing: [...missing, ...missingEvidence.map((item) => `EVIDENCE_MISSING:${item}`)], problems: relatedProblems });
    const assertedFactIds = unique([
      ...testCase.assertions.filter((item) => item.type !== 'DESIGN_EXPECTATION').flatMap((item) => item.factIds ?? []),
      ...(ui?.executionContractReady ? ui.assertions.flatMap((item) => item.factIds ?? []) : []),
    ]).filter((id) => factIds.includes(id));
    const observedAssertionFactIds = unique([
      ...(runtime?.evidence.assertions ?? []).flatMap((item) => item.factIds ?? []),
      ...(ui?.assertions ?? []).flatMap((item) => item.factIds ?? []),
    ]).filter((id) => assertedFactIds.includes(id));
    const verifiedFactIds = result === 'PASS' || result === 'FAIL' ? observedAssertionFactIds : [];
    return {
      caseId: testCase.id,
      requirement: {
        acceptanceCriteriaIds: unique(testCase.source?.acceptanceCriteriaIds ?? []),
        factIds,
        explicitFactIds: factIds.filter((id) => factKnowledge.get(id) === 'EXPLICIT'),
        derivedFactIds: factIds.filter((id) => factKnowledge.get(id) === 'DERIVED'),
        unknownFactIds: factIds.filter((id) => factKnowledge.get(id) === 'UNKNOWN'),
        assertedFactIds,
        verifiedFactIds,
      },
      testModel: {
        objectiveIds: unique(testCase.source?.objectiveIds ?? []),
        scenarioId: testCase.source?.scenarioId,
        dimension: devTestDimensionOf(testCase.testType),
        provenance: testCase.source?.provenance,
        selection: selectedCaseIds.has(testCase.id) ? 'SELECTED' : 'NOT_SELECTED',
        selectionReason: unselectedReason.get(testCase.id),
      },
      executableTest: {
        status: executableStatus,
        preconditions: testCase.preconditions ?? [],
        testData: testCase.data,
        steps: ui?.executionContractReady ? ui.steps : testCase.steps,
        assertions: ui?.executionContractReady ? ui.assertions : testCase.assertions,
        evidencePlan: plan,
        missing,
      },
      execution: {
        status: executionStatus,
        rawStatus,
        executed: Boolean(ui?.executed || runtime?.executed),
        processorInvoked: Boolean(ui?.processorInvoked || runtime?.processorInvoked),
        processor: ui ? 'PlaywrightBrowserProcessor' : runtime?.processor,
        reason,
      },
      evidence: { required, collected, missing: missingEvidence, requiredItems, collectedItems, missingItems,
        complete: evidenceComplete },
      oracle: oracle ? { verdict: oracle.verdict, reason: oracle.reason, expected: oracle.expected, actual: oracle.actual }
        : { verdict: 'BLOCKED', reason: 'ORACLE_NOT_EVALUATED：Case 未进入确定性 Oracle',
          expected: { requirement: [], contract: [], invariants: [] }, actual: undefined },
      result,
      classification,
      problemIds: relatedProblems.map((item) => item.id),
      explanation: [
        `Requirement Facts: ${factIds.join(', ') || 'none'}`,
        `Executable Test: ${executableStatus}`,
        `Execution: ${executionStatus} (${rawStatus})`,
        `Evidence: ${collectedItems.length}/${requiredItems.length}${missingItems.length ? `; missing ${missingItems.join(', ')}` : ''}`,
        `Oracle: ${oracle?.verdict ?? 'NOT_EVALUATED'}`,
        `Classification: ${classification}`,
      ],
    };
  });
}

function percent(part: number, total: number): number {
  return total ? Math.round(part / total * 100) : 0;
}

export function buildDevTestDeliveryCoverage(input: {
  requirementModel: DevTestRequirementModel;
  traces: readonly DevTestAcceptanceTrace[];
}): DevTestDeliveryCoverage {
  const facts = input.requirementModel.facts.filter((fact) => fact.normativity === 'NORMATIVE');
  const linked = (factId: string): DevTestAcceptanceTrace[] => input.traces.filter((trace) => trace.requirement.factIds.includes(factId));
  const generatedFactIds = facts.filter((fact) => linked(fact.id).length > 0).map((fact) => fact.id);
  const executedFactIds = facts.filter((fact) => {
    const traces = linked(fact.id);
    return traces.length > 0 && traces.every((trace) => trace.execution.status === 'EXECUTED');
  }).map((fact) => fact.id);
  // 一个 Happy Path 的确定结果不能把同一 Requirement 下其余未执行/阻断的义务折叠成 VERIFIED。
  const verifiedFactIds = facts.filter((fact) => {
    const traces = linked(fact.id);
    return traces.length > 0 && traces.every((trace) => (trace.result === 'PASS' || trace.result === 'FAIL')
      && (trace.requirement.verifiedFactIds ?? []).includes(fact.id));
  }).map((fact) => fact.id);
  const untestedFactIds = facts.filter((fact) => linked(fact.id).length === 0
    || linked(fact.id).some((trace) => trace.execution.status !== 'EXECUTED')).map((fact) => fact.id);
  const blockedFactIds = facts.filter((fact) => !verifiedFactIds.includes(fact.id)
    && linked(fact.id).some((trace) => trace.result === 'BLOCKED')).map((fact) => fact.id);
  const complete = input.traces.filter((trace) => trace.evidence.complete).map((trace) => trace.caseId);
  const incomplete = input.traces.filter((trace) => !trace.evidence.complete).map((trace) => trace.caseId);
  const requiredEvidence = input.traces.reduce((sum, trace) => sum + trace.evidence.required.length, 0);
  const collectedEvidence = input.traces.reduce((sum, trace) => sum
    + trace.evidence.required.filter((item) => trace.evidence.collected.includes(item)).length, 0);
  return {
    requirements: {
      total: facts.length,
      generated: generatedFactIds.length,
      executed: executedFactIds.length,
      verified: verifiedFactIds.length,
      untested: untestedFactIds.length,
      blocked: blockedFactIds.length,
      generatedCoverage: percent(generatedFactIds.length, facts.length),
      executedCoverage: percent(executedFactIds.length, facts.length),
      verifiedCoverage: percent(verifiedFactIds.length, facts.length),
      untestedFactIds,
      blockedFactIds,
    },
    cases: {
      generated: input.traces.length,
      executable: input.traces.filter((trace) => trace.executableTest.status === 'READY').length,
      executed: input.traces.filter((trace) => trace.execution.status === 'EXECUTED').length,
      verified: input.traces.filter((trace) => trace.result === 'PASS' || trace.result === 'FAIL').length,
      passed: input.traces.filter((trace) => trace.result === 'PASS').length,
      failed: input.traces.filter((trace) => trace.result === 'FAIL').length,
      blocked: input.traces.filter((trace) => trace.result === 'BLOCKED').length,
      notTested: input.traces.filter((trace) => trace.result === 'NOT_TESTED').length,
    },
    evidence: {
      required: requiredEvidence,
      collected: collectedEvidence,
      coverage: percent(collectedEvidence, requiredEvidence),
      completeCaseIds: complete,
      incompleteCaseIds: incomplete,
    },
  };
}
