// 集成测试：HTTP API + Worker 全链路（Phase 24.7）
// 覆盖：POST /runs → QUEUED → Worker 执行 → GET /runs/:id 显示 COMPLETED；
//       API 审计、幂等、cancel / retry。

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { createPlatformAgentWorkerExecutor } from '../../src/integrations/platform-agent-worker.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const TOKEN = 'api-test-token';

interface Api {
  request(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}

const opened: Api[] = [];

async function makeApi(opts?: { registerWorker?: boolean }): Promise<{ api: Api; bundle: PlatformBundle }> {
  const bundle = createPlatformService({ seedProject: true, now: () => FIXED_ISO });
  if (opts?.registerWorker !== false) {
    bundle.registerWorkerExecutor('api-worker', createPlatformAgentWorkerExecutor(bundle, {
      dataFactoryResolver: () => ({
        async setup() { return {}; },
        async teardown() { /* no external resource */ },
        async generate() { return { account: { id: 'api-agent', nickname: 'qa', project_id: 1 } }; },
      }),
      pipelineOptions: {
        executionApproval: { id: 'api-run-approval', status: 'APPROVED', approvedBy: 'qa-reviewer' },
      },
      runner: async (cases) => computeOutcome('wan3', cases.map((item) => ({
        caseId: String(item.def.extra?.agentTestCaseId ?? item.name),
        name: item.name,
        feature: item.feature,
        scene: item.def.scene,
        processor: 'api-contract-processor',
        processorInvoked: true,
        requestId: `api-${String(item.def.extra?.agentTestCaseId ?? item.name)}`,
        executed: true,
        status: 'PASS' as const,
        pass: true,
        passRate: 100,
        checks: [{ name: 'API 业务断言', pass: true, detail: 'verified', kind: 'BUSINESS' as const }],
      })), { executed: true }),
    }));
  }
  const server = createPlatformServer({ service: bundle.service, token: TOKEN, now: () => FIXED_ISO });
  const { port } = await server.listen();
  const base = `http://127.0.0.1:${port}`;
  const api: Api = {
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
    async close() {
      await server.close();
    },
  };
  opened.push(api);
  return { api, bundle };
}

/** 持续调度（Supervisor 角色）：执行 API 创建的 Run */
async function runSupervisor(bundle: PlatformBundle, maxIters = 100): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    const assigned = await bundle.pool.dispatch();
    await bundle.pool.drain();
    if (assigned === 0 && (await bundle.scheduler.pendingCount()) === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(async () => {
  while (opened.length > 0) {
    const t = opened.pop();
    if (t) await t.close();
  }
});

describe('API + Worker 全链路', () => {
  it('POST /runs → Worker 执行 → GET /runs/:id = COMPLETED', async () => {
    const { api, bundle } = await makeApi();
    const created = await api.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'autonomous', change: { type: 'model', target: 'wan3/text-to-video' } },
    });
    expect(created.status).toBe(200);
    const runId = (created.data as { runId: string }).runId;
    expect((created.data as { status: string }).status).toBe('QUEUED');
    await runSupervisor(bundle);
    const got = await api.request('GET', `/runs/${runId}`, { token: TOKEN });
    expect((got.data as { status: string }).status).toBe('COMPLETED');
    // Job 全部 SUCCESS
    const jobs = await bundle.scheduler.list({});
    expect(jobs.every((j) => j.status === 'SUCCESS')).toBe(true);
  });

  it('API 审计：Run 创建 + 取消都有审计记录，可按 runId 还原', async () => {
    const { api, bundle } = await makeApi({ registerWorker: false });
    const created = await api.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    });
    const runId = (created.data as { runId: string }).runId;
    await api.request('POST', `/runs/${runId}/cancel`, {
      token: TOKEN,
      headers: { 'X-Actor': 'qa-user', 'X-Role': 'QA' },
    });
    const entries = await bundle.audit.search({ actor: 'qa-user', runId });
    expect(entries.some((e) => e.action === 'run.create')).toBe(true);
    expect(entries.some((e) => e.action === 'run.cancel')).toBe(true);
  });

  it('API 幂等：相同 Idempotency-Key 两次 POST → 同一 runId，仅 1 个 Run', async () => {
    const { api, bundle } = await makeApi({ registerWorker: false });
    const opts = {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA', 'Idempotency-Key': 'ABC' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    };
    const a = await api.request('POST', '/runs', opts);
    const b = await api.request('POST', '/runs', opts);
    expect((a.data as { runId: string }).runId).toBe((b.data as { runId: string }).runId);
    expect((await bundle.service.listRuns()).length).toBe(1);
  });
});
