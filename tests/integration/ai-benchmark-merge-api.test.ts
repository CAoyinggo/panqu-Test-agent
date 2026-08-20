// 集成测试：Benchmark 候选并入 API（Phase 50 / 43.21 落地：Review → Benchmark）
// 覆盖：POST /api/ai-quality/benchmark-candidates/merge
//       QA 403（人工门禁，禁止 AI 自批/自动并库）/ RELEASE_MANAGER 成功并入 + 升版 /
//       无已批准候选 → 明确提示 / 幂等（已并入不可重复）。
import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import type { AIQualityService } from '../../src/ai-quality/service.js';
import type { BenchmarkCandidate } from '../../src/ai-quality/eval-bridge.js';

const FIXED_ISO = '2026-08-20T12:00:00.000Z';
const JWT_SECRET = 'ai-merge-secret';

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

/** 桥接真实评测并人工批准前 N 条候选，返回候选数组（用于并入测试） */
async function bridgeAndApprove(ts: TestServer, token: string, count: number): Promise<BenchmarkCandidate[]> {
  const bridge = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/bridge', { token, body: {} })).data as { candidates: BenchmarkCandidate[] };
  const approved: BenchmarkCandidate[] = [];
  for (const c of bridge.candidates.slice(0, count)) {
    const res = await ts.request('POST', `/api/ai-quality/benchmark-candidates/${c.id}/approve`, { token, body: {} });
    expect(res.status).toBe(200);
    approved.push(res.data as BenchmarkCandidate);
  }
  return approved;
}

describe('Phase 50：Benchmark 候选并入 API（43.21 Review→Benchmark）', () => {
  it('未认证访问 merge → 401', async () => {
    const ts = await makeServer();
    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { body: {} });
    expect(res.status).toBe(401);
  });

  it('QA（无 RELEASE_APPROVE）→ 403（人工门禁，禁止自动并库）', async () => {
    const ts = await makeServer();
    const qa = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { token: qa, body: {} });
    expect(res.status).toBe(403);
  });

  it('无可并入候选（无已批准）→ 明确提示，不报错', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { token, body: {} });
    expect(res.status).toBe(200);
    const body = res.data as { merged: number; message: string };
    expect(body.merged).toBe(0);
    expect(body.message).toContain('无可并入候选');
  });

  it('RELEASE_MANAGER：桥接 → 批准 → 并入 → 候选 MERGED + Benchmark 升版 + 审计', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const approved = await bridgeAndApprove(ts, token, 1);
    expect(approved.length).toBe(1);
    const cand = approved[0];
    const domainBefore = ts.aiQuality.benchmarkRegistry.latest(cand.domain as never);
    const versionBefore = domainBefore?.version ?? 'v0';

    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { token, body: { candidateIds: [cand.id] } });
    expect(res.status).toBe(200);
    const body = res.data as { merged: number; mergedCases: Array<{ candidateId: string; caseId: string; domain: string }>; benchmarkVersions: string[]; message: string };
    expect(body.merged).toBe(1);
    expect(body.mergedCases[0].candidateId).toBe(cand.id);
    expect(body.benchmarkVersions.length).toBe(1);
    expect(body.message).toContain('已并入');

    // 候选状态 MERGED + 落地凭据
    const updated = ts.aiQuality.benchmarkCandidates.get(cand.id)!;
    expect(updated.status).toBe('MERGED');
    expect(updated.mergedCaseId).toBeTruthy();
    expect(updated.mergedBenchmark).toBe(body.benchmarkVersions[0]);

    // Benchmark 升版（v1 → v2）
    const latest = ts.aiQuality.benchmarkRegistry.latest(cand.domain as never)!;
    expect(versionRankOf(latest.version)).toBe(versionRankOf(versionBefore) + 1);
    expect(latest.cases.some((c) => c.id === updated.mergedCaseId)).toBe(true);

    // 并入用例已登记 Ground Truth（HUMAN 核实，不允许未追踪声称准确率）
    expect(ts.aiQuality.groundTruthRegistry.isTracked(updated.mergedCaseId!)).toBe(true);

    // 完整审计（proposalId/actor/metrics/decision）
    expect(ts.aiQuality.audit.list().some((a) => a.candidate === cand.id && a.action === 'APPROVED' && String(a.metrics?.merged) === '1')).toBe(true);

    // 幂等：已并入候选再次 merge → 不再并入
    const again = (await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { token, body: { candidateIds: [cand.id] } })).data as { merged: number };
    expect(again.merged).toBe(0);
  });

  it('RELEASE_MANAGER：并入全部已批准候选（多领域升版）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const approved = await bridgeAndApprove(ts, token, 3);
    expect(approved.length).toBeGreaterThan(0);

    const res = await ts.request('POST', '/api/ai-quality/benchmark-candidates/merge', { token, body: {} });
    expect(res.status).toBe(200);
    const body = res.data as { merged: number };
    expect(body.merged).toBe(approved.length);
    // 所有并入候选状态收敛为 MERGED
    const stillApproved = ts.aiQuality.benchmarkCandidates.list({ status: 'APPROVED' });
    expect(stillApproved.length).toBe(0);
    expect(ts.aiQuality.benchmarkCandidates.list({ status: 'MERGED' }).length).toBe(approved.length);
  });
});

function versionRankOf(v: string): number {
  const m = /^v(\d+)$/.exec(v);
  return m ? Number(m[1]) : 0;
}
