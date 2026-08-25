// 单元测试：Platform Worker（Phase 24.4）
// 覆盖：注册 / 心跳 / 健康 / 并发槽位 / dispatch 执行 /
//       环境路由 / 能力路由 / maxConcurrency / 失败重试 / 崩溃恢复（Scenario 3）
// 时间源全部固定为 FIXED_MS，避免真实时间与固定心跳的差值导致误判 DOWN。
import { describe, it, expect } from 'vitest';
import {
  WorkerRegistry,
  WorkerPool,
} from '../../src/platform/workers/index.js';
import type { TestJob } from '../../src/platform/scheduler/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import { Scheduler } from '../../src/platform/scheduler/index.js';

const FIXED_MS = Date.parse('2026-08-18T00:00:00.000Z');

function makeEnv(nowMs: () => number = () => FIXED_MS) {
  // 单一时钟源：ISO 时间戳由 nowMs 派生，避免两套时钟不一致导致健康误判
  const nowIso = () => new Date(nowMs()).toISOString();
  const reg = new WorkerRegistry({
    heartbeatTimeoutMs: 1000,
    now: nowIso,
    nowMs,
  });
  const jobs = new InMemoryRepository<TestJob>('job');
  const sched = new Scheduler(jobs, { now: nowIso });
  const pool = new WorkerPool(reg, sched);
  return { reg, sched, pool };
}

/** 持续调度循环：模拟生产 Supervisor 周期 dispatch，直到队列清空或达到安全上限 */
async function dispatchAll(pool: WorkerPool, budget = 100): Promise<number> {
  let total = 0;
  let n: number;
  do {
    n = await pool.dispatch();
    total += n;
    await new Promise((r) => setTimeout(r, 5));
  } while (n > 0 && total < budget);
  return total;
}

describe('Worker Registry：注册 / 心跳 / 健康', () => {
  it('register / get / list / unregister', () => {
    const { reg } = makeEnv();
    const w = reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 2 }, async () => 'ok');
    expect(w.health).toBe('healthy');
    expect(reg.get('w1')!.busy).toBe(0);
    expect(reg.list()).toHaveLength(1);
    reg.unregister('w1');
    expect(reg.get('w1')).toBeNull();
  });

  it('heartbeat 刷新健康；markDown / gracefulShutdown', () => {
    const { reg } = makeEnv();
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => 'ok');
    reg.markDown('w1', 'OOM');
    expect(reg.get('w1')!.health).toBe('down');
    reg.heartbeat('w1');
    expect(reg.get('w1')!.health).toBe('healthy');
    reg.gracefulShutdown('w1');
    expect(reg.get('w1')).toBeNull();
  });

  it('evaluateHealth：心跳超时 → down', () => {
    let now = FIXED_MS;
    const { reg } = makeEnv(() => now);
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => 'ok');
    now += 2000; // 超时 2s > 1s
    expect(reg.evaluateHealth('w1')).toBe('down');
    expect(reg.healthyWorkers()).toHaveLength(0);
  });

  it('acquire / release 并发占用', () => {
    const { reg } = makeEnv();
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 2 }, async () => 'ok');
    reg.acquire('w1');
    reg.acquire('w1');
    expect(reg.get('w1')!.busy).toBe(2);
    reg.release('w1');
    expect(reg.get('w1')!.busy).toBe(1);
  });
});

