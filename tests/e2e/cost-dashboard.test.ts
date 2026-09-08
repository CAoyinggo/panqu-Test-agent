import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import { createPlatformServer, type PlatformHttpServer } from '../../src/platform/api/index.js';
import { CostGovernanceService } from '../../src/cost/governance.js';

let server: PlatformHttpServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('Phase 52 Cost Dashboard E2E', () => {
  it('Dashboard API 提供全部成本、趋势、预测、预算、异常与容量数据', async () => {
    const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: 'phase52-dashboard' }); await bundle.auth.ensureSeeded();
    const cost = new CostGovernanceService();
    const now = new Date();
    const recordTime = new Date(now.getTime() - 60 * 60 * 1000);
    cost.ledger.record({ projectId: 'wan3', runId: 'r1', evaluationId: 'e1', benchmarkId: 'b1', provider: 'openai', model: 'cheap', category: 'LLM', quantity: 10, unitCost: 0.1, currency: 'USD', timestamp: recordTime.toISOString() });
    cost.setBudget({ projectId: 'wan3', monthly: 200 }, 'admin');
    server = createPlatformServer({ service: bundle.service, auth: bundle.auth, mode: 'test', costGovernance: cost, now: () => now.toISOString() }); const { url } = await server.listen();
    const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const token = ((await login.json()) as { accessToken: string }).accessToken; const headers = { Authorization: `Bearer ${token}` };
    const summary = await (await fetch(`${url}/api/cost/summary?projectId=wan3&window=7d&grain=daily`, { headers })).json() as Record<string, unknown>;
    expect(summary).toMatchObject({ totalCost: 1, costPerRun: 1, costPerEvaluation: 1, costPerBenchmark: 1 });
    expect(summary.trend).toEqual([{ period: recordTime.toISOString().slice(0, 10), cost: 1 }]);
    expect((await fetch(`${url}/api/cost/forecast?projectId=wan3`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/api/budgets?projectId=wan3`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/api/workers/capacity`, { headers })).status).toBe(200);
  });
});
