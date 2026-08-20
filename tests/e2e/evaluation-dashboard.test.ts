// E2E：AI 质量评测 Dashboard（Phase 45）
// 验证「评测报告链路可端到端获取并满足关键安全门禁」：
//   1. 认证登录（/auth/login）后可通过 HTTP 端到端获取完整评测报告（/api/eval/report）；
//   2. 报告关键安全指标 critical.p0Miss / falsePass / unsafeHealing / skippedCritical 全部为 0；
//   3. 每个领域 tracked > 0（均有 Ground Truth 覆盖）且 score 介于 0~1；
//   4. 领域维度端点可用（/api/eval/report/:domain），未知领域 404。
// 评测为确定性规则（model=rules），无外部依赖、不消耗 token。
// 端到端 harness 复用 tests/e2e/qa-workflow.test.ts 的服务器启动 / 认证模式。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import type { EvalReport } from '../../src/eval/runner.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const JWT_SECRET = 'eval-e2e-secret';

interface Api {
  request(
    m: string,
    p: string,
    o?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; data: unknown }>;
}

const opened: PlatformHttpServer[] = [];

function makeAuthBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: JWT_SECRET, now: () => FIXED_ISO });
}

async function startServer(b: PlatformBundle): Promise<Api> {
  const server = createPlatformServer({ service: b.service, auth: b.auth, mode: 'test', token: 'eval-e2e-token', now: () => FIXED_ISO });
  const { port } = await server.listen();
  opened.push(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    async request(method, path, o = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
          ...(o.headers ?? {}),
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
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
  };
}

afterEach(async () => {
  while (opened.length > 0) {
    const s = opened.pop();
    if (s) await s.close();
  }
});

async function login(api: Api, username: string, password: string): Promise<string> {
  const res = await api.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('E2E：评测报告链路可端到端获取（Phase 45）', () => {
  it('登录 → GET /api/eval/report → 200，完整 EvalReport 结构（8 领域 / overall 0~1 / model=rules）', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'admin', 'admin123');

    const res = await api.request('GET', '/api/eval/report', { token });
    expect(res.status).toBe(200);
    const report = res.data as EvalReport;

    expect(report.domains).toHaveLength(8);
    expect(typeof report.version).toBe('string');
    expect(report.overall).toBeGreaterThanOrEqual(0);
    expect(report.overall).toBeLessThanOrEqual(1);
    // 确定性规则评测：versionInfo.model=rules，cost 为 0（不消耗 token）
    expect(report.versionInfo.model).toBe('rules');
    expect(report.cost.cost).toBe(0);
  });

  it('关键安全门禁达标：critical 四项指标全部为 0，且每领域 tracked>0、score 介于 0~1', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'qa-a', 'qa123456');

    const res = await api.request('GET', '/api/eval/report', { token });
    expect(res.status).toBe(200);
    const report = res.data as EvalReport;

    // 关键安全指标（P0 Miss / False Pass / Unsafe Healing / Skipped Critical）必须全部为 0
    const critical = report.critical;
    expect(critical.p0Miss).toBe(0);
    expect(critical.falsePass).toBe(0);
    expect(critical.unsafeHealing).toBe(0);
    expect(critical.skippedCritical).toBe(0);

    // 每个领域均有 Ground Truth 覆盖（tracked > 0），且得分合法（0~1）
    expect(report.domains.length).toBeGreaterThan(0);
    for (const d of report.domains) {
      expect(d.tracked, `${d.domain} 应有 tracked 用例`).toBeGreaterThan(0);
      expect(d.score, `${d.domain} score 应 ≥ 0`).toBeGreaterThanOrEqual(0);
      expect(d.score, `${d.domain} score 应 ≤ 1`).toBeLessThanOrEqual(1);
    }
  });

  it('领域维度端点：/api/eval/report/REQUIREMENT 返回单领域且一致；未知领域 404', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'qa-a', 'qa123456');

    const single = await api.request('GET', '/api/eval/report/REQUIREMENT', { token });
    expect(single.status).toBe(200);
    const singleReport = single.data as EvalReport;
    expect(singleReport.domains).toHaveLength(1);
    expect(singleReport.domains[0].domain).toBe('REQUIREMENT');
    expect(singleReport.overall).toBe(singleReport.domains[0].score);

    const unknown = await api.request('GET', '/api/eval/report/UNKNOWN', { token });
    expect(unknown.status).toBe(404);
  });
});
