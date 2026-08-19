// 集成测试：Phase 40.1 单资源读端点 Project Scope 加固
// 验证 JWT 用户不能跨项目读取 Suite / Plan / Template / 资产版本 / 审批列表（均返回 403 或过滤）。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const JWT_SECRET = 'phase40-scope-secret';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(): Promise<TestServer> {
  const bundle = createPlatformService({ seedProject: true, seedUsers: true, jwtSecret: JWT_SECRET, now: () => FIXED_ISO });
  await bundle.auth.ensureSeeded();
  if (!bundle.projects.getProject('order')) {
    bundle.service.createProject({ id: 'order', name: '订单服务' });
  }
  const server = createPlatformServer({ service: bundle.service, auth: bundle.auth, now: () => FIXED_ISO });
  const { url } = await server.listen();
  const ts: TestServer = {
    url,
    server,
    bundle,
    async request(method, path, ro = {}) {
      const res = await fetch(`${url}${path}`, {
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

async function login(ts: TestServer, username: string, password: string): Promise<string> {
  const res = await ts.request('POST', '/auth/login', { body: { username, password } });
  expect(res.status).toBe(200);
  return (res.data as { accessToken: string }).accessToken;
}

describe('Phase 40.1 单资源读端点 Project Scope', () => {
  it('qa-a 可读 wan3 Suite/Plan/Template，读取 order 资源 → 403', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');

    const wSuite = await ts.request('POST', '/test-suites', { token: admin, body: { projectId: 'wan3', name: 'W', caseIds: [] } });
    const oSuite = await ts.request('POST', '/test-suites', { token: admin, body: { projectId: 'order', name: 'O', caseIds: [] } });
    const wSid = (wSuite.data as { id: string }).id;
    const oSid = (oSuite.data as { id: string }).id;

    expect((await ts.request('GET', `/test-suites/${wSid}`, { token: qaA })).status).toBe(200);
    expect((await ts.request('GET', `/test-suites/${oSid}`, { token: qaA })).status).toBe(403);

    const wPlan = await ts.request('POST', '/test-plans', { token: admin, body: { projectId: 'wan3', name: 'WP', suiteIds: [wSid], environment: 'test', mode: 'MANUAL' } });
    const oPlan = await ts.request('POST', '/test-plans', { token: admin, body: { projectId: 'order', name: 'OP', suiteIds: [oSid], environment: 'test', mode: 'MANUAL' } });
    const wPid = (wPlan.data as { id: string }).id;
    const oPid = (oPlan.data as { id: string }).id;

    expect((await ts.request('GET', `/test-plans/${wPid}`, { token: qaA })).status).toBe(200);
    expect((await ts.request('GET', `/test-plans/${oPid}`, { token: qaA })).status).toBe(403);
    expect((await ts.request('GET', `/test-plans/${wPid}/cases`, { token: qaA })).status).toBe(200);
    expect((await ts.request('GET', `/test-plans/${oPid}/cases`, { token: qaA })).status).toBe(403);

    const wTpl = await ts.request('POST', '/run-templates', { token: admin, body: { projectId: 'wan3', name: 'WT', suiteIds: [wSid], environment: 'test' } });
    const oTpl = await ts.request('POST', '/run-templates', { token: admin, body: { projectId: 'order', name: 'OT', suiteIds: [oSid], environment: 'test' } });
    const wTid = (wTpl.data as { id: string }).id;
    const oTid = (oTpl.data as { id: string }).id;

    expect((await ts.request('GET', `/run-templates/${wTid}`, { token: qaA })).status).toBe(200);
    expect((await ts.request('GET', `/run-templates/${oTid}`, { token: qaA })).status).toBe(403);
  });

  it('资产版本按项目隔离：qa-a 不可读 order 资产版本历史 → 403', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');

    const wSuite = await ts.request('POST', '/test-suites', { token: admin, body: { projectId: 'wan3', name: 'W', caseIds: [] } });
    const oSuite = await ts.request('POST', '/test-suites', { token: admin, body: { projectId: 'order', name: 'O', caseIds: [] } });
    const wSid = (wSuite.data as { id: string }).id;
    const oSid = (oSuite.data as { id: string }).id;

    await ts.request('POST', `/assets/${wSid}/version`, { token: admin, body: { assetType: 'suite', snapshot: { name: 'v1', projectId: 'wan3' }, changeReason: 'w' } });
    await ts.request('POST', `/assets/${oSid}/version`, { token: admin, body: { assetType: 'suite', snapshot: { name: 'v1', projectId: 'order' }, changeReason: 'o' } });

    const wVersions = await ts.request('GET', `/assets/${wSid}/versions`, { token: qaA });
    expect(wVersions.status).toBe(200);
    expect((wVersions.data as Array<{ version: number }>)[0].version).toBe(1);
    expect((await ts.request('GET', `/assets/${oSid}/versions`, { token: qaA })).status).toBe(403);
  });

  it('审批列表按项目过滤：qa-a 只见 wan3 审批，admin 见全部', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');

    const runW = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runO = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'order', environment: 'test', trigger: 'manual' } });
    const runWId = (runW.data as { runId: string }).runId;
    const runOId = (runO.data as { runId: string }).runId;

    await ts.bundle.approvals.request({ runId: runWId, action: 'risky-tool', riskLevel: 'risky', environment: 'test', requester: 'admin', reason: 'w' });
    await ts.bundle.approvals.request({ runId: runOId, action: 'risky-tool', riskLevel: 'risky', environment: 'test', requester: 'admin', reason: 'o' });

    const qaAList = await ts.request('GET', '/approvals', { token: qaA });
    expect(qaAList.status).toBe(200);
    const qaAIds = (qaAList.data as Array<{ runId: string }>).map((a) => a.runId);
    expect(qaAIds).toContain(runWId);
    expect(qaAIds).not.toContain(runOId);

    const adminList = await ts.request('GET', '/approvals', { token: admin });
    const adminIds = (adminList.data as Array<{ runId: string }>).map((a) => a.runId);
    expect(adminIds).toContain(runWId);
    expect(adminIds).toContain(runOId);
  });
});

