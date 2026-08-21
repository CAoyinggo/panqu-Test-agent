import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import { createPlatformServer, type PlatformHttpServer } from '../../src/platform/api/index.js';
import { standardEnvironments } from '../../src/platform/projects/project-schema.js';
import { CostGovernanceService } from '../../src/cost/governance.js';

const servers: PlatformHttpServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

describe('Phase 52 Cost API / RBAC / Project Scope', () => {
  it('管理员看全部并修改预算；QA 仅看本项目且不能修改', async () => {
    const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: 'phase52-cost-secret' });
    await bundle.auth.ensureSeeded();
    bundle.projects.createProject({ id: 'order', name: 'Order', businesses: ['order'], environments: standardEnvironments() });
    const cost = new CostGovernanceService();
    cost.ledger.record({ projectId: 'wan3', runId: 'r-a', category: 'LLM', quantity: 2, unitCost: 1, currency: 'USD' });
    cost.ledger.record({ projectId: 'order', runId: 'r-b', category: 'WORKER', quantity: 3, unitCost: 1, currency: 'USD' });
    const server = createPlatformServer({ service: bundle.service, auth: bundle.auth, mode: 'test', costGovernance: cost }); servers.push(server);
    const { url } = await server.listen();
    const request = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const login = async (username: string, password: string): Promise<string> => {
      const response = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return ((await response.json()) as { accessToken: string }).accessToken;
    };
    const admin = await login('admin', 'admin123'); const qa = await login('qa-a', 'qa123456');
    expect((await request('GET', '/api/cost/summary', admin)).data.totalCost).toBe(5);
    expect((await request('GET', '/api/cost/projects/wan3', qa)).data.totalCost).toBe(2);
    expect((await request('GET', '/api/cost/projects/order', qa)).status).toBe(403);
    expect((await request('POST', '/api/budgets?projectId=wan3', qa, { daily: 10 })).status).toBe(403);
    expect((await request('POST', '/api/budgets?projectId=wan3', admin, { daily: 10 })).status).toBe(200);
  });

  it('真实 Telemetry recordLLM 自动桥接到统一 Cost Attribution', async () => {
    const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: 'phase52-telemetry-bridge' });
    await bundle.auth.ensureSeeded();
    const entry = await bundle.telemetry.recordLLM({ runId: 'real-run', projectId: 'wan3', model: 'gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0, latencyMs: 400 });
    const cost = new CostGovernanceService(); const server = createPlatformServer({ service: bundle.service, auth: bundle.auth, mode: 'test', costGovernance: cost }); servers.push(server); const { url } = await server.listen();
    const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }); const token = ((await login.json()) as { accessToken: string }).accessToken;
    const response = await fetch(`${url}/api/cost/projects/wan3`, { headers: { Authorization: `Bearer ${token}` } }); const summary = await response.json() as { totalCost: number; byRun: Record<string, number>; byModel: Record<string, number> };
    expect(response.status).toBe(200); expect(summary.totalCost).toBe(entry.cost); expect(summary.byRun['real-run']).toBe(entry.cost); expect(summary.byModel['gpt-4o-mini']).toBe(entry.cost);
  });
});
