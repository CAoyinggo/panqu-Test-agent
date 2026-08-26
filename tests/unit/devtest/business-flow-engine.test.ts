import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';
import { buildBusinessFlowGraph, buildBusinessLevelProblems, evaluateBusinessFlows,
  evaluateCrossCaseInvariants } from '../../../src/devtest/business-flow-engine.js';
import type { DevTestFeatureModel, DevTestInvariant } from '../../../src/devtest/types.js';

function apiCase(id: string, method: 'POST' | 'GET', url: string, testType: TestCase['testType'] = 'API'): TestCase {
  return {
    id, feature: '订单', name: `${method} ${url}`, priority: 'P0', testType, executionMode: 'EXECUTABLE', protocol: 'HTTP', tags: [],
    source: { requirementId: 'REQ', testPointId: `TP-${id}`, sourceType: 'REQUIREMENT', acceptanceCriteriaIds: [`AC-${id}`],
      apiOperationKey: `${method} ${url}` },
    steps: [{ type: 'HTTP_REQUEST', method, url }], assertions: [{ type: 'STATUS_CODE', expected: method === 'POST' ? 201 : 200 }],
    contractDependencies: [{ contractId: 'api.orders', version: 'v1', fingerprint: 'fp' }],
  } as TestCase;
}

function execution(testCase: TestCase, requestId: string | undefined, responseId: string, status: 'PASS' | 'FAIL' = 'PASS'): AcceptanceCaseExecutionResult {
  const operation = testCase.source!.apiOperationKey!.split(' ');
  return {
    caseId: testCase.id, name: testCase.name, feature: testCase.feature, priority: testCase.priority, tags: [], scene: 'api',
    timestamp: new Date().toISOString(), status, executed: true, processorInvoked: true, processor: 'ApiProcessor',
    pass: status === 'PASS', passRate: status === 'PASS' ? 1 : 0, assertions: 1,
    passedAssertions: status === 'PASS' ? 1 : 0, failedAssertions: status === 'FAIL' ? 1 : 0,
    classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE',
    attribution: { classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE', confidence: 'HIGH', reason: 'test', evidenceSources: ['TEST'] },
    evidence: { acceptanceCriteriaIds: [], request: { method: operation[0], url: requestId ? `http://local/api/orders/${requestId}` : 'http://local/api/orders',
      headers: {}, pathParams: requestId ? { id: requestId } : {}, query: {} },
    response: { status: operation[0] === 'POST' ? 201 : 200, headers: {}, body: { id: responseId } },
    assertions: [{ type: 'STATUS_CODE', expected: 200, actual: 200, pass: status === 'PASS', detail: status }],
    evidenceItems: [] },
  } as AcceptanceCaseExecutionResult;
}

const model = {
  feature: { id: 'orders', name: '订单' }, actors: [], roles: [], tenants: [], projects: [], resources: ['ORDER'],
  operations: [], apis: [], ui: [], states: [], inputs: [], outputs: [], permissions: [], sideEffects: [], billing: [],
  externalDependencies: [], constraints: [], unresolved: [],
} satisfies DevTestFeatureModel;

describe('DevTest Business Flow and consistency', () => {
  it('单接口全部 PASS，但前一步输出没有成为后一步输入时产生 FEATURE_BUG', async () => {
    const create = apiCase('CREATE', 'POST', '/api/orders');
    const detail = apiCase('DETAIL', 'GET', '/api/orders/{id}');
    const graph = buildBusinessFlowGraph({ featureModel: model, testCases: [create, detail], invariants: [], profiles: {
      CREATE: { caseId: 'CREATE', signature: 'create', informationScore: 3, core: true },
      DETAIL: { caseId: 'DETAIL', signature: 'detail', informationScore: 3, core: true },
    } });
    const evaluated = await evaluateBusinessFlows({ graph, testCases: [create, detail], invariants: [],
      results: [execution(create, undefined, 'created-1'), execution(detail, 'other-1', 'other-1')] });
    expect(evaluated.graph.flows[0]).toEqual(expect.objectContaining({ status: 'FAIL', failedStepId: expect.any(String) }));
    const problems = buildBusinessLevelProblems({ graph: evaluated.graph, invariants: [], consistency: evaluated.consistency,
      reproductionRun: false });
    expect(problems).toContainEqual(expect.objectContaining({ type: 'FEATURE_BUG', scope: 'FEATURE', judgement: 'LIKELY_BUG' }));
  });

  it('多个 Resource ID 无法证明是同一实体时保持 BLOCKED，不得生成 DATA_CONSISTENCY_BUG', async () => {
    const create = apiCase('CREATE', 'POST', '/api/orders', 'STATE');
    const invariant: DevTestInvariant = { id: 'INV-1', kind: 'STATE_TRANSITION', statement: '创建后数据存在', sourceFactIds: [],
      linkedCaseIds: ['CREATE'], requiredEvidence: ['RESPONSE', 'STATE'], status: 'DESIGNED' };
    const graph = buildBusinessFlowGraph({ featureModel: model, testCases: [create], invariants: [invariant], profiles: {
      CREATE: { caseId: 'CREATE', signature: 'create', informationScore: 3, core: true },
    } });
    const evaluated = await evaluateBusinessFlows({ graph, testCases: [create], invariants: [invariant],
      results: [execution(create, undefined, 'response-1')],
      stateObserver: async () => [{ caseId: 'CREATE', source: 'DATABASE', phase: 'AFTER', resourceId: 'db-2', exists: true }],
    });
    expect(evaluated.consistency.find((item) => item.caseId === 'CREATE')).toEqual(expect.objectContaining({
      status: 'BLOCKED',
      reason: expect.stringContaining('STATE_ENTITY_CORRELATION_MISSING'),
    }));
    expect(buildBusinessLevelProblems({ graph: evaluated.graph, invariants: [], consistency: evaluated.consistency,
      reproductionRun: false })).not.toContainEqual(expect.objectContaining({ type: 'DATA_CONSISTENCY_BUG' }));
  });

  it('State Observer 异常时保持 BLOCKED，不能把单一 Response 当作一致', async () => {
    const create = apiCase('CREATE', 'POST', '/api/orders', 'STATE');
    const invariant: DevTestInvariant = { id: 'INV-1', kind: 'STATE_TRANSITION', statement: '创建后数据存在', sourceFactIds: [],
      linkedCaseIds: ['CREATE'], requiredEvidence: ['RESPONSE', 'STATE'], status: 'DESIGNED' };
    const graph = buildBusinessFlowGraph({ featureModel: model, testCases: [create], invariants: [invariant], profiles: {
      CREATE: { caseId: 'CREATE', signature: 'create', informationScore: 3, core: true },
    } });
    const evaluated = await evaluateBusinessFlows({ graph, testCases: [create], invariants: [invariant],
      results: [execution(create, undefined, 'response-1')],
      stateObserver: async () => { throw new Error('database unavailable'); },
    });
    expect(evaluated.consistency).toContainEqual(expect.objectContaining({
      caseId: 'CREATE', status: 'BLOCKED', reason: 'STATE_OBSERVER_FAILED：database unavailable',
    }));
  });

  it('失败断言没有 Fact trace 时不得判定 Invariant violation', () => {
    const list = apiCase('LIST', 'GET', '/api/orders', 'DATA_ISOLATION');
    const detail = apiCase('DETAIL', 'GET', '/api/orders/{id}', 'PERMISSION');
    const invariant: DevTestInvariant = { id: 'INV-ISO', kind: 'ISOLATION', statement: '不能访问其他 Tenant', sourceFactIds: [],
      linkedCaseIds: ['LIST'], requiredEvidence: ['RESPONSE'], status: 'DESIGNED' };
    const evaluated = evaluateCrossCaseInvariants({ invariants: [invariant], testCases: [list, detail],
      results: [execution(list, undefined, 'a'), execution(detail, 'a', 'a', 'FAIL')], consistency: [] });
    expect(evaluated[0]).toEqual(expect.objectContaining({
      status: 'BLOCKED', entryPointCaseIds: ['LIST', 'DETAIL'], failedCaseIds: [], blockedCaseIds: ['LIST', 'DETAIL'],
    }));
    expect(buildBusinessLevelProblems({ graph: { flows: [], operationCount: 2, dependencies: [], coverage: 100 },
      invariants: evaluated, consistency: [], reproductionRun: false }))
      .not.toContainEqual(expect.objectContaining({ type: 'BUSINESS_RULE_BUG' }));
  });
});
