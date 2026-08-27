import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDevTest } from '../../src/devtest/index.js';

const servers: Server[] = [];

async function localServer(): Promise<{ baseUrl: string; requests: string[]; behavior: { tagStatus: number; flakyStatus: number } }> {
  const requests: string[] = [];
  const behavior = { tagStatus: 201, flakyStatus: 200 };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/api/tags' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: string };
        const invalid = typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 20;
        const status = invalid ? behavior.tagStatus : 201;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(status === 400 ? '{"error":"name too long"}' : '{"id":"tag-1"}');
      });
      return;
    }
    if (request.url === '/api/flaky' && request.method === 'GET') {
      response.writeHead(behavior.flakyStatus, { 'content-type': 'application/json' });
      response.end(behavior.flakyStatus === 200 ? '{"ok":true}' : '{"error":"intermittent"}');
      return;
    }
    if (request.url === '/api/upstream' && request.method === 'GET') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"upstream unavailable"}');
      return;
    }
    if (request.url === '/profile/edit' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<main><input data-testid="nickname" name="nickname"><button data-testid="save">保存</button></main>');
      return;
    }
    if (request.url === '/api/items' && request.method === 'POST') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"id":"created-1","status":"CREATED"}');
      return;
    }
    if (request.url?.startsWith('/api/items/') && request.method === 'GET') {
      const resourceId = request.url.split('/').at(-1);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: resourceId, status: 'CREATED' }));
      return;
    }
    if (request.url === '/profile/action' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<main>
        <input data-testid="nickname" name="nickname">
        <select data-testid="color" name="color"><option value="red">red</option></select>
        <button data-testid="save" type="button" onclick="document.querySelector('[data-testid=success]').hidden=false">保存</button>
        <div data-testid="success" hidden>保存成功</div>
      </main>`);
      return;
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":"invalid"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server missing address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, behavior };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const SAFE_READ_REQUIREMENT = `# 健康检查

## API

| Method | Path |
| --- | --- |
| GET | /health |

无需认证。

### 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 服务健康 |

## Acceptance Criteria

- AC-1 GET /health 返回 200。
`;

const BILLABLE_REQUIREMENT = SAFE_READ_REQUIREMENT
  .replace('健康检查', '真实扣费')
  .replace('GET | /health', 'POST | /api/billing/charge')
  .replace('GET /health 返回 200', 'POST /api/billing/charge 返回 200');

const PARAMETER_BUG_REQUIREMENT = `# 创建标签

## API

POST /api/tags

公开接口，无需认证。

## Body 参数

| 参数 | 位置 | 类型 | 必填 | 最大长度 |
| --- | --- | --- | --- | --- |
| name | body | string | 是 | 20 |

## 响应

| 状态码 | 描述 |
| --- | --- |
| 201 | 创建成功 |
| 400 | 参数非法 |

## Acceptance Criteria

- AC-1 name 长度超过 20 时 POST /api/tags 返回 400。
`;

const UI_REQUIREMENT = `# 用户资料编辑

## 页面

入口为 /profile/edit，页面必须包含 nickname 输入框和保存按钮。

## Acceptance Criteria

- AC-1 页面打开后 nickname 输入框必须存在。
`;

const UI_ACTION_REQUIREMENT = `# 用户资料保存交互

## 页面

入口为 /profile/action。将 nickname="Ada"，color="red"，点击保存后必须显示 success 成功状态。

## Acceptance Criteria

- AC-1 输入 nickname、选择 color 并点击保存后显示 success。
`;

const BUSINESS_FLOW_REQUIREMENT = `# Item 创建与查询

## API

| Method | Path | Status | Description |
| --- | --- | --- | --- |
| POST | /api/items | 201 | 创建成功并返回 id |
| GET | /api/items/{id} | 200 | 查询成功 |

POST /api/items 是公开接口，无需认证。
GET /api/items/{id} 是公开接口，无需认证。

## Path Parameter

| Method | Path | Name | Location | Type | Required | Default |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/items/{id} | id | path | string | 是 | fixture-1 |

## Acceptance Criteria

- AC-1 POST /api/items 创建资源返回 201，响应包含 id。
- AC-2 GET /api/items/{id} 查询刚创建的同一资源返回 200。
`;

const FLAKY_REQUIREMENT = `# Flaky 查询

## API

GET /api/flaky

公开接口，无需认证。

## 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |

## Acceptance Criteria

- AC-1 GET /api/flaky 返回 200。
`;

const DUPLICATE_SUBMIT_REQUIREMENT = `# 幂等提交任务

## API

POST /api/submit

公开接口，无需认证。

## 响应

| 状态码 | 描述 |
| --- | --- |
| 201 | 提交成功并返回 taskId |

## Acceptance Criteria

- AC-1 相同 requestId 重复提交或重试只能创建一个任务，并返回相同 taskId。
`;

const UPSTREAM_500_REQUIREMENT = `# 上游查询

## API

GET /api/upstream

公开接口，无需认证。

## 响应

| 状态码 | 描述 |
| --- | --- |
| 200 | 查询成功 |

## Acceptance Criteria

- AC-1 GET /api/upstream 返回 200。
`;

describe('DevTest Mode integration', () => {
  it.each([
    ['CRUD', 'devtest-crud.md', 'API'],
    ['新 API', 'devtest-new-api.md', 'API'],
    ['新 UI', 'devtest-new-ui.md', 'UI'],
    ['数据权限', 'devtest-data-permission.md', 'DATA_ISOLATION'],
    ['参数规则', 'devtest-parameter-rules.md', 'PARAMETER_VALIDATION'],
    ['异步任务', 'devtest-async-task.md', 'FUNCTIONAL'],
  ] as const)('%s 真实需求完成理解、Case 生成、SAFE 计划和开发者报告', async (_name, fixture, expectedDimension) => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-scenario-'));
    const result = await runDevTest({
      docPath: path.join('tests/acceptance/fixtures', fixture), mode: 'DRY_RUN', outDir: output,
      discoverProject: false, maxCases: 20,
    });
    expect(result.featureModel.feature.name).not.toBe('未命名开发验收需求');
    expect(result.dimensionStats.find((item) => item.dimension === expectedDimension)?.total).toBeGreaterThan(0);
    expect(result.pipeline.summary.designed).toBeGreaterThan(0);
    expect(await readdir(result.artifacts.dir)).toEqual([
      'acceptance-summary.md', 'cases.csv', 'problems.md', 'report.html', 'report.json', '开发自测测试报告.md', '测试用例.md',
    ]);
    expect(result.pipeline.summary.passed).toBe(0);
    expect(result.conclusion).toBe('BLOCKED');
    if (expectedDimension === 'DATA_ISOLATION') {
      expect(result.permissionMatrix).toContainEqual(expect.objectContaining({ expectedAccess: 'DENY' }));
      expect(result.negativeChecks).toContainEqual(expect.objectContaining({ kind: 'CROSS_TENANT' }));
    }
  });

  it('DRY_RUN 从环境发现到 Processor 都保持零 HTTP 请求', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-dry-run-no-http-'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('DRY_RUN must not call fetch');
    }) as unknown as typeof fetch;
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT,
      baseUrl: 'http://127.0.0.1:43123',
      environment: 'local',
      mode: 'DRY_RUN',
      outDir: output,
      discoverProject: false,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.pipeline.report.executions.every((item) => item.executed === false)).toBe(true);
    expect(result.environmentPreflight.reason).toContain('DRY_RUN_ENVIRONMENT_NOT_PROBED');
  });

  it('SAFE 未提供环境时只做静态降级，不探测本机约定端口', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-safe-static-only-'));
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'devtest-no-environment-'));
    const fetchImpl = vi.fn(async () => {
      throw new Error('missing environment must not call fetch');
    }) as unknown as typeof fetch;
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT,
      environment: 'local',
      mode: 'SAFE',
      outDir: output,
      projectRoot,
      discoverProject: false,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.environmentPreflight.reason).toContain('ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY');
    expect(result.pipeline.summary.executed).toBe(0);
    expect(result.conclusion).toBe('BLOCKED');
    const report = await readFile(result.artifacts.developerSelfTestReportMd, 'utf8');
    expect(report).toContain('无真实执行证据');
    expect(report).toContain('ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY');
  });

  it('SAFE 允许真实只读请求，并保留 Processor/Assertion/Evidence', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-safe-read-'));
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', outDir: output, maxCases: 10,
    });
    expect(server.requests.some((request) => request === 'GET /health')).toBe(true);
    expect(result.pipeline.report.executions.some((item) => item.status === 'PASS' && item.executed)).toBe(true);
    expect(result.pipeline.report.cases.filter((item) => item.executionStatus === 'PASS')
      .every((item) => item.evidence.assertions.length > 0)).toBe(true);
    const accepted = result.acceptanceTraces.find((trace) => trace.result === 'PASS');
    expect(accepted).toEqual(expect.objectContaining({
      testModel: expect.objectContaining({ selection: 'SELECTED', dimension: 'API' }),
      execution: expect.objectContaining({ status: 'EXECUTED', executed: true, processorInvoked: true }),
      evidence: expect.objectContaining({ complete: true, missing: [] }),
      oracle: expect.objectContaining({ verdict: 'PASS' }),
      result: 'PASS',
      classification: 'NONE',
    }));
    expect(accepted?.evidence.required).toEqual(expect.arrayContaining(['API_REQUEST', 'API_RESPONSE']));
    expect(accepted?.evidence.collected).toEqual(expect.arrayContaining(['API_REQUEST', 'API_RESPONSE']));
    expect(result.deliveryCoverage.cases.passed).toBeGreaterThanOrEqual(1);
    expect(result.deliveryCoverage.cases.verified).toBeGreaterThanOrEqual(1);
    expect(result.deliveryCoverage.evidence.completeCaseIds).toContain(accepted?.caseId);
    const report = JSON.parse(await readFile(result.artifacts.reportJson, 'utf8')) as {
      acceptanceTraces: typeof result.acceptanceTraces;
      deliveryCoverage: typeof result.deliveryCoverage;
    };
    expect(report.acceptanceTraces).toContainEqual(expect.objectContaining({ caseId: accepted?.caseId, result: 'PASS' }));
    expect(report.deliveryCoverage).toEqual(result.deliveryCoverage);
  });

  it('单接口全部 PASS 但输出未传入后续步骤时，需求级 FEATURE_BUG 阻止 READY', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-business-flow-'));
    const result = await runDevTest({
      markdown: BUSINESS_FLOW_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, discoverProject: false, maxCases: 10, confirmMutations: true, sandbox: true,
    });
    expect(result.pipeline.report.executions.filter((item) => item.status === 'PASS' && item.executed).length).toBeGreaterThanOrEqual(2);
    expect(result.businessFlowGraph.flows).toContainEqual(expect.objectContaining({ status: 'FAIL' }));
    expect(result.problems).toContainEqual(expect.objectContaining({ type: 'FEATURE_BUG', scope: 'FEATURE' }));
    expect(result.conclusion).toBe('NOT_READY');
  });

  it('真实执行参数边界先判为 LIKELY_BUG，并保留最小复现证据', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-confirmed-bug-'));
    const result = await runDevTest({
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', outDir: output, discoverProject: false, maxCases: 20,
      confirmMutations: true, sandbox: true,
    });
    const bug = result.problems.find((problem) => problem.failureClass === 'PRODUCT_BUG');
    expect(server.requests.some((request) => request === 'POST /api/tags')).toBe(true);
    expect(bug).toEqual(expect.objectContaining({
      type: 'TEST_FAILED', confidenceLabel: 'LIKELY', judgement: 'LIKELY_BUG', reproducible: false,
      request: expect.any(Object), response: expect.any(Object),
      rootCause: 'PARAMETER_REJECTION', minimalReproduction: expect.any(Object),
      environment: expect.objectContaining({ baseUrl: server.baseUrl }),
    }));
    expect(result.conclusion).toBe('NOT_READY');
  });

  it('Bug → --repro → 修复 → --rerun → FIXED 完成闭环且保持稳定问题 ID', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-lifecycle-'));
    const common = {
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE' as const, outDir: output, discoverProject: false, maxCases: 20,
      confirmMutations: true, sandbox: true,
    };
    const first = await runDevTest(common);
    const problem = first.problems.find((item) => item.judgement === 'LIKELY_BUG');
    expect(problem).toEqual(expect.objectContaining({ id: expect.stringMatching(/^P\d+$/), lifecycle: 'OPEN' }));

    const reproduced = await runDevTest({ ...common, reproProblemId: problem!.id });
    expect(reproduced.reproduction).toEqual(expect.objectContaining({ problemId: problem!.id, status: 'REPRODUCED' }));
    expect(reproduced.problems.find((item) => item.id === problem!.id)?.lifecycle).toBe('REPRODUCED');
    expect(reproduced.problems.find((item) => item.id === problem!.id)?.judgement).toBe('CONFIRMED_BUG');
    expect(reproduced.pipeline.report.cases.length).toBe(reproduced.reproduction?.caseIds.length);

    server.behavior.tagStatus = 400;
    const fixed = await runDevTest({ ...common, rerun: true, rerunTarget: problem!.id });
    expect(fixed.baseline.resolvedProblems).toContain(problem!.id);
    expect(fixed.baseline.problemLifecycle).toContainEqual({ problemId: problem!.id, status: 'FIXED' });
    expect(fixed.baseline.rerunOutcomes).toContainEqual({ target: problem!.id, status: 'FIXED' });
    expect(fixed.regressionGuard).toEqual(expect.objectContaining({ enabled: true, status: 'BLOCKED' }));
    expect(fixed.regressionGuard.reason).toContain('REGRESSION_GUARD_BLOCKED');
    expect(fixed.regressionGuard.selectedCaseIds).toEqual(expect.arrayContaining(fixed.regressionGuard.fixedCaseIds));

    const final = await runDevTest({ ...common, final: true });
    expect(final.conclusion).toBe('BLOCKED');
    expect(final.devConfidence.failClosed).toBe(true);
    expect(final.deliveryCoverage.requirements.verifiedCoverage).toBeLessThan(100);
    expect(final.acceptanceTraces.some((trace) => trace.result === 'NOT_TESTED' || trace.result === 'BLOCKED')).toBe(true);
  }, 15_000);

  it('--plan 只输出去重后的计划，不执行业务请求也不覆盖 Baseline', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-plan-'));
    const result = await runDevTest({
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', outDir: output, discoverProject: false, plan: true,
    });
    expect(result.pipeline.mode).toBe('dry-run');
    expect(server.requests).toEqual(['GET /health']);
    expect(result.plan).toEqual(expect.objectContaining({
      feature: '创建标签', estimatedCases: expect.any(Number), estimatedExecutable: expect.any(Number),
      deduplication: expect.objectContaining({ generated: expect.any(Number), retained: expect.any(Number) }),
    }));
    await expect(readdir(path.join(output, '.devtest-baselines'))).rejects.toMatchObject({ code: 'ENOENT' });
    const cached = await runDevTest({
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', outDir: output, discoverProject: false, plan: true,
    });
    expect(cached.plan.cache.status).toBe('HIT');
  });

  it('Prepare/Execute/Observe/Cleanup 全程可审计，Cleanup 失败禁止静默 READY', async () => {
    const server = await localServer();
    server.behavior.tagStatus = 400;
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-cleanup-'));
    const result = await runDevTest({
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, discoverProject: false, maxCases: 2, confirmMutations: true, sandbox: true,
      lifecyclePrepare: async () => undefined,
      lifecycleCleanup: async () => { throw new Error('fixture cleanup unavailable'); },
    });
    expect(result.dataLifecycle).toEqual(expect.objectContaining({
      createdBy: 'DEVTEST', prepareStatus: 'READY', cleanupStatus: 'FAILED',
    }));
    expect(result.problems.some((problem) => problem.reasonCode === 'CLEANUP_FAILED')).toBe(true);
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('Browser 使用源码稳定 data-testid 执行 Requirement 绑定的 UI 元素断言', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-ui-real-'));
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'devtest-ui-project-'));
    await writeFile(path.join(projectRoot, 'profile.tsx'), `
      export const route = { path: '/profile/edit' };
      export function Profile(){ return <main><input data-testid="nickname" name="nickname"/><button data-testid="save">保存</button></main> }
    `);
    const result = await runDevTest({
      markdown: UI_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, projectRoot, maxCases: 20,
    });
    expect(result.environmentPreflight.checks.browser).toBe('READY');
    expect(result.uiExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'PASS', executed: true, processorInvoked: true,
        assertions: expect.arrayContaining([expect.objectContaining({ selector: '[data-testid="nickname"]', pass: true })]) }),
    ]));
    const uiExecution = result.uiExecutions.find((item) => item.status === 'PASS');
    const accepted = result.acceptanceTraces.find((trace) => trace.caseId === uiExecution?.caseId);
    expect(accepted).toEqual(expect.objectContaining({
      testModel: expect.objectContaining({ selection: 'SELECTED', dimension: 'UI' }),
      execution: expect.objectContaining({ status: 'EXECUTED', executed: true, processorInvoked: true }),
      evidence: expect.objectContaining({ complete: true, missing: [] }),
      oracle: expect.objectContaining({ verdict: 'PASS' }),
      result: 'PASS',
      classification: 'NONE',
    }));
    expect(accepted?.evidence.required).toEqual(expect.arrayContaining(['UI_STATE', 'UI_SCREENSHOT']));
    expect(accepted?.evidence.collected).toEqual(expect.arrayContaining(['UI_STATE', 'UI_SCREENSHOT']));
    expect(result.deliveryCoverage.cases.passed).toBeGreaterThanOrEqual(1);
    expect(result.deliveryCoverage.evidence.completeCaseIds).toContain(accepted?.caseId);
    const report = JSON.parse(await readFile(result.artifacts.reportJson, 'utf8')) as {
      acceptanceTraces: typeof result.acceptanceTraces;
      deliveryCoverage: typeof result.deliveryCoverage;
    };
    expect(report.acceptanceTraces).toContainEqual(expect.objectContaining({ caseId: accepted?.caseId, result: 'PASS' }));
    expect(report.deliveryCoverage).toEqual(result.deliveryCoverage);
  });

  it('Browser 在显式 Sandbox 中执行输入、选择、点击并验证成功状态', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-ui-action-'));
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'devtest-ui-project-'));
    await writeFile(path.join(projectRoot, 'profile.tsx'), `
      export const route = { path: '/profile/action' };
      export function Profile(){ return <main>
        <input data-testid="nickname" name="nickname"/>
        <select data-testid="color" name="color"><option value="red">red</option></select>
        <button data-testid="save">保存</button><div data-testid="success">保存成功</div>
      </main> }
    `);
    const result = await runDevTest({
      markdown: UI_ACTION_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, projectRoot, confirmMutations: true, sandbox: true, maxCases: 20,
    });
    const execution = result.uiExecutions.find((item) => item.status === 'PASS');
    expect(execution?.steps).toEqual(expect.arrayContaining([
      expect.stringContaining('INPUT [data-testid="nickname"]'),
      expect.stringContaining('SELECT [data-testid="color"]'),
      'CLICK [data-testid="save"]',
      'ASSERT [data-testid="success"] exists',
    ]));
  });

  it('高成本 Operation 在任何 HTTP 调用前 BLOCKED', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-cost-block-'));
    const result = await runDevTest({
      markdown: BILLABLE_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', confirmMutations: true, outDir: output, maxCases: 10,
    });
    expect(server.requests).toEqual(['GET /health']);
    expect(server.requests.some((request) => request.includes('/api/billing/charge'))).toBe(false);
    expect(result.problems.some((problem) => problem.type === 'SAFE_BLOCKED')).toBe(true);
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('LIVE 没有 Approval 时零请求并输出 SAFE_BLOCKED 根因', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-live-block-'));
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'LIVE', outDir: output, maxCases: 10,
    });
    expect(server.requests).toEqual(['GET /health']);
    expect(result.problems.find((problem) => problem.reasonCode === 'LIVE_APPROVAL_REQUIRED')).toBeDefined();
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('预算不足时在业务请求前 fail-closed，并保留执行估算', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-budget-block-'));
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local',
      mode: 'SAFE', outDir: output, discoverProject: false, budget: 0,
    });
    expect(server.requests).toEqual(['GET /health']);
    expect(result.executionEstimate.exceeded).toContain('BUDGET');
    expect(result.problems).toContainEqual(expect.objectContaining({ reasonCode: 'DEVTEST_BUDGET_EXCEEDED' }));
    expect(result.pipeline.summary.executed).toBe(0);
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('失败请求产生隐藏 Billing 副作用时先判 LIKELY，等待隔离复现确认', async () => {
    const server = await localServer();
    server.behavior.tagStatus = 400;
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-hidden-side-effect-'));
    const result = await runDevTest({
      markdown: PARAMETER_BUG_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, discoverProject: false, confirmMutations: true, sandbox: true, maxCases: 5,
      caseCleanup: async () => undefined,
      caseSnapshotObserver: async ({ phase }) => ({
        billing: phase === 'AFTER_EXECUTE' ? 90 : 100,
        taskCount: 0,
      }),
    });
    expect(result.pollutionFindings).toContainEqual(expect.objectContaining({ classification: 'UNEXPECTED_SIDE_EFFECT' }));
    expect(result.problems).toContainEqual(expect.objectContaining({
      type: 'DATA_CONSISTENCY_BUG', judgement: 'LIKELY_BUG', reproducible: false, failureClass: 'PRODUCT_BUG',
    }));
    expect(result.conclusion).toBe('NOT_READY');
  });

  it('重复提交风险自动识别，但没有安全 Observer 时保持 BLOCKED', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-idempotency-'));
    const result = await runDevTest({ markdown: DUPLICATE_SUBMIT_REQUIREMENT, mode: 'DRY_RUN', outDir: output,
      discoverProject: false });
    expect(result.negativeChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'DUPLICATE_REQUEST', status: 'BLOCKED' }),
      expect.objectContaining({ kind: 'REPLAY', status: 'BLOCKED' }),
      expect.objectContaining({ kind: 'CONCURRENT_REQUEST', status: 'BLOCKED' }),
    ]));
    expect(result.invariants).toContainEqual(expect.objectContaining({ kind: 'IDEMPOTENCY' }));
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('HTTP 500 由 Oracle 保持 UNKNOWN，不直接误报产品 Bug', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-upstream-500-'));
    const result = await runDevTest({ markdown: UPSTREAM_500_REQUIREMENT, baseUrl: server.baseUrl,
      environment: 'local', mode: 'SAFE', outDir: output, discoverProject: false });
    expect(result.oracleResults).toContainEqual(expect.objectContaining({ verdict: 'UNKNOWN', transientSignal: 'HTTP_5XX' }));
    expect(result.problems.some((item) => item.failureClass === 'PRODUCT_BUG')).toBe(false);
    expect(result.problems).toContainEqual(expect.objectContaining({ judgement: 'ENVIRONMENT_ISSUE' }));
    expect(result.conclusion).toBe('BLOCKED');
  });

  it('Cleanup 后状态残留归类 TEST_POLLUTION，不误报产品 Bug', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-pollution-'));
    const result = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE',
      outDir: output, discoverProject: false,
      caseCleanup: async () => undefined,
      caseSnapshotObserver: async ({ phase }) => ({ resourceCount: {
        BEFORE: 1, AFTER_EXECUTE: 2, AFTER_CLEANUP: 2,
      }[phase] }),
    });
    expect(result.pollutionFindings).toContainEqual(expect.objectContaining({ classification: 'TEST_POLLUTION' }));
    expect(result.problems).toContainEqual(expect.objectContaining({ type: 'TEST_POLLUTION', failureClass: 'TEST_ISSUE' }));
    expect(result.problems.some((item) => item.failureClass === 'PRODUCT_BUG')).toBe(false);
  });

  it('历史 PASS 后偶发 FAIL 进入 FLAKY/Test Reliability，不得提升 READY/Coverage/Invariant', async () => {
    const server = await localServer();
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-flaky-'));
    const common = { markdown: FLAKY_REQUIREMENT, baseUrl: server.baseUrl, environment: 'local', mode: 'SAFE' as const,
      outDir: output, discoverProject: false };
    const stable = await runDevTest(common);
    expect(stable.conclusion).toBe('READY');
    server.behavior.flakyStatus = 400;
    const flaky = await runDevTest(common);
    expect(flaky.reliability.cases).toContainEqual(expect.objectContaining({ status: 'FLAKY' }));
    expect(flaky.problems).toContainEqual(expect.objectContaining({ type: 'FLAKY_TEST', failureClass: 'TEST_ISSUE' }));
    expect(flaky.problems.some((item) => item.failureClass === 'PRODUCT_BUG')).toBe(false);
    expect(flaky.acceptanceTraces).toContainEqual(expect.objectContaining({
      result: 'BLOCKED', classification: 'TEST_DESIGN_ERROR',
      execution: expect.objectContaining({ status: 'EXECUTED', rawStatus: 'FAIL' }),
    }));
    expect(flaky.deliveryCoverage.cases.blocked).toBeGreaterThanOrEqual(1);
    expect(flaky.requirementCoverage.coreCoverage).toBe(0);
    expect(flaky.requirementCoverage.coveredAc).not.toContain('AC-1');
    expect(flaky.invariants.some((invariant) => invariant.status === 'VERIFIED'
      && invariant.failedCaseIds?.some((caseId) => flaky.reliability.cases.some((item) => item.caseId === caseId)))).toBe(false);
    expect(flaky.conclusion).toBe('BLOCKED');
  });

  it('固定生成机器审计附件与七段单表开发交付 Markdown，且 schema/CSV/Markdown/HTML 稳定', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-report-'));
    const result = await runDevTest({
      docPath: 'tests/acceptance/fixtures/devtest-sample.md', mode: 'DRY_RUN',
      outDir: output, maxCases: 20,
    });
    expect(await readdir(result.artifacts.dir)).toEqual([
      'acceptance-summary.md', 'cases.csv', 'problems.md', 'report.html', 'report.json', '开发自测测试报告.md', '测试用例.md',
    ]);
    const json = JSON.parse(await readFile(result.artifacts.reportJson, 'utf8')) as Record<string, unknown>;
    expect(json).toEqual(expect.objectContaining({
      run: expect.objectContaining({ mode: 'DRY_RUN' }),
      feature: expect.any(Object), summary: expect.any(Object), dimensions: expect.any(Object),
      contracts: expect.any(Array), cases: expect.any(Array), problems: expect.any(Array), unknowns: expect.any(Array),
      oracleResults: expect.any(Array), adaptiveScores: expect.any(Object), negativeChecks: expect.any(Array),
      permissionMatrix: expect.any(Array), pollutionFindings: expect.any(Array), reliability: expect.any(Object),
      requirementQuality: expect.any(Object), rootCauseGraph: expect.any(Array),
      requirementModel: expect.any(Object), acceptanceTraces: expect.any(Array), deliveryCoverage: expect.any(Object),
    }));
    expect(Object.keys(json.dimensions as object)).toEqual(['api', 'functional', 'ui', 'dataIsolation', 'parameterValidation']);
    const csv = (await readFile(result.artifacts.casesCsv, 'utf8')).replace(/^\uFEFF/, '');
    expect(csv.split(/\r?\n/, 1)[0]).toBe('caseId,dimension,priority,core,coreKind,title,status,acceptanceResult,issueClassification,oracle,evidenceMissing,expected,actual,problemId,confidence,contract,executed,evidence,valueScore,selectionReason');
    const problems = await readFile(result.artifacts.problemsMd, 'utf8');
    expect(problems).toContain('# DevTest Problems');
    expect(problems).toContain('## Root Problems');
    expect(problems).toContain('## Unknowns');
    const acceptanceSummary = await readFile(result.artifacts.acceptanceSummaryMd, 'utf8');
    for (const heading of ['# Feature Acceptance', '## Result', '## Core Requirements', '## Business Flows',
      '## Invariants', '## Regression Guard', '## Risks', '## Developer Action', '## Execution Budget']) {
      expect(acceptanceSummary).toContain(heading);
    }
    const developerReport = await readFile(result.artifacts.developerSelfTestReportMd, 'utf8');
    const headings = ['## 1. 结论概览', '## 2. 需求与实现核对', '## 3. 用例执行清单', '## 4. 审查中发现的问题',
      '## 5. 自动化执行证据', '## 6. 未覆盖项与回归建议', '## 7. 发布判定'];
    const headingIndexes = headings.map((heading) => developerReport.indexOf(heading));
    expect(headingIndexes.every((index) => index >= 0)).toBe(true);
    expect(headingIndexes).toEqual([...headingIndexes].sort((left, right) => left - right));
    expect(developerReport.match(/^## /gm)).toHaveLength(7);
    expect(developerReport).not.toMatch(/<\/?(?:style|div|table|thead|tbody|tr|th|td|br|code|a|strong)\b/i);
    expect(developerReport.match(/^\|\s*:?-{3,}/gm)).toHaveLength(7);
    expect(developerReport).toContain('测试人：DevTest Agent');
    expect(developerReport).toContain('测试设计（无真实执行证据；未产生静态缺陷分析证据，DRY_RUN）');
    expect(developerReport).toContain('PASS/FAIL 只来自真实执行、确定性 Oracle 与完整 Evidence');
    const statistic = /^\| 用例统计 \| (\d+) \| PASS (\d+)；FAIL (\d+)；BLOCKED (\d+)；NOT_EXECUTED (\d+) \|$/m.exec(developerReport);
    expect(statistic).not.toBeNull();
    expect(Number(statistic![1])).toBe(Number(statistic![2]) + Number(statistic![3]) + Number(statistic![4]) + Number(statistic![5]));
    const caseDocument = await readFile(result.artifacts.testCasesMd, 'utf8');
    expect(caseDocument).not.toMatch(/<\/?(?:style|div|table|thead|tbody|tr|th|td|br|code|a|strong)\b/i);
    expect(caseDocument.match(/^\|\s*:?-{3,}/gm)).toHaveLength(1);
    const caseSection = developerReport.split('## 3. 用例执行清单')[1].split('## 4. 审查中发现的问题')[0];
    const markdownCells = (line: string) => {
      const cells: string[] = [];
      let current = '';
      let escaped = false;
      for (const character of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
        if (escaped) {
          current += character;
          escaped = false;
        } else if (character === '\\') escaped = true;
        else if (character === '|') {
          cells.push(current.trim());
          current = '';
        } else current += character;
      }
      cells.push(current.trim());
      return cells;
    };
    const tableCells = (source: string) => source.split('\n').filter((line) => /^\|.*\|$/.test(line.trim()))
      .map(markdownCells).filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
    const reportCaseRows = tableCells(caseSection).slice(1);
    const reportStatuses = reportCaseRows.map((cells) => cells[3]);
    const traceIds = result.acceptanceTraces.map((trace) => trace.caseId).sort();
    const reportIds = reportCaseRows.map((cells) => cells[0]).sort();
    const documentRows = tableCells(caseDocument).slice(1);
    const documentIds = documentRows.map((cells) => cells[0]).sort();
    expect(reportCaseRows).toHaveLength(Number(statistic![1]));
    expect(reportCaseRows).toHaveLength(result.deliveryCoverage.cases.generated);
    expect(reportIds).toEqual(traceIds);
    expect(documentIds).toEqual(traceIds);
    expect(reportStatuses.filter((status) => status === 'PASS')).toHaveLength(Number(statistic![2]));
    expect(reportStatuses.filter((status) => status === 'FAIL')).toHaveLength(Number(statistic![3]));
    expect(reportStatuses.filter((status) => status === 'BLOCKED')).toHaveLength(Number(statistic![4]));
    expect(reportStatuses.filter((status) => status === 'NOT_EXECUTED')).toHaveLength(Number(statistic![5]));
    for (const section of ['Business Scenario', 'Preconditions / Test Data', 'Steps', 'Expected Result / Assertion / Oracle',
      'Evidence Required', 'Cleanup / Dependency']) expect(caseDocument).toContain(section);
    expect(documentRows.every((cells) => ['PASS', 'FAIL', 'BLOCKED', 'NOT_EXECUTED'].includes(cells[3]))).toBe(true);
    const html = await readFile(result.artifacts.reportHtml, 'utf8');
    expect(json.schema).toBe('devtest.report.v8');
    for (const heading of ['最终结论', 'Test Reliability', 'Requirement Quality', 'Adaptive Selection', 'Root Cause Graph',
      'Requirement Coverage Matrix', 'Business Invariants', 'Environment Preflight', 'Problems', 'Test Cases',
      'Coverage', 'Baseline Diff', 'Versions & Data Lifecycle', 'Unknowns', 'Technical Details']) {
      expect(html).toContain(heading);
    }
  }, 15_000);

  it('--rerun 使用同一 Requirement Baseline 并输出差异', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-rerun-'));
    const first = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, mode: 'DRY_RUN', outDir: output, discoverProject: false,
    });
    const second = await runDevTest({
      markdown: SAFE_READ_REQUIREMENT, mode: 'DRY_RUN', outDir: output, discoverProject: false, rerun: true,
    });
    expect(second.baseline.baselineRunId).toBe(first.runId);
    expect(second.baseline.rerunCaseIds.length).toBeGreaterThan(0);
    const report = JSON.parse(await readFile(second.artifacts.reportJson, 'utf8')) as { baseline: { baselineRunId?: string } };
    expect(report.baseline.baselineRunId).toBe(first.runId);
  });

  it('Wan3/VideoHub 真实需求覆盖五维，并因未知 submit Contract fail-closed', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'devtest-wan3-'));
    const result = await runDevTest({
      docPath: 'tests/acceptance/fixtures/wan3-devtest.md',
      mode: 'DRY_RUN',
      outDir: output,
      maxCases: 20,
    });

    expect(result.dimensionApplicability.every((item) => item.candidateCases > 0)).toBe(true);
    expect(result.pipeline.contracts.resolutions.map((item) => item.query.id)).toEqual(expect.arrayContaining([
      'model.wan3', 'enum.wan3.workflow', 'api.videohub.submit',
    ]));
    expect(result.pipeline.contracts.resolutions.find((item) => item.query.id === 'api.videohub.submit')?.status)
      .not.toBe('RESOLVED');
    expect(result.problems.some((problem) => problem.type === 'UNKNOWN_CONTRACT')).toBe(true);
    expect(result.pipeline.summary.passed).toBe(0);
    expect(result.conclusion).toBe('BLOCKED');
    const report = JSON.parse(await readFile(result.artifacts.reportJson, 'utf8')) as {
      contracts: Array<{ id?: string; version?: string; fingerprint?: string }>;
      cases: Array<{ contractDependencies?: Array<{ contractId?: string; version?: string; fingerprint?: string }> }>;
      unknowns: Array<{ type: string }>;
    };
    expect(report.contracts.find((contract) => contract.id === 'api.videohub.submit')).toEqual(expect.objectContaining({
      version: expect.any(String), fingerprint: expect.any(String),
    }));
    expect(report.cases.every((item) => item.contractDependencies?.every((dependency) =>
      Boolean(dependency.contractId && dependency.version && dependency.fingerprint)))).toBe(true);
    expect(report.unknowns.map((item) => item.type)).toEqual(expect.arrayContaining([
      'UNKNOWN_CONTRACT', 'UNKNOWN_BILLING', 'UNKNOWN_PROVIDER', 'UNKNOWN_UI',
    ]));
  });
});
