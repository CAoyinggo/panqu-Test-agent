import type { EvaluationQueue, EvaluationQueueJob } from './evaluation-queue.js';

export interface EvaluationWorkerState {
  id: string;
  status: 'IDLE' | 'BUSY' | 'DOWN';
  processed: number;
  failedAttempts: number;
  busyMs: number;
}

export interface WorkerPoolMetrics {
  workers: number;
  submitted: number;
  completed: number;
  failed: number;
  queued: number;
  running: number;
  retries: number;
  throughputPerSecond: number;
  wallTimeMs: number;
  queueDelay: { p50: number; p95: number; p99: number };
  execution: { p50: number; p95: number; p99: number };
  workerUtilization: number;
}

export class EvaluationWorkerPool<T = unknown, R = unknown> {
  readonly workers: EvaluationWorkerState[];
  private readonly executionTimes = new Map<string, number>();

  constructor(
    private readonly queue: EvaluationQueue<T>,
    workerCount: number,
    private readonly execute: (job: EvaluationQueueJob<T>) => R | Promise<R>,
  ) {
    if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('workerCount 必须是正整数');
    this.workers = Array.from({ length: workerCount }, (_, index) => ({
      id: `eval-worker-${index + 1}`, status: 'IDLE', processed: 0, failedAttempts: 0, busyMs: 0,
    }));
  }

  async drain(): Promise<{ metrics: WorkerPoolMetrics; results: Map<string, R> }> {
    const started = performance.now();
    const submitted = this.queue.list().length;
    const initialAttempts = this.queue.list().reduce((sum, job) => sum + job.attempts, 0);
    const results = new Map<string, R>();

    const runWorker = async (worker: EvaluationWorkerState): Promise<void> => {
      while (worker.status !== 'DOWN') {
        const lease = this.queue.claim(worker.id);
        if (!lease) return;
        worker.status = 'BUSY';
        const jobStarted = performance.now();
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const result = await this.execute(lease.job);
          this.queue.complete(lease.job.id, lease.token);
          results.set(lease.job.id, result);
          worker.processed += 1;
        } catch (caught) {
          worker.failedAttempts += 1;
          this.queue.fail(lease.job.id, lease.token, caught instanceof Error ? caught.message : String(caught));
        } finally {
          const elapsed = performance.now() - jobStarted;
          worker.busyMs += elapsed;
          this.executionTimes.set(lease.job.id, (this.executionTimes.get(lease.job.id) ?? 0) + elapsed);
          worker.status = 'IDLE';
        }
      }
    };
    await Promise.all(this.workers.map(runWorker));
    const wallTimeMs = Math.max(0.001, performance.now() - started);
    const counts = this.queue.counts();
    const all = this.queue.list();
    const completed = all.filter((job) => job.status === 'COMPLETED');
    const delays = completed.map((job) => Math.max(0, (job.startedAt ?? job.enqueuedAt) - job.enqueuedAt));
    const executions = completed.map((job) => this.executionTimes.get(job.id) ?? 0);
    const attempts = all.reduce((sum, job) => sum + job.attempts, 0);
    const totalBusy = this.workers.reduce((sum, worker) => sum + worker.busyMs, 0);
    return {
      results,
      metrics: {
        workers: this.workers.length,
        submitted,
        completed: counts.COMPLETED,
        failed: counts.FAILED,
        queued: counts.QUEUED,
        running: counts.RUNNING,
        retries: Math.max(0, attempts - initialAttempts - submitted),
        throughputPerSecond: round3((counts.COMPLETED * 1000) / wallTimeMs),
        wallTimeMs: round3(wallTimeMs),
        queueDelay: distribution(delays),
        execution: distribution(executions),
        workerUtilization: round3(Math.min(1, totalBusy / (wallTimeMs * this.workers.length))),
      },
    };
  }
}

function distribution(values: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => round3(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
