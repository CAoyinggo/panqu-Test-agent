// E2E：QA Workflow（Phase 39.8）8 个核心场景
// S1 Create Suite → Add Cases → Save
// S2 Suite → Test Plan → Run → COMPLETED
// S3 Run → Save Template → Run Again
// S4 TestCase v1 → v2 → Compare → Run 固定 v2
// S5 Failure → Comment → Mention → Notification
// S6 Run → Share Report → Project Permission
// S7 Project A User → 无法查看 Project B Report
// S8 QA Home → Pending Approval → Failed Run → Release Review → 一键进入处理页面

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import type { PlatformEvent } from '../../src/platform/events/events.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const TOKEN = 'qa-e2e-token';
const JWT_SECRET = 'qa-e2e-secret';

const opened: PlatformHttpServer[] = [];

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

function makeAuthBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: JWT_SECRET, now: () => FIXED_ISO });
}

async function startServer(b: PlatformBundle, auth?: import('../../src/platform/auth/auth-service.js').AuthService): Promise<{ request: (m: string, p: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }> }> {
  const server = createPlatformServer({ service: b.service, auth, token: TOKEN, now: () => FIXED_ISO });
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

const QA = { 'X-Actor': 'qa', 'X-Role': 'QA' };

async function login(ts: { request: (m: string, p: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }> }, u: string, p: string): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username: u, password: p } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('S1：Create Suite → Add Cases → Save', () => {
  it('创建 Suite，添加真实 Case，保存后引用完整', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    const created = await api.request('POST', '/test-suites', { token: TOKEN, headers: QA, body: { projectId: 'wan3', name: 'WAN3 1080p 回归', caseIds: ['wan3-1080p-10s', 'wan3-1080p-5s'], tags: ['regression', 'p0'] } });
    expect(created.status).toBe(200);
    const id = (created.data as { id: string }).id;
    const saved = await api.request('GET', `/test-suites/${id}`, { token: TOKEN, headers: QA });
    expect((saved.data as { caseIds: string[] }).caseIds).toEqual(['wan3-1080p-10s', 'wan3-1080p-5s']);
    expect((saved.data as { tags: string[] }).tags).toContain('p0');
  });
});

describe('S2：Suite → Test Plan → Run → COMPLETED', () => {
  it('完整工作流：Plan 引用 Suite 并运行到 COMPLETED', async () => {
    const b = makeBundle();
    b.registerWorkerExecutor('w', async (job: unknown) => {
      const { runId } = job as { runId: string };
      const run = await b.service.getRun(runId);
      if (run?.status === 'QUEUED') {
        await b.service.startRun(runId);
        await b.service.completeRun(runId);
      }
    });
    const api = await startServer(b);
    const s = await api.request('POST', '/test-suites', { token: TOKEN, headers: QA, body: { projectId: 'wan3', name: 'S2 suite', caseIds: ['wan3-1080p-10s'] } });
    const sid = (s.data as { id: string }).id;
    const p = await api.request('POST', '/test-plans', { token: TOKEN, headers: QA, body: { projectId: 'wan3', name: 'S2 plan', suiteIds: [sid], environment: 'staging', mode: 'REGRESSION' } });
    const pid = (p.data as { id: string }).id;
    const r = await api.request('POST', `/test-plans/${pid}/run`, { token: TOKEN, headers: QA });
    const runId = (r.data as { runId: string }).runId;
    // Worker 执行 → COMPLETED
    await b.pool.dispatch();
    await b.pool.drain();
    const run = await b.service.getRun(runId);
    expect(run?.status).toBe('COMPLETED');
    expect(run?.planId).toBe(pid);
  });
});

describe('S3：Run → Save Template → Run Again', () => {
  it('保存模板并 Run Again，仅复制配置', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    const r = await api.request('POST', '/runs', { token: TOKEN, headers: QA, body: { projectId: 'wan3', environment: 'staging', trigger: 'autonomous', suiteIds: ['s1'], mode: 'AUTONOMOUS', budget: 10, releaseGate: true } });
    const runId = (r.data as { runId: string }).runId;
    const t = await api.request('POST', `/runs/${runId}/template`, { token: TOKEN, headers: QA, body: { name: 'WAN3 回归模板' } });
    expect(t.status).toBe(200);
    const tid = (t.data as { id: string }).id;
    const again = await api.request('POST', `/run-templates/${tid}/run`, { token: TOKEN, headers: QA });
    const againId = (again.data as { runId: string }).runId;
    const fresh = await b.service.getRun(againId);
    expect(fresh?.templateId).toBe(tid);
    expect(fresh?.mode).toBe('AUTONOMOUS');
    expect(fresh?.budget).toBe(10);
    expect(fresh?.status).toBe('QUEUED'); // 不带旧结果
  });
});