describe('Phase 40.2 Defect 平台化（HTTP 层）', () => {
  it('登记 / 列表 / 详情 / 状态流转 / 指派 全链路', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');

    const created = await ts.request('POST', '/defects', { token: admin, body: { projectId: 'wan3', title: '首页白屏', severity: 'critical', runId: 'run-x', caseId: 'case-x', description: '复现' } });
    expect(created.status).toBe(200);
    const d = created.data as { defectId: string; status: string; severity: string };
    expect(d.defectId).toMatch(/^defect-/);
    expect(d.status).toBe('OPEN');
    expect(d.severity).toBe('critical');

    const list = await ts.request('GET', '/defects', { token: admin });
    expect(list.status).toBe(200);
    expect((list.data as Array<{ defectId: string }>).some((x) => x.defectId === d.defectId)).toBe(true);

    const detail = await ts.request('GET', `/defects/${d.defectId}`, { token: admin });
    expect(detail.status).toBe(200);
    expect((detail.data as { title: string }).title).toBe('首页白屏');

    const status = await ts.request('PATCH', `/defects/${d.defectId}/status`, { token: admin, body: { status: 'IN_PROGRESS' } });
    expect(status.status).toBe(200);
    expect((status.data as { status: string }).status).toBe('IN_PROGRESS');
    const resolved = await ts.request('PATCH', `/defects/${d.defectId}/status`, { token: admin, body: { status: 'RESOLVED', resolution: '已修复' } });
    expect((resolved.data as { status: string }).status).toBe('RESOLVED');
    // RESOLVED → WONT_FIX 非法迁移
    await expectReject(ts.request('PATCH', `/defects/${d.defectId}/status`, { token: admin, body: { status: 'WONT_FIX' } }), 400);

    const assign = await ts.request('POST', `/defects/${d.defectId}/assign`, { token: admin, body: { assignee: 'dev-1' } });
    expect(assign.status).toBe(200);
    expect((assign.data as { assignee: string }).assignee).toBe('dev-1');
  });

  it('VIEWER 无权登记缺陷；qa-a 不可在 order 项目登记缺陷（跨项目写 → 403）', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');
    const viewer = await login(ts, 'viewer', 'view123456');

    const denyViewer = await ts.request('POST', '/defects', { token: viewer, body: { projectId: 'wan3', title: 'X' } });
    expect(denyViewer.status).toBe(403);

    const denyCross = await ts.request('POST', '/defects', { token: qaA, body: { projectId: 'order', title: '跨项目' } });
    expect(denyCross.status).toBe(403);

    const ok = await ts.request('POST', '/defects', { token: qaA, body: { projectId: 'wan3', title: '本人项目' } });
    expect(ok.status).toBe(200);
  });

  it('缺陷列表按项目隔离：qa-a 只见 wan3 缺陷；读取 order 缺陷 → 403', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');

    const w = await ts.request('POST', '/defects', { token: admin, body: { projectId: 'wan3', title: 'W' } });
    const o = await ts.request('POST', '/defects', { token: admin, body: { projectId: 'order', title: 'O' } });
    const wId = (w.data as { defectId: string }).defectId;
    const oId = (o.data as { defectId: string }).defectId;

    const list = await ts.request('GET', '/defects', { token: qaA });
    const ids = (list.data as Array<{ defectId: string }>).map((x) => x.defectId);
    expect(ids).toContain(wId);
    expect(ids).not.toContain(oId);

    expect((await ts.request('GET', `/defects/${oId}`, { token: qaA })).status).toBe(403);
  });

  it('QA Home recentDefects 返回真实缺陷实体（契约对齐）', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const qaA = await login(ts, 'qa-a', 'qa123456');

    await ts.request('POST', '/defects', { token: admin, body: { projectId: 'wan3', title: '支付超时', severity: 'high' } });
    const home = await ts.request('GET', '/qa-home', { token: qaA });
    expect(home.status).toBe(200);
    const recent = (home.data as { recentDefects: Array<{ defectId: string; title: string; severity: string; status: string }> }).recentDefects;
    expect(recent.length).toBeGreaterThanOrEqual(1);
    const d = recent.find((x) => x.title === '支付超时');
    expect(d).toBeDefined();
    expect(d?.severity).toBe('high');
    expect(d?.status).toBe('OPEN');
  });
});

