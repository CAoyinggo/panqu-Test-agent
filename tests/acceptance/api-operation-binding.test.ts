import { describe, expect, it } from 'vitest';
import type { TestStep } from '../../src/agents/test-design/testcase-schema.js';
import { validateApiBindingGate } from '../../src/acceptance/api-binding-gate.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';

type GeneratedPoint = ReturnType<typeof generateTestPoints>[number];

function pointForCriterion(
  points: ReturnType<typeof generateTestPoints>,
  criterionId: string,
  predicate: (point: GeneratedPoint) => boolean = () => true,
): GeneratedPoint {
  const point = points.find((candidate) => candidate.acceptanceCriteriaIds.includes(criterionId) && predicate(candidate));
  expect(point, `missing TestPoint for ${criterionId}`).toBeDefined();
  return point!;
}

function caseForPoint(
  cases: ReturnType<typeof generateAcceptanceApiCases>,
  point: GeneratedPoint,
) {
  const testCase = cases.find((candidate) => candidate.source?.objectiveIds?.includes(point.objectiveId));
  expect(testCase, `missing TestCase for ${point.objectiveId}`).toBeDefined();
  return testCase!;
}

describe('ApiOperationBinding policy', () => {
  it('binds a single API deterministically', () => {
    const requirement = parseAcceptanceRequirement('# One\nPUT /items/{itemId}\n返回 200\nAC-1 更新成功返回 200');
    const point = pointForCriterion(generateTestPoints(requirement), 'AC-1');
    expect(point.apiBinding).toMatchObject({
      apiSpecId: requirement.apis[0].id,
      method: 'PUT',
      path: '/items/{itemId}',
      strategy: 'SINGLE_API',
    });
    expect(point.bindingIssue).toBeUndefined();
  });

  it('does not let the single-API shortcut override an explicit mismatched operation', () => {
    const requirement = parseAcceptanceRequirement('# One\nGET /items/{itemId}\n返回 200\nAC-1 DELETE /items/{itemId} 删除成功返回 204');
    const point = pointForCriterion(generateTestPoints(requirement), 'AC-1');
    expect(point.apiBinding).toBeUndefined();
    expect(point.bindingIssue).toMatchObject({ code: 'API_NOT_FOUND', blocking: true });
  });

  it('binds multiple APIs only by explicit Method + Path', () => {
    const requirement = parseAcceptanceRequirement(`# Multi
POST /echo/{resourceKey}
GET /status/404
AC-1 POST /echo/{resourceKey} 创建成功返回 200
    AC-2 GET /status/404 查询不存在返回 404`);
    const points = generateTestPoints(requirement);
    const create = pointForCriterion(points, 'AC-1');
    const missing = pointForCriterion(points, 'AC-2');
    expect(create.apiBinding).toMatchObject({ operationKey: 'POST /echo/{resourceKey}', strategy: 'EXACT_METHOD_PATH' });
    expect(missing.apiBinding).toMatchObject({ operationKey: 'GET /status/404', strategy: 'EXACT_METHOD_PATH' });
  });

  it('blocks ambiguous and missing operations instead of selecting the first API', () => {
    const ambiguous = parseAcceptanceRequirement('# Multi\nGET /users/{id}\nGET /users/{id}/status\nAC-1 查询用户状态返回 200');
    const ambiguousPoint = pointForCriterion(generateTestPoints(ambiguous), 'AC-1', (point) => point.dimension === 'API');
    expect(ambiguousPoint.apiBinding).toBeUndefined();
    expect(ambiguousPoint.bindingIssue).toMatchObject({ code: 'BINDING_AMBIGUOUS', blocking: true });

    const missing = parseAcceptanceRequirement('# Multi\nGET /users/{id}\nGET /users/{id}/status\nAC-1 DELETE /users/{id} 删除成功返回 204');
    const missingPoint = pointForCriterion(generateTestPoints(missing), 'AC-1', (point) => point.dimension === 'API');
    expect(missingPoint.apiBinding).toBeUndefined();
    expect(missingPoint.bindingIssue).toMatchObject({ code: 'API_NOT_FOUND', blocking: true });
  });
});

describe('API Binding Gate', () => {
  function generatedGet() {
    const requirement = parseAcceptanceRequirement(`# Query
GET /echo/{resourceKey}
无需认证
| name | type | location | required | default |
| --- | --- | --- | --- | --- |
| resourceKey | string | path | yes | resource-a |
| mode | string | query | yes | contract |
| X-Client | string | header | yes | acceptance |
## Response
返回 200
    ## Acceptance Criteria
    AC-1 GET /echo/{resourceKey} 查询成功返回 200`);
    const points = generateTestPoints(requirement);
    const point = pointForCriterion(points, 'AC-1');
    const testCase = caseForPoint(generateAcceptanceApiCases(requirement, points), point);
    return { requirement, testCase, step: testCase.steps[0] };
  }

  it('validates Path/Query/Header propagation and GET no-body policy', () => {
    const { requirement, testCase, step } = generatedGet();
    expect(step).toMatchObject({
      method: 'GET', url: '/echo/{resourceKey}',
      pathParams: { resourceKey: 'resource-a' },
      query: { mode: 'contract' }, headers: { 'X-Client': 'acceptance' },
    });
    expect(step).not.toHaveProperty('body');
    expect(validateApiBindingGate(testCase, step, requirement.apis, step.headers ?? {})).toMatchObject({ valid: true });
  });

  it.each([
    ['method/path mismatch', (step: TestStep) => ({ ...step, method: 'POST' as const }), 'BINDING_MISMATCH'],
    ['path missing', (step: TestStep) => ({ ...step, pathParams: {} }), 'PATH_PARAMETER_MISSING'],
    ['query missing', (step: TestStep) => ({ ...step, query: {} }), 'QUERY_PARAMETER_MISSING'],
    ['header missing', (step: TestStep) => ({ ...step, headers: {} }), 'HEADER_MISSING'],
    ['GET body', (step: TestStep) => ({ ...step, body: {} }), 'BODY_MISMATCH'],
  ])('blocks %s before execution', (_name, mutate, expectedCode) => {
    const { requirement, testCase, step } = generatedGet();
    const changed = mutate(step);
    expect(validateApiBindingGate(testCase, changed, requirement.apis, changed.headers ?? {})).toMatchObject({
      valid: false, code: expectedCode,
    });
  });

  it('blocks a Body Schema mismatch unless the Case declares an explicit negative contract intent', () => {
    const requirement = parseAcceptanceRequirement(`# Create
POST /items
无需认证
| name | type | location | required |
| --- | --- | --- | --- |
| name | string | body | yes |
    ## Response
    返回 200 和 400
    AC-1 创建成功返回 200`);
    const points = generateTestPoints(requirement);
    const point = pointForCriterion(points, 'AC-1');
    const testCase = caseForPoint(generateAcceptanceApiCases(requirement, points), point);
    const changed = { ...testCase.steps[0], body: { name: 123 } };

    expect(validateApiBindingGate(testCase, changed, requirement.apis, {})).toMatchObject({ valid: false, code: 'BODY_MISMATCH' });
    expect(validateApiBindingGate(
      { ...testCase, negativeContractIntent: { invalidBodyFields: ['name'] } },
      changed,
      requirement.apis,
      {},
    )).toMatchObject({ valid: true });
  });
});
