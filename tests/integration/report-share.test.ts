// 集成测试：Report / Share（Phase 39.6）
// 覆盖：报告摘要关键字段（Release Decision / Coverage / Cost / Risk / DecisionTrace）、
//       Share link、Export JSON / HTML、跨项目报告权限隔离（S6/S7）。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const STATIC_TOKEN = 'static-internal-token';
const JWT_SECRET = 'report-share-secret';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { withAuth?: boolean } = {}): Promise<TestServer> {
  const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: JWT_SECRET, now: () => FIXED_ISO });
  await bundle.auth.ensureSeeded();
  const server = createPlatformServer({ service: bundle.service, auth: opts.withAuth ? bundle.auth : undefined, token: STATIC_TOKEN, now: () => FIXED_ISO });
  const { url } = await server.listen();
  const ts: TestServer = {
    url,
    server,
    bundle,
    async request(method, path, ro = {}) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(ro.token ? { Authorization: `Bearer ${ro.token}` } : {}),
          ...(ro.headers ?? {}),
        },
        body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
    async close() {
      await server.close();
    },
  };
  opened.push(ts);
  return ts;
}

afterEach(async () => {
  while (opened.length > 0) {
    const t = opened.pop();
    if (t) await t.close();
  }
});

function qaHeaders(role = 'QA'): Record<string, string> {
  return { 'X-Actor': 'qa-user', 'X-Role': role };
}

async function login(ts: TestServer, username: string, password: string): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('Report（39.6）：关键结论首页', () => {
  it('报告摘要包含 Release Decision / Coverage / Cost / Risk / DecisionTrace', async () => {
    const ts = await makeServer();
    const r = await ts.request('POST', '/runs', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (r.data as { runId: string }).runId;
    const report = await ts.request('GET', `/runs/${runId}/report`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(report.status).toBe(200);
    const s = report.data as {
      runId: string; projectId: string; environment: string; status: string;
      releaseDecision: unknown; coverage: { total: number }; cost: { tracked: boolean };
      risk: string; decisionTrace: unknown; approvals: unknown[];
    };
    expect(s.runId).toBe(runId);
    expect(s.projectId).toBe('wan3');
    expect(typeof s.coverage.total).toBe('number');
    expect(s.cost.tracked).toBe(false); // 无真实成本数据 → tracked=false（不虚构）
    expect(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).toContain(s.risk);
    expect(s.approvals).toEqual([]);
  });
});

describe('Share / Export（39.6）', () => {
  it('Share link + Export JSON / HTML', async () => {
    const ts = await makeServer();
    const r = await ts.request('POST', '/runs', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (r.data as { runId: string }).runId;

    const share = await ts.request('GET', `/runs/${runId}/share`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(share.status).toBe(200);
    const sh = share.data as { share: { token: string }; url: string };
    expect(sh.url).toContain('/runs/');
    expect(sh.url).toContain(sh.share.token);

    const json = await ts.request('GET', `/runs/${runId}/report/export?format=json`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(json.status).toBe(200);
    expect(String(json.data)).toContain('report');

    const html = await ts.request('GET', `/runs/${runId}/report/export?format=html`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(html.status).toBe(200);
    expect(String(html.data)).toContain('<!DOCTYPE html>');
  });
});

describe('跨项目报告隔离（S6/S7）', () => {
  it('Project A 用户可看 A 报告；不可看 Project B 报告（RBAC + Project Scope）', async () => {
    const ts = await makeServer({ withAuth: true });
    // admin 创建 order 项目（qa-a 作用域只有 wan3）
    const admin = await login(ts, 'admin', 'admin123');
    const proj = await ts.request('POST', '/projects', { token: admin, body: { id: 'order', name: 'Order', businesses: ['order'], environments: [{ id: 'test', name: 'test', type: 'test', enabled: true }], defaultEnvironment: 'test' } });
    expect(proj.status).toBe(200);

    // order 项目里创建 Run（admin）
    const rB = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'order', environment: 'test', trigger: 'manual' } });
    const runB = (rB.data as { runId: string }).runId;

    // wan3 项目里创建 Run（qa-a，作用域 wan3）
    const qaA = await login(ts, 'qa-a', 'qa123456');
    const rA = await ts.request('POST', '/runs', { token: qaA, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runA = (rA.data as { runId: string }).runId;

    // qa-a 看自己项目报告 → 200
    expect((await ts.request('GET', `/runs/${runA}/report`, { token: qaA })).status).toBe(200);
    // qa-a 看 Project B（order）报告 → 403（跨项目隔离）
    expect((await ts.request('GET', `/runs/${runB}/report`, { token: qaA })).status).toBe(403);
  });
});
