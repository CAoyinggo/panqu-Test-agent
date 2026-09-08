import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { runAcceptanceCli } from '../../src/acceptance/acceptance-cli.js';
import { startFakeApiServer, type FakeApiServer } from './helpers/fake-api-server.js';

const fixturePath = fileURLToPath(new URL('./fixtures/user-profile.md', import.meta.url));
let server: FakeApiServer | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function createConfig(baseUrl: string): { configPath: string; output: string } {
  tempRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-handoff-'));
  const output = path.join(tempRoot, 'reports');
  const configPath = path.join(tempRoot, 'acceptance.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    project: 'user-service',
    environment: 'local',
    mode: 'execute',
    output,
    baseUrl,
    timeoutMs: 500,
    operationPolicies: {
      'PUT /api/users/{id}': { effect: 'WRITE', reason: 'fake local fixture' },
      'POST /echo/{resourceKey}': { effect: 'READ', reason: 'fake echo endpoint has no persisted side effect' },
      'GET /status/404': { effect: 'READ', reason: 'fake read-only status endpoint' },
      'GET /status/200': { effect: 'READ', reason: 'fake read-only status endpoint' },
    },
    actorHeaders: {
      'user-a': { Authorization: 'Bearer token-user-a' },
      'user-b': { Authorization: 'Bearer token-user-b' },
      admin: { Authorization: 'Bearer token-admin' },
      'tenant-b-user': { Authorization: 'Bearer token-tenant-b-user' },
    },
    dataLifecycle: {
      prepare: { method: 'POST', path: '/test-support/prepare' },
      cleanup: { method: 'POST', path: '/test-support/cleanup' },
    },
  }, null, 2));
  return { configPath, output };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function caseForCriterion(
  cases: TestCase[],
  criterionId: string,
  operationKey?: string,
): TestCase {
  const testCase = cases.find((candidate) =>
    candidate.source?.acceptanceCriteriaIds.includes(criterionId)
    && (!operationKey || candidate.source?.apiOperationKey === operationKey));
  expect(testCase, `missing archived Case for ${criterionId}${operationKey ? ` / ${operationKey}` : ''}`).toBeDefined();
  return testCase!;
}

function resultForCase<T extends { caseId: string }>(results: T[], caseId: string): T {
  const result = results.find((candidate) => candidate.caseId === caseId);
  expect(result, `missing archived Result for ${caseId}`).toBeDefined();
  return result!;
}

