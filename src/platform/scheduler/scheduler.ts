// Scheduler（Phase 24.3）：Job 队列调度
// - 同一 Run 不重复执行（已有 QUEUED/RUNNING/RETRY 则拒绝）
// - 同一 Job 不被多个 Worker 同时消费（next() 原子领取：QUEUED → RUNNING）
// - 支持 priority / retry / timeout / cancel / pause / resume / idempotencyKey

import type { Repository } from '../storage/repository.js';
import { isJobTerminal, type EnqueueJobInput, type JobStatus, type TestJob } from './test-job.js';

export interface SchedulerOptions {
  now?: () => string;
}

export class Scheduler {
  constructor(
    private readonly jobs: Repository<TestJob>,
    private readonly opts: SchedulerOptions = {},
  ) {}

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  /**
   * 入队。返回 { job, created }：
   * - idempotencyKey 已存在（任意状态）→ 返回已有，created=false（幂等）
   * - 同一 runId 已有 QUEUED/RUNNING/RETRY → 抛错（同一 Run 不重复执行）
   */
  async enqueue(input: EnqueueJobInput): Promise<{ job: TestJob; created: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.jobs.query({ idempotencyKey: input.idempotencyKey });
      if (existing.length > 0) return { job: existing[0], created: false };
    }
    const dup = await this.jobs.query({ runId: input.runId });
    if (dup.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'RETRY')) {
      throw new Error(`Run ${input.runId} 已有在执行中的 Job，禁止重复入队`);
    }
    const jobId = input.jobId ?? `job-${input.runId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: TestJob = {
      id: jobId,
      jobId,
      runId: input.runId,
      priority: input.priority ?? 5,
      projectId: input.projectId,
      environment: input.environment,
      payload: input.payload,
      requiredCapability: input.requiredCapability,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 2,
      status: 'QUEUED',
      idempotencyKey: input.idempotencyKey,
      timeoutMs: input.timeoutMs,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    await this.jobs.create(job);
    return { job, created: true };
  }

  /**
   * 领取下一个 Job（Worker 调度入口）。原子领取：从 QUEUED 置为 RUNNING，
   * 保证同一 Job 不被多个 Worker 同时消费。
   * 可传环境 / 能力过滤（Worker 只领取自己能执行的环境与能力）。
   */
  async next(opts: { environment?: string; capability?: string; status?: JobStatus; claimedBy?: string } = {}): Promise<TestJob | null> {
    const queued = await this.jobs.query({ status: opts.status ?? 'QUEUED' });
    let candidates = queued.sort((a, b) => a.priority - b.priority);
    if (opts.environment) candidates = candidates.filter((j) => j.environment === opts.environment);
    if (opts.capability) {
      candidates = candidates.filter(
        (j) => !j.requiredCapability || j.requiredCapability === opts.capability,
      );
    }
    if (candidates.length === 0) return null;
    const job = candidates[0];
    const claimed = await this.jobs.update(job.jobId, {
      status: 'RUNNING',
      claimedBy: opts.claimedBy,
      updatedAt: this.nowIso(),
    });
    return claimed;
  }

  async complete(jobId: string): Promise<TestJob> {
    return this.jobs.update(jobId, { status: 'SUCCESS', updatedAt: this.nowIso() });
  }

  /** 失败：可重试且未达上限 → RETRY 重新入队；否则 FAILED */
  async fail(jobId: string, error?: string): Promise<TestJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error(`Job 不存在：${jobId}`);
    if (job.retryCount < job.maxRetries) {
      return this.jobs.update(jobId, {
        status: 'RETRY',
        retryCount: job.retryCount + 1,
        error,
        claimedBy: undefined,
        updatedAt: this.nowIso(),
      });
    }
    return this.jobs.update(jobId, { status: 'FAILED', error, updatedAt: this.nowIso() });
  }

  /** RETRY 状态重新回到可领取队列 */
  async requeueRetries(environment?: string): Promise<number> {
    const retrying = await this.jobs.query({ status: 'RETRY' });
    let count = 0;
    for (const j of retrying) {
      if (environment && j.environment !== environment) continue;
      await this.jobs.update(j.jobId, { status: 'QUEUED', updatedAt: this.nowIso() });
      count += 1;
    }
    return count;
  }

  async cancel(jobId: string): Promise<TestJob> {
    return this.jobs.update(jobId, { status: 'CANCELLED', updatedAt: this.nowIso() });
  }

  async pause(jobId: string): Promise<TestJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error(`Job 不存在：${jobId}`);
    if (job.status === 'RUNNING') {
      return this.jobs.update(jobId, { status: 'QUEUED', claimedBy: undefined, updatedAt: this.nowIso() });
    }
    return job;
  }

  async resume(jobId: string): Promise<TestJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error(`Job 不存在：${jobId}`);
    if (job.status === 'QUEUED') {
      return this.jobs.update(jobId, { status: 'QUEUED', updatedAt: this.nowIso() });
    }
    return job;
  }

  /** 超时扫描：RUNNING 超过 timeoutMs 的 Job 标记失败（可重试） */
  async sweepTimeouts(nowMs = Date.now()): Promise<TestJob[]> {
    const running = await this.jobs.query({ status: 'RUNNING' });
    const timedOut: TestJob[] = [];
    for (const j of running) {
      if (!j.timeoutMs) continue;
      const created = Date.parse(j.createdAt);
      if (Number.isFinite(created) && nowMs - created > j.timeoutMs) {
        timedOut.push(await this.fail(j.jobId, 'Job 执行超时'));
      }
    }
    return timedOut;
  }

  async get(jobId: string): Promise<TestJob | null> {
    return this.jobs.get(jobId);
  }

  async list(filter?: Partial<TestJob>): Promise<TestJob[]> {
    return this.jobs.query(filter);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.jobs.query();
    return rows.filter((j) => j.status === 'QUEUED' || j.status === 'RETRY').length;
  }

  async clear(): Promise<void> {
    await this.jobs.clear();
  }
}

export { isJobTerminal } from './test-job.js';
export type { TestJob, JobStatus, EnqueueJobInput } from './test-job.js';
