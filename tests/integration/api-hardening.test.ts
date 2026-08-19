// 集成测试：API Hardening（Phase 25.7）
// 覆盖：requestId/traceId 透传与响应头、统一错误契约 {error,message,status,requestId,traceId}、
//       每 IP 限流（X-RateLimit-* 头 + 429 Retry-After）、列表可选分页（?page&pageSize → {items,pagination}）。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const STATIC_TOKEN = 'hardening-token';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; data: unknown; headers: Record<string, string> }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { withAuth?: boolean; rateLimitPerMinute?: number } = {}): Promise<TestServer> {
  const bundle = createPlatformService({
    seedProject: true,
    seedUsers: true,
    jwtSecret: 'hardening-secret',
    now: () => FIXED_ISO,
  });
  await bundle.auth.ensureSeeded();
  const server = createPlatformServer({
    service: bundle.service,
    auth: opts.withAuth ? bundle.auth : undefined,
    mode: 'test',
    token: STATIC_TOKEN,
    now: () => FIXED_ISO,
    rateLimitPerMinute: opts.rateLimitPerMinute,
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
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, data, headers };
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

describe('requestId / traceId 透传与响应头（25.7）', () => {
  it('客户端透传 X-Request-Id / X-Trace-Id → 响应头原样返回', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/api/health', {
      token: STATIC_TOKEN,
      headers: { 'X-Request-Id': 'req-client-123', 'X-Trace-Id': 'trace-client-456' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-client-123');
    expect(res.headers['x-trace-id']).toBe('trace-client-456');
  });

  it('未透传时服务端生成，响应头带 X-Request-Id / X-Trace-Id', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/api/health', { token: STATIC_TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^req-/);
    expect(res.headers['x-trace-id']).toMatch(/^trace-/);
  });
});

describe('统一错误契约（25.7）', () => {
  it('401 错误体含 error/message/status/requestId/traceId，与响应头一致', async () => {
    const ts = await makeServer({ withAuth: true });
    const res = await ts.request('GET', '/api/health', { headers: { 'X-Request-Id': 'err-req' } });
    expect(res.status).toBe(401);
    const body = res.data as { error: string; message: string; status: number; requestId: string; traceId: string };
    expect(body.error).toBe('unauthorized');
    expect(body.status).toBe(401);
    expect(body.requestId).toBe('err-req');
    expect(body.traceId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe('err-req');
  });

  it('404 未匹配路由返回统一错误契约', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/api/definitely-not-a-route', { token: STATIC_TOKEN });
    expect(res.status).toBe(404);
    const body = res.data as { error: string; status: number };
    expect(body.error).toBe('not_found');
    expect(body.status).toBe(404);
  });
});

describe('限流（25.7）', () => {
  it('超过 rateLimitPerMinute 后返回 429 + Retry-After；正常响应带 X-RateLimit-* 头', async () => {
    const ts = await makeServer({ rateLimitPerMinute: 3 });
    const r1 = await ts.request('GET', '/api/health', { token: STATIC_TOKEN });
    expect(r1.status).toBe(200);
    expect(r1.headers['x-ratelimit-limit']).toBe('3');
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');

    await ts.request('GET', '/api/health', { token: STATIC_TOKEN });
    await ts.request('GET', '/api/health', { token: STATIC_TOKEN });
    const r4 = await ts.request('GET', '/api/health', { token: STATIC_TOKEN });
    expect(r4.status).toBe(429);
    expect(r4.headers['retry-after']).toBe('1');
    expect(r4.headers['x-ratelimit-remaining']).toBe('0');
    const body = r4.data as { error: string; status: number; retryAfterSeconds?: number };
    expect(body.error).toBe('rate_limited');
    expect(body.status).toBe(429);
  });
});

describe('可选分页（25.7）', () => {
  it('显式 ?page&pageSize → {items, pagination}；不传 → 纯数组（向后兼容）', async () => {
    const ts = await makeServer();
    // 造 3 个 Run
    for (let i = 0; i < 3; i++) {
      await ts.bundle.service.createRun({
        projectId: 'wan3', environment: 'test', trigger: 'manual', feature: `f-${i}`, actor: 'cli', role: 'ADMIN',
      });
    }
    // 分页
    const paged = await ts.request('GET', '/api/runs?page=1&pageSize=2', { token: STATIC_TOKEN });
    expect(paged.status).toBe(200);
    const pd = paged.data as { items: unknown[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } };
    expect(Array.isArray(pd.items)).toBe(true);
    expect(pd.items.length).toBeLessThanOrEqual(2);
    expect(pd.pagination.page).toBe(1);
    expect(pd.pagination.pageSize).toBe(2);
    expect(pd.pagination.total).toBeGreaterThanOrEqual(3);
    expect(pd.pagination.totalPages).toBeGreaterThanOrEqual(2);

    // 越界页
    const out = await ts.request('GET', '/api/runs?page=99&pageSize=2', { token: STATIC_TOKEN });
    const od = out.data as { items: unknown[]; pagination: { page: number } };
    expect(od.items.length).toBe(0);
    expect(od.pagination.page).toBe(99);

    // 不传参 → 纯数组
    const raw = await ts.request('GET', '/api/runs', { token: STATIC_TOKEN });
    expect(Array.isArray(raw.data)).toBe(true);

    // 其他列表路由（/api/audit 为 OPS_READ 运维端点，27.2：需 ADMIN 身份）
    const audit = await ts.request('GET', '/api/audit?pageSize=1', { token: STATIC_TOKEN, headers: { 'X-Actor': 'ops', 'X-Role': 'ADMIN' } });
    const ad = audit.data as { items: unknown[]; pagination: { pageSize: number } };
    expect(audit.status).toBe(200);
    expect(Array.isArray(ad.items)).toBe(true);
    expect(ad.pagination.pageSize).toBe(1);
  });
});