describe('Phase 40.4 数据真实性（report failures + decisionTrace 可读化）', () => {
  it('failures 由真实 execution/rca 遥测事件填充；coverage.failed 真实计数；decisionTrace 可读化', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');

    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;

    // 真实遥测事件：case-a 失败（含 RCA 分类）、case-c 失败（无 RCA）、case-b 成功、pipeline 汇总失败（不计入）
    await ts.bundle.telemetry.recordExecution({ runId, projectId: 'wan3', phase: 'case:case-a', result: 'failed', durationMs: 120 });
    await ts.bundle.telemetry.recordExecution({ runId, projectId: 'wan3', phase: 'case:case-b', result: 'success', durationMs: 80 });
    await ts.bundle.telemetry.recordExecution({ runId, projectId: 'wan3', phase: 'case:case-c', result: 'failed', durationMs: 90 });
    await ts.bundle.telemetry.recordExecution({ runId, projectId: 'wan3', phase: 'pipeline', result: 'failed' });
    await ts.bundle.telemetry.recordRca({ runId, projectId: 'wan3', rcaId: 'rca-x', caseId: 'case-a', predictedCategory: 'ASSERTION', confidence: 0.9 });
    await ts.bundle.service.saveCheckpoint({
      runId, stage: 'profile', completedCases: ['case-b'],
      remainingCases: ['case-a', 'case-c'],
      decisionState: { risk: 'MEDIUM', decision: 'REVIEW', reason: '存在 2 个失败用例' },
      budgetState: { used: 10, total: 30 },
      traceId: `trace-${runId}`,
    });

    const report = await ts.request('GET', `/runs/${runId}/report`, { token: admin });
    expect(report.status).toBe(200);
    const s = report.data as {
      failures: Array<{ caseId?: string; reason?: string; category?: string }>;
      coverage: { failed: number };
      decisionTrace: { summary: string; decision: string; risk: string; reason: string; steps: Array<{ step: string; detail: string }> };
    };
    const fids = s.failures.map((f) => f.caseId);
    expect(fids).toContain('case-a');
    expect(fids).toContain('case-c');
    expect(fids).not.toContain('case-b');
    expect(fids).not.toContain('pipeline');
    expect(s.failures.find((f) => f.caseId === 'case-a')?.category).toBe('ASSERTION');
    expect(s.coverage.failed).toBe(2);

    // decisionTrace 可读化（来自真实 decisionState）
    expect(s.decisionTrace.decision).toBe('REVIEW');
    expect(s.decisionTrace.risk).toBe('MEDIUM');
    expect(s.decisionTrace.reason).toBe('存在 2 个失败用例');
    expect(s.decisionTrace.summary).toContain('决策 REVIEW');
    expect(Array.isArray(s.decisionTrace.steps)).toBe(true);
    expect(s.decisionTrace.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('无遥测数据时 failures 为空、coverage.failed=0、decisionTrace 为“暂无”占位（不虚构）', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;

    const report = await ts.request('GET', `/runs/${runId}/report`, { token: admin });
    expect(report.status).toBe(200);
    const s = report.data as { failures: unknown[]; coverage: { failed: number }; decisionTrace: { summary: string; steps: unknown[] } };
    expect(s.failures).toEqual([]);
    expect(s.coverage.failed).toBe(0);
    expect(s.decisionTrace.summary).toContain('暂无决策追踪');
    expect(s.decisionTrace.steps).toEqual([]);
  });
});

describe('Phase 40.5 性能（QAHome / run-report TTL 缓存）', () => {
  it('QAHome 相同 scopes 命中缓存（对象引用相同）；不同 scopes 数据隔离', async () => {
    const ts = await makeServer();
    const scopesWan3 = { projects: ['wan3'], environments: ['test'] };
    const scopesOrder = { projects: ['order'], environments: ['test'] };

    const a1 = await ts.bundle.service.qaHome(scopesWan3);
    const a2 = await ts.bundle.service.qaHome(scopesWan3);
    expect(a2).toBe(a1); // TTL 内命中缓存，未重新聚合

    const b1 = await ts.bundle.service.qaHome(scopesOrder);
    expect(b1).not.toBe(a1); // 不同 scope 隔离（不泄漏他人项目数据）
  });

  it('runReport 相同 run 命中缓存（对象引用相同）；不同 run 独立', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');
    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;

    const r1 = await ts.bundle.service.runReport(runId);
    const r2 = await ts.bundle.service.runReport(runId);
    expect(r2).toBe(r1); // 5s TTL 内命中缓存

    const created2 = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId2 = (created2.data as { runId: string }).runId;
    const r3 = await ts.bundle.service.runReport(runId2);
    expect(r3).not.toBe(r1); // 不同 run 不共享缓存
  });
});

