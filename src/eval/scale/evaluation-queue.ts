// Phase 51.3：Evaluation Queue（租约、重试、worker-down requeue、幂等终态）。
import { randomUUID } from 'node:crypto';
import type { EvaluationDomain } from '../contract.js';

export type EvaluationJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface EvaluationQueueJob<T = unknown> {
  id: string;
  projectId: string;
  domains: EvaluationDomain[];
  payload?: T;
  status: EvaluationJobStatus;
  attempts: number;
  maxRetries: number;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  error?: string;
}

export interface EvaluationLease<T = unknown> {
  job: EvaluationQueueJob<T>;
  token: string;
  workerId: string;
}

export class EvaluationQueue<T = unknown> {
  private readonly jobs = new Map<string, EvaluationQueueJob<T>>();
  private readonly order: string[] = [];

  enqueue(input: {
    id: string;
    projectId: string;
    domains: EvaluationDomain[];
    payload?: T;
    maxRetries?: number;
    now?: number;
  }): EvaluationQueueJob<T> {
    if (!input.id.trim()) throw new Error('Evaluation job id 不能为空');
    const existing = this.jobs.get(input.id);
    if (existing) return cloneJob(existing);
    const job: EvaluationQueueJob<T> = {
      id: input.id,
      projectId: input.projectId,
      domains: [...input.domains],
      payload: input.payload,
      status: 'QUEUED',
      attempts: 0,
      maxRetries: Math.max(0, input.maxRetries ?? 2),
      enqueuedAt: input.now ?? Date.now(),
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    return cloneJob(job);
  }

  claim(workerId: string, opts: { now?: number; leaseMs?: number } = {}): EvaluationLease<T> | undefined {
    const now = opts.now ?? Date.now();
    const leaseMs = Math.max(1, opts.leaseMs ?? 30_000);
    const job = this.order.map((id) => this.jobs.get(id)!).find((candidate) => candidate.status === 'QUEUED');
    if (!job) return undefined;
    job.status = 'RUNNING';
    job.attempts += 1;
    job.startedAt ??= now;
    job.workerId = workerId;
    job.leaseToken = randomUUID();
    job.leaseExpiresAt = now + leaseMs;
    return { job: cloneJob(job), token: job.leaseToken, workerId };
  }

  heartbeat(jobId: string, token: string, opts: { now?: number; leaseMs?: number } = {}): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'RUNNING' || job.leaseToken !== token) return false;
    job.leaseExpiresAt = (opts.now ?? Date.now()) + Math.max(1, opts.leaseMs ?? 30_000);
    return true;
  }

  complete(jobId: string, token: string, now = Date.now()): EvaluationQueueJob<T> {
    const job = this.requireActiveLease(jobId, token);
    job.status = 'COMPLETED';
    job.completedAt = now;
    clearLease(job);
    return cloneJob(job);
  }

  fail(jobId: string, token: string, error: string, now = Date.now()): EvaluationQueueJob<T> {
    const job = this.requireActiveLease(jobId, token);
    job.error = error;
    if (job.attempts <= job.maxRetries) {
      job.status = 'QUEUED';
    } else {
      job.status = 'FAILED';
      job.completedAt = now;
    }
    clearLease(job);
    return cloneJob(job);
  }

  /** 回收掉线 worker 的过期租约；不会产生新 job，因此终态仍恰好一份。 */
  recoverExpired(now = Date.now()): { requeued: string[]; failed: string[] } {
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'RUNNING' || (job.leaseExpiresAt ?? Infinity) > now) continue;
      job.error = `worker lease expired: ${job.workerId ?? 'unknown'}`;
      if (job.attempts <= job.maxRetries) {
        job.status = 'QUEUED';
        requeued.push(job.id);
      } else {
        job.status = 'FAILED';
        job.completedAt = now;
        failed.push(job.id);
      }
      clearLease(job);
    }
    return { requeued, failed };
  }

  get(id: string): EvaluationQueueJob<T> | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  list(filter: { status?: EvaluationJobStatus; projectId?: string } = {}): EvaluationQueueJob<T>[] {
    return this.order
      .map((id) => this.jobs.get(id)!)
      .filter((job) => !filter.status || job.status === filter.status)
      .filter((job) => !filter.projectId || job.projectId === filter.projectId)
      .map(cloneJob);
  }

  counts(): Record<EvaluationJobStatus, number> {
    return {
      QUEUED: this.list({ status: 'QUEUED' }).length,
      RUNNING: this.list({ status: 'RUNNING' }).length,
      COMPLETED: this.list({ status: 'COMPLETED' }).length,
      FAILED: this.list({ status: 'FAILED' }).length,
    };
  }

  snapshot(): EvaluationQueueJob<T>[] {
    return this.list();
  }

  /** 进程恢复时 RUNNING lease 一律失效并原 job requeue，避免僵尸 worker 迟到提交。 */
  static restore<T>(snapshot: EvaluationQueueJob<T>[]): EvaluationQueue<T> {
    const queue = new EvaluationQueue<T>();
    for (const stored of snapshot) {
      const job = cloneJob(stored);
      if (job.status === 'RUNNING') {
        job.status = 'QUEUED';
        job.error = `requeued after queue recovery: ${job.workerId ?? 'unknown worker'}`;
        clearLease(job);
      }
      queue.jobs.set(job.id, job);
      queue.order.push(job.id);
    }
    return queue;
  }

  private requireActiveLease(jobId: string, token: string): EvaluationQueueJob<T> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Evaluation job 不存在：${jobId}`);
    if (job.status !== 'RUNNING' || job.leaseToken !== token) throw new Error(`Evaluation lease 已失效：${jobId}`);
    return job;
  }
}

function clearLease(job: EvaluationQueueJob): void {
  delete job.workerId;
  delete job.leaseToken;
  delete job.leaseExpiresAt;
}

function cloneJob<T>(job: EvaluationQueueJob<T>): EvaluationQueueJob<T> {
  return { ...job, domains: [...job.domains] };
}
