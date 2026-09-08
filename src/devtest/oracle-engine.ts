import { isDeepStrictEqual } from 'node:util';

import type { TestCase, TestEvidenceRequirement } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { DevTestBaselineSnapshot } from './baseline.js';
import type {
  DevTestInvariant,
  DevTestEnvironmentSnapshot,
  DevTestOracleResult,
  DevTestStateConsistencyResult,
  DevTestUiExecutionResult,
} from './types.js';

function evidenceKey(item: Pick<TestEvidenceRequirement, 'id' | 'channel' | 'phase' | 'expectation'>): string {
  return item.id ?? `${item.channel}@${item.phase}:${item.expectation ?? 'PRESENT'}`;
}

function apiCollectedEvidence(input: {
  result: AcceptanceCaseExecutionResult;
  consistency?: DevTestStateConsistencyResult;
  snapshots: readonly DevTestEnvironmentSnapshot[];
  requirements: readonly TestEvidenceRequirement[];
}): { collected: Set<string>; semanticChecks: NonNullable<DevTestOracleResult['evidence']['semanticChecks']> } {
  const collected = new Set<string>();
  const semanticChecks: NonNullable<DevTestOracleResult['evidence']['semanticChecks']> = [];
  const observations = [...(input.consistency?.before ?? []), ...(input.consistency?.after ?? [])];
  const structured = (item: (typeof observations)[number]): boolean => typeof item.evidence !== 'string';
  const comparable = (item: (typeof observations)[number]): unknown => item.value
    ?? { resourceId: item.resourceId, state: item.state, exists: item.exists };
  const verifiedRuntimeEvidence = new Set((input.result.evidence.evidenceItems ?? [])
    .filter((item) => item.collected && item.verified)
    .map((item) => item.requirementId));
  for (const requirement of input.requirements) {
    const key = evidenceKey(requirement);
    if (requirement.id && verifiedRuntimeEvidence.has(requirement.id)) collected.add(key);
    if (requirement.channel === 'API_REQUEST' && input.result.evidence?.request) collected.add(key);
    else if (requirement.channel === 'API_RESPONSE' && input.result.evidence?.response) collected.add(key);
    else if (requirement.channel === 'DATABASE_STATE'
      && observations.some((item) => item.source !== 'RESPONSE' && item.phase === requirement.phase && structured(item))) {
      collected.add(key);
    } else if (requirement.channel === 'LOG'
      && observations.some((item) => item.source === 'AUDIT' && item.phase === requirement.phase && structured(item))) {
      collected.add(key);
    } else if (requirement.channel === 'STATE_CHANGE') {
      const before = input.consistency?.before.find((item) => item.source !== 'RESPONSE' && structured(item));
      const after = input.consistency?.after.find((item) => item.source !== 'RESPONSE' && structured(item)
        && (!before?.resourceId || !item.resourceId || before.resourceId === item.resourceId));
      if (before && after) {
        collected.add(key);
        const equal = isDeepStrictEqual(comparable(before), comparable(after));
        if (requirement.expectation === 'UNCHANGED' || requirement.expectation === 'CHANGED') semanticChecks.push({
          key,
          verdict: requirement.expectation === 'UNCHANGED' ? (equal ? 'PASS' : 'FAIL') : (!equal ? 'PASS' : 'FAIL'),
          reason: requirement.expectation === 'UNCHANGED'
            ? (equal ? 'Observer 前后状态保持不变' : 'Observer 发现本应不变的状态发生变化')
            : (!equal ? 'Observer 证明状态发生变化' : 'Observer 未观察到要求的状态变化'),
        });
        else semanticChecks.push({ key, verdict: input.consistency?.status === 'CONSISTENT' ? 'PASS' : 'BLOCKED',
          reason: input.consistency?.status === 'CONSISTENT' ? 'Response 与独立状态 Observer 一致' : '缺少可判定的跨源一致性' });
      }
    } else if (requirement.channel === 'DATA_DIFF') {
      const before = input.snapshots.find((item) => item.caseId === input.result.caseId && item.phase === 'BEFORE' && !item.error);
      const after = input.snapshots.find((item) => item.caseId === input.result.caseId && item.phase === 'AFTER_EXECUTE' && !item.error);
      if (before && after) {
        collected.add(key);
        const equal = before.fingerprint && after.fingerprint
          ? before.fingerprint === after.fingerprint : isDeepStrictEqual(before.value, after.value);
        if (requirement.expectation === 'UNCHANGED' || requirement.expectation === 'CHANGED') semanticChecks.push({
          key,
          verdict: requirement.expectation === 'UNCHANGED' ? (equal ? 'PASS' : 'FAIL') : (!equal ? 'PASS' : 'FAIL'),
          reason: requirement.expectation === 'UNCHANGED'
            ? (equal ? 'BEFORE 与 AFTER_EXECUTE 快照一致' : '失败/拒绝路径产生了状态变化')
            : (!equal ? 'BEFORE 与 AFTER_EXECUTE 快照证明状态变化' : '未观察到要求的数据变化'),
        });
        else semanticChecks.push({ key, verdict: 'BLOCKED', reason: 'DATA_DIFF 只有快照但没有可判定的 Expected Diff 规则' });
      }
    }
  }
  return { collected, semanticChecks };
}