async function expectReject(p: Promise<{ status: number }>, status: number): Promise<void> {
  const res = await p;
  expect(res.status).toBe(status);
}

describe('Phase 40.3 前端断点修复（HTTP 层）', () => {
  it('share 为 POST 返回 token/url；GET 同路径 → 404（方法不匹配）', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');

    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;

    const getShare = await ts.request('GET', `/runs/${runId}/share`, { token: admin });
    expect(getShare.status).toBe(404);

    const share = await ts.request('POST', `/runs/${runId}/share`, { token: admin });
    expect(share.status).toBe(200);
    const s = share.data as { token: string; url: string };
    expect(s.token).toMatch(/^tok-/);
    expect(s.url).toBe(`/runs/${runId}/report?share=${s.token}`);

    // 幂等：再次 share 复用同一 token
    const again = await ts.request('POST', `/runs/${runId}/share`, { token: admin });
    expect(((again.data as { token: string }).token)).toBe(s.token);
  });

  it('公开分享落地页：无 JWT + 合法 share token 可读报告；非法 token → 403；无 token 无 share → 401', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');

    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;
    const share = await ts.request('POST', `/runs/${runId}/share`, { token: admin });
    const token = (share.data as { token: string }).token;

    // 无 JWT（不带头）访问公开报告
    const pub = await ts.request('GET', `/runs/${runId}/report?share=${token}`);
    expect(pub.status).toBe(200);
    expect((pub.data as { runId: string }).runId).toBe(runId);

    // 前端 api.ts baseURL=/api：带 /api 前缀的公开访问同样生效（真实前端请求路径）
    const pubApi = await ts.request('GET', `/api/runs/${runId}/report?share=${token}`);
    expect(pubApi.status).toBe(200);
    expect((pubApi.data as { runId: string }).runId).toBe(runId);

    // 非法 share token → 403
    const bad = await ts.request('GET', `/runs/${runId}/report?share=tok-bogus`);
    expect(bad.status).toBe(403);

    // 无 JWT 且无 share 参数 → 401（受保护）
    const noAuth = await ts.request('GET', `/runs/${runId}/report`);
    expect(noAuth.status).toBe(401);
  });

  it('公开分享导出直链：无 JWT + share token 可导出 JSON / HTML', async () => {
    const ts = await makeServer();
    const admin = await login(ts, 'admin', 'admin123');

    const created = await ts.request('POST', '/runs', { token: admin, body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (created.data as { runId: string }).runId;
    const share = await ts.request('POST', `/runs/${runId}/share`, { token: admin });
    const token = (share.data as { token: string }).token;

    const json = await ts.request('GET', `/runs/${runId}/report/export?format=json&share=${token}`);
    expect(json.status).toBe(200);
    const parsed = json.data as { report: { runId: string } };
    expect(parsed.report.runId).toBe(runId);

    const html = await ts.request('GET', `/runs/${runId}/report/export?format=html&share=${token}`);
    expect(html.status).toBe(200);
    expect(String(html.data)).toContain('<!DOCTYPE html>');

    // 非法 share token 导出 → 403
    const bad = await ts.request('GET', `/runs/${runId}/report/export?format=json&share=tok-bogus`);
    expect(bad.status).toBe(403);
  });
});
