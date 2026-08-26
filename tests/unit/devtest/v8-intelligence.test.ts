import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';
import type { DevTestBaselineSnapshot } from '../../../src/devtest/baseline.js';
import { adaptiveScore, buildNegativeIntelligence } from '../../../src/devtest/test-intelligence.js';
import { buildTestOracleResults } from '../../../src/devtest/oracle-engine.js';
import { buildTestReliability } from '../../../src/devtest/reliability-engine.js';
import { buildPollutionProblems, detectTestPollution } from '../../../src/devtest/pollution-engine.js';
import { selectDevTestCases } from '../../../src/devtest/dimension-selector.js';

function testCase(): TestCase {
  return {
    id: 'CASE-1', feature: '提交任务', name: 'POST /submit', priority: 'P1', testType: 'API', executionMode: 'EXECUTABLE',
    protocol: 'HTTP', tags: ['submit'], source: { requirementId: 'REQ', testPointId: 'TP', acceptanceCriteriaIds: ['AC-1'],
      apiOperationKey: 'POST /submit' }, steps: [{ type: 'HTTP_REQUEST', method: 'POST', url: '/submit', body: { name: 'x' } }],
    assertions: [{ type: 'STATUS_CODE', expected: 201 }], expected: { status: '201' },
    evidenceRequirements: [
      { channel: 'API_REQUEST', phase: 'DURING', required: true, description: '记录真实请求', factIds: ['FACT'] },
      { channel: 'API_RESPONSE', phase: 'AFTER', required: true, description: '记录真实响应', factIds: ['FACT'] },
    ],
    design: { objectiveIds: ['OBJ'], factIds: ['FACT'], sourceType: 'REQUIREMENT', expectedOutcome: '返回 201',
      actions: ['POST /submit'], executability: 'EXECUTABLE' },
    contractDependencies: [{ contractId: 'api.submit', version: 'v1', fingerprint: 'fp' }],
  } as TestCase;
}