describe('Developer Handoff E2E', () => {
  it('runs one entry, creates an isolated Run directory, cleans data and produces delivery reports', async () => {
    server = await startFakeApiServer();
    const { configPath, output } = createConfig(server.baseUrl);

    const first = await runAcceptanceCli(['--requirement', fixturePath, '--config', configPath]);
    // AC-5/AC-7 are denied writes. Without a state observer they stay
    // DESIGNED_ONLY/NOT_EXECUTED; the mixed handoff is PARTIAL, never PASS.
    expect(first).toMatchObject({ exitCode: 3, conclusion: 'PARTIAL', summary: { failed: 0 } });
    expect(first.summary!.passed).toBeGreaterThan(0);
    expect(first.summary!.notExecuted).toBeGreaterThan(0);
    expect(first.summary!.total).toBe(
      first.summary!.passed + first.summary!.failed + first.summary!.blocked + first.summary!.notExecuted,
    );
    expect(first.runId).toMatch(/^RUN-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.artifacts && Object.values(first.artifacts).every((file) => fs.existsSync(file))).toBe(true);
    expect(server.lifecycle).toEqual({ prepared: 1, cleaned: 1 });
    expect(server.users()['user-a']).toMatchObject({ nickname: 'Alice', age: 20 });

    const reportText = fs.readFileSync(first.artifacts!.reportJson, 'utf8');
    const executionText = fs.readFileSync(first.artifacts!.execution, 'utf8');
    const requirementText = fs.readFileSync(first.artifacts!.requirementIr, 'utf8');
    for (const artifact of [reportText, executionText]) {
      expect(artifact).not.toContain('token-user-a');
      expect(artifact).not.toContain('developer@example.com');
      expect(artifact).not.toContain('13800138000');
      expect(artifact).not.toContain('"userId": "user-a"');
      expect(artifact).not.toContain('"tenantId": "tenant-a"');
      expect(artifact).not.toContain(server.baseUrl);
    }
    expect(requirementText).toContain('"authPolicy": "AUTH_REQUIRED"');
    expect(requirementText).not.toContain('token-user-a');
    expect(reportText).toContain('[CONFIGURED_BASE_URL]');

    const archivedCases = readJson<TestCase[]>(first.artifacts!.testCases);
    const archivedExecution = readJson<{ results: Array<{ caseId: string; status: string; executed: boolean }> }>(first.artifacts!.execution);
    const designedOnlyCases = archivedCases.filter((testCase) => testCase.executionMode === 'DESIGNED_ONLY');
    expect(designedOnlyCases.length).toBeGreaterThan(0);
    expect(designedOnlyCases.every((testCase) => {
      const result = resultForCase(archivedExecution.results, testCase.id);
      const quality = testCase.metadata?.caseQuality as { status?: string } | undefined;
      const expectedStatus = quality?.status === 'BLOCKED' ? 'BLOCKED' : 'NOT_EXECUTED';
      return result.status === expectedStatus && result.executed === false;
    })).toBe(true);

    const second = await runAcceptanceCli(['--requirement', fixturePath, '--config', configPath]);
    expect(second).toMatchObject({ exitCode: 3, conclusion: 'PARTIAL', summary: { failed: 0 } });
    expect(second.runId).not.toBe(first.runId);
    expect(second.artifacts?.runDirectory).not.toBe(first.artifacts?.runDirectory);
    expect(fs.existsSync(first.artifacts!.reportMarkdown)).toBe(true);
    expect(fs.existsSync(second.artifacts!.reportMarkdown)).toBe(true);
    expect(server.lifecycle).toEqual({ prepared: 2, cleaned: 2 });
    expect(server.users()['user-a']).toMatchObject({ nickname: 'Alice', age: 20 });

    const lifecycleBeforeRegression = { ...server.lifecycle };
    const requestsBeforeRegression = server.requests.length;
    await expect(runAcceptanceCli([
      '--run-id', second.runId!, '--regression', '--output', output, '--config', configPath,
    ])).rejects.toThrow('ARCHIVE_REPLAY_UNSAFE');
    expect(server.lifecycle).toEqual(lifecycleBeforeRegression);
    expect(server.requests).toHaveLength(requestsBeforeRegression);
  }, 15_000);

  it('reproduces a real product FAIL by Run ID + Case ID without creating defects for infrastructure states', async () => {
    server = await startFakeApiServer();
    const { configPath, output } = createConfig(server.baseUrl);
    const requirementPath = path.join(tempRoot!, 'safe-product-failure.md');
    fs.writeFileSync(requirementPath, `# Product mismatch
GET /status/200
该接口无需认证
返回 201
AC-1 GET /status/200 返回 201`);
    const failed = await runAcceptanceCli(['--requirement', requirementPath, '--config', configPath]);
    expect(failed).toMatchObject({ exitCode: 1, conclusion: 'FAIL' });
    expect(failed.summary!.failed).toBeGreaterThan(0);
    const failedCases = readJson<TestCase[]>(failed.artifacts!.testCases);
    const productCase = caseForCriterion(failedCases, 'AC-1', 'GET /status/200');
    const defects = readJson<Array<{ runId: string; caseId: string; request: { headers: Record<string, string>; url: string } }>>(failed.artifacts!.defects);
    expect(defects.length).toBeGreaterThan(0);
    const productDefect = defects.find((defect) => defect.caseId === productCase.id);
    expect(productDefect).toMatchObject({ runId: failed.runId, caseId: productCase.id });
    expect(productDefect?.request.url).toContain('[CONFIGURED_BASE_URL]');

    const rerun = await runAcceptanceCli([
      '--run-id', failed.runId!, '--case-id', productCase.id, '--output', output, '--config', configPath,
    ]);
    expect(rerun).toMatchObject({ exitCode: 1, conclusion: 'FAIL', summary: { total: 1, failed: 1 } });
    expect(rerun.runId).not.toBe(failed.runId);
    const manifest = readJson<{ parentRunId: string; selectedCaseIds: string[] }>(rerun.artifacts!.manifest);
    expect(manifest).toMatchObject({ parentRunId: failed.runId, selectedCaseIds: [productCase.id] });

    const regression = await runAcceptanceCli([
      '--run-id', failed.runId!, '--regression', '--output', output, '--config', configPath,
    ]);
    expect(regression).toMatchObject({
      exitCode: 1,
      conclusion: 'FAIL',
      regression: {
        strategy: 'FACT_BASED_REGRESSION_V1',
        seedCaseIds: [productCase.id],
        affectedCaseIds: expect.arrayContaining([productCase.id]),
      },
    });
    const regressionManifest = readJson<{
      parentRunId: string;
      selectedCaseIds: string[];
      regressionPlan: { strategy: string; affectedCaseIds: string[] };
    }>(regression.artifacts!.manifest);
    expect(regressionManifest.parentRunId).toBe(failed.runId);
    expect([...regressionManifest.selectedCaseIds].sort()).toEqual([...regression.regression!.affectedCaseIds].sort());
    expect(regressionManifest.regressionPlan).toMatchObject({
      strategy: 'FACT_BASED_REGRESSION_V1',
      affectedCaseIds: regression.regression!.affectedCaseIds,
    });
    const regressionReport = readJson<{
      regression: { available: boolean; plan: { seedCaseIds: string[]; affectedFactIds: string[]; affectedCaseIds: string[] } };
    }>(regression.artifacts!.reportJson);
    expect(regressionReport.regression).toMatchObject({
      available: true,
      plan: {
        seedCaseIds: [productCase.id],
        affectedFactIds: expect.any(Array),
        affectedCaseIds: expect.arrayContaining([productCase.id]),
      },
    });
    expect(regressionReport.regression.plan.affectedFactIds.length).toBeGreaterThan(0);
    expect(server.lifecycle).toEqual({ prepared: 3, cleaned: 3 });

    const driftedArchive = structuredClone(failedCases);
    const driftedProductCase = driftedArchive.find((testCase) => testCase.id === productCase.id)!;
    const driftedStep = driftedProductCase.steps.find((step) => step.type === 'HTTP_REQUEST');
    expect(driftedStep).toBeDefined();
    driftedStep!.url = '/status/201';
    fs.writeFileSync(failed.artifacts!.testCases, JSON.stringify(driftedArchive, null, 2));
    const lifecycleBeforeDriftedRegression = { ...server.lifecycle };
    const requestsBeforeDriftedRegression = server.requests.length;
    await expect(runAcceptanceCli([
      '--run-id', failed.runId!, '--regression', '--output', output, '--config', configPath,
    ])).rejects.toThrow('ARCHIVE_REPLAY_MISMATCH');
    expect(server.lifecycle).toEqual(lifecycleBeforeDriftedRegression);
    expect(server.requests).toHaveLength(requestsBeforeDriftedRegression);
  });

  it('closes the developer loop by rerunning affected Facts after the product is fixed', async () => {
    server = await startFakeApiServer({ forcedStatuses: { '/status/200': 201 } });
    const { configPath, output } = createConfig(server.baseUrl);
    const requirementPath = path.join(tempRoot!, 'status-fix-regression.md');
    fs.writeFileSync(requirementPath, `# Status fix regression
GET /status/200
该接口无需认证
返回 200
AC-1 GET /status/200 必须返回 200。`);
    const failed = await runAcceptanceCli(['--requirement', requirementPath, '--config', configPath]);
    expect(failed).toMatchObject({ exitCode: 1, conclusion: 'FAIL' });
    expect(failed.summary!.failed).toBeGreaterThan(0);
    const failedReport = readJson<{
      regression: { available: boolean; plan: { seedCaseIds: string[]; affectedFactIds: string[] } };
    }>(failed.artifacts!.reportJson);
    expect(failedReport.regression.available).toBe(true);
    expect(failedReport.regression.plan.seedCaseIds.length).toBeGreaterThan(0);
    expect(failedReport.regression.plan.affectedFactIds.length).toBeGreaterThan(0);

    await server.close();
    server = undefined;
    server = await startFakeApiServer();
    const fixedConfig = createConfig(server.baseUrl);
    const fixed = await runAcceptanceCli([
      '--run-id', failed.runId!, '--regression', '--output', output, '--config', fixedConfig.configPath,
    ]);
    expect(fixed.summary!.failed).toBe(0);
    expect(fixed.summary!.total).toBeGreaterThan(fixed.summary!.notExecuted);
    expect(fixed.regression).toMatchObject({
      strategy: 'FACT_BASED_REGRESSION_V1',
      seedCaseIds: failedReport.regression.plan.seedCaseIds,
      affectedFactIds: expect.arrayContaining(failedReport.regression.plan.affectedFactIds),
    });
    const fixedExecution = readJson<{
      results: Array<{ status: string; executed: boolean; evidence: { assertions: unknown[] } }>;
    }>(fixed.artifacts!.execution);
    const executed = fixedExecution.results.filter((result) => result.executed);
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.every((result) => result.status === 'PASS' && result.evidence.assertions.length > 0)).toBe(true);
    const fixedReport = readJson<{
      conclusion: string;
      regression: { available: boolean; plan: { affectedFactIds: string[]; affectedCaseIds: string[] } };
    }>(fixed.artifacts!.reportJson);
    expect(fixedReport.conclusion).not.toBe('FAIL');
    expect(fixedReport.conclusion).not.toBe('BLOCKED');
    expect(fixedReport.regression).toMatchObject({
      available: true,
      plan: {
        affectedFactIds: expect.arrayContaining(failedReport.regression.plan.affectedFactIds),
        affectedCaseIds: expect.arrayContaining(fixed.regression!.affectedCaseIds),
      },
    });
    expect(server.lifecycle).toEqual({ prepared: 1, cleaned: 1 });
  });

  it('reruns a multi-API Case with the same explicit ApiSpec binding', async () => {
    server = await startFakeApiServer();
    const { configPath, output } = createConfig(server.baseUrl);
    const requirementPath = path.join(tempRoot!, 'multi-api.md');
    fs.writeFileSync(requirementPath, `# Multi API
POST /echo/{resourceKey} 无需认证
GET /status/404 无需认证
## Acceptance Criteria
AC-1 POST /echo/{resourceKey} 创建成功返回 200
    AC-2 GET /status/404 查询不存在返回 404`);

    const first = await runAcceptanceCli(['--requirement', requirementPath, '--config', configPath]);
    expect(first).toMatchObject({ exitCode: 3, conclusion: 'PARTIAL', summary: { failed: 0 } });
    expect(first.summary!.passed).toBeGreaterThan(0);
    expect(first.summary!.notExecuted).toBeGreaterThan(0);
    expect(readJson(first.artifacts!.manifest)).toMatchObject({
      schemaVersion: 3,
      replaySafety: 'SAFE',
      caseIdentityPolicy: 'SEMANTIC_SHA256_V2',
      executionPlan: {
        version: 'ACCEPTANCE_EXECUTION_PLAN_V2',
        caseIdentityPolicy: 'SEMANTIC_SHA256_V2',
        requirementDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const firstReport = readJson<{ coverage: { operationContractEvidenceCoverage: number } }>(first.artifacts!.reportJson);
    expect(firstReport.coverage.operationContractEvidenceCoverage).toBe(100);
    const firstCases = readJson<TestCase[]>(first.artifacts!.testCases);
    const createCase = caseForCriterion(firstCases, 'AC-1', 'POST /echo/{resourceKey}');
    const missingCase = caseForCriterion(firstCases, 'AC-2', 'GET /status/404');
    expect(createCase).toMatchObject({ executionMode: 'DESIGNED_ONLY' });
    expect(createCase.steps.length).toBeGreaterThan(0);
    expect(createCase.steps.every((step) => step.execution === 'PLANNED')).toBe(true);
    expect(missingCase.executionMode).toBe('EXECUTABLE');
    const firstExecution = readJson<{ results: Array<{ caseId: string; status: string; executed: boolean }> }>(first.artifacts!.execution);
    expect(resultForCase(firstExecution.results, createCase.id)).toMatchObject({ status: 'NOT_EXECUTED', executed: false });
    expect(resultForCase(firstExecution.results, missingCase.id)).toMatchObject({ status: 'PASS', executed: true });
    const firstRequests = server.requests.filter((request) => !request.url.includes('/test-support/'));
    expect(firstRequests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['GET /status/404']);

    const requestCountBeforeRerun = server.requests.length;
    const rerun = await runAcceptanceCli([
      '--run-id', first.runId!, '--case-id', missingCase.id, '--output', output, '--config', configPath,
    ]);
    expect(rerun).toMatchObject({ exitCode: 3, conclusion: 'PARTIAL', summary: { total: 1, passed: 1 } });
    const rerunCases = readJson<TestCase[]>(rerun.artifacts!.testCases);
    const replayedCase = rerunCases.find((testCase) => testCase.id === missingCase.id);
    expect(replayedCase).toMatchObject({
      source: { apiSpecId: expect.stringMatching(/^API-[A-F0-9]{12}$/), apiOperationKey: 'GET /status/404' },
      steps: [{ method: 'GET', url: '/status/404' }],
    });
    const rerunRequest = server.requests.slice(requestCountBeforeRerun)
      .find((request) => !request.url.includes('/test-support/'));
    expect(rerunRequest).toBeDefined();
    expect(`${rerunRequest?.method} ${new URL(rerunRequest!.url).pathname}`).toBe('GET /status/404');
  });

  it('fails closed before lifecycle when an archive drifts or predates stable Operation Identity', async () => {
    server = await startFakeApiServer();
    const { configPath, output } = createConfig(server.baseUrl);
    const requirementPath = path.join(tempRoot!, 'replay-safety.md');
    fs.writeFileSync(requirementPath, '# Replay\nGET /status/200\n该接口无需认证\nAC-1 GET /status/200 返回 200');
    const first = await runAcceptanceCli(['--requirement', requirementPath, '--config', configPath]);
    const testCasesFile = first.artifacts!.testCases;
    const archived = readJson<TestCase[]>(testCasesFile);
    const replayCase = caseForCriterion(archived, 'AC-1', 'GET /status/200');
    const lifecycleBefore = { ...server.lifecycle };
    const requestsBefore = server.requests.length;

    const drifted = structuredClone(archived);
    const driftedCase = drifted.find((testCase) => testCase.id === replayCase.id)!;
    const driftedStep = driftedCase.steps.find((step) =>
      step.type === 'HTTP_REQUEST' && step.method === 'GET' && step.url === '/status/200');
    expect(driftedStep).toBeDefined();
    driftedStep!.url = '/status/201';
    fs.writeFileSync(testCasesFile, JSON.stringify(drifted, null, 2));
    await expect(runAcceptanceCli([
      '--run-id', first.runId!, '--case-id', replayCase.id, '--output', output, '--config', configPath,
    ])).rejects.toThrow('ARCHIVE_REPLAY_MISMATCH');
    expect(server.lifecycle).toEqual(lifecycleBefore);
    expect(server.requests).toHaveLength(requestsBefore);

    const legacy = structuredClone(archived);
    const legacyCase = legacy.find((testCase) => testCase.id === replayCase.id)!;
    delete legacyCase.source!.apiOperationKey;
    fs.writeFileSync(testCasesFile, JSON.stringify(legacy, null, 2));
    await expect(runAcceptanceCli([
      '--run-id', first.runId!, '--case-id', replayCase.id, '--output', output, '--config', configPath,
    ])).rejects.toThrow('必须迁移或重新建立基线');
    expect(server.lifecycle).toEqual(lifecycleBefore);
    expect(server.requests).toHaveLength(requestsBefore);

    const manifestFile = first.artifacts!.manifest;
    const manifestWithoutPlan = readJson<Record<string, unknown>>(manifestFile);
    delete manifestWithoutPlan.caseIdentityPolicy;
    delete manifestWithoutPlan.executionPlan;
    fs.writeFileSync(manifestFile, JSON.stringify(manifestWithoutPlan, null, 2));
    await expect(runAcceptanceCli([
      '--run-id', first.runId!, '--case-id', replayCase.id, '--output', output, '--config', configPath,
    ])).rejects.toThrow('缺少稳定 Case Identity / Execution Plan Digest');
    expect(server.lifecycle).toEqual(lifecycleBefore);
    expect(server.requests).toHaveLength(requestsBefore);
  });

  it('never replays a requirement whose archived input was changed by redaction', async () => {
    server = await startFakeApiServer();
    const { configPath, output } = createConfig(server.baseUrl);
    const requirementPath = path.join(tempRoot!, 'redacted-replay.md');
    fs.writeFileSync(requirementPath, `# Redacted replay
GET /status/200
该接口无需认证
通知邮箱为 developer@example.com
AC-1 GET /status/200 返回 200`);

    const first = await runAcceptanceCli(['--requirement', requirementPath, '--config', configPath]);
    const manifest = readJson<{ schemaVersion: number; replaySafety: string }>(first.artifacts!.manifest);
    expect(manifest).toMatchObject({ schemaVersion: 3, replaySafety: 'BLOCKED_REDACTED_INPUT' });
    const archived = readJson<TestCase[]>(first.artifacts!.testCases);
    const replayCase = caseForCriterion(archived, 'AC-1', 'GET /status/200');
    const lifecycleBefore = { ...server.lifecycle };
    const requestsBefore = server.requests.length;

    await expect(runAcceptanceCli([
      '--run-id', first.runId!, '--case-id', replayCase.id, '--output', output, '--config', configPath,
    ])).rejects.toThrow('ARCHIVE_REPLAY_UNSAFE');
    expect(server.lifecycle).toEqual(lifecycleBefore);
    expect(server.requests).toHaveLength(requestsBefore);
  });
});
