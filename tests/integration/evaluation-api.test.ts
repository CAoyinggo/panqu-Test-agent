// 集成测试：AI 质量评测 API（Phase 45）
// 覆盖：GET /api/eval/report（认证）返回完整 EvalReport（8 个 domains、overall 0~1、
//       critical 四字段均为数字、version/cost/versionInfo 齐备）；未认证返回 401；
//       GET /api/eval/report/:domain 返回单领域；未知领域返回 404。
// 评测为确定性规则（model=rules），无外部依赖、不消耗 token。
// 服务器启动 / 认证模式严格复用 tests/integration/web-dashboard.test.ts 的既有 harness。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import type { EvalReport } from '../../src/eval/runner.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const JWT_SECRET = 'eval-api-secret';

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

async function makeServer(opts: { withAuth?: boolean } = {}): Promise<TestServer> {
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
    token: 'eval-static-token',
    now: () => FIXED_ISO,
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

const CRITICAL_KEYS = ['p0Miss', 'falsePass', 'unsafeHealing', 'skippedCritical'] as const;

describe('Phase 45：评测 API GET /api/eval/report', () => {
  it('未认证访问 /api/eval/report → 401', async () => {
    const ts = await makeServer({ withAuth: true });
    const res = await ts.request('GET', '/api/eval/report');
    expect(res.status).toBe(401);
  });

  it('认证访问 /api/eval/report → 200，含 8 个 domains、overall 0~1、critical 四字段均为数字', async () => {
    const ts = await makeServer({ withAuth: true });
    const token = await login(ts);
    const res = await ts.request('GET', '/api/eval/report', { token });
    expect(res.status).toBe(200);

    const report = res.data as EvalReport;
    // EvalReport 完整结构：version / overall / critical / domains[8] / cost / versionInfo
    expect(typeof report.version).toBe('string');
    expect(report.domains).toHaveLength(8);
    expect(report.overall).toBeGreaterThanOrEqual(0);
    expect(report.overall).toBeLessThanOrEqual(1);
    for (const k of CRITICAL_KEYS) {
      expect(typeof report.critical[k]).toBe('number');
    }
    expect(typeof report.cost.cost).toBe('number');
    expect(report.versionInfo).toBeDefined();
    expect(report.versionInfo.model).toBe('rules'); // 确定性规则评测，无外部依赖
  });

  it('认证访问 /api/eval/report/REQUIREMENT → 200，仅返回该领域', async () => {
    const ts = await makeServer({ withAuth: true });
    const token = await login(ts);
    const res = await ts.request('GET', '/api/eval/report/REQUIREMENT', { token });
    expect(res.status).toBe(200);

    const report = res.data as EvalReport;
    expect(report.domains).toHaveLength(1);
    expect(report.domains[0].domain).toBe('REQUIREMENT');
    // 单领域报告：overall 与该领域 score 一致
    expect(report.overall).toBe(report.domains[0].score);
  });

  it('认证访问 /api/eval/report/UNKNOWN → 404', async () => {
    const ts = await makeServer({ withAuth: true });
    const token = await login(ts);
    const res = await ts.request('GET', '/api/eval/report/UNKNOWN', { token });
    expect(res.status).toBe(404);
    // 统一错误契约含 error 码
    expect((res.data as { error?: string }).error).toBe('NOT_FOUND');
  });
});
