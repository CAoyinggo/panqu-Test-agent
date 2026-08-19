// Worker Pool（Phase 24.4）：环境 + 能力 + 并发 + 健康 维度调度
// - dispatch：把队列 Job 分配给空闲健康 Worker
// - recoverOrphans：Worker 崩溃（心跳超时/注销）后回收其 RUNNING Job → RETRY → 其他 Worker 领取（Scenario 3）
// - 幂等：Job 由 scheduler.next 原子领取，同一 Job 不会被两个 Worker 同时执行

import type { Scheduler, TestJob } from '../scheduler/index.js';
import type { WorkerRegistry, TestWorker } from './index.js';

export class WorkerPool {
  /** 在途任务（含归属 Worker）：drain 等待全部完成；崩溃 Worker 的任务可被 dropInFlight 丢弃 */
  private inFlight = new Set<{ workerId: string; task: Promise<void> }>();

  constructor(
    private readonly registry: WorkerRegistry,
    private readonly scheduler: Scheduler,
  ) {}

  /** 调度一轮：给每个健康空闲 Worker 领取并执行 Job；返回本轮回派数 */
  async dispatch(): Promise<number> {
    let assigned = 0;
    for (const w of this.registry.healthyWorkers()) {
      while (w.busy < w.maxConcurrency) {
        const job = await this.claimForWorker(w);
        if (!job) break;
        this.registry.acquire(w.workerId);
        assigned += 1;
        this.execute(w, job);
      }
    }
    return assigned;
  }

  /** 按 Worker 环境 + 能力领取（原子：QUEUED → RUNNING，claimedBy 记录归属） */
  private async claimForWorker(w: TestWorker): Promise<TestJob | null> {
    for (const env of w.environments) {
      for (const cap of w.capabilities) {
        const job = await this.scheduler.next({ environment: env, capability: cap, claimedBy: w.workerId });
        if (job) return job;
      }
      const job = await this.scheduler.next({ environment: env, claimedBy: w.workerId });
      if (job) return job;
    }
    return null;
  }

  private execute(w: TestWorker, job: TestJob): void {
    const entry = { workerId: w.workerId, task: Promise.resolve() };
    const task = (async () => {
      try {
        const executor = this.registry.getExecutor(w.workerId);
        if (!executor) throw new Error(`Worker 无执行器：${w.workerId}`);
        await executor(job.payload);
        await this.scheduler.complete(job.jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.scheduler.fail(job.jobId, msg);
      } finally {
        this.registry.release(w.workerId);
      }
    })();
    entry.task = task;
    void task.then(
      () => this.inFlight.delete(entry),
      () => this.inFlight.delete(entry),
    );
    this.inFlight.add(entry);
  }

  /** 等待全部在途 Job 完成（测试 / 停机用） */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight].map((e) => e.task));
    }
  }

  /** 丢弃指定 Worker 的挂起任务（模拟进程崩溃：任务不再被跟踪，不阻塞后续 drain）。
   * 仅用于故障演练/测试——真实运行中 Worker 崩溃由 recoverOrphans 处理，任务仍可重试。 */
  dropInFlight(workerId: string): number {
    let dropped = 0;
    for (const entry of this.inFlight) {
      if (entry.workerId === workerId) {
        this.inFlight.delete(entry);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** 回收孤儿 Job：RUNNING 但归属 Worker 已 down/注销 → 置 RETRY，等待其他 Worker 领取 */
  async recoverOrphans(): Promise<number> {
    let recovered = 0;
    const running = await this.scheduler.list({ status: 'RUNNING' });
    for (const job of running) {
      if (!job.claimedBy) continue;
      const w = this.registry.get(job.claimedBy);
      const isDown = !w || this.registry.evaluateHealth(job.claimedBy) === 'down';
      if (isDown) {
        await this.scheduler.fail(job.jobId, 'Worker 下线，Job 回收重试');
        recovered += 1;
      }
    }
    return recovered;
  }
}
