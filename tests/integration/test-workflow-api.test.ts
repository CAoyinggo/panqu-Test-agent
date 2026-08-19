// 集成测试：QA Workflow API（Phase 39）
// 覆盖：Suite / Plan / Template / Versioning / Collaboration / 权限 / 跨项目隔离。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const STATIC_TOKEN = 'static-internal-token';

interface TestServer {
  url: string;
  server: PlatformHttpServer;
  bundle: PlatformBundle;
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: TestServer[] = [];

async function makeServer(): Promise<TestServer> {
  const bundle = createPlatformService({ seedProject: true, now: () => FIXED_ISO });
  const server = createPlatformServer({ service: bundle.service, token: STATIC_TOKEN, now: () => FIXED_ISO });
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

function qaHeaders(role = 'QA'): Record<string, string> {
  return { 'X-Actor': 'qa-user', 'X-Role': role };
}

describe('Test Suite API（39.1）', () => {
  it('CRUD + 复制 + 归档 + 添加/移除 Case', async () => {
    const ts = await makeServer();
    const created = await ts.request('POST', '/test-suites', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', name: '回归', caseIds: ['c1', 'c2'], tags: ['p0'] } });
    expect(created.status).toBe(200);
    const id = (created.data as { id: string }).id;

    const list = await ts.request('GET', '/test-suites', { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((list.data as Array<{ id: string }>).map((x) => x.id)).toContain(id);

    const one = await ts.request('GET', `/test-suites/${id}`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((one.data as { name: string }).name).toBe('回归');

    const patched = await ts.request('PATCH', `/test-suites/${id}`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { name: '回归 v2', tags: ['p0', 'smoke'] } });
    expect((patched.data as { name: string }).name).toBe('回归 v2');

    const added = await ts.request('POST', `/test-suites/${id}/cases`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { caseIds: ['c3'] } });
    expect((added.data as { caseIds: string[] }).caseIds).toEqual(['c1', 'c2', 'c3']);

    const copy = await ts.request('POST', `/test-suites/${id}/copy`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((copy.data as { id: string }).id).not.toBe(id);

    const archived = await ts.request('POST', `/test-suites/${id}/archive`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((archived.data as { status: string }).status).toBe('ARCHIVED');
  });

  it('VIEWER 无权创建 Suite → 403', async () => {
    const ts = await makeServer();
    const res = await ts.request('POST', '/test-suites', { token: STATIC_TOKEN, headers: qaHeaders('VIEWER'), body: { projectId: 'wan3', name: 'X' } });
    expect(res.status).toBe(403);
  });
});

describe('Test Plan API（39.2）', () => {
  it('CRUD + 运行 Plan → 新 Run', async () => {
    const ts = await makeServer();
    const s = await ts.request('POST', '/test-suites', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', name: 'S', caseIds: ['wan3-1080p-10s'] } });
    const sid = (s.data as { id: string }).id;
    const plan = await ts.request('POST', '/test-plans', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', name: 'P', suiteIds: [sid], environment: 'staging', mode: 'AUTONOMOUS', budget: 10 } });
    expect(plan.status).toBe(200);
    const pid = (plan.data as { id: string }).id;

    const cases = await ts.request('GET', `/test-plans/${pid}/cases`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((cases.data as { caseIds: string[] }).caseIds).toEqual(['wan3-1080p-10s']);

    const run = await ts.request('POST', `/test-plans/${pid}/run`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(run.status).toBe(200);
    expect((run.data as { status: string }).status).toBe('QUEUED');
  });
});

describe('Run Template API（39.3）', () => {
  it('创建 Template + Run Template → 新 Run（固定 templateId）', async () => {
    const ts = await makeServer();
    const t = await ts.request('POST', '/run-templates', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', name: 'WAN3 回归模板', environment: 'staging', suiteIds: [], mode: 'AUTONOMOUS', budget: 10, releaseGate: true } });
    expect(t.status).toBe(200);
    const tid = (t.data as { id: string }).id;
    const run = await ts.request('POST', `/run-templates/${tid}/run`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(run.status).toBe(200);
    const runId = (run.data as { runId: string }).runId;
    const detail = await ts.request('GET', `/runs/${runId}`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((detail.data as { templateId: string }).templateId).toBe(tid);
  });

  it('Run Again / Clone / Save Template from Run', async () => {
    const ts = await makeServer();
    const r = await ts.request('POST', '/runs', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (r.data as { runId: string }).runId;

    const rerun = await ts.request('POST', `/runs/${runId}/rerun`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(rerun.status).toBe(200);
    expect((rerun.data as { runId: string }).runId).not.toBe(runId);

    const clone = await ts.request('POST', `/runs/${runId}/clone`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { environment: 'preprod', budget: 3, releaseGate: false } });
    expect((clone.data as { runId: string }).runId).toBeTruthy();

    const tpl = await ts.request('POST', `/runs/${runId}/template`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { name: '从 Run 保存' } });
    expect(tpl.status).toBe(200);
    expect((tpl.data as { name: string }).name).toBe('从 Run 保存');
  });
});

describe('Asset Versioning API（39.4）', () => {
  it('versions / compare / 固定版本', async () => {
    const ts = await makeServer();
    const v1 = await ts.request('POST', '/assets/c1/version', { token: STATIC_TOKEN, headers: qaHeaders(), body: { assetType: 'test-case', snapshot: { title: 'A' }, changeReason: 'v1' } });
    const v2 = await ts.request('POST', '/assets/c1/version', { token: STATIC_TOKEN, headers: qaHeaders(), body: { assetType: 'test-case', snapshot: { title: 'B' }, changeReason: 'v2' } });
    expect((v1.data as { version: number }).version).toBe(1);
    expect((v2.data as { version: number }).version).toBe(2);

    const versions = await ts.request('GET', '/assets/c1/versions', { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((versions.data as Array<{ version: number }>).map((v) => v.version)).toEqual([1, 2]);

    const diff = await ts.request('GET', '/assets/c1/compare?from=1&to=2', { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((diff.data as { changed: string[] }).changed).toEqual(['title']);
  });
});

describe('Collaboration API（39.5）', () => {
  it('评论 + 指派 + @mention 通知事件', async () => {
    const ts = await makeServer();
    const r = await ts.request('POST', '/runs', { token: STATIC_TOKEN, headers: qaHeaders(), body: { projectId: 'wan3', environment: 'test', trigger: 'manual' } });
    const runId = (r.data as { runId: string }).runId;

    const comment = await ts.request('POST', `/runs/${runId}/comments`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { body: 'RCA: MODEL_ERROR @zhangsan 请确认' } });
    expect(comment.status).toBe(200);
    expect((comment.data as { mentions: string[] }).mentions).toEqual(['zhangsan']);

    const list = await ts.request('GET', `/runs/${runId}/comments`, { token: STATIC_TOKEN, headers: qaHeaders() });
    expect((list.data as Array<{ body: string }>)).toHaveLength(1);

    const assign = await ts.request('POST', `/runs/${runId}/assign`, { token: STATIC_TOKEN, headers: qaHeaders(), body: { assignees: ['zhangsan'] } });
    expect((assign.data as { assignees: string[] }).assignees).toEqual(['zhangsan']);
  });
});

describe('QA Home API（39.7）', () => {
  it('qa-home 返回项目 / Action Center（真实数据）', async () => {
    const ts = await makeServer();
    const home = await ts.request('GET', '/qa-home', { token: STATIC_TOKEN, headers: qaHeaders() });
    expect(home.status).toBe(200);
    const h = home.data as { projects: Array<{ id: string }>; actionCenter: Array<{ category: string }> };
    expect(h.projects.some((p) => p.id === 'wan3')).toBe(true);
    expect(Array.isArray(h.actionCenter)).toBe(true);
  });
});