function transientSignal(result: AcceptanceCaseExecutionResult): DevTestOracleResult['transientSignal'] | undefined {
  const text = `${result.error ?? ''} ${result.attribution?.reason ?? ''}`;
  const status = result.evidence?.response?.status;
  if (result.timedOut || /timeout|timed out/i.test(text)) return 'TIMEOUT';
  if (/slow.response|latency|duration.*(?:exceed|over)|响应过慢|延迟超/i.test(text)) return 'SLOW_RESPONSE';
  if (typeof status === 'number' && status >= 500) return 'HTTP_5XX';
  if (/browser|playwright|locator/i.test(text)) return 'BROWSER_ERROR';
  if (/ECONN|ENOTFOUND|fetch failed|network|environment/i.test(text)) return 'ENVIRONMENT';
  if (/auth|credential|token|401|403/i.test(text)) return 'AUTH';
  if (/fixture|test.data|data prep/i.test(text)) return 'TEST_DATA';
  if (/processor/i.test(text)) return 'PROCESSOR';
  const assertions = result.evidence?.assertions ?? [];
  if (result.executed && result.evidence?.response && assertions.some((item) => item.pass === false
    && item.actual === undefined)) return 'EMPTY_RESPONSE';
  return undefined;
}

/**
 * Deterministic Oracle. Every verdict is derived from canonical assertions and observed evidence;
 * no explanatory model output participates in PASS/FAIL.
 */