describe('Worker Pool 调度', () => {
  it('dispatch 执行 Job → SUCCESS', async () => {
    const { reg, sched, pool } = makeEnv();
    const seen: string[] = [];
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 2 }, async (payload) => {
      seen.push((payload as { runId: string }).runId);
    });
    await sched.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', payload: { runId: 'r1' } });
    await sched.enqueue({ runId: 'r2', projectId: 'p', environment: 'test', payload: { runId: 'r2' } });
    const n = await pool.dispatch();
    await pool.drain();
    expect(n).toBe(2);
    expect(seen.sort()).toEqual(['r1', 'r2']);
    expect((await sched.list()).every((j) => j.status === 'SUCCESS')).toBe(true);
  });

  it('环境路由：Worker 只领取自己支持的环境', async () => {
    const { reg, sched, pool } = makeEnv();
    const seen: string[] = [];
    reg.register({ workerId: 'secure', capabilities: ['secure'], environments: ['production'], maxConcurrency: 1 }, async (p) => seen.push((p as { runId: string }).runId));
    await sched.enqueue({ runId: 'prod1', projectId: 'p', environment: 'production', payload: { runId: 'prod1' } });
    await sched.enqueue({ runId: 'test1', projectId: 'p', environment: 'test', payload: { runId: 'test1' } });
    await pool.dispatch();
    await pool.drain();
    expect(seen).toEqual(['prod1']);
    expect((await sched.list()).find((j) => j.runId === 'test1')!.status).toBe('QUEUED');
  });

  it('能力路由：GPU Worker 领取 gpu Job，通用 Worker 领取无能力 Job', async () => {
    const { reg, sched, pool } = makeEnv();
    const seen: string[] = [];
    reg.register({ workerId: 'gpu', capabilities: ['gpu'], environments: ['test'], maxConcurrency: 1 }, async (p) => seen.push(`gpu:${(p as { runId: string }).runId}`));
    reg.register({ workerId: 'gen', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async (p) => seen.push(`gen:${(p as { runId: string }).runId}`));
    await sched.enqueue({ runId: 'video', projectId: 'p', environment: 'test', requiredCapability: 'gpu', payload: { runId: 'video' } });
    await sched.enqueue({ runId: 'api', projectId: 'p', environment: 'test', payload: { runId: 'api' } });
    await pool.dispatch();
    await pool.drain();
    expect(seen).toContain('gpu:video');
    expect(seen).toContain('gen:api');
  });

  it('maxConcurrency 限制并发领取', async () => {
    const { reg, sched, pool } = makeEnv();
    let running = 0;
    let peak = 0;
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 2 }, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });
    for (let i = 0; i < 5; i++) await sched.enqueue({ runId: `r${i}`, projectId: 'p', environment: 'test', payload: { runId: `r${i}` } });
    await dispatchAll(pool);
    await pool.drain();
    expect(peak).toBeLessThanOrEqual(2);
    expect((await sched.list()).every((j) => j.status === 'SUCCESS')).toBe(true);
  });

  it('执行失败 → RETRY，重试后成功', async () => {
    const { reg, sched, pool } = makeEnv();
    let calls = 0;
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => {
      calls += 1;
      if (calls === 1) throw new Error('first fail');
    });
    await sched.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', maxRetries: 1 });
    await pool.dispatch();
    await pool.drain();
    expect((await sched.list())[0].status).toBe('RETRY');
    await sched.requeueRetries();
    await pool.dispatch();
    await pool.drain();
    expect((await sched.list())[0].status).toBe('SUCCESS');
    expect(calls).toBe(2);
  });
});

describe('Worker 崩溃恢复（Scenario 3）', () => {
  it('Worker1 DOWN → recoverOrphans → Job RETRY → Worker2 完成，Run 不丢失', async () => {
    let now = FIXED_MS;
    const { reg, sched, pool } = makeEnv(() => now);
    // Worker1 领取后崩溃（不调用 complete）
    reg.register({ workerId: 'w1', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async () => {
      /* worker1 执行中崩溃：永不 resolve */
      await new Promise(() => undefined);
    });
    await sched.enqueue({ runId: 'r1', projectId: 'p', environment: 'test', maxRetries: 1, payload: { runId: 'r1' } });
    await pool.dispatch();
    // 等 Job 被 w1 领取
    const claimed = (await sched.list())[0];
    expect(claimed.status).toBe('RUNNING');
    expect(claimed.claimedBy).toBe('w1');
    // Worker1 心跳超时 → down
    now += 5000;
    expect(reg.evaluateHealth('w1')).toBe('down');
    // Worker2 上线
    const done: string[] = [];
    reg.register({ workerId: 'w2', capabilities: ['general'], environments: ['test'], maxConcurrency: 1 }, async (p) => {
      done.push((p as { runId: string }).runId);
    });
    // 回收孤儿 Job → RETRY → 重入队
    expect(await pool.recoverOrphans()).toBe(1);
    await sched.requeueRetries();
    await pool.dispatch();
    // recoverOrphans 已将 w1 的悬挂任务移出跟踪；drain 只等待 w2 的重试执行。
    await pool.drain();
    expect(done).toEqual(['r1']);
    expect((await sched.list())[0].status).toBe('SUCCESS');
  });
});
