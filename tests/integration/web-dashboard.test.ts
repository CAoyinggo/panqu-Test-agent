// 集成测试：Web Dashboard（Phase 25.6）
// 覆盖：静态托管（/ 与 /assets/*）、SPA fallback（Accept: text/html）、前端 /api 前缀剥离、
//       Dashboard 数据源路由（metrics / telemetry / jobs / audit / workers / activation）、
//       与既有根路径 API 兼容。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const JWT_SECRET = 'web-dashboard-secret';
const STATIC_TOKEN = 'static-web-token';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; data: unknown; contentType?: string }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

function makeWebDir(hasIndex: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dash-'));
  if (hasIndex) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>PANQU</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>', 'utf-8');
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("panqu dashboard");', 'utf-8');
    fs.writeFileSync(path.join(dir, 'assets', 'style.css'), 'body{background:#0f1420}', 'utf-8');
  }
  return dir;
}

async function makeServer(opts: { withAuth?: boolean; webDir?: string } = {}): Promise<TestServer> {
  const bundle = createPlatformService({
    seedProject: true,
    seedUsers: true,
    jwtSecret: JWT_SECRET,
    now: () => FIXED_ISO,
  });
  await bundle.auth.ensureSeeded();
  const server = createPlatformServer({
    service: bundle.service,
    auth: opts.withAuth ? bundle.auth : undefined,
    mode: 'test',
    token: STATIC_TOKEN,
    now: () => FIXED_ISO,
    webDir: opts.webDir,
  });
  const { url } = await server.listen();
  const ts: TestServer = {
    url,
    server,
    bundle,
    async request(method, p, ro = {}) {
      const res = await fetch(`${url}${p}`, {
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
      return { status: res.status, data, contentType: res.headers.get('content-type') ?? undefined };
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

async function login(ts: TestServer, username = 'qa-a', password = 'qa123456'): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('静态托管 + SPA fallback（webDir）', () => {
  it('GET / 与 /index.html 返回 index.html；/assets/* 原样返回（带缓存头）', async () => {
    const ts = await makeServer({ webDir: makeWebDir(true) });
    const root = await ts.request('GET', '/');
    expect(root.status).toBe(200);
    expect(root.contentType).toContain('text/html');
    expect(String(root.data)).toContain('PANQU');

    const idx = await ts.request('GET', '/index.html');
    expect(idx.status).toBe(200);
    expect(idx.contentType).toContain('text/html');

    const js = await ts.request('GET', '/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.contentType).toContain('text/javascript');
    expect(String(js.data)).toContain('panqu dashboard');

    const css = await ts.request('GET', '/assets/style.css');
    expect(css.status).toBe(200);
    expect(css.contentType).toContain('text/css');
  });

  it('SPA fallback：浏览器 Accept: text/html 访问客户端路由返回 index.html', async () => {
    const ts = await makeServer({ withAuth: true, webDir: makeWebDir(true) });
    const token = await login(ts);
    // 浏览器直链 /runs（Accept: text/html）→ index.html（即使未认证也回退，SPA 负责登录门禁）
    const spa = await ts.request('GET', '/runs', { headers: { Accept: 'text/html' } });
    expect(spa.status).toBe(200);
    expect(spa.contentType).toContain('text/html');
    expect(String(spa.data)).toContain('PANQU');
    // 认证的 fetch（Accept: */*）→ 仍走 API
    const api = await ts.request('GET', '/runs', { token });
    expect(api.status).toBe(200);
    expect(Array.isArray(api.data)).toBe(true);
  });

  it('未认证浏览器访问客户端路由同样回退 index.html（SPA 登录门禁）', async () => {
    const ts = await makeServer({ withAuth: true, webDir: makeWebDir(true) });
    const spa = await ts.request('GET', '/settings', { headers: { Accept: 'text/html' } });
    expect(spa.status).toBe(200);
    expect(spa.contentType).toContain('text/html');
  });

  it('webDir 存在但未构建：GET / 返回 NOT_FOUND 404', async () => {
    const ts = await makeServer({ webDir: makeWebDir(false) });
    const root = await ts.request('GET', '/');
    expect(root.status).toBe(404);
    expect((root.data as { error: string }).error).toBe('NOT_FOUND');
  });
});

describe('/api 前缀（Dashboard 与 API 同源）', () => {
  it('无 token 访问 /api/* → 401', async () => {
    const ts = await makeServer({ withAuth: true });
    expect((await ts.request('GET', '/api/health')).status).toBe(401);
  });

  it('带 token 访问 /api/metrics?window= 等 Dashboard 数据源', async () => {
    const ts = await makeServer({ withAuth: true, webDir: makeWebDir(true) });
    // 27.2：/api/telemetry/cost、/api/jobs、/api/audit、/api/workers 为运维只读端点（OPS_READ），需 admin 身份
    const token = await login(ts, 'admin', 'admin123');

    const metrics = await ts.request('GET', '/api/metrics?window=1h', { token });
    expect(metrics.status).toBe(200);
    expect((metrics.data as { queueLength: number }).queueLength).toBeTypeOf('number');

    const activation = await ts.request('GET', '/api/metrics/activation', { token });
    expect(activation.status).toBe(200);
    expect((activation.data as { activeCount: number }).activeCount).toBeTypeOf('number');

    const snap = await ts.request('GET', '/api/telemetry/snapshot?window=7d', { token });
    expect(snap.status).toBe(200);
    expect((snap.data as { cost: { total: { tracked: boolean } } }).cost.total.tracked).toBe(false);

    const cost = await ts.request('GET', '/api/telemetry/cost?window=7d', { token });
    expect(cost.status).toBe(200);

    const events = await ts.request('GET', '/api/telemetry/events', { token });
    expect(events.status).toBe(200);
    expect(Array.isArray(events.data)).toBe(true);

    const jobs = await ts.request('GET', '/api/jobs', { token });
    expect(jobs.status).toBe(200);
    expect(Array.isArray(jobs.data)).toBe(true);

    const audit = await ts.request('GET', '/api/audit', { token });
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.data)).toBe(true);

    const workers = await ts.request('GET', '/api/workers', { token });
    expect(workers.status).toBe(200);
    expect(Array.isArray(workers.data)).toBe(true);

    const dash = await ts.request('GET', '/api/dashboard', { token });
    expect(dash.status).toBe(200);
  });

  it('QA 角色访问运维端点 /api/audit → 403（OPS_READ 权限隔离）', async () => {
    const ts = await makeServer({ withAuth: true, webDir: makeWebDir(true) });
    const token = await login(ts, 'qa-a', 'qa123456');
    expect((await ts.request('GET', '/api/audit', { token })).status).toBe(403);
    expect((await ts.request('GET', '/api/telemetry/cost', { token })).status).toBe(403);
    // 非运维端点（dashboard 数据源）仍可访问
    expect((await ts.request('GET', '/api/dashboard', { token })).status).toBe(200);
  });
});

describe('根路径 API 兼容（既有客户端不受影响）', () => {
  it('带 token 访问 /health、/runs 等根路径路由', async () => {
    const ts = await makeServer({ withAuth: true, webDir: makeWebDir(true) });
    const token = await login(ts);
    expect((await ts.request('GET', '/health', { token })).status).toBe(200);
    expect((await ts.request('GET', '/runs', { token })).status).toBe(200);
    expect((await ts.request('GET', '/projects', { token })).status).toBe(200);
    expect((await ts.request('GET', '/approvals', { token })).status).toBe(200);
  });

  it('内部模式（无 auth）：/api/metrics 同样可访问', async () => {
    const ts = await makeServer({ webDir: makeWebDir(true) });
    const metrics = await ts.request('GET', '/api/metrics', { token: STATIC_TOKEN });
    expect(metrics.status).toBe(200);
    expect((metrics.data as { queueLength: number }).queueLength).toBeTypeOf('number');
  });
});
