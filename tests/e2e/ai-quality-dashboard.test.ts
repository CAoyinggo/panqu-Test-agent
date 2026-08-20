// E2E：AI Quality Dashboard（Phase 46 / 43.22）
// 验证「AI 质量聚合视图可端到端获取并满足关键安全门禁」：
//   1. 认证登录（/auth/login）后可通过 HTTP 端到端获取 AI Quality 聚合报告（/api/ai-quality）；
//   2. 报告包含 Accuracy / Regression / False Pass / P0 Miss / RCA / Selection / Defect /
//      Healing / Cost / Latency 等关键指标，且关键安全指标（falsePass / p0Miss）为 0；
//   3. 趋势端点可用（/api/ai-quality/trends），反馈/提案/实验/知识统计可见；
//   4. 未认证访问 → 401（写/读均需凭证）。
// 评测为确定性规则（model=rules），无外部依赖、不消耗 token。
// 端到端 harness 复用 tests/e2e/evaluation-dashboard.test.ts 的服务器启动 / 认证模式。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-20T00:00:00.000Z';
const JWT_SECRET = 'aiq-e2e-secret';

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
  const server = createPlatformServer({ service: b.service, auth: b.auth, mode: 'test', token: 'aiq-e2e-token', now: () => FIXED_ISO });
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

describe('E2E：AI Quality Dashboard（Phase 46 / 43.22）', () => {
  it('未认证访问 /api/ai-quality 与 /api/ai-quality/trends → 401', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const q = await api.request('GET', '/api/ai-quality');
    expect(q.status).toBe(401);
    const t = await api.request('GET', '/api/ai-quality/trends');
    expect(t.status).toBe(401);
  });

  it('登录 → GET /api/ai-quality → 200，聚合报告含 Accuracy / False Pass / P0 Miss / RCA / Selection / Defect / Healing / Cost / Latency', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'qa-a', 'qa123456');

    const res = await api.request('GET', '/api/ai-quality', { token });
    expect(res.status).toBe(200);
    const report = res.data as Record<string, unknown>;

    // 关键安全指标必须为 0（Unsafe Healing / False Pass 不增加）
    expect(report.falsePass).toBe(0);
    expect(report.p0Miss).toBe(0);

    // 领域质量指标存在且合法（0~1）
    for (const key of ['rcaAccuracy', 'selectionRecall', 'defectQuality', 'healingSafety']) {
      const v = report[key] as number;
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Cost / Latency / Benchmark / Feedback / Proposals / Experiments / Knowledge 统计齐全
    expect(typeof report.accuracy).toBe('number');
    expect(typeof report.cost).toBe('number');
    expect(typeof report.latency).toBe('number');
    expect((report.benchmark as { tracked: number }).tracked).toBeGreaterThan(0);
    expect((report.feedback as { total: number }).total).toBeGreaterThanOrEqual(0);
    expect((report.proposals as { total: number }).total).toBeGreaterThanOrEqual(0);
    expect((report.experiments as { total: number }).total).toBeGreaterThanOrEqual(0);
    expect((report.knowledge as { candidates: number }).candidates).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/ai-quality/trends → 200，含整体趋势快照与各维度基线', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'qa-a', 'qa123456');

    const res = await api.request('GET', '/api/ai-quality/trends', { token });
    expect(res.status).toBe(200);
    const trends = res.data as Record<string, unknown>;
    // 趋势数据为当前快照的聚合指标（Accuracy / 安全 / Cost / Latency / 统计）
    expect(typeof trends.overall).toBe('number');
    expect(typeof trends.generatedAt).toBe('string');
    expect(trends.falsePass).toBe(0);
    expect(trends.p0Miss).toBe(0);
    expect((trends.feedback as { total: number }).total).toBeGreaterThanOrEqual(0);
  });

  it('AI Quality 面板关联端点可读：/api/ai-feedback /api/ai-errors /api/ai-improvements /api/knowledge/review', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b);
    const token = await login(api, 'qa-a', 'qa123456');

    const fb = await api.request('GET', '/api/ai-feedback', { token });
    expect(fb.status).toBe(200);
    const er = await api.request('GET', '/api/ai-errors', { token });
    expect(er.status).toBe(200);
    const im = await api.request('GET', '/api/ai-improvements', { token });
    expect(im.status).toBe(200);
    const kn = await api.request('GET', '/api/knowledge/review', { token });
    expect(kn.status).toBe(200);
    const kr = kn.data as { quality: { total: number } };
    expect(typeof kr.quality.total).toBe('number');
  });
});
