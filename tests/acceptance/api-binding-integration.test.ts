import { afterEach, describe, expect, it } from 'vitest';
import { buildAcceptanceReport } from '../../src/acceptance/acceptance-report.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { buildAcceptanceDefects, runAcceptanceApiCases } from '../../src/acceptance/api-processor.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { startFakeApiServer, type FakeApiServer } from './helpers/fake-api-server.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';

type PipelineExecution = Awaited<ReturnType<typeof runAcceptancePipeline>>;
type PipelinePoint = PipelineExecution['testPoints'][number];

function pointForCriterion(
  execution: PipelineExecution,
  criterionId: string,
  predicate: (point: PipelinePoint) => boolean = () => true,
): PipelinePoint {
  const point = execution.testPoints.find((candidate) =>
    candidate.acceptanceCriteriaIds.includes(criterionId) && predicate(candidate));
  expect(point, `missing TestPoint for ${criterionId}`).toBeDefined();
  return point!;
}

function caseForPoint(execution: PipelineExecution, point: PipelinePoint) {
  const testCase = execution.testCases.find((candidate) => candidate.source?.objectiveIds?.includes(point.objectiveId));
  expect(testCase, `missing TestCase for ${point.objectiveId}`).toBeDefined();
  return testCase!;
}

function resultForCase(execution: PipelineExecution, caseId: string) {
  const result = execution.results.find((candidate) => candidate.caseId === caseId);
  expect(result, `missing Result for ${caseId}`).toBeDefined();
  return result!;
}

