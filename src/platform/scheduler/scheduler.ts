// Scheduler（Phase 24.3）：Job 队列调度
// - 同一 Run 不重复执行（已有 QUEUED/RUNNING/RETRY 则拒绝）
// - 同一 Job 不被多个 Worker 同时消费（next() 原子领取：QUEUED → RUNNING）
// - 支持 priority / retry / timeout / cancel / pause / resume / idempotencyKey

import type { Repository } from '../storage/repository.js';
import { generateId } from '../../core/id.js';
import { isJobTerminal, type EnqueueJobInput, type JobStatus, type TestJob } from './test-job.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

export interface SchedulerOptions {
  now?: () => string;
}

export class Scheduler {
  /** 全局暂停（26.4）：Storage/DB 异常时暂停领取，Run/Job 不丢失，恢复后继续 */
  private paused = false;
  private abortHandler?: (jobId: string, reason: string) => void;

  constructor(
    private readonly jobs: Repository<TestJob>,
    private readonly opts: SchedulerOptions = {},
  ) {}

  /** 由 WorkerPool 注册；取消/暂停/超时先落终态，再中止实际 Executor。 */
  setAbortHandler(handler: (jobId: string, reason: string) => void): void {
    this.abortHandler = handler;
  }

  private nowIso(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  /** 全局暂停调度：暂停后 next() 不再领取 Job（已入队的 Run/Job 保留，不丢失） */
  pauseDispatch(): void {
    this.paused = true;
  }

  /** 恢复调度 */
  resumeDispatch(): void {
    this.paused = false;
  }

  /** 是否全局暂停 */
  isDispatchPaused(): boolean {
    return this.paused;
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
      throw new CodedError(ErrorCode.CONFLICT, `Run ${input.runId} 已有在执行中的 Job，禁止重复入队`);
    }
    // 29.3：碰撞安全 ID（高吞吐入队下 Date.now+Math.random 会碰撞）
    const jobId = input.jobId ?? generateId('job');
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
   * 记录被执行前 Policy Gate 阻断的调度审计项。
   * 该 Job 从未进入 QUEUED/RUNNING，因此 Worker 永远无法领取。
   */
  async recordBlocked(input: EnqueueJobInput, error: string): Promise<TestJob> {
    const jobId = input.jobId ?? generateId('job');
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
      maxRetries: 0,
      status: 'CANCELLED',
      idempotencyKey: input.idempotencyKey,
      timeoutMs: input.timeoutMs,
      error,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    await this.jobs.create(job);
    return job;
  }

  /**
   * 领取下一个 Job（Worker 调度入口）。原子领取：从 QUEUED 置为 RUNNING，
   * 保证同一 Job 不被多个 Worker 同时消费。
   * 可传环境 / 能力过滤（Worker 只领取自己能执行的环境与能力）。
   */
  async next(opts: { environment?: string; capability?: string; status?: JobStatus; claimedBy?: string } = {}): Promise<TestJob | null> {
    // 全局暂停（26.4）：DB/Storage 异常期间不领取新 Job；已入队 Run/Job 保留等待恢复
    if (this.paused) return null;
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
    if (!job) throw new CodedError(ErrorCode.NOT_FOUND, `Job 不存在：${jobId}`);
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
    const cancelled = await this.jobs.update(jobId, { status: 'CANCELLED', updatedAt: this.nowIso() });
    this.abortHandler?.(jobId, 'Job 已取消');
    return cancelled;
  }

  async pause(jobId: string): Promise<TestJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new CodedError(ErrorCode.NOT_FOUND, `Job 不存在：${jobId}`);
    if (job.status === 'RUNNING') {
      const paused = await this.jobs.update(jobId, { status: 'QUEUED', claimedBy: undefined, updatedAt: this.nowIso() });
      this.abortHandler?.(jobId, 'Job 已暂停');
      return paused;
    }
    return job;
  }

  async resume(jobId: string): Promise<TestJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new CodedError(ErrorCode.NOT_FOUND, `Job 不存在：${jobId}`);
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
        this.abortHandler?.(j.jobId, 'Job 执行超时');
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
