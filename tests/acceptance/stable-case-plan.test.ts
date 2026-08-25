import { afterEach, describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { runAcceptancePipeline } from '../../src/acceptance/acceptance-pipeline.js';
import { buildAcceptanceExecutionPlanIdentity } from '../../src/acceptance/acceptance-execution-plan.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { buildAcceptanceTestDesign } from '../../src/acceptance/test-objective.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { startFakeApiServer, type FakeApiServer } from './helpers/fake-api-server.js';
import { localAcceptanceSafetyPolicy } from './helpers/acceptance-safety.js';

let server: FakeApiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function compile(markdown: string): TestCase[] {
  const requirement = parseAcceptanceRequirement(markdown, { documentId: 'stable-plan.md' });
  const design = buildAcceptanceTestDesign(requirement);
  return generateAcceptanceApiCases(requirement, generateTestPoints(requirement, design));
}

function executableFor(cases: TestCase[], operationKey: string): TestCase {
  const testCase = cases.find((candidate) => candidate.executionMode === 'EXECUTABLE'
    && candidate.source?.apiOperationKey === operationKey);
  expect(testCase, `missing executable ${operationKey}`).toBeDefined();
  return testCase!;
}

const BASE_REQUIREMENT = `# Stable plan
GET /status/200
该接口无需认证
返回 200
AC-1 GET /status/200 成功返回 200`;

describe('Stable Case Identity and scoped Execution Plan gate', () => {
  it('keeps Case ID bound to execution semantics instead of generation position', () => {
    const original = executableFor(compile(BASE_REQUIREMENT), 'GET /status/200');
    const withEarlierDesignOnlyFact = executableFor(compile(`# Stable plan
页面必须显示帮助提示
GET /status/200
该接口无需认证
返回 200
AC-1 GET /status/200 成功返回 200`), 'GET /status/200');

    expect(original.id).toMatch(/^CASE-[A-F0-9]{24}$/);
    expect(withEarlierDesignOnlyFact.id).toBe(original.id);
  });

  it('blocks changed or unbound scoped plans before Data Prepare and HTTP', async () => {
    server = await startFakeApiServer();
    const preview = await runAcceptancePipeline({
      project: 'stable-plan', markdown: BASE_REQUIREMENT, baseUrl: '', mode: 'dry-run',
    });
    const previewCase = executableFor(preview.testCases, 'GET /status/200');
    const lifecycle = { prepared: 0, cleaned: 0 };
    const lifecycleHooks = {
      prepare: async () => { lifecycle.prepared++; },
      cleanup: async () => { lifecycle.cleaned++; },
    };

    const changed = await runAcceptancePipeline({
      project: 'stable-plan',
      markdown: `${BASE_REQUIREMENT}\n页面必须显示帮助提示`,
      baseUrl: server.baseUrl,
      environment: 'local',
      mode: 'execute',
      caseIds: [previewCase.id],
      expectedExecutionPlan: preview.executionPlan,
      safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
      lifecycle: lifecycleHooks,
    });
    expect(changed.results).toHaveLength(1);
    expect(changed.results[0]).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(changed.results[0].error).toContain('STALE_PLAN');
    expect(changed.report.conclusion).toBe('BLOCKED');
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(server.requests).toHaveLength(0);

    const missingPreview = await runAcceptancePipeline({
      project: 'stable-plan', markdown: BASE_REQUIREMENT, baseUrl: server.baseUrl,
      environment: 'local', mode: 'execute', caseIds: [previewCase.id],
      safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
      lifecycle: lifecycleHooks,
    });
    expect(missingPreview.results[0]).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(missingPreview.results[0].error).toContain('STALE_PLAN');
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(server.requests).toHaveLength(0);

    const generatorDriftCases = structuredClone(preview.testCases);
    const generatorDriftStep = generatorDriftCases
      .find((testCase) => testCase.id === previewCase.id)!
      .steps.find((step) => step.type === 'HTTP_REQUEST')!;
    generatorDriftStep.query = { generatedByDifferentPlan: true };
    const generatorDriftPlan = buildAcceptanceExecutionPlanIdentity({
      markdown: BASE_REQUIREMENT,
      allTestCases: generatorDriftCases,
      selectedCaseIds: generatorDriftCases.map((testCase) => testCase.id),
    });
    const changedPlan = await runAcceptancePipeline({
      project: 'stable-plan', markdown: BASE_REQUIREMENT, baseUrl: server.baseUrl,
      environment: 'local', mode: 'execute', caseIds: [previewCase.id],
      expectedExecutionPlan: generatorDriftPlan,
      safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
      lifecycle: lifecycleHooks,
    });
    expect(changedPlan.results[0]).toMatchObject({ status: 'BLOCKED', executed: false, processorInvoked: false });
    expect(changedPlan.results[0].error).toContain('Case 计划与预览语义不一致');
    expect(lifecycle).toEqual({ prepared: 0, cleaned: 0 });
    expect(server.requests).toHaveLength(0);

    const accepted = await runAcceptancePipeline({
      project: 'stable-plan', markdown: BASE_REQUIREMENT, baseUrl: server.baseUrl,
      environment: 'local', mode: 'execute', caseIds: [previewCase.id],
      expectedExecutionPlan: preview.executionPlan,
      safetyPolicy: localAcceptanceSafetyPolicy(['GET /status/200']),
    });
    expect(accepted.results[0]).toMatchObject({ status: 'PASS', executed: true, processorInvoked: true });
    expect(server.requests).toHaveLength(1);
  });

  it('coalesces identical mutation requests while preserving every parameter vector trace', async () => {
    server = await startFakeApiServer();
    const markdown = `# Mutation vector coalescing
POST /echo/orders
该接口无需认证
| 参数 | 位置 | 类型 | 必填 | 最小长度 | 最大长度 | 默认值 |
| --- | --- | --- | --- | --- | --- | --- |
| sku | body | string | 是 | 1 | 1 | a |
| region | body | string | 是 | 1 | 1 | a |
| 状态码 | 描述 |
| --- | --- |
| 200 | valid |
| 422 | invalid |
AC-1 sku 最小长度=1 最大长度=1，满足约束返回 200，违反约束返回 422。
AC-2 region 最小长度=1 最大长度=1，满足约束返回 200，违反约束返回 422。`;
    const generated = compile(markdown);
    const exactBaseline = generated.filter((testCase) => {
      const request = testCase.steps.find((step) => step.type === 'HTTP_REQUEST');
      return testCase.executionMode === 'EXECUTABLE'
        && request?.method === 'POST'
        && request.url === '/echo/orders'
        && JSON.stringify(request.body) === JSON.stringify({ sku: 'a', region: 'a' })
        && testCase.assertions.some((assertion) => assertion.type === 'STATUS_CODE' && assertion.expected === 200);
    });
    expect(exactBaseline).toHaveLength(1);
    expect(exactBaseline[0].source?.acceptanceCriteriaIds).toEqual(expect.arrayContaining(['AC-1', 'AC-2']));
    expect(exactBaseline[0].parameterCoverage?.map((coverage) => coverage.parameter).sort()).toEqual(['region', 'sku']);
    expect(exactBaseline[0].parameterCoverage?.every((coverage) =>
      coverage.boundaryVectors.includes('MIN') && coverage.boundaryVectors.includes('MAX'))).toBe(true);

    const execution = await runAcceptancePipeline({
      project: 'stable-plan', markdown, baseUrl: server.baseUrl, environment: 'local', mode: 'execute',
      safetyPolicy: localAcceptanceSafetyPolicy(['POST /echo/orders']),
    });
    const mutationRequests = server.requests.filter((request) => request.method === 'POST' && request.url.includes('/echo/orders'));
    const signatures = mutationRequests.map((request) => JSON.stringify({ method: request.method, url: request.url, body: request.body }));
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(mutationRequests.filter((request) => JSON.stringify(request.body) === JSON.stringify({ sku: 'a', region: 'a' }))).toHaveLength(1);
    expect(execution.results.filter((result) => result.executed)).not.toHaveLength(0);
  });
});
