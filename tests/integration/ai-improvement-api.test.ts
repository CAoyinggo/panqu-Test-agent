// 集成测试：AI Improvement API（Phase 46 / 43.26）
// 覆盖：统一 JWT / RBAC / 审计 / 人工审批。
//   - 读端点（GET /ai-feedback /ai-errors /ai-improvements /prompts /models /experiments /knowledge/review /ai-quality /ai-quality/trends）
//     认证即可访问（401 未认证）。
//   - 写端点（POST /ai-feedback/:id/verify /ai-improvements/:id/approve|reject /experiments）必须 RELEASE_APPROVE
//     （VIEWER/QA 403，RELEASE_MANAGER/ADMIN 成功）——人工门禁，禁止 AI 自批。
// 通过 ApiServerOptions.aiQuality 注入预置状态的共享 AI Quality 服务，验证完整链路可被 HTTP 访问。
import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import type { AIQualityService } from '../../src/ai-quality/service.js';
import type { AIFeedback, ImprovementProposal, PromptVersion } from '../../src/ai-quality/contract.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const JWT_SECRET = 'ai-improve-api-secret';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  aiQuality: AIQualityService;
  request(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; data: unknown; contentType?: string }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { withAuth?: boolean; aiQuality?: AIQualityService } = {}): Promise<TestServer> {
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
    auth: opts.withAuth ? bundle.auth : undefined,
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

async function login(ts: TestServer, username: string, password: string): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

/** 预置一条"AI 预测 P2 / 真值 P0"的人工核验错误反馈（RISK / UNDER_PREDICTION） */
function seedFeedback(ai: AIQualityService): AIFeedback {
  return ai.ingest({
    domain: 'RISK',
    prediction: 'P2',
    actual: 'P0',
    feedbackType: 'INCORRECT',
    source: 'HUMAN',
    channel: 'HUMAN_CORRECTION',
    confidence: 0.9,
    note: '集成测试：低估漏判',
  });
}

/** 预置一条已通过离线评测（EVALUATING + Gate=PASS）的提案 */
function seedEvaluatedProposal(ai: AIQualityService): ImprovementProposal {
  ai.autoProposals(); // 从错误聚类自动生成提案
  const p = ai.proposals.list()[0];
  return ai.proposals.recordEvaluation(p.id, {
    baselineScore: 0.9,
    candidateScore: 0.94,
    benchmark: 'RISK_BENCHMARK_v1',
    benchmarkVersion: 'v1',
    critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 },
    qualityDelta: 0.01,
  });
}

