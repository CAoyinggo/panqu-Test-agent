// 8 个核心 Platform E2E Scenario（Phase 24）
// S1 创建 Run | S2 Worker 执行 | S3 Worker 崩溃 | S4 Pause/Resume
// S5 Production Dangerous DENY | S6 Risky + Approval | S7 Idempotency | S8 Audit

import { describe, it, expect, afterEach } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { createPlatformServer } from '../../src/platform/api/index.js';
import type { PlatformHttpServer } from '../../src/platform/api/index.js';
import { advanceVerifiedRunToRunning, completeVerifiedRun } from '../helpers/platform-run.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';
const TOKEN = 'scenario-token';

const opened: PlatformHttpServer[] = [];

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

/** Supervisor：持续 dispatch（含 RETRY 重入队）直到队列清空 */
async function runSupervisor(b: PlatformBundle, maxIters = 100): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    const assigned = await b.pool.dispatch();
    await b.pool.drain();
    await b.scheduler.requeueRetries();
    if (assigned === 0 && (await b.scheduler.pendingCount()) === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function startServer(b: PlatformBundle): Promise<{ url: string; request: (m: string, p: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }> }> {
  const server = createPlatformServer({ service: b.service, token: TOKEN, now: () => FIXED_ISO });
  const { port } = await server.listen();
  opened.push(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
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

describe('Scenario 1：创建 Run（POST /runs → QUEUED → Scheduler → PLANNING）', () => {
  it('API 创建 Run 后立即触发 Scheduler，空 Worker 成功只能进入 PLANNING', async () => {
    const b = makeBundle();
    b.registerWorkerExecutor('w1', async (job: unknown) => {
      const p = job as { runId: string };
      if ((await b.service.getRun(p.runId))?.status === 'QUEUED') await b.service.startRun(p.runId);
    });
    const api = await startServer(b);
    const created = await api.request('POST', '/runs', {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'autonomous', change: { type: 'model', target: 'wan3/text-to-video' } },
    });
    const runId = (created.data as { runId: string }).runId;
    expect((created.data as { status: string }).status).toBe('QUEUED');
    // HTTP 主链必须真实触发 Scheduler，不依赖调用方再手工 dispatch。
    expect(await b.scheduler.pendingCount()).toBe(0);
    await b.pool.drain();
    expect((await b.service.getRun(runId))?.status).toBe('PLANNING');
  });
});

describe('Scenario 2：Worker 执行（Scheduler → Worker → 流水线 → COMPLETED）', () => {
  it('完整流水线执行到 COMPLETED，Job SUCCESS', async () => {
    const b = makeBundle();
    b.registerWorkerExecutor('w1', async (job: unknown) => {
      const p = job as { runId: string };
      await b.service.saveCheckpoint({
        runId: p.runId,
        stage: 'autonomous-pipeline',
        completedCases: ['c1', 'c2'],
        remainingCases: [],
        decisionState: { risk: 'LOW' },
        budgetState: { used: 20, total: 100 },
        traceId: `trace-${p.runId}`,
      });
      await completeVerifiedRun(b, p.runId);
    });
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'autonomous', actor: 'qa', role: 'QA' });
    await runSupervisor(b);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
    expect((await b.scheduler.list({}))[0].status).toBe('SUCCESS');
  });
});

