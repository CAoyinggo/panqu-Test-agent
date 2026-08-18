// 单元测试：Platform HTTP API（Phase 24.7）
// 覆盖：POST /runs 返回 { runId, status: 'QUEUED' }、认证 401、限流 429、404、
//       请求校验 400、幂等（Idempotency-Key）、Dashboard / Health、
//       Approval 流程（approve / reject）、Run 查询 / 报告 / Trace。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const TOKEN = 'test-token';

interface RequestOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface TestServer {
  port: number;
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: RequestOpts): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(opts: { rateLimitPerMinute?: number } = {}): Promise<TestServer> {
  const bundle = createPlatformService({ seedProject: true, now: () => FIXED_ISO });
  const server = createPlatformServer({
    service: bundle.service,
    token: TOKEN,
    now: () => FIXED_ISO,
    rateLimitPerMinute: opts.rateLimitPerMinute,
  });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const ts: TestServer = {
    port,
    url: base,
    server,
    bundle,
    async request(method: string, path: string, ro: RequestOpts = {}) {
      const res = await fetch(`${base}${path}`, {
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

describe('Platform API：认证与基础', () => {
  it('无 Token → 401', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/health');
    expect(res.status).toBe(401);
    expect((res.data as { error: string }).error).toBe('unauthorized');
  });

  it('错误 Token → 401', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/health', { token: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('未知路由 → 404', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/no-such-route', { token: TOKEN });
    expect(res.status).toBe(404);
  });

  it('GET /health → ok', async () => {
    const ts = await makeServer();
    const res = await ts.request('GET', '/health', { token: TOKEN });
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
  });
});

describe('Platform API：限流（429）', () => {
  it('超过每分钟上限 → 429', async () => {
    const ts = await makeServer({ rateLimitPerMinute: 2 });
    expect((await ts.request('GET', '/health', { token: TOKEN })).status).toBe(200);
    expect((await ts.request('GET', '/health', { token: TOKEN })).status).toBe(200);
    const third = await ts.request('GET', '/health', { token: TOKEN });
    expect(third.status).toBe(429);
    expect((third.data as { error: string }).error).toBe('rate_limited');
  });
});

describe('Platform API：Run 生命周期', () => {
  it('POST /runs → { runId, status: "QUEUED" }', async () => {
    const ts = await makeServer();
    const res = await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'autonomous', change: { type: 'model', target: 'wan3/text-to-video' } },
    });
    expect(res.status).toBe(200);
    const data = res.data as { runId: string; status: string };
    expect(data.runId).toMatch(/^run-/);
    expect(data.status).toBe('QUEUED');
    // Run 已落入存储且入队
    const run = await ts.bundle.service.getRun(data.runId);
    expect(run?.environment).toBe('test');
    expect(await ts.bundle.scheduler.pendingCount()).toBe(1);
  });

  it('VIEWER 角色无 TEST_RUN → 400（RBAC 拒绝）', async () => {
    const ts = await makeServer();
    const res = await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'viewer', 'X-Role': 'VIEWER' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/权限/);
  });

  it('不存在的 Project → 400', async () => {
    const ts = await makeServer();
    const res = await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'nope', environment: 'test', trigger: 'manual' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/Project 不存在/);
  });

  it('幂等：相同 Idempotency-Key 只创建 1 个 Run', async () => {
    const ts = await makeServer();
    const opts = {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA', 'Idempotency-Key': 'ABC' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    };
    const a = await ts.request('POST', '/runs', opts);
    const b = await ts.request('POST', '/runs', opts);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.data as { runId: string }).runId).toBe((b.data as { runId: string }).runId);
    expect((await ts.bundle.runs.list({})).length).toBe(1);
  });

  it('GET /runs/:id 返回 Run；GET /runs/:id/report 与 /trace 可用', async () => {
    const ts = await makeServer();
    const created = await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    const runId = (created.data as { runId: string }).runId;
    const getRes = await ts.request('GET', `/runs/${runId}`, { token: TOKEN });
    expect(getRes.status).toBe(200);
    expect((getRes.data as { runId: string }).runId).toBe(runId);
    const reportRes = await ts.request('GET', `/runs/${runId}/report`, { token: TOKEN });
    expect(reportRes.status).toBe(200);
    expect((reportRes.data as { runId: string }).runId).toBe(runId);
    const traceRes = await ts.request('GET', `/runs/${runId}/trace`, { token: TOKEN });
    expect(traceRes.status).toBe(200);
    // Run Detail：Run + Checkpoint + Trace 视图
    const detailRes = await ts.request('GET', `/runs/${runId}/detail`, { token: TOKEN });
    expect(detailRes.status).toBe(200);
    expect((detailRes.data as { run: { runId: string } }).run.runId).toBe(runId);
    expect((detailRes.data as { approvals: unknown[] }).approvals).toBeDefined();
  });

  it('POST /runs/:id/cancel → CANCELLED', async () => {
    const ts = await makeServer();
    const created = await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    const runId = (created.data as { runId: string }).runId;
    const res = await ts.request('POST', `/runs/${runId}/cancel`, {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
    });
    expect(res.status).toBe(200);
    expect((res.data as { status: string }).status).toBe('CANCELLED');
  });
});

