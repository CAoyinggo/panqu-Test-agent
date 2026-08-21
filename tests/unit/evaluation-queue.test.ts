import { describe, expect, it } from 'vitest';
import { EvaluationQueue, EvaluationWorkerPool } from '../../src/eval/scale/index.js';

const domains = ['REQUIREMENT', 'RISK', 'RCA', 'RELEASE'] as const;

function filledQueue(count: number): EvaluationQueue<{ sequence: number }> {
  const queue = new EvaluationQueue<{ sequence: number }>();
  for (let index = 0; index < count; index++) {
    queue.enqueue({ id: `job-${index}`, projectId: 'wan3', domains: [...domains], payload: { sequence: index } });
  }
  return queue;
}

describe('Phase 51.3 Evaluation Queue / Worker', () => {
  for (const [jobs, workers] of [[10, 1], [50, 2], [100, 5], [500, 10]] as const) {
    it(`${jobs} jobs / ${workers} workers：零丢失、零重复`, async () => {
      const queue = filledQueue(jobs);
      const executions = new Map<string, number>();
      const pool = new EvaluationWorkerPool(queue, workers, async (job) => {
        executions.set(job.id, (executions.get(job.id) ?? 0) + 1);
        return job.payload!.sequence;
      });
      const run = await pool.drain();
      expect(run.metrics).toMatchObject({ submitted: jobs, completed: jobs, failed: 0, queued: 0, running: 0 });
      expect(run.metrics.throughputPerSecond).toBeGreaterThan(0);
      expect(run.metrics.queueDelay.p99).toBeGreaterThanOrEqual(run.metrics.queueDelay.p50);
      expect(run.metrics.execution.p99).toBeGreaterThanOrEqual(run.metrics.execution.p50);
      expect(run.metrics.workerUtilization).toBeGreaterThanOrEqual(0);
      expect(executions.size).toBe(jobs);
      expect([...executions.values()].every((count) => count === 1)).toBe(true);
    });
  }

  it('worker down → lease expiry → requeue → another worker；旧 lease 不能重复完成', () => {
    const queue = filledQueue(1);
    const first = queue.claim('worker-down', { now: 1_000, leaseMs: 100 })!;
    expect(queue.recoverExpired(1_101)).toEqual({ requeued: ['job-0'], failed: [] });
    const second = queue.claim('worker-healthy', { now: 1_102, leaseMs: 100 })!;
    expect(second.job.attempts).toBe(2);
    queue.complete(second.job.id, second.token, 1_150);
    expect(() => queue.complete(first.job.id, first.token, 1_151)).toThrow('lease 已失效');
    expect(queue.counts()).toEqual({ QUEUED: 0, RUNNING: 0, COMPLETED: 1, FAILED: 0 });
  });

  it('enqueue 幂等：相同 ID 不产生第二个 job', () => {
    const queue = filledQueue(1);
    queue.enqueue({ id: 'job-0', projectId: 'wan3', domains: [...domains] });
    expect(queue.list()).toHaveLength(1);
  });

  it('执行失败 requeue 并由 worker retry，最终只有一个完成结果', async () => {
    const queue = filledQueue(10);
    const seen = new Map<string, number>();
    const pool = new EvaluationWorkerPool(queue, 5, (job) => {
      const attempt = (seen.get(job.id) ?? 0) + 1;
      seen.set(job.id, attempt);
      if (attempt === 1) throw new Error('SIMULATED transient worker failure');
      return job.id;
    });
    const run = await pool.drain();
    expect(run.metrics.completed).toBe(10);
    expect(queue.list().every((job) => job.status === 'COMPLETED' && job.attempts === 2)).toBe(true);
    expect(run.results.size).toBe(10);
  });
});