describe('Scenario 3：Worker 崩溃（Worker1 DOWN → RETRY → Worker2，Run 不丢失）', () => {
  it('心跳超时/下线 → Job 回收重试 → 其他 Worker 完成', async () => {
    const b = makeBundle();
    b.workers.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => {
      await new Promise(() => undefined); // w1 执行中崩溃
    });
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await b.pool.dispatch();
    expect((await b.scheduler.list({}))[0].status).toBe('RUNNING');
    expect((await b.scheduler.list({}))[0].claimedBy).toBe('w1');
    // w1 下线
    b.workers.markDown('w1', 'crash');
    expect(b.workers.evaluateHealth('w1')).toBe('down');
    // w2 接管
    const done: string[] = [];
    b.workers.register({ workerId: 'w2', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async (job: unknown) => {
      done.push((job as { runId: string }).runId);
    });
    expect(await b.pool.recoverOrphans()).toBe(1);
    await b.scheduler.requeueRetries();
    await b.pool.dispatch();
    let status = '';
    for (let i = 0; i < 50; i++) {
      status = (await b.scheduler.list({}))[0].status;
      if (status === 'SUCCESS' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(status).toBe('SUCCESS');
    expect(done).toEqual([runId]);
    expect((await b.scheduler.list({}))[0].claimedBy).toBe('w2');
    // Run 不丢失（仍可查询）
    expect((await b.service.getRun(runId))?.runId).toBe(runId);
  });
});

describe('Scenario 4：Pause / Resume（Checkpoint 恢复，不重复执行已完成 Case）', () => {
  it('RUNNING → PAUSED(checkpoint) → RESUME → COMPLETED', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await advanceVerifiedRunToRunning(b, runId);
    await b.service.saveCheckpoint({
      runId,
      stage: 'regression',
      completedCases: ['case-1', 'case-2'],
      remainingCases: ['case-3', 'case-4'],
      decisionState: { risk: 'LOW' },
      budgetState: { used: 40, total: 100 },
      traceId: `trace-${runId}`,
    });
    await b.service.pauseRun(runId, 'qa', 'QA');
    expect((await b.service.getRun(runId))?.status).toBe('PAUSED');
    // Checkpoint 保存了已完成 Case
    const ck = (await b.service.loadCheckpoint(runId)) as { completedCases: string[]; remainingCases: string[] };
    expect(ck.completedCases).toEqual(['case-1', 'case-2']);
    expect(ck.remainingCases).toEqual(['case-3', 'case-4']);
    // Resume：从 checkpoint 恢复，不重新生成 Test Plan
    await b.service.resumeRun(runId, 'qa', 'QA');
    const ck2 = (await b.service.loadCheckpoint(runId)) as { completedCases: string[] };
    expect(ck2.completedCases).toEqual(['case-1', 'case-2']);
    // 只执行剩余 Case，然后完成
    await completeVerifiedRun(b, runId);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
  });
});

describe('Scenario 5：Production Dangerous（QA + Production + Dangerous → DENY）', () => {
  it('QA 角色 RBAC 拒绝 + RELEASE_MANAGER 环境策略拒绝（ADMIN 亦不可绕过）', async () => {
    const b = makeBundle();
    const env = b.projects.getEnvironment('wan3', 'production');
    expect(env).not.toBeNull();
    // QA 无 PRODUCTION_ACCESS → RBAC 拒绝
    const qaOutcome = await b.gate.execute({
      actor: 'qa', role: 'QA', permission: 'PRODUCTION_ACCESS', action: 'dangerous', runId: 'r5', environment: env!,
    });
    expect(qaOutcome.verdict).toBe('DENIED');
    expect(qaOutcome.decision.rbacPassed).toBe(false);
    // RELEASE_MANAGER 有 PRODUCTION_ACCESS，但环境策略 dangerous@production = deny → 拒绝
    const rmOutcome = await b.gate.execute({
      actor: 'rm', role: 'RELEASE_MANAGER', permission: 'PRODUCTION_ACCESS', action: 'dangerous', runId: 'r5', environment: env!,
    });
    expect(rmOutcome.verdict).toBe('DENIED');
    expect(rmOutcome.decision.reason).toMatch(/ADMIN 亦不可绕过/);
    // ADMIN 同样不可绕过
    const adminOutcome = await b.gate.execute({
      actor: 'admin', role: 'ADMIN', permission: 'PRODUCTION_ACCESS', action: 'dangerous', runId: 'r5', environment: env!,
    });
    expect(adminOutcome.verdict).toBe('DENIED');
  });
});

describe('Scenario 6：Risky + Approval（Production + Risky → PENDING → APPROVED → Execute）', () => {
  it('审批通过后执行；Reject → REJECTED → DENY', async () => {
    const b = makeBundle();
    const env = b.projects.getEnvironment('wan3', 'production');
    const runId = 'run-s6';
    // Risky@production → 审批
    const outcome = await b.gate.execute({
      actor: 'qa', role: 'RELEASE_MANAGER', permission: 'PRODUCTION_ACCESS', action: 'risky', runId, reason: '生产发布前验证', environment: env!,
    });
    expect(outcome.verdict).toBe('APPROVAL_REQUIRED');
    const approvalId = (outcome as { approval: { approvalId: string } }).approval.approvalId;
    expect((await b.approvals.get(approvalId))?.status).toBe('PENDING');
    // APPROVED → 可执行
    const approved = await b.service.approveApproval(approvalId, 'release-mgr', 'RELEASE_MANAGER');
    expect(approved.status).toBe('APPROVED');
    // Reject 场景：另一个审批被驳回
    const out2 = await b.gate.execute({
      actor: 'qa', role: 'RELEASE_MANAGER', permission: 'PRODUCTION_ACCESS', action: 'risky', runId: 'run-s6b', reason: '回滚演练', environment: env!,
    });
    const approvalId2 = (out2 as { approval: { approvalId: string } }).approval.approvalId;
    await b.service.rejectApproval(approvalId2, 'release-mgr', 'RELEASE_MANAGER');
    expect((await b.approvals.get(approvalId2))?.status).toBe('REJECTED');
  });
});

describe('Scenario 7：Idempotency（相同 Idempotency-Key 两次 → 只创建 1 个 Run）', () => {
  it('POST /runs 两次同键 → 同一 runId，仅 1 个 Run', async () => {
    const b = makeBundle();
    const api = await startServer(b);
    const opts = {
      token: TOKEN,
      headers: { 'X-Actor': 'qa', 'X-Role': 'QA', 'Idempotency-Key': 'ABC' },
      body: { projectId: 'wan3', environment: 'test', trigger: 'manual' },
    };
    const a = await api.request('POST', '/runs', opts);
    const c = await api.request('POST', '/runs', opts);
    expect(a.status).toBe(200);
    expect(c.status).toBe(200);
    expect((a.data as { runId: string }).runId).toBe((c.data as { runId: string }).runId);
    expect((await b.service.listRuns()).length).toBe(1);
  });
});

describe('Scenario 8：Audit（通过 runId / traceId / approvalId / actor 完整还原链路）', () => {
  it('Request → Approval → Tool → Execution → Release 全链路可还原', async () => {
    const b = makeBundle();
    const actor = 'release-actor';
    // 27.3 审批职责分离：审批人必须与申请人不同
    const approver = 'release-mgr';
    // Request：创建 Run（捕获真实 runId）
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'release', actor, role: 'RELEASE_MANAGER', feature: 'text-to-video' });
    // Service 约定：traceId = runId
    const traceId = runId;
    // Approval：production risky 审批
    const env = b.projects.getEnvironment('wan3', 'production');
    const outcome = await b.gate.execute({
      actor, role: 'RELEASE_MANAGER', permission: 'PRODUCTION_ACCESS', action: 'risky', runId, reason: '生产发布', evidence: [{ case: 'c1', result: 'PASS' }], environment: env!,
    });
    const approvalId = (outcome as { approval: { approvalId: string } }).approval.approvalId;
    await b.service.approveApproval(approvalId, approver, 'RELEASE_MANAGER');
    // Tool / Execution / Release：审计记录（带 approvalId + traceId 关联）
    await b.audit.record({ actor, role: 'RELEASE_MANAGER', action: 'risky.tool', resource: `run:${runId}`, environment: 'production', result: 'success', approvalId, traceId });
    await b.audit.record({ actor, role: 'RELEASE_MANAGER', action: 'production.access', resource: `run:${runId}`, environment: 'production', result: 'success', approvalId, traceId });
    await b.audit.record({ actor, role: 'RELEASE_MANAGER', action: 'release', resource: 'project:wan3', environment: 'production', result: 'success', approvalId, traceId });
    // 按 actor：Request → Tool → Execution → Release（审批由 approver 独立完成）
    const byActor = await b.audit.search({ actor });
    for (const action of ['run.create', 'risky.tool', 'production.access', 'release']) {
      expect(byActor.some((e) => e.action === action)).toBe(true);
    }
    // 审批职责分离：approval 事件记录在审批人 release-mgr 名下
    const byApprover = await b.audit.search({ actor: approver });
    expect(byApprover.some((e) => e.action === 'approval')).toBe(true);
    // 按 runId：还原 Run 创建
    const byRun = await b.audit.search({ runId });
    expect(byRun.some((e) => e.action === 'run.create')).toBe(true);
    // 按 traceId：还原 Tool → Execution → Release 执行链
    const byTrace = await b.audit.search({ traceId });
    for (const action of ['approval', 'risky.tool', 'production.access', 'release']) {
      expect(byTrace.some((e) => e.action === action)).toBe(true);
    }
    // 按 approvalId：还原审批及其授权动作
    const byApproval = await b.audit.search({ approvalId });
    expect(byApproval.some((e) => e.action === 'approval')).toBe(true);
    expect(byApproval.every((e) => e.approvalId === approvalId)).toBe(true);
    expect(byApproval.some((e) => e.action === 'release')).toBe(true);
  });
});
