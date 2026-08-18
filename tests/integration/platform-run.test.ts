// 集成测试：Platform Run 生命周期（Phase 24.7）
// 覆盖：Service.createRun → QUEUED + 入队 → start → RUNNING →
//       pause + checkpoint → resume（不重生成 Test Plan）→ complete；
//       cancel / retry / RBAC 拒绝 / 幂等。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

describe('Run 生命周期（Service Layer）', () => {
  it('create → QUEUED 并入队；start → RUNNING；complete → COMPLETED', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'autonomous',
      change: { type: 'model', target: 'wan3/text-to-video' },
      actor: 'qa-user',
      role: 'QA',
    });
    expect(runId).toMatch(/^run-/);
    expect((await b.service.getRun(runId))?.status).toBe('QUEUED');
    expect(await b.scheduler.pendingCount()).toBe(1);
    await b.service.startRun(runId);
    expect((await b.service.getRun(runId))?.status).toBe('RUNNING');
    await b.service.completeRun(runId);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
  });

  it('pause 保存 checkpoint，resume 从 checkpoint 恢复，不重生成 Test Plan', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'qa',
      role: 'QA',
    });
    await b.service.startRun(runId);
    // 执行中完成 c1，剩余 c2/c3
    await b.service.saveCheckpoint({
      runId,
      stage: 'regression',
      completedCases: ['c1'],
      remainingCases: ['c2', 'c3'],
      decisionState: { risk: 'LOW' },
      budgetState: { used: 10, total: 100 },
      traceId: `trace-${runId}`,
    });
    await b.service.pauseRun(runId, 'qa', 'QA');
    expect((await b.service.getRun(runId))?.status).toBe('PAUSED');
    const ck = await b.service.loadCheckpoint(runId) as { completedCases: string[]; remainingCases: string[] };
    expect(ck.completedCases).toEqual(['c1']);
    expect(ck.remainingCases).toEqual(['c2', 'c3']);
    // Resume：从 checkpoint 恢复（completed 保持，不重新生成）
    await b.service.resumeRun(runId, 'qa', 'QA');
    const ck2 = await b.service.loadCheckpoint(runId) as { completedCases: string[] };
    expect(ck2.completedCases).toEqual(['c1']);
    await b.service.completeRun(runId);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
  });

  it('非法迁移被拒绝：QUEUED 直接 pause 抛错（状态机校验）', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'qa',
      role: 'QA',
    });
    await expect(b.service.pauseRun(runId, 'qa', 'QA')).rejects.toThrow(/非法 Run 状态迁移/);
    expect((await b.service.getRun(runId))?.status).toBe('QUEUED');
  });

  it('cancel QUEUED Run → CANCELLED', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'qa',
      role: 'QA',
    });
    await b.service.cancelRun(runId, 'qa', 'QA');
    expect((await b.service.getRun(runId))?.status).toBe('CANCELLED');
  });

  it('retry 终态 Run → 新建 QUEUED Run（保留上下文）', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      feature: 'text-to-video',
      actor: 'qa',
      role: 'QA',
    });
    await b.service.startRun(runId);
    await b.service.failRun(runId, 'pipeline error');
    expect((await b.service.getRun(runId))?.status).toBe('FAILED');
    const fresh = await b.service.retryRun(runId, 'qa', 'QA');
    expect(fresh.status).toBe('QUEUED');
    expect(fresh.feature).toBe('text-to-video');
    expect(fresh.runId).not.toBe(runId);
  });

  it('RBAC：VIEWER 无 TEST_RUN → 拒绝', async () => {
    const b = makeBundle();
    await expect(
      b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'v', role: 'VIEWER' }),
    ).rejects.toThrow(/权限/);
  });

  it('幂等：相同 idempotencyKey 只创建 1 个 Run', async () => {
    const b = makeBundle();
    const req = { projectId: 'wan3', environment: 'test', trigger: 'manual' as const, actor: 'qa', role: 'QA' as const, idempotencyKey: 'ABC' };
    const a = await b.service.createRun(req);
    const c = await b.service.createRun(req);
    expect(a.runId).toBe(c.runId);
    expect((await b.service.listRuns()).length).toBe(1);
  });

  it('事件总线：create → start → complete 依次发布', async () => {
    const b = makeBundle();
    const order: string[] = [];
    b.bus.subscribeAll((e) => {
      order.push(e.type);
    });
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await b.service.startRun(runId);
    await b.service.completeRun(runId);
    expect(order).toEqual(['RunCreated', 'RunStarted', 'RunCompleted']);
  });

  it('审计：createRun 记录 run.create 审计条目', async () => {
    const b = makeBundle();
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa-user', role: 'QA' });
    const entries = await b.audit.search({ actor: 'qa-user', runId });
    expect(entries.some((e) => e.action === 'run.create')).toBe(true);
  });
});
