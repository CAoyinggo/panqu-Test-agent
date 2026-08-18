// 集成测试：Scheduler + Worker（Phase 24.7）
// 覆盖：Worker 执行 Run 到 COMPLETED、失败重试、Worker 崩溃回收（markDown → recoverOrphans →
//       RETRY → 其他 Worker 完成）、环境路由（Worker 只领取自己支持的环境）。

import { describe, it, expect } from 'vitest';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeBundle(): PlatformBundle {
  return createPlatformService({ seedProject: true, now: () => FIXED_ISO });
}

/** 持续调度：模拟生产 Supervisor 周期 dispatch（含 RETRY 重入队）直到队列清空 */
async function dispatchUntilIdle(b: PlatformBundle, maxIters = 100): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    const assigned = await b.pool.dispatch();
    await b.pool.drain();
    await b.scheduler.requeueRetries(); // RETRY → QUEUED 重新可领取
    if (assigned === 0 && (await b.scheduler.pendingCount()) === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Scheduler + Worker 集成', () => {
  it('Worker 执行自治流水线：QUEUED → RUNNING → COMPLETED（Job SUCCESS）', async () => {
    const b = makeBundle();
    const seen: string[] = [];
    b.registerWorkerExecutor('w1', async (job: unknown) => {
      const payload = job as { runId: string };
      seen.push(payload.runId);
      await b.service.startRun(payload.runId);
      await b.service.completeRun(payload.runId);
    });
    const { runId } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'autonomous', actor: 'qa', role: 'QA' });
    await dispatchUntilIdle(b);
    expect(seen).toEqual([runId]);
    expect((await b.service.getRun(runId))?.status).toBe('COMPLETED');
    const jobs = await b.scheduler.list({});
    expect(jobs[0].status).toBe('SUCCESS');
    expect(jobs[0].claimedBy).toBe('w1');
  });

  it('执行失败 → RETRY → 重入队后成功（重试计数正确）', async () => {
    const b = makeBundle();
    let calls = 0;
    b.registerWorkerExecutor('w1', async (job: unknown) => {
      calls += 1;
      const payload = job as { runId: string };
      // 幂等启动：重试时 Run 已 RUNNING，不再重复 start
      if ((await b.service.getRun(payload.runId))?.status === 'QUEUED') {
        await b.service.startRun(payload.runId);
      }
      if (calls === 1) throw new Error('first fail');
      await b.service.completeRun(payload.runId);
    });
    await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await dispatchUntilIdle(b);
    expect(calls).toBe(2);
    const jobs = await b.scheduler.list({});
    expect(jobs[0].status).toBe('SUCCESS');
    expect(jobs[0].retryCount).toBe(1);
  });

  it('环境路由：Secure Worker 领取 production，General Worker 领取 test', async () => {
    const b = makeBundle();
    const done: string[] = [];
    b.workers.register({ workerId: 'secure', capabilities: ['secure'], environments: ['production'], maxConcurrency: 1 }, async (job: unknown) => {
      done.push(`secure:${(job as { runId: string }).runId}`);
    });
    b.workers.register({ workerId: 'general', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async (job: unknown) => {
      done.push(`general:${(job as { runId: string }).runId}`);
    });
    const { runId: prodRun } = await b.service.createRun({ projectId: 'wan3', environment: 'production', trigger: 'release', actor: 'qa', role: 'QA' });
    const { runId: testRun } = await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await dispatchUntilIdle(b);
    expect(done).toContain(`secure:${prodRun}`);
    expect(done).toContain(`general:${testRun}`);
  });

  it('Worker 崩溃回收：w1 DOWN → recoverOrphans → w2 完成，Run 不丢失', async () => {
    const b = makeBundle();
    // w1 领取后崩溃（永不完成）
    b.workers.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => {
      await new Promise(() => undefined);
    });
    await b.service.createRun({ projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA' });
    await b.pool.dispatch();
    const claimed = (await b.scheduler.list({}))[0];
    expect(claimed.status).toBe('RUNNING');
    expect(claimed.claimedBy).toBe('w1');
    // w1 崩溃（markDown）
    b.workers.markDown('w1', 'crash');
    expect(b.workers.evaluateHealth('w1')).toBe('down');
    // w2 上线，回收孤儿 Job
    const done: string[] = [];
    b.workers.register({ workerId: 'w2', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async (job: unknown) => {
      done.push((job as { runId: string }).runId);
    });
    expect(await b.pool.recoverOrphans()).toBe(1);
    await b.scheduler.requeueRetries();
    await b.pool.dispatch();
    // 等 w2 完成（w1 悬挂任务永不 resolve，故不 drain，仅轮询 Job 状态）
    let status = '';
    for (let i = 0; i < 50; i++) {
      status = (await b.scheduler.list({}))[0].status;
      if (status === 'SUCCESS' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(done).toHaveLength(1);
    expect(status).toBe('SUCCESS');
    const job = (await b.scheduler.list({}))[0];
    expect(job.claimedBy).toBe('w2');
  });
});