describe('Phase 46：AI Improvement API（43.26）', () => {
  it('未认证访问读端点 → 401', async () => {
    const ts = await makeServer({ withAuth: true });
    for (const p of ['/api/ai-feedback', '/api/ai-errors', '/api/ai-improvements', '/api/ai-quality']) {
      const res = await ts.request('GET', p);
      expect(res.status).toBe(401);
    }
  });

  it('GET /api/ai-feedback：认证可见反馈列表，可过滤 domain/source/verified', async () => {
    const ai = createAIQualityService();
    seedFeedback(ai);
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const token = await login(ts, 'qa-a', 'qa123456');

    const all = await ts.request('GET', '/api/ai-feedback', { token });
    expect(all.status).toBe(200);
    const list = all.data as AIFeedback[];
    expect(list.length).toBe(1);
    expect(list[0].domain).toBe('RISK');
    expect(list[0].feedbackType).toBe('INCORRECT');
    expect(list[0].verified).toBe(false);

    const filtered = await ts.request('GET', '/api/ai-feedback?domain=RISK&verified=false', { token });
    expect((filtered.data as AIFeedback[]).length).toBe(1);
    const empty = await ts.request('GET', '/api/ai-feedback?source=PRODUCTION', { token });
    expect((empty.data as AIFeedback[]).length).toBe(0);
  });

  it('POST /api/ai-feedback/:id/verify：QA（无 RELEASE_APPROVE）→ 403；RELEASE_MANAGER → 核验成功', async () => {
    const ai = createAIQualityService();
    const fb = seedFeedback(ai);
    const ts = await makeServer({ withAuth: true, aiQuality: ai });

    const qaToken = await login(ts, 'qa-a', 'qa123456');
    const denied = await ts.request('POST', `/api/ai-feedback/${fb.id}/verify`, { token: qaToken, body: { note: 'QA 越权尝试' } });
    expect(denied.status).toBe(403);

    const rmToken = await login(ts, 'release-mgr', 'release123');
    const ok = await ts.request('POST', `/api/ai-feedback/${fb.id}/verify`, { token: rmToken, body: { note: '人工核验通过' } });
    expect(ok.status).toBe(200);
    const v = ok.data as AIFeedback;
    expect(v.verified).toBe(true);
    expect(v.verifiedBy).toBe('release-mgr');
  });

  it('GET /api/ai-errors：反馈自动聚类为错误聚类（含分类与证据）', async () => {
    const ai = createAIQualityService();
    seedFeedback(ai);
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const token = await login(ts, 'qa-a', 'qa123456');

    const res = await ts.request('GET', '/api/ai-errors', { token });
    expect(res.status).toBe(200);
    const clusters = res.data as Array<{ domain: string; category: string; count: number; cases: string[]; evidence: unknown[] }>;
    expect(clusters.length).toBe(1);
    expect(clusters[0].domain).toBe('RISK');
    expect(clusters[0].category).toBe('UNDER_PREDICTION'); // 预测 P2 真值 P0 → 低估漏判
    expect(clusters[0].count).toBe(1);
    expect(clusters[0].cases).toContain(fbIdOf(ai));
  });

  it('GET /api/ai-improvements + 审批：QA → 403；RELEASE_MANAGER approve/reject → 成功并留审计', async () => {
    const ai = createAIQualityService();
    seedFeedback(ai);
    const p = seedEvaluatedProposal(ai);
    expect(p.gateVerdict).toBe('PASS');
    expect(p.status).toBe('EVALUATING');
    const ts = await makeServer({ withAuth: true, aiQuality: ai });

    const qaToken = await login(ts, 'qa-a', 'qa123456');
    const list = await ts.request('GET', '/api/ai-improvements', { token: qaToken });
    expect((list.data as ImprovementProposal[]).length).toBe(1);

    const denied = await ts.request('POST', `/api/ai-improvements/${p.id}/approve`, { token: qaToken });
    expect(denied.status).toBe(403);

    const rmToken = await login(ts, 'release-mgr', 'release123');
    const approved = await ts.request('POST', `/api/ai-improvements/${p.id}/approve`, { token: rmToken });
    expect(approved.status).toBe(200);
    const ap = approved.data as ImprovementProposal;
    expect(ap.status).toBe('APPROVED');
    expect(ap.approvedBy).toBe('release-mgr');
    expect(ap.approvalId).toBeDefined();

    const rejected = await ts.request('POST', `/api/ai-improvements/${p.id}/reject`, { token: rmToken, body: { reason: '改为人工拒绝测试' } });
    expect(rejected.status).toBe(200);
    expect((rejected.data as ImprovementProposal).status).toBe('REJECTED');
  });

  it('GET /api/prompts、/api/prompts/:id/versions、/api/models：版本化信息可读', async () => {
    const ai = createAIQualityService();
    const v1 = ai.prompts.add({ promptKey: 'risk', content: 'v1 prompt', createdBy: 'human-1' });
    ai.prompts.add({ promptKey: 'risk', content: 'v2 prompt', createdBy: 'human-2' });
    ai.models.add({ provider: 'deepseek', model: 'xxx', modelVersion: 'v4', createdBy: 'human-1' });
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const token = await login(ts, 'qa-a', 'qa123456');

    const prompts = await ts.request('GET', '/api/prompts', { token });
    expect((prompts.data as PromptVersion[]).length).toBe(2);
    const versions = await ts.request('GET', `/api/prompts/${v1.id}/versions`, { token });
    expect((versions.data as PromptVersion[]).length).toBe(2); // 同 key 版本序列
    const models = await ts.request('GET', '/api/models', { token });
    const ml = models.data as Array<{ provider: string; modelVersion: string }>;
    expect(ml.length).toBe(1);
    expect(ml[0].provider).toBe('deepseek');
    expect(ml[0].modelVersion).toBe('v4');
  });

  it('POST /api/experiments：QA → 403；RELEASE_MANAGER 创建 Shadow / Canary', async () => {
    const ai = createAIQualityService();
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const qaToken = await login(ts, 'qa-a', 'qa123456');
    const denied = await ts.request('POST', '/api/experiments', { token: qaToken, body: { type: 'SHADOW', proposalId: 'imp-x', candidateRef: 'prompt-1' } });
    expect(denied.status).toBe(403);

    const rmToken = await login(ts, 'release-mgr', 'release123');
    const shadow = await ts.request('POST', '/api/experiments', { token: rmToken, body: { type: 'SHADOW', proposalId: 'imp-x', candidateRef: 'prompt-1' } });
    expect(shadow.status).toBe(200);
    expect((shadow.data as { type: string }).type).toBe('SHADOW');

    const canary = await ts.request('POST', '/api/experiments', { token: rmToken, body: { type: 'CANARY', proposalId: 'imp-y', candidateRef: 'prompt-2' } });
    expect(canary.status).toBe(200);
    expect((canary.data as { type: string; canaryStage: string }).type).toBe('CANARY');
    expect((canary.data as { canaryStage: string }).canaryStage).toBe('5%');

    const list = await ts.request('GET', '/api/experiments?type=CANARY', { token: rmToken });
    expect((list.data as unknown[]).length).toBe(1);
  });

  it('POST /api/experiments 缺参数 → 400；未知类型 → 400', async () => {
    const ai = createAIQualityService();
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const rmToken = await login(ts, 'release-mgr', 'release123');
    const noRef = await ts.request('POST', '/api/experiments', { token: rmToken, body: { type: 'SHADOW', proposalId: 'imp-x' } });
    expect(noRef.status).toBe(400);
    const badType = await ts.request('POST', '/api/experiments', { token: rmToken, body: { type: 'MAGIC', proposalId: 'imp-x', candidateRef: 'r' } });
    expect(badType.status).toBe(400);
  });

  it('GET /api/knowledge/review：候选 + 生产知识 + 质量指标', async () => {
    const ai = createAIQualityService();
    ai.knowledge.createCandidate({ category: 'RISK', content: 'P0 严重度规则', source: 'HUMAN', confidence: 0.9 });
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const token = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('GET', '/api/knowledge/review', { token });
    expect(res.status).toBe(200);
    const body = res.data as { candidates: unknown[]; items: unknown[]; quality: { total: number } };
    expect(body.candidates.length).toBe(1);
    expect(body.items.length).toBe(0); // 未经人工 Review 不进入生产
    expect(typeof body.quality.total).toBe('number');
  });

  it('GET /api/ai-quality 与 /api/ai-quality/trends：聚合质量报告含关键指标', async () => {
    const ai = createAIQualityService();
    seedFeedback(ai);
    const ts = await makeServer({ withAuth: true, aiQuality: ai });
    const token = await login(ts, 'qa-a', 'qa123456');

    const report = await ts.request('GET', '/api/ai-quality', { token });
    expect(report.status).toBe(200);
    const r = report.data as Record<string, unknown>;
    expect(typeof r.accuracy).toBe('number');
    expect(typeof r.falsePass).toBe('number');
    expect(typeof r.p0Miss).toBe('number');
    expect((r.feedback as { total: number }).total).toBe(1);

    const trends = await ts.request('GET', '/api/ai-quality/trends', { token });
    expect(trends.status).toBe(200);
    const t = trends.data as Record<string, unknown>;
    expect(typeof t.overall).toBe('number');
    expect(t.generatedAt).toBeDefined();
  });
});

/** 从服务中取出首个反馈 ID（供聚类 cases 断言） */
function fbIdOf(ai: AIQualityService): string {
  const fb = ai.feedback.list()[0];
  if (!fb) throw new Error('无反馈');
  return fb.id;
}
