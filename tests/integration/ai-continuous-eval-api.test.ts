// 集成测试：Continuous Evaluation API（Phase 48 / 43.26 扩展）
// 覆盖：GET /api/ai-quality/continuous-evals（列表 + 调度常量）
//       GET /api/ai-quality/continuous-evals/:id（详情 / 404）
//       POST /api/ai-quality/continuous-evals/run（手动触发；QA 403 / RELEASE_MANAGER 成功 / 非法 schedule 400）
//       JWT / RBAC / 审计一致性。
import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import type { AIQualityService } from '../../src/ai-quality/service.js';
import type { ContinuousEvalRun } from '../../src/ai-quality/continuous-eval.js';

const FIXED_ISO = '2026-08-18T12:00:00.000Z';
const JWT_SECRET = 'ai-continuous-eval-secret';

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

describe('Phase 48：Continuous Evaluation API（43.20 落地）', () => {
  it('未认证访问列表 → 401', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/api/ai-quality/continuous-evals');
    expect(res.status).toBe(401);
  });

  it('GET 列表：初始 total=0，且返回调度常量（NIGHTLY/WEEKLY/RELEASE）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('GET', '/api/ai-quality/continuous-evals', { token });
    expect(res.status).toBe(200);
    const body = res.data as { total: number; runs: ContinuousEvalRun[]; schedules: Array<{ name: string; cronLike: string }> };
    expect(body.total).toBe(0);
    expect(body.runs).toEqual([]);
    expect(body.schedules.map((s) => s.name)).toEqual(['nightly', 'weekly', 'release']);
  });

  it('POST run：QA（无 RELEASE_APPROVE）→ 403（人工门禁）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'qa-a', 'qa123456');
    const res = await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'NIGHTLY' } });
    expect(res.status).toBe(403);
    expect(ts.aiQuality.continuousEval.size()).toBe(0); // 未执行
  });

  it('POST run：RELEASE_MANAGER 手动触发 → 200，返回真实运行记录（verdict/alert/releaseBlocked）', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const res = await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'RELEASE' } });
    expect(res.status).toBe(200);
    const run = res.data as ContinuousEvalRun;
    expect(run.schedule).toBe('RELEASE');
    expect(run.triggeredBy).toBe('MANUAL');
    expect(run.current.overall).toBeGreaterThan(0);
    expect(run.domainCount).toBe(8);
    expect(['PASS', 'REVIEW', 'BLOCK']).toContain(run.regression.verdict);
    expect(run.alertSent).toBe(false);
    expect(run.releaseBlocked).toBe(false);
    // 已入库 + 审计
    expect(ts.aiQuality.continuousEval.size()).toBe(1);
    expect(ts.aiQuality.audit.size()).toBe(1);
  });

  it('POST run：非法 schedule → 400', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const res = await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'DAILY' } });
    expect(res.status).toBe(400);
  });

  it('GET 详情：存在返回运行记录；不存在 → 404', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    const created = (await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'NIGHTLY' } })).data as ContinuousEvalRun;

    const detail = await ts.request('GET', `/api/ai-quality/continuous-evals/${created.id}`, { token });
    expect(detail.status).toBe(200);
    expect((detail.data as ContinuousEvalRun).id).toBe(created.id);
    expect((detail.data as ContinuousEvalRun).regression.verdict).toBe('PASS');

    const missing = await ts.request('GET', '/api/ai-quality/continuous-evals/nonexistent', { token });
    expect(missing.status).toBe(404);
  });

  it('GET 列表支持 ?schedule= 过滤', async () => {
    const ts = await makeServer();
    const token = await login(ts, 'release-mgr', 'release123');
    await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'NIGHTLY' } });
    await ts.request('POST', '/api/ai-quality/continuous-evals/run', { token, body: { schedule: 'WEEKLY' } });

    const all = (await ts.request('GET', '/api/ai-quality/continuous-evals', { token })).data as { total: number };
    expect(all.total).toBe(2);
    const weekly = (await ts.request('GET', '/api/ai-quality/continuous-evals?schedule=WEEKLY', { token })).data as { total: number };
    expect(weekly.total).toBe(1);
  });
});
