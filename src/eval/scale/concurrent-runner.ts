// Phase 51.2：受控并发 Evaluation Runner。
// 该层只负责任务调度与容量观测，不改变 Benchmark / Ground Truth。
import type { EvaluationDomain } from '../contract.js';

export interface ConcurrentEvaluationJob {
  id: string;
  projectId: string;
  domains: EvaluationDomain[];
  createdAt?: number;
}

export interface ConcurrentEvaluationResult<T> {
  jobId: string;
  projectId: string;
  status: 'COMPLETED' | 'FAILED';
  attempts: number;
  queueLatencyMs: number;
  executionMs: number;
  value?: T;
  error?: string;
}

export interface ConcurrentEvaluationMetrics {
  submitted: number;
  completed: number;
  failed: number;
  lost: number;
  retries: number;
  concurrency: number;
  maxActive: number;
  wallTimeMs: number;
  throughputPerSecond: number;
  queueLatency: { p50: number; p95: number; p99: number; max: number };
  executionTime: { p50: number; p95: number; p99: number; max: number };
  workerUtilization: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  memoryDeltaBytes: number;
  peakHeapBytes: number;
  integrityPreserved: boolean;
}

export interface ConcurrentEvaluationRun<T> {
  results: ConcurrentEvaluationResult<T>[];
  metrics: ConcurrentEvaluationMetrics;
}

export interface ConcurrentEvaluationOptions<T> {
  concurrency: number;
  execute: (job: ConcurrentEvaluationJob, attempt: number) => T | Promise<T>;
  maxRetries?: number;
  integrityProbe?: () => string | Promise<string>;
  now?: () => number;
}

export async function runConcurrentEvaluations<T>(
  jobs: ConcurrentEvaluationJob[],
  opts: ConcurrentEvaluationOptions<T>,
): Promise<ConcurrentEvaluationRun<T>> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('concurrency 必须是正整数');
  const ids = new Set<string>();
  for (const job of jobs) {
    if (!job.id || ids.has(job.id)) throw new Error(`Evaluation job id 重复或为空：${job.id}`);
    ids.add(job.id);
  }

  const now = opts.now ?? (() => performance.now());
  const maxRetries = Math.max(0, opts.maxRetries ?? 0);
  const integrityBefore = await opts.integrityProbe?.();
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage().heapUsed;
  let peakHeapBytes = memoryBefore;
  let cursor = 0;
  let active = 0;
  let maxActive = 0;
  let retries = 0;
  let busyMs = 0;
  const startedAt = now();
  const enqueuedAt = jobs.map((job) => job.createdAt ?? startedAt);
  const results: ConcurrentEvaluationResult<T>[] = [];

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      const executionStarted = now();
      const queueLatencyMs = Math.max(0, executionStarted - enqueuedAt[index]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);

      let attempt = 0;
      let value: T | undefined;
      let error: string | undefined;
      while (attempt <= maxRetries) {
        attempt += 1;
        try {
          // 先让同批 worker 领取任务，确保同步 evaluator 也能被容量层正确观测。
          await new Promise<void>((resolve) => setImmediate(resolve));
          value = await opts.execute(job, attempt);
          error = undefined;
          break;
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          if (attempt <= maxRetries) retries += 1;
        }
      }
      const executionMs = Math.max(0, now() - executionStarted);
      busyMs += executionMs;
      active -= 1;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      results.push({
        jobId: job.id,
        projectId: job.projectId,
        status: error ? 'FAILED' : 'COMPLETED',
        attempts: attempt,
        queueLatencyMs,
        executionMs,
        value,
        error,
      });
    }
  };

  const workerCount = Math.min(opts.concurrency, Math.max(1, jobs.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const wallTimeMs = Math.max(0.001, now() - startedAt);
  const integrityAfter = await opts.integrityProbe?.();
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage().heapUsed;
  results.sort((a, b) => a.jobId.localeCompare(b.jobId));
  const completed = results.filter((result) => result.status === 'COMPLETED').length;
  const failed = results.length - completed;
  const queue = results.map((result) => result.queueLatencyMs);
  const execution = results.map((result) => result.executionMs);

  return {
    results,
    metrics: {
      submitted: jobs.length,
      completed,
      failed,
      lost: jobs.length - results.length,
      retries,
      concurrency: opts.concurrency,
      maxActive,
      wallTimeMs: round3(wallTimeMs),
      throughputPerSecond: round3((completed * 1000) / wallTimeMs),
      queueLatency: distribution(queue),
      executionTime: distribution(execution),
      workerUtilization: round3(Math.min(1, busyMs / (wallTimeMs * workerCount))),
      cpuUserMs: round3(cpu.user / 1000),
      cpuSystemMs: round3(cpu.system / 1000),
      memoryDeltaBytes: memoryAfter - memoryBefore,
      peakHeapBytes,
      integrityPreserved: integrityBefore === undefined || integrityBefore === integrityAfter,
    },
  };
}

function distribution(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round3(sorted[sorted.length - 1]),
  };
}

function percentile(sorted: number[], quantile: number): number {
  return round3(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
