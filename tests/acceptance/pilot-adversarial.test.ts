import { describe, expect, it, vi } from 'vitest';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { runAcceptanceApiCases } from '../../src/acceptance/api-processor.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';

describe('Controlled-pilot adversarial contracts', () => {
  it('keeps Operation Identity stable across insertion, deletion, ordering and description edits', () => {
    const original = parseAcceptanceRequirement(`# APIs
POST /users
GET /users/{id}
AC-1 POST /users 创建成功返回 201
AC-2 GET /users/{id} 查询成功返回 200`);
    const changed = parseAcceptanceRequirement(`# APIs
POST /health
GET /users/{id}
获取用户详情的描述已修改
POST /users
AC-1 POST /users 创建成功返回 201
AC-2 GET /users/{id} 查询成功返回 200`);
    const originalIds = Object.fromEntries(original.apis.map((api) => [api.operationKey, api.id]));
    const changedIds = Object.fromEntries(changed.apis.map((api) => [api.operationKey, api.id]));

    expect(changedIds['POST /users']).toBe(originalIds['POST /users']);
    expect(changedIds['GET /users/{id}']).toBe(originalIds['GET /users/{id}']);
    expect(original.apis.every((api) => api.id.startsWith('API-'))).toBe(true);
  });

  it('makes exact Method + Path limitations visible instead of silently merging duplicate or alternate templates', () => {
    const requirement = parseAcceptanceRequirement(`# Identity
GET /users/{id}
GET /users/{id}
GET /users/:id
GET /users/{userId}
AC-1 GET /users/{id} 返回 200`);

    expect(requirement.apis.map((api) => api.operationKey)).toEqual([
      'GET /users/{id}', 'GET /users/:id', 'GET /users/{userId}',
    ]);
    expect(requirement.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_API_OPERATION' }),
    ]));
  });

  it('blocks recognizable but unparsed Header, Query, Auth, Response and isolation contracts before data preparation', async () => {
    const lifecycle = { prepare: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn<typeof fetch>();
    const markdown = `# Silent omission challenge
GET /users/{id}
返回 200
Header X-Tenant is mandatory
查询参数 page 必填且为整数
接口必须使用 Bearer Token 鉴权
响应必须返回 data.tenantId 字段
The response must be scoped to the caller organization.
AC-1 GET /users/{id} 查询成功返回 200`;
    const requirement = parseAcceptanceRequirement(markdown);
    const warningCodes = requirement.warnings.filter((warning) => warning.blocking).map((warning) => warning.code);
    expect(warningCodes).toEqual(expect.arrayContaining([
      'UNPARSED_CONTRACT_HINT', 'AUTH_CONTRACT_UNRESOLVED', 'UNPARSED_RESPONSE_CONTRACT', 'UNMAPPED_REQUIREMENT_RULE',
    ]));

    const execution = await runAcceptancePipeline({
      markdown, project: 'adversarial', baseUrl: 'http://127.0.0.1:1', lifecycle,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['GET /users/{id}']),
      processor: { name: 'api', supportedScenes: ['api'], supportedMethods: ['GET'], supports: () => true, execute: fetchImpl } as never,
    });
    expect(execution.report.conclusion).toBe('BLOCKED');
    expect(execution.results.every((result) => result.executed === false
      && ['BLOCKED', 'NOT_EXECUTED'].includes(result.status ?? ''))).toBe(true);
    expect(execution.results.some((result) => result.status === 'PASS')).toBe(false);
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('distinguishes public, required and unknown authentication contracts', () => {
    const publicApi = parseAcceptanceRequirement('# Public\nGET /health\n该接口无需认证\n返回 200\nAC-1 返回 200');
    const protectedApi = parseAcceptanceRequirement(`# Protected
GET /profile
| name | type | location | required |
| --- | --- | --- | --- |
| Authorization | string | header | yes |
返回 200
AC-1 返回 200`);
    const unknownApi = parseAcceptanceRequirement('# Unknown\nGET /health\n返回 200\nAC-1 返回 200');

    expect(publicApi.apis[0].authPolicy).toBe('AUTH_NOT_REQUIRED');
    expect(publicApi.warnings.some((warning) => warning.code === 'AUTH_UNKNOWN')).toBe(false);
    expect(protectedApi.apis[0].authPolicy).toBe('AUTH_REQUIRED');
    expect(protectedApi.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AUTH_REQUIRED_NO_ACTOR', blocking: true }),
    ]));
    expect(unknownApi.apis[0].authPolicy).toBe('AUTH_UNKNOWN');
    const unknownWarning = unknownApi.warnings.find((warning) => warning.code === 'AUTH_UNKNOWN');
    expect(unknownWarning).toBeDefined();
    expect(unknownWarning?.blocking).toBe(true);
  });

  it('blocks an unsupported rule in an explicit Business Rules section instead of treating it as covered', async () => {
    const markdown = `# Delete
DELETE /users/{id}
该接口无需认证
返回 204
## Business Rules
- Deleting a user must preserve all audit records.
## Acceptance Criteria
AC-1 DELETE /users/{id} 返回 204`;
    const requirement = parseAcceptanceRequirement(markdown);
    expect(requirement.businessRules).toHaveLength(1);
    expect(requirement.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNMAPPED_REQUIREMENT_RULE', blocking: true }),
    ]));
    const execution = await runAcceptancePipeline({
      project: 'rules', baseUrl: 'http://127.0.0.1:1', markdown,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['DELETE /users/{id}']),
    });
    expect(execution.results.every((result) => !result.executed
      && ['BLOCKED', 'NOT_EXECUTED'].includes(result.status ?? ''))).toBe(true);
    expect(execution.results.some((result) => result.status === 'PASS')).toBe(false);
  });

  it('keeps mutation parameter violations designed-only when no isolated writable fixture is bound', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response('{"error":"invalid"}', { status: 400, headers: { 'content-type': 'application/json' } });
    };
    const requirement = parseAcceptanceRequirement(`# Negative contract
POST /echo/{id}
该接口无需认证
| name | type | location | required |
| --- | --- | --- | --- |
| id | integer | path | yes |
| page | integer | query | yes |
| X-Mode | string | header | yes |
| name | string | body | yes |
| status | description |
| --- | --- |
| 200 | success |
| 400 | invalid input |
AC-1 id 参数类型错误返回 400
AC-2 page 参数缺失返回 400
AC-3 X-Mode 参数缺失返回 400
AC-4 name 参数缺失返回 400`);
    const testCases = generateAcceptanceApiCases(requirement, generateTestPoints(requirement));
    const run = await runAcceptanceApiCases(testCases, {
      baseUrl: 'http://acceptance.invalid', apiSpecs: requirement.apis, fetchImpl,
    });

    const mutationParameterCases = testCases.filter((testCase) => ['AC-1', 'AC-2', 'AC-3', 'AC-4']
      .some((acId) => testCase.source?.acceptanceCriteriaIds.includes(acId)));
    expect(mutationParameterCases.length).toBeGreaterThanOrEqual(4);
    expect(mutationParameterCases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(mutationParameterCases.some((testCase) =>
      String(testCase.design?.reason).includes('MUTATION_PATH_FIXTURE_UNAVAILABLE'))).toBe(true);
    expect(run.results.filter((result) => mutationParameterCases.some((testCase) => testCase.id === result.caseId))
      .every((result) => result.status === 'NOT_EXECUTED' && !result.executed)).toBe(true);
    expect(run.results.some((result) => result.executed || result.status === 'PASS')).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('blocks a legitimate large generated suite before lifecycle when the configured Case budget is exceeded', async () => {
    // 102 operations leaves 101 executable 2xx Cases (the 300 response is
    // intentionally design-only), so the executable maxCases=100 gate fires.
    const operations = Array.from({ length: 102 }, (_, index) => `GET /status/${200 + index} 无需认证`).join('\n');
    const criteria = Array.from({ length: 102 }, (_, index) => `AC-${index + 1} GET /status/${200 + index} 返回 ${200 + index}`).join('\n');
    const lifecycle = { prepare: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) };
    const execution = await runAcceptancePipeline({
      project: 'budget', baseUrl: 'http://127.0.0.1:1', maxCases: 100, lifecycle,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(
        Array.from({ length: 102 }, (_, index) => `GET /status/${200 + index}`),
      ),
      markdown: `# Case budget\n${operations}\n${criteria}`,
    });

    // The design engine may legitimately add more than one traced Case per
    // operation; this contract is about enforcing the configured budget, not
    // freezing the generator's cardinality.
    expect(execution.testCases.length).toBeGreaterThan(100);
    expect(execution.results).toHaveLength(execution.testCases.length);
    expect(execution.results.every((result) => ['BLOCKED', 'NOT_EXECUTED'].includes(result.status ?? '')
      && !result.executed)).toBe(true);
    expect(execution.results.some((result) => result.status === 'BLOCKED'
      && result.error?.includes('CASE_LIMIT_EXCEEDED'))).toBe(true);
    expect(execution.results.some((result) => result.status === 'PASS')).toBe(false);
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
  });

  it('blocks a direct execute call with no explicit safety policy before Data Prepare or HTTP', async () => {
    const lifecycle = { prepare: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined) };
    const execute = vi.fn();
    const execution = await runAcceptancePipeline({
      project: 'direct-safety-bypass',
      environment: 'local',
      baseUrl: 'http://127.0.0.1:1',
      markdown: '# Health\nGET /health\n无需认证\n返回 200\nAC-1 GET /health 返回 200',
      lifecycle,
      processor: { name: 'api', supportedScenes: ['api'], supportedMethods: ['GET'], supports: () => true, execute } as never,
    });

    expect(execution.report.conclusion).toBe('BLOCKED');
    expect(execution.results).toEqual([
      expect.objectContaining({
        status: 'BLOCKED', executed: false, processorInvoked: false,
        classification: 'EXECUTION_BLOCKED', error: expect.stringContaining('SAFETY_POLICY_REQUIRED'),
      }),
    ]);
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