let server: FakeApiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('Requirement → Binding → Case → Request integration', () => {
  it('sends arbitrary Path, required Query/Header and no Body for GET', async () => {
    server = await startFakeApiServer();
    const execution = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['GET /echo/{resourceKey}']),
      markdown: `# Query
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
AC-1 GET /echo/{resourceKey} 查询成功返回 200`,
    });

    expect(execution.report).toMatchObject({ conclusion: 'PARTIAL', coverage: { operationContractEvidenceCoverage: 100 } });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: 'GET', body: undefined });
    expect(new URL(server.requests[0].url).searchParams.get('mode')).toBe('contract');
    expect(server.requests[0].headers['x-client']).toBe('acceptance');
    expect(new URL(server.requests[0].url).pathname).toBe('/echo/resource-a');
  });

  it('executes single POST JSON and HEAD without a request body', async () => {
    server = await startFakeApiServer();
    const post = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['POST /echo/{resourceKey}']),
      markdown: `# Create
POST /echo/{resourceKey}
无需认证
| name | type | location | required | default |
| --- | --- | --- | --- | --- |
| resourceKey | string | path | yes | resource-a |
| name | string | body | yes | payload |
## Response
返回 200
## Acceptance Criteria
AC-1 POST /echo/{resourceKey} 创建成功返回 200`,
    });
    const head = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['HEAD /status/200']),
      markdown: '# Head\nHEAD /status/200\n无需认证\n## Response\n返回 200\n## Acceptance Criteria\nAC-1 HEAD /status/200 成功返回 200',
    });
    expect(post.report).toMatchObject({ conclusion: 'PARTIAL', summary: { passed: 1 } });
    expect(server.requests[0]).toMatchObject({ method: 'POST', body: { name: 'payload' } });
    // A successful HTTP assertion proves the operation contract, but the
    // generated Requirement model still contains unverified design facts.
    // V2 must not promote generated coverage to a fully verified PASS.
    expect(head.report).toMatchObject({ conclusion: 'PARTIAL', summary: { passed: 1 } });
    expect(server.requests[1]).toMatchObject({ method: 'HEAD', body: undefined });
  });

  it('binds explicit operations in a multi-API requirement and asserts 404', async () => {
    server = await startFakeApiServer();
    const execution = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['POST /echo/{resourceKey}', 'GET /status/404']),
      markdown: `# Multi
POST /echo/{resourceKey} 无需认证
GET /status/404 无需认证
## Acceptance Criteria
AC-1 POST /echo/{resourceKey} 创建成功返回 200
AC-2 GET /status/404 查询不存在返回 404`,
    });
    const createPoint = pointForCriterion(execution, 'AC-1', (point) => point.dimension === 'API');
    const createCase = caseForPoint(execution, createPoint);
    expect(createCase.executionMode).toBe('DESIGNED_ONLY');
    expect(resultForCase(execution, createCase.id)).toMatchObject({ status: 'NOT_EXECUTED', executed: false });

    const missingPoint = pointForCriterion(execution, 'AC-2', (point) => point.dimension === 'ERROR');
    const missingCase = caseForPoint(execution, missingPoint);
    const missingResult = resultForCase(execution, missingCase.id);
    expect(missingResult).toMatchObject({ status: 'PASS', executed: true });
    expect(missingResult.evidence.request).toBeDefined();
    expect([
      missingResult.evidence.request!.method,
      new URL(missingResult.evidence.request!.url).pathname,
    ]).toEqual(['GET', '/status/404']);

    const executableResults = execution.results.filter((result) => result.executed === true);
    expect(executableResults.every((result) => result.status === 'PASS' && result.evidence.request)).toBe(true);
    expect(execution.report.coverage.operationContractEvidenceCoverage).toBe(100);
    expect(execution.report.coverage.executionCoverage).toBeGreaterThan(0);
    expect(execution.report.coverage.executionCoverage).toBeLessThan(100);
    expect(execution.report.coverage.evidenceCoverage).toBe(execution.report.coverage.executionCoverage);
  });

  it('blocks ambiguous or missing multi-API binding before lifecycle and HTTP', async () => {
    server = await startFakeApiServer();
    const lifecycle = { prepared: 0, cleaned: 0 };
    const execution = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['GET /users/{id}', 'GET /users/{id}/status']),
      markdown: '# Multi\nGET /users/{id} 无需认证\nGET /users/{id}/status 无需认证\nAC-1 查询用户状态返回 200',
      lifecycle: {
        prepare: async () => { lifecycle.prepared++; },
        cleanup: async () => { lifecycle.cleaned++; },
      },
    });
    const ambiguousPoint = pointForCriterion(execution, 'AC-1', (point) => point.dimension === 'API');
    expect(ambiguousPoint.bindingIssue).toMatchObject({ code: 'BINDING_AMBIGUOUS' });
    const ambiguousCase = caseForPoint(execution, ambiguousPoint);
    expect(ambiguousCase.executionMode).toBe('DESIGNED_ONLY');
    expect(resultForCase(execution, ambiguousCase.id)).toMatchObject({
      status: 'NOT_EXECUTED', executed: false, processorInvoked: false, classification: 'NOT_EXECUTED',
    });
    expect(execution.report).toMatchObject({
      conclusion: 'PARTIAL',
      coverage: { caseCoverage: 100, executionCoverage: 0, evidenceCoverage: 0, operationContractEvidenceCoverage: 'NOT_AVAILABLE' },
    });
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(server.requests).toHaveLength(0);
  });

  it('blocks a mutated Method/Path and excludes it from effective coverage', async () => {
    server = await startFakeApiServer();
    const requirement = parseAcceptanceRequirement(`# One
GET /echo/{resourceKey}
无需认证
| name | type | location | required | default |
| --- | --- | --- | --- | --- |
| resourceKey | string | path | yes | resource-a |
返回 200
AC-1 GET /echo/{resourceKey} 查询成功返回 200`);
    const points = generateTestPoints(requirement);
    const cases = generateAcceptanceApiCases(requirement, points);
    const point = points.find((candidate) => candidate.acceptanceCriteriaIds.includes('AC-1') && candidate.dimension === 'API');
    expect(point).toBeDefined();
    const testCase = cases.find((candidate) => candidate.source?.objectiveIds?.includes(point!.objectiveId)
      && candidate.executionMode === 'EXECUTABLE');
    expect(testCase).toBeDefined();
    testCase!.steps[0] = { ...testCase!.steps[0], method: 'POST', url: '/wrong/{resourceKey}' };
    const run = await runAcceptanceApiCases(cases, { baseUrl: server.baseUrl, apiSpecs: requirement.apis });
    const report = buildAcceptanceReport({
      project: 'binding', requirement, testPoints: points, testCases: cases, results: run.results,
      defects: buildAcceptanceDefects(run.results),
    });
    const result = run.results.find((candidate) => candidate.caseId === testCase!.id);
    expect(result).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false, classification: 'EXECUTION_BLOCKED' });
    expect(result?.error).toContain('BINDING_MISMATCH');
    expect(report.conclusion).toBe('BLOCKED');
    expect(report.coverage).toMatchObject({
      caseCoverage: 0,
      executionCoverage: 0, evidenceCoverage: 0, operationContractEvidenceCoverage: 0,
    });
    expect(server.requests).toHaveLength(0);
  });

  it('keeps an unexpected 500 unconfirmed and does not create a product defect', async () => {
    server = await startFakeApiServer();
    const execution = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/500']),
      markdown: '# Failure\nGET /status/500\n无需认证\n| status | description |\n| --- | --- |\n| 200 | success |\nAC-1 请求成功返回 200',
    });
    const testCase = execution.testCases.find((candidate) =>
      candidate.source?.acceptanceCriteriaIds.includes('AC-1')
      && candidate.steps.some((step) => step.type === 'HTTP_REQUEST' && step.method === 'GET' && step.url === '/status/500'));
    expect(testCase).toBeDefined();
    expect(resultForCase(execution, testCase!.id)).toMatchObject({ status: 'FAIL', classification: 'UNCONFIRMED', executed: true });
    expect(execution.defects).toHaveLength(0);
    expect(execution.report.risks).toEqual(expect.arrayContaining([expect.objectContaining({ classification: 'UNCONFIRMED' })]));
  });

  it('stops ambiguous parameter multiplication at descriptive Cases before data preparation or HTTP', async () => {
    server = await startFakeApiServer();
    const parameterRows = Array.from({ length: 20 }, (_, index) => `| field${index + 1} | string | body | yes | 1 | 20 |`).join('\n');
    const criteria = Array.from({ length: 20 }, (_, index) => `AC-${index + 1} 参数边界必须返回 200`).join('\n');
    const lifecycle = { prepared: 0, cleaned: 0 };
    const execution = await runAcceptancePipeline({
      project: 'binding', baseUrl: server.baseUrl, maxCases: 100,
      environment: 'local', safetyPolicy: localAcceptanceSafetyPolicy(['POST /echo/{resourceKey}']),
      markdown: `# Explosion
POST /echo/{resourceKey}
无需认证
| name | type | location | required | minLength | maxLength |
| --- | --- | --- | --- | --- | --- |
${parameterRows}
## Response
返回 200 和 400
## Acceptance Criteria
${criteria}`,
      lifecycle: {
        prepare: async () => { lifecycle.prepared++; },
        cleanup: async () => { lifecycle.cleaned++; },
      },
    });

    const ambiguousCases = execution.testCases.filter((testCase) =>
      String(testCase.design?.reason).includes('PARAMETER_TARGET_AMBIGUOUS'));
    expect(ambiguousCases.length).toBeGreaterThan(0);
    expect(ambiguousCases.every((testCase) => testCase.executionMode === 'DESIGNED_ONLY')).toBe(true);
    expect(ambiguousCases.every((testCase) => {
      const result = execution.results.find((candidate) => candidate.caseId === testCase.id);
      return result?.status === 'NOT_EXECUTED' && result.executed === false && result.processorInvoked === false;
    })).toBe(true);
    expect(execution.report).toMatchObject({
      conclusion: 'PARTIAL',
      summary: { total: execution.testCases.length, passed: 0, failed: 0, blocked: 0, notExecuted: execution.testCases.length },
      coverage: { executionCoverage: 0, evidenceCoverage: 0, operationContractEvidenceCoverage: 'NOT_AVAILABLE' },
    });
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(server.requests).toHaveLength(0);
  });
});