describe('S4：TestCase v1 → v2 → Compare → Run 固定 v2', () => {
  it('版本递增、比较、Run 固定最新版本', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    await api.request('POST', '/assets/wan3-1080p-10s/version', { token: TOKEN, headers: QA, body: { assetType: 'test-case', snapshot: { title: 'v1', steps: ['s1'] }, changeReason: '初始' } });
    await api.request('POST', '/assets/wan3-1080p-10s/version', { token: TOKEN, headers: QA, body: { assetType: 'test-case', snapshot: { title: 'v2', steps: ['s1', 's2'] }, changeReason: '补充步骤' } });
    const diff = await api.request('GET', '/assets/wan3-1080p-10s/compare?from=1&to=2', { token: TOKEN, headers: QA });
    expect((diff.data as { changed: string[] }).changed).toContain('steps');
    const s = await api.request('POST', '/test-suites', { token: TOKEN, headers: QA, body: { projectId: 'wan3', name: 'S4', caseIds: ['wan3-1080p-10s'] } });
    const p = await api.request('POST', '/test-plans', { token: TOKEN, headers: QA, body: { projectId: 'wan3', name: 'S4 plan', suiteIds: [(s.data as { id: string }).id], environment: 'test', mode: 'MANUAL' } });
    const run = await api.request('POST', `/test-plans/${(p.data as { id: string }).id}/run`, { token: TOKEN, headers: QA });
    const runId = (run.data as { runId: string }).runId;
    const detail = await api.request('GET', `/runs/${runId}`, { token: TOKEN, headers: QA });
    expect((detail.data as { assetVersion: Record<string, number> }).assetVersion?.['wan3-1080p-10s']).toBe(2);
  });
});

describe('S5：Failure → Comment → Mention → Notification', () => {
  it('失败 Run 评论 @zhangsan → 触发 CollaborationMention 通知事件', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    const mentions: PlatformEvent[] = [];
    b.bus.subscribe('CollaborationMention', (e) => { mentions.push(e); });
    // 制造失败 Run
    const r = await api.request('POST', '/runs', { token: TOKEN, headers: QA, body: { projectId: 'wan3', environment: 'staging', trigger: 'autonomous' } });
    const runId = (r.data as { runId: string }).runId;
    await b.service.startRun(runId);
    await b.service.failRun(runId, 'MODEL_ERROR');
    // 评论 + @mention
    const c = await api.request('POST', `/runs/${runId}/comments`, { token: TOKEN, headers: QA, body: { body: 'RCA: MODEL_ERROR @zhangsan 请确认模型服务是否刚发布。' } });
    expect(c.status).toBe(200);
    expect((c.data as { mentions: string[] }).mentions).toEqual(['zhangsan']);
    expect(mentions.length).toBe(1);
    expect(mentions[0].data.mention).toBe('zhangsan');
  });
});

describe('S6：Run → Share Report → Project Permission', () => {
  it('分享报告生成 share link，报告可读', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    const r = await api.request('POST', '/runs', { token: TOKEN, headers: QA, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (r.data as { runId: string }).runId;
    const share = await api.request('GET', `/runs/${runId}/share`, { token: TOKEN, headers: QA });
    expect(share.status).toBe(200);
    const sh = share.data as { url: string; share: { token: string } };
    expect(sh.url).toContain(`/runs/${runId}/report`);
    const report = await api.request('GET', `/runs/${runId}/report`, { token: TOKEN, headers: QA });
    expect(report.status).toBe(200);
  });
});

describe('S7：Project A User → 无法查看 Project B Report', () => {
  it('qa-a（wan3）无法查看 order 项目报告', async () => {
    const b = makeAuthBundle();
    await b.auth.ensureSeeded();
    const api = await startServer(b, b.auth);
    const admin = await login(api, 'admin', 'admin123');
    const proj = await api.request('POST', '/projects', { token: admin, body: { id: 'order', name: 'Order', businesses: ['order'], environments: [{ id: 'test', name: 'test', type: 'test', enabled: true }], defaultEnvironment: 'test' } });
    expect(proj.status).toBe(200);
    const rB = await api.request('POST', '/runs', { token: admin, body: { projectId: 'order', environment: 'test', trigger: 'manual' } });
    const runB = (rB.data as { runId: string }).runId;
    const qaA = await login(api, 'qa-a', 'qa123456');
    expect((await api.request('GET', `/runs/${runB}/report`, { token: qaA })).status).toBe(403);
  });
});

describe('S8：QA Home → Pending Approval / Failed Run / Release Review → 一键进入', () => {
  it('Action Center 聚合待审批与失败 Run，target 直达资源', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    // 制造失败 Run
    const r = await api.request('POST', '/runs', { token: TOKEN, headers: QA, body: { projectId: 'wan3', environment: 'staging', trigger: 'autonomous' } });
    const runId = (r.data as { runId: string }).runId;
    await b.service.startRun(runId);
    await b.service.failRun(runId, 'model crash');
    // 制造待审批 Release Review
    await b.approvals.request({ runId, action: 'release', riskLevel: 'risky', environment: 'staging', requester: 'qa', reason: 'release review' });
    const home = await api.request('GET', '/qa-home', { token: TOKEN, headers: QA });
    expect(home.status).toBe(200);
    const h = home.data as { failedRuns: Array<{ runId: string }>; pendingApprovals: Array<{ approvalId: string }>; actionCenter: Array<{ category: string; title: string; target: string }> };
    expect(h.failedRuns.some((f) => f.runId === runId)).toBe(true);
    expect(h.pendingApprovals.length).toBeGreaterThan(0);
    // Action Center：失败 Run 与 Release REVIEW 待审批，target 一键直达
    const failureAction = h.actionCenter.find((a) => a.category === 'FAILURE');
    expect(failureAction?.target).toBe(runId);
    const releaseAction = h.actionCenter.find((a) => a.category === 'RELEASE');
    expect(releaseAction?.title).toContain('Release REVIEW');
    expect(releaseAction?.target).toBe(h.pendingApprovals[0].approvalId);
  });
});
