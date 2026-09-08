import { createServer, type Server } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevTestMcpService } from '../../src/devtest/mcp-service.js';
import { initializeDevTestProject } from '../../src/devtest/cli-config.js';
import { initializeDevTestTrae } from '../../src/devtest/trae-setup.js';

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
  it('plans with zero requests, executes independent HTTP results, and retries without repeating requests', async () => {
    const { service, root } = await fixture();
    const server = await httpService();
    const plan = await service.call({ action: 'plan', requirement: 'requirements/feature.md' });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.status).toBe('NOT_EXECUTED');
    expect(server.requests).toEqual([]);
    expect((plan.counts as { executed: number }).executed).toBe(0);
    const result = await service.call(execution(plan));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result.counts as { executed: number }).executed).toBeGreaterThan(0);
    expect((result.counts as { passed: number }).passed).toBeGreaterThan(0);
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
    await initializeDevTestTrae(root);
    const skillFile = path.join(root, '.trae', 'skills', 'devtest', 'SKILL.md');
    await writeFile(skillFile, 'team custom instructions');
    expect(await initializeDevTestTrae(root)).toEqual([]);
    expect(await readFile(skillFile, 'utf8')).toBe('team custom instructions');
    const config = JSON.parse(await readFile(path.join(root, '.trae', 'mcp.json'), 'utf8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['devtest', 'team']);
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
    expect(messages.find((item) => item.id === 2).result.tools.map((item: { name: string }) => item.name)).toEqual(['devtest']);
    expect(messages.find((item) => item.id === 3).result.structuredContent.status).toBe('NOT_EXECUTED');
  });
});
