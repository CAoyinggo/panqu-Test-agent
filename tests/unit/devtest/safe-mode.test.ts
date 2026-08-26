import { describe, expect, it } from 'vitest';
import type { ApiSpec } from '../../../src/acceptance/requirement-ir.js';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import { ApiProcessor, type AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';
import {
  SafeMutationHoldProcessor,
  buildOperationPolicies,
  caseHttpMethod,
  isMutatingMethod,
} from '../../../src/devtest/safe-mode.js';

function apiOf(method: ApiSpec['method'], path: string): ApiSpec {
  return {
    id: `api-${method}-${path}`,
    operationKey: `${method} ${path}`,
    authPolicy: 'AUTH_REQUIRED',
    method,
    path,
    headers: [], query: [], pathParams: [], body: [], responses: [],
  };
}

function httpCase(id: string, method: TestCase['steps'][number]['method']): TestCase {
  return {
    id,
    feature: 'devtest',
    name: `${method} 用例`,
    priority: 'P0',
    testType: 'API',
    executionMode: 'EXECUTABLE',
    protocol: 'HTTP',
    steps: [{ type: 'HTTP_REQUEST', method, url: '/api/things' }],
  } as unknown as TestCase;
}

class SpyProcessor extends ApiProcessor {
  readonly invoked: string[] = [];
  override async execute(testCase: TestCase): Promise<AcceptanceCaseExecutionResult> {
    this.invoked.push(testCase.id);
    return heldMutationResultForPassThrough(testCase);
  }
}

function heldMutationResultForPassThrough(testCase: TestCase): AcceptanceCaseExecutionResult {
  return {
    caseId: testCase.id,
    name: testCase.name,
    pass: true,
    passRate: 1,
    executed: true,
    status: 'PASS',
    classification: 'SUCCESS',
    attribution: { classification: 'SUCCESS', confidence: 'HIGH', reason: 'spy', evidenceSources: ['SPY'] },
    evidence: { acceptanceCriteriaIds: [], assertions: [], evidenceItems: [] },
  };
}

describe('DevTest SAFE 模式写保护', () => {
  it('operationPolicies 由 Method 确定性映射：GET/HEAD/OPTIONS→READ，DELETE→DELETE，POST/PUT/PATCH→WRITE', () => {
    const policies = buildOperationPolicies([
      apiOf('GET', '/a'), apiOf('HEAD', '/b'), apiOf('OPTIONS', '/c'),
      apiOf('POST', '/d'), apiOf('PUT', '/e'), apiOf('PATCH', '/f'), apiOf('DELETE', '/g'),
    ]);
    expect(policies['GET /a']?.effect).toBe('READ');
    expect(policies['HEAD /b']?.effect).toBe('READ');
    expect(policies['OPTIONS /c']?.effect).toBe('READ');
    expect(policies['POST /d']?.effect).toBe('WRITE');
    expect(policies['PUT /e']?.effect).toBe('WRITE');
    expect(policies['PATCH /f']?.effect).toBe('WRITE');
    expect(policies['DELETE /g']?.effect).toBe('DELETE');
  });

  it('扣费/Provider/消息类 Operation 按高风险副作用分类', () => {
    const policies = buildOperationPolicies([
      apiOf('POST', '/api/billing/charge'),
      apiOf('POST', '/api/notifications/send'),
    ]);
    expect(policies['POST /api/billing/charge']?.effect).toBe('BILLABLE');
    expect(policies['POST /api/notifications/send']?.effect).toBe('EXTERNAL_SIDE_EFFECT');
  });

  it('高成本语义无法唯一绑定 Operation 时对普通 Mutation 保守阻断', () => {
    expect(buildOperationPolicies([apiOf('POST', '/api/tasks')], 'estimatedCost=240，会产生真实扣费')['POST /api/tasks']?.effect)
      .toBe('BILLABLE');
    expect(buildOperationPolicies([apiOf('POST', '/api/tasks')], '任务会调用第三方 Provider 生成')['POST /api/tasks']?.effect)
      .toBe('EXTERNAL_SIDE_EFFECT');
    expect(buildOperationPolicies([apiOf('GET', '/api/tasks')], 'estimatedCost=240')['GET /api/tasks']?.effect)
      .toBe('READ');
  });

  it('SAFE 模式挂起写路径且绝不触碰内层处理器；只读路径正常委托', async () => {
    const spy = new SpyProcessor();
    const guard = new SafeMutationHoldProcessor({ confirmMutations: false, inner: spy });

    const post = await guard.execute(httpCase('C-POST', 'POST'), { baseUrl: 'http://127.0.0.1:9' });
    const del = await guard.execute(httpCase('C-DEL', 'DELETE'), { baseUrl: 'http://127.0.0.1:9' });
    const get = await guard.execute(httpCase('C-GET', 'GET'), { baseUrl: 'http://127.0.0.1:9' });

    expect(post.status).toBe('BLOCKED');
    expect(post.executed).toBe(false);
    expect(post.processorInvoked).toBe(false);
    expect(post.attribution.reason).toContain('SAFE_MODE_MUTATION_HOLD');
    expect(del.status).toBe('BLOCKED');
    expect(get.status).toBe('PASS');
    expect(spy.invoked).toEqual(['C-GET']);
  });

  it('confirmMutations=true 时写路径放行给内层处理器', async () => {
    const spy = new SpyProcessor();
    const guard = new SafeMutationHoldProcessor({ confirmMutations: true, inner: spy });
    const result = await guard.execute(httpCase('C-POST', 'POST'), { baseUrl: 'http://127.0.0.1:9' });
    expect(result.status).toBe('PASS');
    expect(spy.invoked).toEqual(['C-POST']);
  });

  it('显式非法且具有拒绝断言的 Mutation 在 SAFE 中仍必须阻断', async () => {
    const spy = new SpyProcessor();
    const guard = new SafeMutationHoldProcessor({ confirmMutations: false, inner: spy });
    const negative = httpCase('C-NEGATIVE', 'POST');
    negative.expected = { status: '400' };
    negative.assertions = [{ type: 'STATUS_CODE', expected: 400 }];
    negative.negativeContractIntent = { omittedBodyFields: ['name'] };
    const result = await guard.execute(negative, { baseUrl: 'http://127.0.0.1:9' });
    expect(result.status).toBe('BLOCKED');
    expect(result.executed).toBe(false);
    expect(result.processorInvoked).toBe(false);
    expect(result.attribution.reason).toContain('SAFE_MODE_MUTATION_HOLD');
    expect(spy.invoked).toEqual([]);
  });

  it('工具函数：isMutatingMethod 与 caseHttpMethod', () => {
    expect(isMutatingMethod('POST')).toBe(true);
    expect(isMutatingMethod('delete')).toBe(true);
    expect(isMutatingMethod('GET')).toBe(false);
    expect(isMutatingMethod(undefined)).toBe(false);
    expect(caseHttpMethod(httpCase('X', 'PUT') as TestCase)).toBe('PUT');
    const noHttp = { steps: [] } as unknown as TestCase;
    expect(caseHttpMethod(noHttp)).toBeUndefined();
  });
});