export function buildTestOracleResults(input: {
  testCases: readonly TestCase[];
  results: readonly AcceptanceCaseExecutionResult[];
  invariants: readonly DevTestInvariant[];
  consistency: readonly DevTestStateConsistencyResult[];
  uiResults?: readonly DevTestUiExecutionResult[];
  snapshots?: readonly DevTestEnvironmentSnapshot[];
  baseline?: DevTestBaselineSnapshot;
}): DevTestOracleResult[] {
  const caseById = new Map(input.testCases.map((item) => [item.id, item]));
  const consistencyByCase = new Map(input.consistency.map((item) => [item.caseId, item]));
  const baselineByCase = new Map((input.baseline?.cases ?? []).map((item) => [item.caseId, item]));
  const resultByCase = new Map(input.results.map((item) => [item.caseId, item]));
  const uiByCase = new Map((input.uiResults ?? []).map((item) => [item.caseId, item]));
  return [...new Set([...input.results.map((item) => item.caseId), ...(input.uiResults ?? []).map((item) => item.caseId)])].map((caseId) => {
    const result = resultByCase.get(caseId);
    const testCase = caseById.get(caseId);
    const ui = uiByCase.get(caseId);
    const expected = {
      requirement: testCase?.design?.expectedOutcome ? [testCase.design.expectedOutcome] : [],
      contract: (testCase?.contractDependencies ?? []).map((item) => `${item.contractId}@${item.version ?? 'unknown'}:${item.fingerprint ?? 'unknown'}`),
      invariants: input.invariants.filter((item) => item.linkedCaseIds.includes(caseId)).map((item) => item.statement),
      historicalBaseline: baselineByCase.get(caseId)?.status,
    };
    if (ui && testCase?.testType === 'UI') {
      const kinds = new Set(ui.evidence.map((item) => item.kind));
      const collected = new Set<string>();
      const oracleEvidenceIds = testCase.schemaVersion === 'TEST_CASE_V2'
        ? new Set(testCase.oracle?.evidenceRequirementIds ?? []) : undefined;
      const requirements = (testCase.evidenceRequirements ?? []).filter((item) => item.required
        && (!oracleEvidenceIds || Boolean(item.id && oracleEvidenceIds.has(item.id))));
      const required = requirements.map(evidenceKey);
      const uiEvidenceKey = (channel: TestEvidenceRequirement['channel']): string[] => requirements
        .filter((item) => item.channel === channel).map(evidenceKey);
      for (const key of uiEvidenceKey('UI_STATE')) if (kinds.has('PAGE') && kinds.has('DOM')) collected.add(key);
      for (const key of uiEvidenceKey('UI_SCREENSHOT')) if (kinds.has('SCREENSHOT')) collected.add(key);
      const missing = required.filter((item) => !collected.has(item));
      const requiredComplete = required.length > 0 && missing.length === 0;
      const evidence = {
        execution: ui.executed === true && ui.processorInvoked === true && ui.executionContractReady === true,
        assertion: ui.assertions.length > 0,
        // UI 没有 HTTP Response；PAGE/DOM 是 UI 协议的实际响应状态。
        response: kinds.has('PAGE') && kinds.has('DOM'),
        observedState: requiredComplete,
        complete: false,
        required, collected: [...collected], missing, semanticChecks: [],
      };
      evidence.complete = evidence.execution && evidence.assertion && evidence.response && evidence.observedState;
      if (ui.status === 'PASS' && ui.assertions.every((item) => item.pass)) return {
        caseId, verdict: evidence.complete ? 'PASS' : 'BLOCKED', expected, actual: ui.evidence, evidence,
        reason: evidence.complete
          ? 'UI deterministic assertions 与 Page/DOM/Screenshot Evidence 一致'
          : 'UI PASS 缺少 Processor、断言、Page/DOM 或 Screenshot Evidence',
      };
      if (ui.status === 'FAIL' && evidence.complete && ui.assertions.some((item) => !item.pass)) return {
        caseId, verdict: 'FAIL', expected, actual: ui.assertions.filter((item) => !item.pass), evidence,
        reason: '真实 Browser 执行且 UI Expected 与 Actual 明确不相等',
      };
      return {
        caseId, verdict: ui.status === 'BLOCKED' || ui.status === 'NOT_EXECUTED' ? 'BLOCKED' : 'UNKNOWN',
        expected, actual: ui.error ?? ui.evidence, evidence,
        transientSignal: /browser|playwright|navigation|environment/i.test(ui.error ?? '') ? 'BROWSER_ERROR' : undefined,
        reason: `${ui.error ?? ui.status}：UI 未形成完整可判定 Evidence`,
      };
    }
    if (!result) return {
      caseId, verdict: 'BLOCKED', expected, actual: undefined,
      evidence: { execution: false, assertion: false, response: false, observedState: false, complete: false },
      reason: 'NOT_EXECUTED：Case 没有 Runner 结果',
    };
    const oracleAssertionIds = testCase?.schemaVersion === 'TEST_CASE_V2'
      ? new Set(testCase.oracle?.assertionIds ?? []) : undefined;
    const assertions = (result.evidence?.assertions ?? []).filter((assertion) => !oracleAssertionIds
      || Boolean(assertion.assertionId && oracleAssertionIds.has(assertion.assertionId)));
    const observedAssertionIds = assertions.map((assertion) => assertion.assertionId)
      .filter((id): id is string => Boolean(id));
    const assertionsComplete = !oracleAssertionIds || (oracleAssertionIds.size === observedAssertionIds.length
      && new Set(observedAssertionIds).size === observedAssertionIds.length
      && [...oracleAssertionIds].every((id) => observedAssertionIds.includes(id)));
    const relatedInvariants = input.invariants.filter((item) => item.linkedCaseIds.includes(result.caseId));
    const consistency = consistencyByCase.get(result.caseId);
    const oracleEvidenceIds = testCase?.schemaVersion === 'TEST_CASE_V2'
      ? new Set(testCase.oracle?.evidenceRequirementIds ?? []) : undefined;
    const requirements = (testCase?.evidenceRequirements ?? []).filter((item) => item.required
      && (!oracleEvidenceIds || Boolean(item.id && oracleEvidenceIds.has(item.id))));
    const required = requirements.map(evidenceKey);
    const evidenceResult = apiCollectedEvidence({ result, consistency, snapshots: input.snapshots ?? [], requirements });
    const missing = required.filter((item) => !evidenceResult.collected.has(item));
    const semanticBlocked = evidenceResult.semanticChecks.some((item) => item.verdict === 'BLOCKED');
    const requiredComplete = required.length > 0 && missing.length === 0 && !semanticBlocked;
    const evidence = {
      execution: result.executed === true && result.processorInvoked === true,
      assertion: assertions.length > 0 && assertionsComplete,
      response: result.evidence?.response !== undefined,
      observedState: requiredComplete && consistency?.status !== 'BLOCKED',
      complete: false,
      required, collected: [...evidenceResult.collected], missing, semanticChecks: evidenceResult.semanticChecks,
    };
    evidence.complete = evidence.execution && evidence.assertion && evidence.response && evidence.observedState;
    expected.invariants = relatedInvariants.map((item) => item.statement);
    const transient = transientSignal(result);
    // A completed HTTP exchange can still be non-attributable. In particular,
    // a 5xx response is observed evidence, but it does not by itself prove a
    // product defect. Keep that distinction even if an inner execution layer
    // used BLOCKED while assembling its runtime Oracle.
    if (transient && result.executed === true && result.evidence?.response !== undefined) return {
      caseId: result.caseId, verdict: 'UNKNOWN', expected, actual: result.evidence.response,
      evidence, transientSignal: transient,
      reason: `${transient} 需要先排除 Environment/Contract/Auth/Test Data/Processor，不能直接判产品 Bug`,
    };
    if (['BLOCKED', 'NOT_EXECUTED', 'CANCELLED', 'TIMEOUT'].includes(result.status ?? '')) return {
      caseId: result.caseId, verdict: result.status === 'TIMEOUT' ? 'UNKNOWN' : 'BLOCKED', expected,
      actual: result.evidence?.response ?? result.error, evidence, transientSignal: transient,
      reason: `${transient ?? result.status}：没有形成可用于产品归因的完整 Expected/Actual Evidence`,
    };
    if (transient) return {
      caseId: result.caseId, verdict: 'UNKNOWN', expected, actual: result.evidence?.response ?? result.error,
      evidence, transientSignal: transient,
      reason: `${transient} 需要先排除 Environment/Contract/Auth/Test Data/Processor，不能直接判产品 Bug`,
    };
    const semanticMismatch = evidenceResult.semanticChecks.find((item) => item.verdict === 'FAIL');
    if (semanticMismatch && evidence.execution && evidence.assertion && evidence.response && missing.length === 0) return {
      caseId: result.caseId, verdict: 'FAIL', expected, actual: semanticMismatch,
      evidence: { ...evidence, complete: true }, reason: semanticMismatch.reason,
    };
    if (consistency?.status === 'INCONSISTENT' && evidence.execution && evidence.assertion
      && evidence.response && requiredComplete) return {
      caseId: result.caseId, verdict: 'FAIL', expected, actual: consistency.after, evidence: { ...evidence, complete: true },
      reason: consistency.reason ?? 'Observed State 与 Response 不一致',
    };
    if (result.status === 'PASS' && assertions.every((item) => item.pass)) return {
      caseId: result.caseId, verdict: evidence.complete ? 'PASS' : 'BLOCKED', expected,
      actual: result.evidence?.response, evidence,
      reason: evidence.complete ? 'Canonical Assertion 与 Observed Evidence 一致' : 'PASS 缺少完整执行/断言/Evidence',
    };
    const mismatches = assertions.filter((item) => item.pass === false);
    if (result.status === 'FAIL' && evidence.complete && mismatches.length) return {
      caseId: result.caseId, verdict: 'FAIL', expected, actual: mismatches.map((item) => ({ actual: item.actual, detail: item.detail })),
      evidence, reason: '真实执行且 canonical Expected 与 Actual 明确不相等',
    };
    return { caseId: result.caseId, verdict: 'UNKNOWN', expected, actual: result.evidence?.response ?? result.error,
      evidence, reason: 'Expected/Actual/Evidence 不完整，保持 UNKNOWN' };
  });
}