function result(statusCode: number, status: 'PASS' | 'FAIL', error?: string): AcceptanceCaseExecutionResult {
  return {
    caseId: 'CASE-1', name: 'submit', feature: 'submit', priority: 'P1', tags: [], scene: 'api', timestamp: new Date().toISOString(),
    status, executed: true, processorInvoked: true, processor: 'ApiProcessor', pass: status === 'PASS', passRate: status === 'PASS' ? 1 : 0,
    assertions: 1, passedAssertions: status === 'PASS' ? 1 : 0, failedAssertions: status === 'FAIL' ? 1 : 0,
    classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE', error,
    attribution: { classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE', confidence: 'HIGH', reason: error ?? status, evidenceSources: ['HTTP'] },
    evidence: { acceptanceCriteriaIds: ['AC-1'], request: { method: 'POST', url: 'http://local/submit', headers: {}, pathParams: {}, query: {}, body: { name: 'x' } },
      response: { status: statusCode, headers: {}, body: statusCode >= 500 ? { error: 'upstream' } : { id: '1' } },
      assertions: [{ type: 'STATUS_CODE', expected: 201, actual: statusCode, pass: status === 'PASS', detail: `expected=201 actual=${statusCode}` }],
      evidenceItems: [] },
  } as AcceptanceCaseExecutionResult;
}

describe('DevTest v8 intelligence', () => {
  it('deterministic Oracle separates explicit mismatch from HTTP 500 uncertainty', () => {
    const explicit = buildTestOracleResults({ testCases: [testCase()], results: [result(400, 'FAIL')], invariants: [], consistency: [] });
    const transient = buildTestOracleResults({ testCases: [testCase()], results: [result(500, 'FAIL')], invariants: [], consistency: [] });
    expect(explicit[0]).toEqual(expect.objectContaining({ verdict: 'FAIL' }));
    expect(explicit[0].transientSignal).toBeUndefined();
    expect(transient[0]).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', transientSignal: 'HTTP_5XX' }));
  });

  it.each([
    {
      name: 'changed snapshot',
      after: { resource: { owner: 'tenant-b' } },
      afterFingerprint: 'after-changed',
      verdict: 'FAIL' as const,
    },
    {
      name: 'unchanged snapshot',
      after: { resource: { owner: 'tenant-a' } },
      afterFingerprint: 'before',
      verdict: 'PASS' as const,
    },
  ])('uses DATA_DIFF UNCHANGED as a deterministic Oracle for $name', ({ after, afterFingerprint, verdict }) => {
    const rejected = testCase();
    rejected.expected = { status: '403' };
    rejected.assertions = [{ type: 'STATUS_CODE', expected: 403, factIds: ['FACT'] }];
    rejected.evidenceRequirements = [
      ...(rejected.evidenceRequirements ?? []),
      {
        channel: 'DATA_DIFF', phase: 'AFTER', expectation: 'UNCHANGED', required: true,
        description: '403 后资源必须保持不变', factIds: ['FACT'],
      },
    ];
    const rejectedResult = result(403, 'PASS');
    rejectedResult.evidence.assertions = [{
      type: 'STATUS_CODE', expected: 403, actual: 403, pass: true, detail: 'expected=403 actual=403', factIds: ['FACT'],
    }];

    const oracle = buildTestOracleResults({
      testCases: [rejected], results: [rejectedResult], invariants: [], consistency: [],
      snapshots: [
        { caseId: 'CASE-1', phase: 'BEFORE', value: { resource: { owner: 'tenant-a' } }, fingerprint: 'before', capturedAt: 'before' },
        { caseId: 'CASE-1', phase: 'AFTER_EXECUTE', value: after, fingerprint: afterFingerprint, capturedAt: 'after' },
      ],
    });

    expect(oracle[0]).toEqual(expect.objectContaining({ verdict }));
    expect(oracle[0].evidence.semanticChecks).toContainEqual(expect.objectContaining({
      key: 'DATA_DIFF@AFTER:UNCHANGED', verdict,
    }));
  });

  it('alternating historical outcomes become FLAKY and feed adaptive priority', () => {
    const baseline: DevTestBaselineSnapshot = { runId: 'RUN-2', requirementHash: 'hash', problems: [{ id: 'P001', signature: 's',
      affectedCases: ['CASE-1'], failureClass: 'PRODUCT_BUG' }], regressionCaseIds: ['CASE-1'], cases: [{ caseId: 'CASE-1', status: 'PASS', history: [
        { runId: 'RUN-1', status: 'PASS', durationMs: 10, at: '2026-01-01T00:00:00Z' },
        { runId: 'RUN-2', status: 'FAIL', durationMs: 30, at: '2026-01-02T00:00:00Z' },
      ] }] };
    const reliability = buildTestReliability({ baseline, results: [result(201, 'PASS')] });
    expect(reliability.cases[0]).toEqual(expect.objectContaining({ status: 'FLAKY', runs: 3, avgDurationMs: 13 }));
    expect(adaptiveScore({ testCase: testCase(), baseline, changedCaseIds: ['CASE-1'], contractDrift: true }))
      .toEqual(expect.objectContaining({ historicalFailures: 1, bugDensity: 1, codeChangeFrequency: 1, contractDrift: 1, recentRegression: 1 }));
  });

  it('failed request with billing mutation is likely on first sight and confirmed only after reproduction', () => {
    const rejected = testCase();
    rejected.expected = { status: '400' };
    const rejectedResult = result(400, 'PASS');
    const findings = detectTestPollution({ testCases: [rejected], results: [rejectedResult],
      graph: { flows: [], operationCount: 1, dependencies: [], coverage: 100 }, cleanupConfigured: false,
      snapshots: [
        { caseId: 'CASE-1', phase: 'BEFORE', value: { billing: 100 }, fingerprint: 'a', capturedAt: 'before' },
        { caseId: 'CASE-1', phase: 'AFTER_EXECUTE', value: { billing: 90 }, fingerprint: 'b', capturedAt: 'after-execute' },
        { caseId: 'CASE-1', phase: 'AFTER_CLEANUP', value: { billing: 100 }, fingerprint: 'a', capturedAt: 'after-cleanup' },
      ] });
    expect(findings).toContainEqual(expect.objectContaining({ classification: 'UNEXPECTED_SIDE_EFFECT', severity: 'CRITICAL' }));
    expect(buildPollutionProblems(findings)).toContainEqual(expect.objectContaining({
      type: 'DATA_CONSISTENCY_BUG', judgement: 'LIKELY_BUG', failureClass: 'PRODUCT_BUG', reproducible: false,
    }));
    expect(buildPollutionProblems(findings, { reproductionRun: true })).toContainEqual(expect.objectContaining({
      type: 'DATA_CONSISTENCY_BUG', judgement: 'CONFIRMED_BUG', failureClass: 'PRODUCT_BUG', reproducible: true,
    }));
  });

  it('idempotency/concurrency risks are selected only for relevant mutation and stay BLOCKED without safe observers', () => {
    const checks = buildNegativeIntelligence({ requirementText: '创建任务并提交，重复请求只能创建一个任务',
      testCases: [testCase()], mutationSafe: false, observerAvailable: false });
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'DUPLICATE_REQUEST', status: 'BLOCKED' }),
      expect.objectContaining({ kind: 'CONCURRENT_REQUEST', status: 'BLOCKED' }),
    ]));
    expect(checks.find((item) => item.kind === 'CROSS_TENANT')?.status).toBe('NOT_APPLICABLE');
  });

  it('default runs Tier 0 + Tier 1 and --deep opts into Tier 2 boundary cases', () => {
    const core = testCase();
    core.id = 'CORE';
    core.priority = 'P0';
    const boundary = testCase();
    boundary.id = 'BOUNDARY';
    boundary.priority = 'P2';
    boundary.testType = 'BOUNDARY';
    boundary.name = '低频极值边界';
    expect(selectDevTestCases([core, boundary], { maxCases: 10 }).selected.map((item) => item.id)).toEqual(['CORE']);
    expect(selectDevTestCases([core, boundary], { maxCases: 10, deep: true }).selected.map((item) => item.id)).toContain('BOUNDARY');
  });
});
