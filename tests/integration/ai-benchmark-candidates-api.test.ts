// 集成测试：Benchmark 扩充候选 API（Phase 49 / 43.21 + 43.26 扩展）
// 覆盖：GET /api/ai-quality/benchmark-candidates（列表 + 状态/领域过滤）
//       POST /api/ai-quality/benchmark-candidates/bridge（QA 403 / RELEASE_MANAGER 成功，真实评测桥接）
//       POST /api/ai-quality/benchmark-candidates/:id/approve|reject（人工门禁 + 状态机 + 审计）
//       JWT / RBAC / 幂等一致性。
import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import type { AIQualityService } from '../../src/ai-quality/service.js';
import type { BenchmarkCandidate } from '../../src/ai-quality/eval-bridge.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const JWT_SECRET = 'ai-benchmark-secret';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  aiQuality: AIQualityService;
  request(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { aiQuality?: AIQualityService } = {}): Promise<TestServer> {
  const bundle = createPlatformService({
    seedProject: true,
    seedUsers: true,
    jwtSecret: JWT_SECRET,
    now: () => FIXED_ISO,
  });
  await bundle.auth.ensureSeeded();
  const aiQuality = opts.aiQuality ?? createAIQualityService();
  const server = createPlatformServer({
    service: bundle.service,
    auth: bundle.auth,
    mode: 'test',
    token: 'ai-static-token',
    now: () => FIXED_ISO,
    aiQuality,
  });
  const { url } = await server.listen();
  const ts: TestServer = {
    url,
    server,
    bundle,
    aiQuality,
    async request(method, p, ro = {}) {
      const res = await fetch(`${url}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(ro.token ? { Authorization: `Bearer ${ro.token}` } : {}),
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

async function login(ts: TestServer, username: string, password: string): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('Phase 49：Benchmark 扩充候选 API（43.21 落地）', () => {
  it('未认证访问列表 → 401', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/api/ai-quality/benchmark-candidates');
    expect(res.status).toBe(401);
  });

  it('GET 列表：初始为空数组', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('GET', '/api/ai-quality/benchmark-candidates', { token });
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it('POST bridge：QA（无 RELEASE_APPROVE）→ 403（人工门禁，禁止自动并库）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} });
    expect(res.status).toBe(403);
    expect(ts.aiQuality.benchmarkCandidates.size()).toBe(0); // 未执行
  });

  it('POST bridge：RELEASE_MANAGER → 真实评测桥接失败用例为候选（全部 PENDING_REVIEW）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} });
    expect(res.status).toBe(200);
    const body = res.data as { ingested: number; feedbackIds: string[]; candidates: BenchmarkCandidate[]; message: string };
    expect(body.candidates.length).toBe(body.ingested);
    expect(body.feedbackIds.length).toBe(body.ingested);
    for (const c of body.candidates) {
      expect(c.status).toBe('PENDING_REVIEW'); // 一律待审，禁止自动并入
      expect(c.source).toBe('EVALUATION');
      expect(c.feedbackId).toBeTruthy();
    }
    // 反馈已入库（BENCHMARK_FAILURE 渠道，待人工核验）
    expect(ts.aiQuality.feedback.size()).toBe(body.ingested);
    expect(ts.aiQuality.feedback.list({ channel: 'BENCHMARK_FAILURE' }).length).toBe(body.ingested);
    // 幂等：再次 bridge 不重复入库
    const second = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} })).data as { ingested: number; skippedDupes: number };
    expect(second.ingested).toBe(0);
    expect(second.skippedDupes).toBe(body.ingested);
  });

  it('POST approve：RELEASE_MANAGER → APPROVED + reviewer + 审计；QA → 403；不存在 → 400', async () => {
    const ts = await makeServer();
    const release = await login(ts, 'release-mgr', 'release123');
    const bridge = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token: release, body: {} })).data as { candidates: BenchmarkCandidate[] };
    const cand = bridge.candidates[0];

    // QA 无权限 → 403
    const qa = await login(ts, 'qa-a', 'qa123456');
    const denied = await ts.request('POST', `/api/ai-quality/benchmark-candidates/${cand.id}/approve`, { token: qa, body: {} });
    expect(denied.status).toBe(403);

    // RELEASE_MANAGER 批准 → 200
    const ok = await ts.request('POST', `/api/ai-quality/benchmark-candidates/${cand.id}/approve`, { token: release, body: {} });
    expect(ok.status).toBe(200);
    const approved = ok.data as BenchmarkCandidate;
    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewer).toBe('release-mgr');
    expect(approved.reviewedAt).toBeTruthy();
    expect(ts.aiQuality.audit.list().some((a) => a.candidate === cand.id && a.action === 'APPROVED')).toBe(true);

    // 重复批准 → 400（状态机禁止）
    const dup = await ts.request('POST', `/api/ai-quality/benchmark-candidates/${cand.id}/approve`, { token: release, body: {} });
    expect(dup.status).toBe(400);

    // 不存在 → 400
    const missing = await ts.request('POST', '/api/ai-quality/benchmark-candidates/nonexistent/approve', { token: release, body: {} });
    expect(missing.status).toBe(400);
  });

  it('POST reject：记录原因 + reviewer + 审计', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const bridge = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} })).data as { candidates: BenchmarkCandidate[] };
    const cand = bridge.candidates[0];
    const res = await ts.request('POST', `/api/ai-quality/benchmark-candidates/${cand.id}/reject`, { token, body: { reason: 'Ground Truth 有误' } });
    expect(res.status).toBe(200);
    const rejected = res.data as BenchmarkCandidate;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reason).toBe('Ground Truth 有误');
    expect(ts.aiQuality.audit.list().some((a) => a.candidate === cand.id && a.action === 'REJECTED')).toBe(true);
  });

  it('GET 列表支持 ?status / ?domain 过滤', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const bridge = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} })).data as { candidates: BenchmarkCandidate[] };
    const cand = bridge.candidates[0];
    await ts.request('POST', `/api/ai-quality/benchmark-candidates/${cand.id}/approve`, { token, body: {} });

    const all = (await ts.request('GET', '/api/ai-quality/benchmark-candidates', { token })).data as BenchmarkCandidate[];
    expect(all.length).toBe(bridge.candidates.length);
    const approved = (await ts.request('GET', '/api/ai-quality/benchmark-candidates?status=APPROVED', { token })).data as BenchmarkCandidate[];
    expect(approved.length).toBe(1);
    const byDomain = (await ts.request('GET', `/api/ai-quality/benchmark-candidates?domain=${cand.domain}`, { token })).data as BenchmarkCandidate[];
    expect(byDomain.length).toBeGreaterThan(0);
    expect(byDomain.every((c) => c.domain === cand.domain)).toBe(true);
  });
});
