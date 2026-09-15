import { createServer, type Server } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevTestMcpService, DEVTEST_MCP_TOOL } from '../../src/devtest/mcp-service.js';
import { initializeDevTestProject } from '../../src/devtest/cli-config.js';
import { initializeDevTestTrae, DEVTEST_BUNDLED_SKILLS } from '../../src/devtest/trae-setup.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(requirement = '# 资源查询\n## API\nGET /resources\n无需认证。\n返回 200。\n## Acceptance Criteria\nAC-1 GET /resources 查询资源返回 HTTP 200。\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devtest-mcp-'));
  directories.push(root);
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await initializeDevTestProject({ root, github: false });
  await mkdir(path.join(root, 'requirements'));
  await writeFile(path.join(root, 'requirements', 'feature.md'), requirement);
  vi.stubEnv('DEVTEST_BASE_URL', '');
  vi.stubEnv('TESTFLOW_BASE_URL', '');
  vi.stubEnv('TEST_BASE_URL', '');
  vi.stubEnv('DEVTEST_RUNTIME_MODULE', '');
  vi.stubEnv('DEVTEST_ACTOR_HEADERS_JSON', '');
  return { root, service: new DevTestMcpService(root) };
}

async function httpService() {
  let responseStatus = 200;
  const requests: string[] = [];
  // Independent implementation: never reads test cases, assertions or expected values.
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.statusCode = request.url === '/health' ? 200 : responseStatus;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ resources: [{ id: 'resource-a', owner: 'user-a' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  vi.stubEnv('DEVTEST_BASE_URL', `http://127.0.0.1:${port}`);
  return { requests, fail: (status = 201) => { responseStatus = status; } };
}

function execution(plan: Record<string, unknown>, key = 'attempt_1') {
  return { action: 'execute', plan_id: plan.plan_id, expected_plan_hash: plan.plan_hash, idempotency_key: key };
}

describe('Trae MCP → actual DevTest Generator/Quality Gate/Execution/Evidence', () => {
  it('executes the returned confirmation arguments directly and recovers them unchanged without duplicate requests', async () => {
    const { service } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.next_action, JSON.stringify({ counts: plan.counts, readiness: plan.readiness, selected: plan.selected_case_ids, next: plan.next_action })).toMatchObject({ kind: 'CONFIRM_EXECUTION', requires_user_confirmation: true });
    const next = plan.next_action as { execute_arguments: Record<string, unknown>; status_arguments: Record<string, unknown> };
    expect(server.requests).toEqual([]);
    const recovered = await service.call(next.status_arguments);
    expect(recovered.next_action).toEqual(plan.next_action);
    // Represents dispatch after an external user has confirmed the displayed plan.
    const result = await service.call(next.execute_arguments);
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ passed: 1, executed: 1 });
    expect(result.next_action).toMatchObject({ kind: 'REVIEW_RESULT' });
    const requestCount = server.requests.length;
    expect((await service.call(next.execute_arguments)).replayed).toBe(true);
    expect(server.requests).toHaveLength(requestCount);
  });

  it('execution approval cannot confirm a pending requirement; status and artifacts retain the gap', async () => {
    const { service, root } = await fixture('# 资源查询\n## API\nGET /resources\n无需认证。\n返回 200。\n## Acceptance Criteria\nAC-1 GET /resources 返回 HTTP 200（待确认）。\n');
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.ok).toBe(true); expect(server.requests).toEqual([]);
    expect(plan.next_action).toMatchObject({ kind: 'CLARIFY_REQUIREMENTS' });
    expect(plan.next_action).not.toHaveProperty('execute_arguments');
    expect(plan.requirement_assurance).toMatchObject({ status: 'BLOCKED', entries: expect.arrayContaining([
      expect.objectContaining({ status: 'NEEDS_CONFIRMATION', question: expect.any(String), source: { documentId: expect.any(String), section: expect.any(String), line: 7, lineStart: 7, lineEnd: 7, content: expect.any(String), text: expect.any(String) } }),
    ]) });
    const result = await service.call(execution(plan));
    expect(result.conclusion).toBe('BLOCKED');
    expect(result.counts).toMatchObject({ executed: 0, verified: 0, passed: 0 });
    expect(result.requirement_assurance).toMatchObject({ status: 'BLOCKED' });
    const status = await service.call({ action: 'status', plan_id: plan.plan_id });
    expect(status.requirement_assurance).toEqual(result.requirement_assurance);
    const report = JSON.parse(await readFile(path.resolve(root, (result.paths as { reportJson: string }).reportJson), 'utf8'));
    expect(report.requirementAssurance.status).toBe('BLOCKED');
    expect(report.requirementAssurance.entries.some((entry: { status: string }) => entry.status === 'NEEDS_CONFIRMATION')).toBe(true);
  });

  it('plans with zero requests, executes independent HTTP results, and retries without repeating requests', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.status).toBe('NOT_EXECUTED');
    expect(plan.plan).toMatchObject({ feature: expect.any(String), risk: expect.any(String) });
    expect(plan.execution_estimate).toMatchObject({ readFailureConfirmation: { enabled: true, maxAttemptsPerCase: 2 } });
    expect((plan.selected_case_ids as string[]).length).toBeGreaterThan(0);
    expect(plan.requirement_coverage).toHaveProperty('behaviors');
    expect(plan.unknowns).toBeInstanceOf(Array);
    expect(server.requests).toEqual([]);
    expect((plan.counts as { executed: number }).executed).toBe(0);
    const result = await service.call(execution(plan));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result.counts as { executed: number }).executed).toBeGreaterThan(0);
    expect((result.counts as { passed: number }).passed).toBeGreaterThan(0);
    expect(result.data_lifecycle).toHaveProperty('cleanupStatus');
    const evidenceFile = (result.paths as { evidenceJson: string }).evidenceJson;
    const evidence = JSON.parse(await readFile(path.resolve(root, evidenceFile), 'utf8'));
    expect(evidence.executions.some((item: { executed: boolean }) => item.executed)).toBe(true);
    const requestCount = server.requests.length;
    const replay = await service.call(execution(plan));
    expect(replay.replayed).toBe(true);
    expect(server.requests).toHaveLength(requestCount);
    const status = await service.call({ action: 'status', plan_id: plan.plan_id });
    expect(status.run_id).toBe(result.run_id);
    const newKey = await service.call(execution(plan, 'different_attempt'));
    expect(newKey.ok).toBe(false);
    expect(newKey.message).toContain('PLAN_ALREADY_EXECUTED');
  });

  it('detects a real incorrect HTTP response and retains its actual status as evidence', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    server.fail();
    const result = await service.call(execution(plan));
    expect((result.counts as { failed: number }).failed, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.conclusion).not.toBe('READY');
    const evidence = await readFile(path.resolve(root, (result.paths as { evidenceJson: string }).evidenceJson), 'utf8');
    expect(evidence).toContain('201');
    expect(evidence).toContain('FAIL');
  });

  it('retains HTTP 5xx evidence without guessing a product root cause or reporting PASS', async () => {
    const { service } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    server.fail(503);
    const result = await service.call(execution(plan));
    expect(result.counts).toMatchObject({ executed: 1, passed: 0, verified: 0 });
    expect(result.oracle).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: 'UNKNOWN', transientSignal: 'HTTP_5XX' })]));
  });

  it('rejects changed requirements, source and plan hash before making any request', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    const wrongHash = await service.call({ ...execution(plan), expected_plan_hash: '0'.repeat(64) });
    expect(wrongHash.message).toContain('STALE_PLAN');
    await writeFile(path.join(root, 'new-route.ts'), 'export const route = "changed";');
    const changedSource = await service.call(execution(plan));
    expect(changedSource.message).toContain('STALE_PLAN');
    const newPlan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    await writeFile(path.join(root, 'requirements', 'feature.md'), '# Requirement changed');
    expect((await service.call(execution(newPlan))).message).toContain('STALE_PLAN');
    expect(server.requests).toEqual([]);
  });

  it('invalidates an approved plan on a Vue-only edit before all HTTP work', async () => {
    const { service, root } = await fixture(); const server = await httpService();
    await writeFile(path.join(root, 'Panel.vue'), '<template><button>old</button></template>');
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    await writeFile(path.join(root, 'Panel.vue'), '<template><button>new</button></template>');
    expect((await service.call(execution(plan))).message).toContain('STALE_PLAN');
    expect(server.requests).toEqual([]);
  });

  it('keeps missing runtime BLOCKED with no verified cases instead of inventing PASS', async () => {
    const { service } = await fixture();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    const result = await service.call(execution(plan));
    expect(result.conclusion, JSON.stringify(result)).toBe('BLOCKED');
    expect(result.counts).toMatchObject({ executed: 0, verified: 0, passed: 0 });
  });

  it('rejects changed operator targets and a persisted project lock without sending requests', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    vi.stubEnv('DEVTEST_BASE_URL', 'http://127.0.0.1:1');
    expect((await service.call(execution(plan))).message).toContain('STALE_PLAN');
    await writeFile(path.join(root, 'devtest-results', '.mcp', 'execution.lock'), '');
    const competingProcess = new DevTestMcpService(root);
    expect((await competingProcess.call(execution(plan))).message).toContain('RUN_IN_PROGRESS');
    expect((await competingProcess.call({ action: 'status', plan_id: plan.plan_id })).status).toBe('NOT_EXECUTED');
    expect(server.requests).toEqual([]);
  });

  it.each([undefined, 'NO_SILENT_REQUIREMENT_GAPS_V1'])('rejects a previously confirmed plan with old policy %s', async (oldPolicy) => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    const file = path.join(root, 'devtest-results', '.mcp', `${plan.plan_id}.json`);
    const { executionPolicy: _policy, planHash: _hash, preview, ...oldUnsigned } = JSON.parse(await readFile(file, 'utf8'));
    if (oldPolicy !== undefined) oldUnsigned.executionPolicy = oldPolicy;
    const oldHash = createHash('sha256').update(JSON.stringify(oldUnsigned)).digest('hex');
    await writeFile(file, JSON.stringify({ ...oldUnsigned, planHash: oldHash, preview }));
    const result = await service.call(execution({ ...plan, plan_hash: oldHash }));
    expect(result.message).toContain('STALE_PLAN: execution policy changed');
    expect(server.requests).toEqual([]);
  });

  it('rejects edited runtime module contents even in ignored dist output', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    await mkdir(path.join(root, 'dist'));
    const runtimeFile = path.join(root, 'dist', 'runtime.mjs');
    await writeFile(runtimeFile, 'export default {};');
    vi.stubEnv('DEVTEST_RUNTIME_MODULE', 'dist/runtime.mjs');
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    await writeFile(runtimeFile, 'export default { actorHeaders: {} };');
    expect((await service.call(execution(plan))).message).toContain('STALE_PLAN');
    expect(server.requests).toEqual([]);
  });

  it('rejects model-authored cases, credentials, arbitrary paths and symlink escape', async () => {
    const { service, root } = await fixture();
    const { root: outside } = await fixture();
    for (const extra of [{ test_cases: [] }, { cookie: 'do-not-log' }, { cwd: outside }, { command: 'curl' }]) {
      const result = await service.call({ action: 'plan', requirement: 'requirements/feature.md', ...extra });
      expect(result).toMatchObject({ ok: false, status: 'BLOCKED' });
      expect(JSON.stringify(result)).not.toContain('do-not-log');
    }
    await symlink(path.join(outside, 'requirements', 'feature.md'), path.join(root, 'escape.md'));
    expect((await service.call({ action: 'plan', requirement: 'escape.md' })).message).toContain('PATH_OUTSIDE_PROJECT');
  });

  it('initializes Trae without replacing existing MCP entries or an edited skill', async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, '.trae'));
    await writeFile(path.join(root, '.trae', 'mcp.json'), JSON.stringify({ mcpServers: { team: { command: 'team-tool' } } }));
    const added = await initializeDevTestTrae(root);
    expect(added).toHaveLength(23);
    for (const name of DEVTEST_BUNDLED_SKILLS) {
      for (const resource of name === 'devtest' ? ['SKILL.md'] : ['SKILL.md', 'references/code-map.md', 'references/input-constraints.md']) {
        expect(await readFile(path.join(root, '.trae', 'skills', name, resource), 'utf8'))
          .toBe(await readFile(path.resolve('src/devtest/assets', name, resource), 'utf8'));
      }
    }
    const skillFile = path.join(root, '.trae', 'skills', 'devtest', 'SKILL.md');
    await writeFile(skillFile, 'team custom instructions');
    const specialist = path.join(root, '.trae', 'skills', 'panqu-video-models', 'references', 'code-map.md');
    await writeFile(specialist, 'team model entry points');
    const constraints = path.join(root, '.trae', 'skills', 'panqu-image-models', 'references', 'input-constraints.md');
    await writeFile(constraints, 'team confirmed image limits');
    expect(await initializeDevTestTrae(root)).toEqual([]);
    expect(await readFile(skillFile, 'utf8')).toBe('team custom instructions');
    expect(await readFile(specialist, 'utf8')).toBe('team model entry points');
    expect(await readFile(constraints, 'utf8')).toBe('team confirmed image limits');
    const config = JSON.parse(await readFile(path.join(root, '.trae', 'mcp.json'), 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['devtest', 'team']);
  });

  it('adds missing input checklists on upgrade without replacing existing team skills', async () => {
    const { root } = await fixture();
    await initializeDevTestTrae(root);
    const names = ['panqu-canvas', 'panqu-image-models', 'panqu-video-models'];
    const newResources = names.map((name) => `.trae/skills/${name}/references/input-constraints.md`);
    for (const relative of newResources) await rm(path.join(root, relative));
    const teamMain = path.join(root, '.trae', 'skills', 'devtest', 'SKILL.md');
    await writeFile(teamMain, 'existing team workflow');
    expect((await initializeDevTestTrae(root)).sort()).toEqual(newResources.sort());
    expect(await readFile(teamMain, 'utf8')).toBe('existing team workflow');
    for (const name of names) {
      expect(await readFile(path.join(root, '.trae', 'skills', name, 'references', 'input-constraints.md'), 'utf8'))
        .toBe(await readFile(path.resolve('src/devtest/assets', name, 'references', 'input-constraints.md'), 'utf8'));
    }
    expect(await initializeDevTestTrae(root)).toEqual([]);
  });

  it('does not overwrite a symlinked Trae config outside the project', async () => {
    const { root } = await fixture();
    const { root: outside } = await fixture();
    const outsideFile = path.join(outside, 'mcp.json');
    await writeFile(outsideFile, '{}');
    await mkdir(path.join(root, '.trae'));
    await symlink(outsideFile, path.join(root, '.trae', 'mcp.json'));
    await expect(initializeDevTestTrae(root)).rejects.toThrow('DEVTEST_TRAE_PATH');
    expect(await readFile(outsideFile, 'utf8')).toBe('{}');
  });

  it.each(['skills', 'skills/panqu-canvas', 'skills/panqu-canvas/references'])('rejects a symlinked %s before creating children outside the project', async (relative) => {
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'devtest-skill-outside-'));
    directories.push(outside);
    const target = path.join(root, '.trae', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target);
    await expect(initializeDevTestTrae(root)).rejects.toThrow('DEVTEST_TRAE_PATH');
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(['SKILL.md', 'references/input-constraints.md'])('preserves a symlink target instead of writing specialist %s through it', async (resource) => {
    const { root } = await fixture();
    const { root: outside } = await fixture();
    const outsideFile = path.join(outside, 'custom-skill.md');
    await writeFile(outsideFile, 'keep this file');
    const target = path.join(root, '.trae', 'skills', 'panqu-image-models', resource);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outsideFile, target);
    await expect(initializeDevTestTrae(root)).rejects.toThrow('DEVTEST_TRAE_PATH');
    expect(await readFile(outsideFile, 'utf8')).toBe('keep this file');
  });

  it('exposes only the kernel tool over stdio and flushes responses after stdin closes', async () => {
    const { root } = await fixture();
    const entry = path.resolve('dist/bin/devtest-mcp.js');
    const child = spawn(process.execPath, [entry, '--project-root', root], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'devtest', arguments: { action: 'plan', requirement: 'requirements/feature.md' } } },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(code, errors).toBe(0);
    const messages = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    const initMsg = messages.find((item) => item.id === 1);
    expect(initMsg).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'devtest', version: expect.any(String) },
      },
    });
    expect(messages.find((item) => item.id === 2).result.tools.map((item: { name: string }) => item.name)).toEqual(['devtest']);
    expect(messages.find((item) => item.id === 3).result.structuredContent.status).toBe('NOT_EXECUTED');
  });

  it('real mixed scenario: executes unblocked SAFE cases while blocking PANQU_METHOD_CONFLICT with MATCH reconciliation', async () => {
    const mixedReq = [
      '# 混合接口验收',
      '## API',
      'GET /resources',
      '无需认证。',
      '返回 200。',
      'GET /aivideo/videonew/add',
      '无需认证。',
      '返回 200。',
      '## Acceptance Criteria',
      'AC-1 GET /resources 返回 HTTP 200。',
      'AC-2 GET /aivideo/videonew/add 返回 HTTP 200。',
    ].join('\n');
    const { service, root } = await fixture(mixedReq);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '16', '@xyflow/react': '12' } }));
    await mkdir(path.join(root, 'components', 'nodes'), { recursive: true });
    await writeFile(path.join(root, 'components', 'nodes', 'useAddFlowNode.ts'), 'export const node = 1;');
    await mkdir(path.join(root, 'lib', 'api'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'api', 'request.ts'), `export async function requestPHPApi(path, options = {}) {
      const response = await fetch(path, options);
      const result = await response.json();
      if (!response.ok || result.code !== 1) throw new Error('request failed');
      return result.data;
    }`);
    await writeFile(path.join(root, 'lib', 'api', 'video.ts'), 'import { requestPHPApi } from "./request"; export const submitVideo = () => requestPHPApi("/aivideo/videonew/add", { method: "POST" });');
    const server = await httpService();

    // 1. Plan 阶段：零业务请求，生成待确认计划
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.ok).toBe(true);
    expect(plan.status).toBe('NOT_EXECUTED');
    expect(server.requests).toEqual([]);
    expect(plan.next_action).toMatchObject({
      kind: 'CONFIRM_EXECUTION',
      requires_user_confirmation: true,
    });

    const next = plan.next_action as { execute_arguments: Record<string, unknown>; status_arguments: Record<string, unknown> };

    // 2. Execute 阶段：仅安全接口真实执行，受阻接口无业务请求
    const result = await service.call(next.execute_arguments);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(server.requests).toContain('GET /resources');
    expect(server.requests.some((r) => r.includes('/aivideo/videonew/add'))).toBe(false);

    // 对账必须 MATCH
    const reconciliation = result.reconciliation as { status: string; reconciled: boolean; mismatches: string[] };
    expect(reconciliation.status).toBe('MATCH');
    expect(reconciliation.reconciled).toBe(true);
    expect(reconciliation.mismatches).toEqual([]);

    // 四类清单：正确分类与责任人
    const fourLists = result.four_lists as {
      passed_items: Array<{ case_id: string; operation_key?: string }>;
      test_blockers: Array<{ case_id: string; operation_key?: string; responsible_party: string; remediation: string }>;
    };
    expect(fourLists.passed_items.length).toBeGreaterThan(0);
    expect(fourLists.test_blockers.length).toBeGreaterThan(0);
    const blockedItem = fourLists.test_blockers.find((b) => b.operation_key?.includes('/aivideo/videonew/add'));
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.responsible_party).toBe('研发负责人 (后端开发)');
    expect(blockedItem!.remediation).toContain('修正 Panqu Controller 方法定义');

    // 3. Status 阶段：返回同一份执行事实与 COMPLETED 状态
    const status = await service.call(next.status_arguments);
    expect(status.ok).toBe(true);
    expect(status.status).toBe('COMPLETED');
    expect((status.reconciliation as { status: string }).status).toBe('MATCH');
    expect(status.run_id).toBe(result.run_id);

    // 4. 重放验证：幂等且不重复发送网络请求
    const requestCountBefore = server.requests.length;
    const replay = await service.call(next.execute_arguments);
    expect(replay.replayed).toBe(true);
    expect(server.requests.length).toBe(requestCountBefore);
  });

  it('full stdio lifecycle: initialize -> tools/list -> plan -> execute -> status with MATCH reconciliation', async () => {
    const { root } = await fixture();
    const server = await httpService();
    const entry = path.resolve('dist/bin/devtest-mcp.js');
    const child = spawn(process.execPath, [entry, '--project-root', root], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });

    const messages: Array<{ id: number; result: any; jsonrpc?: string }> = [];
    let buffer = '';

    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          messages.push(msg);

          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          } else if (msg.id === 2) {
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: 'devtest', arguments: { action: 'plan', requirement: 'requirements/feature.md' } },
            }) + '\n');
          } else if (msg.id === 3) {
            const planResult = msg.result.structuredContent;
            const nextAction = planResult.next_action;
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 4,
              method: 'tools/call',
              params: { name: 'devtest', arguments: nextAction.execute_arguments },
            }) + '\n');
          } else if (msg.id === 4) {
            const execResult = msg.result.structuredContent;
            const planId = execResult.plan_id ?? messages.find((m) => m.id === 3)?.result.structuredContent.plan_id;
            child.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 5,
              method: 'tools/call',
              params: { name: 'devtest', arguments: { action: 'status', plan_id: planId } },
            }) + '\n');
          } else if (msg.id === 5) {
            child.stdin.end();
            resolve();
          }
        }
      });
      child.on('error', reject);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    });

    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(exitCode, errors).toBe(0);
    expect(messages).toHaveLength(5);

    const initMsg = messages.find((m) => m.id === 1);
    expect(initMsg?.result).toBeDefined();

    const toolsMsg = messages.find((m) => m.id === 2);
    expect(toolsMsg?.jsonrpc).toBe('2.0');
    expect(toolsMsg?.id).toBe(2);
    expect(toolsMsg?.result.tools.map((t: { name: string }) => t.name)).toEqual(['devtest']);

    const planMsg = messages.find((m) => m.id === 3)?.result.structuredContent;
    expect(planMsg.status).toBe('NOT_EXECUTED');
    expect(planMsg.next_action.requires_user_confirmation).toBe(true);

    const execMsg = messages.find((m) => m.id === 4)?.result.structuredContent;
    expect(execMsg.ok).toBe(true);
    expect(execMsg.counts.passed).toBe(1);
    expect(execMsg.reconciliation.status).toBe('MATCH');

    const statusMsg = messages.find((m) => m.id === 5)?.result.structuredContent;
    expect(statusMsg.ok).toBe(true);
    expect(statusMsg.reconciliation.status).toBe('MATCH');
    expect(statusMsg.run_id).toBe(execMsg.run_id);
  }, 20_000);

  describe('Contract 1 & 2: MCP Tool Schema, Protocol Invariants & Task Lifecycle', () => {
    it('TRAE stable contract: exposes devtest tool with core actions (doctor, plan, execute, status) and strict input validation', async () => {
      // 1. Tool name and basic schema
      expect(DEVTEST_MCP_TOOL.name).toBe('devtest');
      expect(DEVTEST_MCP_TOOL.description).toBeTruthy();
      expect(DEVTEST_MCP_TOOL.inputSchema.type).toBe('object');
      expect(DEVTEST_MCP_TOOL.inputSchema.required).toEqual(['action']);

      // 2. Core TRAE actions guaranteed
      const coreActions = ['doctor', 'plan', 'execute', 'status'] as const;
      const actionEnum = DEVTEST_MCP_TOOL.inputSchema.properties.action.enum;
      for (const core of coreActions) {
        expect(actionEnum).toContain(core);
      }

      // 3. Core actions required fields & parameter constraints in schema
      const allOf = DEVTEST_MCP_TOOL.inputSchema.allOf;
      expect(allOf).toEqual(expect.arrayContaining([
        { if: { properties: { action: { const: 'plan' } } }, then: { required: ['requirement'] } },
        { if: { properties: { action: { const: 'execute' } } }, then: { required: ['plan_id', 'expected_plan_hash', 'idempotency_key'] } },
        { if: { properties: { action: { const: 'status' } } }, then: { required: ['plan_id'] } },
      ]));
      expect(DEVTEST_MCP_TOOL.inputSchema.properties.requirement.type).toBe('string');
      expect(DEVTEST_MCP_TOOL.inputSchema.properties.plan_id.type).toBe('string');
      expect(DEVTEST_MCP_TOOL.inputSchema.properties.expected_plan_hash.pattern).toBe('^[a-f0-9]{64}$');
      expect(DEVTEST_MCP_TOOL.inputSchema.properties.idempotency_key.pattern).toBe('^[A-Za-z0-9_-]{1,128}$');

      // 4. Invalid input stably returns current error structure
      const { service } = await fixture();

      // 4a. Missing or unknown action
      const unknownAction = await service.call({ action: 'non_existent_action' });
      expect(unknownAction.ok).toBe(false);
      expect(unknownAction.status).toBe('BLOCKED');
      expect(unknownAction.message).toContain('INVALID_INPUT: unknown action or field');

      // 4b. Plan missing requirement
      const missingReq = await service.call({ action: 'plan' });
      expect(missingReq.ok).toBe(false);
      expect(missingReq.status).toBe('BLOCKED');
      expect(missingReq.message).toContain('INVALID_INPUT');

      // 4c. Execute with invalid plan_id token
      const invalidPlanId = await service.call({ action: 'execute', plan_id: 'bad token!!', expected_plan_hash: 'a'.repeat(64), idempotency_key: 'key1' });
      expect(invalidPlanId.ok).toBe(false);
      expect(invalidPlanId.status).toBe('BLOCKED');
      expect(invalidPlanId.message).toContain('INVALID_INPUT: plan_id');

      // 4d. Execute with invalid expected_plan_hash format
      const invalidHash = await service.call({ action: 'execute', plan_id: 'plan-123', expected_plan_hash: 'short-hash', idempotency_key: 'key1' });
      expect(invalidHash.ok).toBe(false);
      expect(invalidHash.status).toBe('BLOCKED');
      expect(invalidHash.message).toContain('INVALID_INPUT: expected_plan_hash');
    });

    // 注意：此处固化当前代码库中已实现的 22 个 action 枚举，仅作为当前实现表征（observed extension surface），
    // 用于在后续减法审计中及时感知未决改动，不代表 TRAE MCP 的长期稳定承诺。后续减法审计可在产品决策后更新该表征。
    it('observed extension surface: records current 22 actions as temporary implementation baseline', () => {
      const actionEnum = DEVTEST_MCP_TOOL.inputSchema.properties.action.enum;
      expect(actionEnum).toHaveLength(22);
      expect(actionEnum).toEqual(expect.arrayContaining([
        'doctor', 'plan', 'execute', 'status',
        'quick_verify', 'audit_billing', 'diagnose_diversion', 'self_test_plan',
        'probe_environment', 'export_repro', 'extract_model_matrix',
        'analyze_git_impact', 'watch_task', 'simulate_chaos', 'audit_config_drift',
        'audit_margin', 'review_pr', 'propose_fix_pr', 'report_check_run',
        'handle_pr_command', 'post_merge_release', 'export_ci_workflow',
      ]));
    });

    it('stdio MCP server returns -32700 on malformed JSON and -32601 on unknown tool/method', async () => {
      const { root } = await fixture();
      const entry = path.resolve('dist/bin/devtest-mcp.js');
      const child = spawn(process.execPath, [entry, '--project-root', root], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });

      const responses: Array<{ id: number | null; error?: { code: number; message: string } }> = [];
      let buffer = '';

      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            responses.push(JSON.parse(line));
            if (responses.length === 3) {
              child.stdin.end();
              resolve();
            }
          }
        });
        child.on('error', reject);

        // 1. Send malformed JSON -> Expect -32700
        child.stdin.write('{"jsonrpc":"2.0", incomplete\n');
        // 2. Send unsupported RPC method -> Expect -32601
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'invalid/method' }) + '\n');
        // 3. Send call to unsupported tool name -> Expect -32601
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'unknown_tool', arguments: {} } }) + '\n');
      });

      await new Promise((resolve) => child.on('close', resolve));
      expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.stringContaining('JSON') } });
      expect(responses[1]).toMatchObject({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: expect.stringContaining('Unsupported method or tool') } });
      expect(responses[2]).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32601, message: expect.stringContaining('Unsupported method or tool') } });
    });

    it('task status queries for a completed run are idempotent and preserve single run identity', async () => {
      const { service } = await fixture();
      const server = await httpService();
      const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
      const next = plan.next_action as { execute_arguments: Record<string, unknown>; status_arguments: Record<string, unknown> };

      const execResult = await service.call(next.execute_arguments);
      expect(execResult.ok).toBe(true);
      expect(execResult.run_id).toBeDefined();

      const status1 = await service.call(next.status_arguments);
      const status2 = await service.call(next.status_arguments);

      expect(status1.run_id).toBe(execResult.run_id);
      expect(status2.run_id).toBe(execResult.run_id);
      expect(status1.counts).toEqual(status2.counts);
      expect((status1.reconciliation as any).status).toBe('MATCH');
      expect((status2.reconciliation as any).status).toBe('MATCH');

      // Non-existent plan_id returns BLOCKED without crashing
      const nonExistent = await service.call({ action: 'status', plan_id: 'PLAN-99999999-9999-9999-9999-999999999999' });
      expect(nonExistent.ok).toBe(false);
      expect(nonExistent.status).toBe('BLOCKED');
    });
  });
});
