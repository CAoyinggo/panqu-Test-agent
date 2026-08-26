import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { buildExecutionEstimate, buildRegressionGuard, buildRegressionProblem, evaluateRegressionGuard } from '../../../src/devtest/acceptance-governance.js';
import type { DevTestBaselineSnapshot } from '../../../src/devtest/baseline.js';

function testCase(id: string, method: 'GET' | 'POST'): TestCase {
  return { id, feature: 'demo', name: id, priority: 'P0', testType: 'API', executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [],
    steps: [{ type: 'HTTP_REQUEST', method, url: '/api/items' }], assertions: [],
    contractDependencies: [{ contractId: 'api.items', version: 'v1', fingerprint: 'fp' }] } as TestCase;
}

function regressionGuardFixture() {
  const create = testCase('CREATE', 'POST');
  const detail = testCase('DETAIL', 'GET');
  const baseline: DevTestBaselineSnapshot = { runId: 'RUN-1', requirementHash: 'hash', cases: [],
    problems: [{ id: 'P001', signature: 'sig', affectedCases: ['CREATE'] }] };
  return buildRegressionGuard({ target: 'P001', baseline, testCases: [create, detail],
    graph: { operationCount: 2, coverage: 0, dependencies: [], flows: [{ id: 'FLOW-1', name: 'create → detail', core: true,
      acIds: [], invariantIds: [], status: 'NOT_EXECUTED', steps: [
        { id: 'S1', order: 1, name: 'create', operation: 'POST /api/items', caseIds: ['CREATE'], dependencies: [] },
        { id: 'S2', order: 2, name: 'detail', operation: 'GET /api/items/{id}', caseIds: ['DETAIL'], dependencies: [] },
      ] }] },
    invariants: [{ id: 'INV', kind: 'CUSTOM', statement: 'rule', sourceFactIds: [], linkedCaseIds: ['CREATE', 'DETAIL'],
      requiredEvidence: ['RESPONSE'], status: 'DESIGNED' }],
  });
}

describe('DevTest acceptance governance', () => {
  it('修复问题后扩展到同 Contract/Invariant/Flow，并把新失败判为 Regression', () => {
    const guard = regressionGuardFixture();
    expect(guard.selectedCaseIds).toEqual(['CREATE', 'DETAIL']);
    const evaluated = evaluateRegressionGuard(guard, [
      { caseId: 'CREATE', status: 'PASS', verified: true, evidenceComplete: true },
      { caseId: 'DETAIL', status: 'FAIL', verified: true, evidenceComplete: true },
    ]);
    expect(evaluated.status).toBe('FAIL');
    expect(buildRegressionProblem(evaluated)).toEqual(expect.objectContaining({ type: 'REGRESSION_BUG', judgement: 'CONFIRMED_BUG' }));
  });

  it.each([
    ['legacy PASS without verified', { caseId: 'CREATE', status: 'PASS' }],
    ['PASS with incomplete Evidence', { caseId: 'CREATE', status: 'PASS', verified: true, evidenceComplete: false }],
  ])('%s 不得使 Regression Guard 通过', (_name, rawPass) => {
    const evaluated = evaluateRegressionGuard(regressionGuardFixture(), [
      rawPass,
      { caseId: 'DETAIL', status: 'PASS', verified: true, evidenceComplete: true },
    ]);
    expect(evaluated.status).toBe('BLOCKED');
    expect(buildRegressionProblem(evaluated)).toBeUndefined();
  });

  it('Regression Guard 仅在所有 Case 都是 verified + Evidence complete PASS 时通过', () => {
    const evaluated = evaluateRegressionGuard(regressionGuardFixture(), [
      { caseId: 'CREATE', status: 'PASS', verified: true, evidenceComplete: true },
      { caseId: 'DETAIL', status: 'PASS', verified: true, evidenceComplete: true },
    ]);
    expect(evaluated.status).toBe('PASS');
  });

  it('输出 Case/Request/Runtime/Cost 估算并在超预算时阻断', () => {
    const estimate = buildExecutionEstimate({ testCases: [testCase('READ', 'GET'), testCase('WRITE', 'POST')],
      timeoutMs: 5_000, maxRuntimeMs: 600, budget: 0.001 });
    expect(estimate).toEqual(expect.objectContaining({ estimatedCases: 2, estimatedRequests: 2,
      estimatedRuntimeMs: 750, estimatedCost: 0.006 }));
    expect(estimate.exceeded).toEqual(['MAX_RUNTIME', 'BUDGET']);
  });
});
