// 单元测试：Platform Scheduler / Queue（Phase 24.3）
import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import { Scheduler } from '../../src/platform/scheduler/index.js';
import type { TestJob } from '../../src/platform/scheduler/index.js';

function makeScheduler(): Scheduler {
  const repo = new InMemoryRepository<TestJob>('job');
  return new Scheduler(repo, { now: () => '2026-08-18T00:00:00.000Z' });
}

describe('Scheduler 入队与去重', () => {
  it('enqueue 创建 QUEUED Job', async () => {
    const s = makeScheduler();
    const { job, created } = await s.enqueue({ runId: 'r1', projectId: 'wan3', environment: 'test' });
    expect(created).toBe(true);
    expect(job.status).toBe('QUEUED');
    expect(job.priority).toBe(5);
    expect(job.maxRetries).toBe(2);
  });

  it('同一 Run 不重复执行：已有活跃 Job 时抛错', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' });
    await expect(s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' })).rejects.toThrow(/禁止重复入队/);
    // 终态后允许重新入队
    const job = await s.list();
    await s.complete(job[0].jobId);
    const { created } = await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' });
    expect(created).toBe(true);
  });

  it('idempotencyKey：同键重复入队返回已有，不创建新 Job', async () => {
    const s = makeScheduler();
    const a = await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', idempotencyKey: 'ABC' });
    const b = await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'test', idempotencyKey: 'ABC' });
    expect(b.created).toBe(false);
    expect(b.job.jobId).toBe(a.job.jobId);
    expect(await s.list()).toHaveLength(1);
  });
});

describe('Scheduler 领取与并发安全', () => {
  it('优先级：数值小先执行', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', priority: 3 });
    await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'test', priority: 1 });
    await s.enqueue({ runId: 'r3', projectId: 'p', environment: 'test', priority: 2 });
    const first = await s.next();
    expect(first!.runId).toBe('r2'); // priority 1
    const second = await s.next();
    expect(second!.runId).toBe('r3'); // priority 2
  });

  it('原子领取：领取后置 RUNNING，同一 Job 不被二次消费', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' });
    await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'test' });
    const a = await s.next();
    const b = await s.next();
    expect(a!.runId).not.toBe(b!.runId);
    // 再次 next 无 QUEUED 可领
    expect(await s.next()).toBeNull();
    expect((await s.list())[0].status).toBe('RUNNING');
  });

  it('环境过滤：Worker 只领取自己能执行的环境', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'production' });
    await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'test' });
    const t = await s.next({ environment: 'test' });
    expect(t!.runId).toBe('r2');
    expect(await s.next({ environment: 'test' })).toBeNull();
  });
});

describe('Scheduler 重试 / 取消 / 超时', () => {
  it('失败重试：未达上限 → RETRY + 计数；重入队后可再次领取；达上限 → FAILED', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', maxRetries: 1 });
    const job = (await s.list())[0];
    await s.next();
    const retry = await s.fail(job.jobId, 'boom');
    expect(retry.status).toBe('RETRY');
    expect(retry.retryCount).toBe(1);
    await s.requeueRetries();
    expect((await s.get(job.jobId))!.status).toBe('QUEUED');
    await s.next();
    const failed = await s.fail(job.jobId, 'boom2');
    expect(failed.status).toBe('FAILED');
  });

  it('cancel 置 CANCELLED', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' });
    const job = (await s.list())[0];
    await s.cancel(job.jobId);
    expect((await s.get(job.jobId))!.status).toBe('CANCELLED');
  });

  it('超时扫描：RUNNING 超过 timeoutMs → RETRY；未超时不受影响', async () => {
    const s = makeScheduler();
    const t0 = Date.parse('2026-08-18T00:00:00.000Z');
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', timeoutMs: 1000 });
    await s.next(); // 领取为 RUNNING（createdAt = 00:00:00）
    const timed = await s.sweepTimeouts(t0 + 10_000); // 10s > 1s
    expect(timed).toHaveLength(1);
    expect((await s.list())[0].status).toBe('RETRY');
    // 未超时不受影响
    await s.enqueue({ runId: 'r2', projectId: 'p', environment: 'test', timeoutMs: 60_000 });
    await s.next();
    const timed2 = await s.sweepTimeouts(t0 + 10_000); // 10s < 60s
    expect(timed2).toHaveLength(0);
  });

  it('pendingCount 统计 QUEUED + RETRY', async () => {
    const s = makeScheduler();
    await s.enqueue({ runId: 'r1', projectId: 'p', environment: 'test' });
    expect(await s.pendingCount()).toBe(1);
  });
});