describe('Platform API：Approval 流程', () => {
  it('risky@production → 审批 PENDING → approve 通过', async () => {
    const ts = await makeServer();
    const env = ts.bundle.projects.getEnvironment('wan3', 'production');
    expect(env).not.toBeNull();
    // 模拟 Pipeline 中的受限动作：创建审批
    const outcome = await ts.bundle.gate.execute({
      actor: 'qa-user',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      runId: 'run-e2e-1',
      reason: '验证生产风险动作审批',
      environment: env!,
    });
    expect(outcome.verdict).toBe('APPROVAL_REQUIRED');
    const approvalId = (outcome as { approval: { approvalId: string } }).approval.approvalId;
    // 待审批列表
    const listRes = await ts.request('GET', '/approvals', { token: TOKEN });
    expect(listRes.status).toBe(200);
    const pending = (listRes.data as Array<{ approvalId: string; status: string }>).find((a) => a.approvalId === approvalId);
    expect(pending?.status).toBe('PENDING');
    // 审批通过
    const approveRes = await ts.request('POST', `/approvals/${approvalId}/approve`, {
      token: TOKEN,
      headers: { 'X-Actor': 'release-mgr', 'X-Role': 'RELEASE_MANAGER' },
    });
    expect(approveRes.status).toBe(200);
    expect((approveRes.data as { status: string }).status).toBe('APPROVED');
    expect((approveRes.data as { decidedBy: string }).decidedBy).toBe('release-mgr');
  });

  it('reject → REJECTED；重复审批幂等返回既有结果', async () => {
    const ts = await makeServer();
    const env = ts.bundle.projects.getEnvironment('wan3', 'production');
    const outcome = await ts.bundle.gate.execute({
      actor: 'qa-user',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      runId: 'run-e2e-2',
      reason: '验证驳回',
      environment: env!,
    });
    const approvalId = (outcome as { approval: { approvalId: string } }).approval.approvalId;
    const opts = {
      token: TOKEN,
      headers: { 'X-Actor': 'release-mgr', 'X-Role': 'RELEASE_MANAGER' },
    };
    const first = await ts.request('POST', `/approvals/${approvalId}/reject`, opts);
    expect((first.data as { status: string }).status).toBe('REJECTED');
    const second = await ts.request('POST', `/approvals/${approvalId}/reject`, opts);
    expect((second.data as { status: string }).status).toBe('REJECTED');
  });

  it('VIEWER 无审批权限 → 400', async () => {
    const ts = await makeServer();
    const env = ts.bundle.projects.getEnvironment('wan3', 'production');
    const outcome = await ts.bundle.gate.execute({
      actor: 'qa-user',
      role: 'RELEASE_MANAGER',
      permission: 'PRODUCTION_ACCESS',
      action: 'risky',
      runId: 'run-e2e-3',
      reason: '验证权限拒绝',
      environment: env!,
    });
    const approvalId = (outcome as { approval: { approvalId: string } }).approval.approvalId;
    const res = await ts.request('POST', `/approvals/${approvalId}/approve`, {
      token: TOKEN,
      headers: { 'X-Actor': 'viewer', 'X-Role': 'VIEWER' },
    });
    expect(res.status).toBe(400);
    expect((res.data as { message: string }).message).toMatch(/无权审批/);
  });
});

describe('Platform API：Projects / Dashboard', () => {
  it('POST /projects + GET /projects', async () => {
    const ts = await makeServer();
    const created = await ts.request('POST', '/projects', {
      token: TOKEN,
      headers: { 'X-Actor': 'admin', 'X-Role': 'ADMIN' },
      body: { id: 'order', name: '订单服务' },
    });
    expect(created.status).toBe(200);
    expect((created.data as { id: string }).id).toBe('order');
    const list = await ts.request('GET', '/projects', { token: TOKEN });
    const ids = (list.data as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain('order');
    expect(ids).toContain('wan3');
  });

  it('GET /dashboard 汇总平台状态', async () => {
    const ts = await makeServer();
    await ts.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    const res = await ts.request('GET', '/dashboard', { token: TOKEN });
    expect(res.status).toBe(200);
    const d = res.data as Record<string, unknown>;
    expect(d.projects).toBeGreaterThanOrEqual(1);
    expect((d.runsByStatus as Record<string, number>).QUEUED).toBe(1);
    expect(d.queue).toBeDefined();
  });
});
