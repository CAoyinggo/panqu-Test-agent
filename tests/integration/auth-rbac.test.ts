// 集成测试：Auth + RBAC（Phase 25.3）
// S1 登录 → JWT → API → User；S2 项目隔离：QA-A → wan3 PASS / order DENY；
//       环境隔离：QA-A → wan3/production DENY；角色：VIEWER 无 TEST_RUN。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import { UserStore, AuthService } from '../../src/platform/auth/index.js';
import type { UserRecord } from '../../src/platform/auth/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const FIXED_MS = Date.parse(FIXED_ISO);
const JWT_SECRET = 'integration-secret';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeAuthServer(opts: { mode?: 'development' | 'test' | 'staging' | 'production'; storage?: 'memory' | 'sqlite' } = {}): Promise<TestServer> {
  const bundle = createPlatformService({
    seedProject: true,
    seedUsers: true,
    jwtSecret: JWT_SECRET,
    storage: opts.storage ?? 'memory',
    now: () => FIXED_ISO,
  });
  await bundle.auth.ensureSeeded();
  // 创建第二个项目 order（供隔离验证）
  if (!bundle.projects.getProject('order')) {
    bundle.service.createProject({ id: 'order', name: '订单服务' });
  }
  const server = createPlatformServer({
    service: bundle.service,
    auth: bundle.auth,
    mode: opts.mode,
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

describe('S1 登录 → JWT → API → User', () => {
  it('login 获取 JWT；携带 Bearer 访问 /auth/info 得到用户', async () => {
    const ts = await makeAuthServer();
    const login = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'qa123456' } });
    expect(login.status).toBe(200);
    const tokens = login.data as { accessToken: string; refreshToken: string; user: { username: string; roles: string[] } };
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.user.username).toBe('qa-a');
    expect(tokens.user.roles).toEqual(['QA']);
    const info = await ts.request('GET', '/auth/info', { token: tokens.accessToken });
    expect(info.status).toBe(200);
    expect((info.data as { username: string }).username).toBe('qa-a');
  });

  it('登录失败 → 401 invalid_credentials', async () => {
    const ts = await makeAuthServer();
    const res = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'wrong' } });
    expect(res.status).toBe(401);
    expect((res.data as { error: string }).error).toBe('invalid_credentials');
  });

  it('refresh 旋转令牌；旧 refresh 失效', async () => {
    const ts = await makeAuthServer();
    const login = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'qa123456' } });
    const first = login.data as { refreshToken: string; accessToken: string };
    const refresh = await ts.request('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } });
    expect(refresh.status).toBe(200);
    const second = refresh.data as { refreshToken: string; accessToken: string };
    expect(second.accessToken).not.toBe(first.accessToken);
    // 旧 refresh 已旋转失效
    const reuse = await ts.request('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } });
    expect(reuse.status).toBe(401);
  });

  it('logout 后 refresh 失效', async () => {
    const ts = await makeAuthServer();
    const login = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'qa123456' } });
    const { refreshToken } = login.data as { refreshToken: string };
    await ts.request('POST', '/auth/logout', { body: { refreshToken } });
    const refresh = await ts.request('POST', '/auth/refresh', { body: { refreshToken } });
    expect(refresh.status).toBe(401);
  });
});

describe('S2 项目隔离（JWT 用户）', () => {
  async function loginAs(ts: TestServer, username: string, password: string): Promise<string> {
    const res = await ts.request('POST', '/auth/login', { body: { username, password } });
    expect(res.status).toBe(200);
    return (res.data as { accessToken: string }).accessToken;
  }

  it('QA-A（wan3/test+staging）→ wan3 PASS', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(200);
    expect((res.data as { status: string }).status).toBe('QUEUED');
  });

  it('QA-A → order DENY（项目越权）', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'order', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/无权访问项目 order/);
  });

  it('QA-B（order/test）→ wan3 DENY；order PASS', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'qa-b', 'qa123456');
    const denied = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(denied.status).toBe(400);
    expect((denied.data as { message: string }).message).toMatch(/无权访问项目 wan3/);
    const allowed = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'order', environment: 'test', trigger: 'manual' },
    });
    expect(allowed.status).toBe(200);
  });

  it('QA-A → wan3/production DENY（环境越权：仅 test/staging）', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'wan3', environment: 'production', trigger: 'manual' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/无权访问环境 production/);
  });

  it('项目列表按作用域过滤：QA-A 只见 wan3', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'qa-a', 'qa123456');
    const res = await ts.request('GET', '/projects', { token });
    const ids = (res.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain('wan3');
    expect(ids).not.toContain('order');
  });

  it('ADMIN 不受作用域限制：可创建 order Run', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'admin', 'admin123');
    const res = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'order', environment: 'production', trigger: 'manual' },
    });
    expect(res.status).toBe(200);
  });

  it('VIEWER 无 TEST_RUN 权限 → 400', async () => {
    const ts = await makeAuthServer();
    const token = await loginAs(ts, 'viewer', 'view123456');
    const res = await ts.request('POST', '/runs', {
      token,
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/缺少权限 TEST_RUN/);
  });

  it('无 Token 访问受保护接口 → 401', async () => {
    const ts = await makeAuthServer();
    const res = await ts.request('GET', '/health');
    expect(res.status).toBe(401);
  });
});

describe('审计：认证与运行写入 audit（按 traceId 关联）', () => {
  it('登录 + 创建 Run 均有审计记录', async () => {
    const ts = await makeAuthServer();
    const login = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'qa123456' } });
    const token = (login.data as { accessToken: string }).accessToken;
    const run = await ts.request('POST', '/runs', { token, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (run.data as { runId: string }).runId;
    const audit = await ts.bundle.audit.list({});
    expect(audit.some((e) => e.action === 'auth.login')).toBe(true);
    expect(audit.some((e) => e.action === 'run.create' && e.resource === runId)).toBe(true);
  });
});

describe('SQLite 后端下认证持久化', () => {
  it('auth + run 在 sqlite 后端同样工作', async () => {
    const ts = await makeAuthServer({ storage: 'sqlite' });
    const login = await ts.request('POST', '/auth/login', { body: { username: 'qa-a', password: 'qa123456' } });
    expect(login.status).toBe(200);
    const token = (login.data as { accessToken: string }).accessToken;
    const run = await ts.request('POST', '/runs', { token, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    expect(run.status).toBe(200);
  });
});
