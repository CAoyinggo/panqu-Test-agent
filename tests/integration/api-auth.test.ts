// 集成测试：API Auth（Phase 25.3）
// 覆盖：JWT 认证（有效/无效/缺失）、X-Actor/X-Role 内部模式（development/test）、
//       production 关闭 X-Header 直信任（S6 生产安全）、requestId/traceId 契约。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const FIXED_MS = Date.parse(FIXED_ISO);
const JWT_SECRET = 'api-auth-secret';
const STATIC_TOKEN = 'static-internal-token';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { mode?: 'development' | 'test' | 'staging' | 'production'; withAuth?: boolean } = {}): Promise<TestServer> {
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
    mode: opts.mode,
    token: STATIC_TOKEN,
    now: () => FIXED_ISO,
  });
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

async function login(ts: TestServer, username = 'qa-a', password = 'qa123456'): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('JWT 认证（withAuth）', () => {
  it('缺失 / 无效 JWT → 401；有效 JWT → 200', async () => {
    const ts = await makeServer({ withAuth: true });
    expect((await ts.request('GET', '/health')).status).toBe(401);
    expect((await ts.request('GET', '/health', { token: 'a.b.c' })).status).toBe(401);
    const token = await login(ts);
    expect((await ts.request('GET', '/health', { token })).status).toBe(200);
  });

  it('伪造/篡改 JWT → 401', async () => {
    const ts = await makeServer({ withAuth: true });
    const token = await login(ts);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u-admin', username: 'admin', roles: ['ADMIN'], exp: 9999999999 })).toString('base64url');
    const res = await ts.request('GET', '/health', { token: `${h}.${forged}.${s}` });
    expect(res.status).toBe(401);
  });

  it('错误密码登录 → 401', async () => {
    const ts = await makeServer({ withAuth: true });
    const res = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'nope' } });
    expect(res.status).toBe(401);
  });
});

describe('X-Actor/X-Role 内部模式', () => {
  it('development：静态 Token + X-Header 可用（兼容 Phase 24）', async () => {
    const ts = await makeServer({ withAuth: true, mode: 'development' });
    const res = await ts.request('POST', '/runs', {
      token: STATIC_TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(200);
    expect((res.data as { status: string }).status).toBe('QUEUED');
  });

  it('test：X-Header 内部模式同样可用', async () => {
    const ts = await makeServer({ withAuth: true, mode: 'test' });
    const res = await ts.request('POST', '/runs', {
      token: STATIC_TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(200);
  });

  it('S6 production：静态 Token + X-Header 被拒绝（生产禁止 X-Header 直信任）', async () => {
    const ts = await makeServer({ withAuth: true, mode: 'production' });
    const res = await ts.request('POST', '/runs', {
      token: STATIC_TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'ADMIN' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(401);
    expect((res.data as { error: string }).error).toBe('unauthorized');
  });

  it('production：合法 JWT 仍可访问', async () => {
    const ts = await makeServer({ withAuth: true, mode: 'production' });
    const token = await login(ts);
    expect((await ts.request('GET', '/health', { token })).status).toBe(200);
  });
});

describe('27.2 读端点 RBAC：OPS_READ（审计 / 遥测成本 / Job / Worker）', () => {
  const OPS_ENDPOINTS = ['/audit', '/jobs', '/workers', '/telemetry/cost'];

  it('VIEWER / QA 无权读取运维端点 → 403 Forbidden', async () => {
    const ts = await makeServer({ mode: 'development' });
    for (const ep of OPS_ENDPOINTS) {
      for (const role of ['VIEWER', 'QA']) {
        const res = await ts.request('GET', ep, { token: STATIC_TOKEN, headers: { 'X-Actor': 'ops-user', 'X-Role': role } });
        expect(res.status, `${ep} 角色 ${role}`).toBe(403);
        expect((res.data as { message: string }).message, `${ep} 角色 ${role}`).toMatch(/无权读取运维数据/);
      }
    }
  });

  it('ADMIN / RELEASE_MANAGER / SERVICE_ACCOUNT 有权读取运维端点 → 200', async () => {
    const ts = await makeServer({ mode: 'development' });
    for (const ep of OPS_ENDPOINTS) {
      for (const role of ['ADMIN', 'RELEASE_MANAGER', 'SERVICE_ACCOUNT']) {
        const res = await ts.request('GET', ep, { token: STATIC_TOKEN, headers: { 'X-Actor': 'ops-user', 'X-Role': role } });
        expect(res.status, `${ep} 角色 ${role}`).toBe(200);
      }
    }
  });

  it('JWT 登录的 VIEWER 同样无 OPS_READ（不依赖 X-Header 身份）', async () => {
    const ts = await makeServer({ withAuth: true, mode: 'development' });
    const token = await login(ts, 'viewer', 'view123456');
    expect((await ts.request('GET', '/audit', { token })).status).toBe(403);
  });
});

describe('requestId / traceId 契约', () => {
  it('错误响应携带 requestId 与 traceId', async () => {
    const ts = await makeServer({ withAuth: true });
    const res = await ts.request('GET', '/health');
    const data = res.data as { requestId: string; traceId: string };
    expect(data.requestId).toMatch(/^req-/);
    expect(data.traceId).toMatch(/^trace-/);
  });
});
