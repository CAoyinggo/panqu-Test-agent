import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import { runConcurrentEvaluations, type ConcurrentEvaluationJob } from '../../src/eval/scale/index.js';

const DOMAINS = ['REQUIREMENT', 'RISK', 'RCA', 'RELEASE'] as const;

function jobs(count: number): ConcurrentEvaluationJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `eval-${String(index).padStart(3, '0')}`,
    projectId: 'wan3',
    domains: [...DOMAINS],
  }));
}

function fingerprint(service: ReturnType<typeof createAIQualityService>): string {
  const stable = JSON.stringify({
    benchmarks: service.benchmarkRegistry.snapshot(),
    groundTruth: service.groundTruthRegistry.snapshot(),
  });
  return createHash('sha256').update(stable).digest('hex');
}

describe('Phase 51.2 concurrent evaluation', () => {
  for (const concurrency of [10, 50, 100]) {
    it(`并发 ${concurrency}：零丢失、零失败、Benchmark/GT 零变异`, async () => {
      const service = createAIQualityService();
      const run = await runConcurrentEvaluations(jobs(concurrency), {
        concurrency,
        execute: (job) => service.evaluationReport(job.domains),
        integrityProbe: () => fingerprint(service),
      });

      expect(run.metrics).toMatchObject({
        submitted: concurrency,
        completed: concurrency,
        failed: 0,
        lost: 0,
        retries: 0,
        integrityPreserved: true,
      });
      expect(run.metrics.maxActive).toBe(concurrency);
      expect(run.metrics.throughputPerSecond).toBeGreaterThan(0);
      expect(run.metrics.queueLatency.p99).toBeGreaterThanOrEqual(0);
      expect(run.metrics.executionTime.p95).toBeGreaterThanOrEqual(0);
      expect(run.metrics.cpuUserMs).toBeGreaterThanOrEqual(0);
      expect(run.metrics.peakHeapBytes).toBeGreaterThan(0);
      expect(run.results.every((result) => result.value?.domains.length === DOMAINS.length)).toBe(true);
    }, 30_000);
  }

  it('失败可按策略重试，结果仍恰好一份', async () => {
    const attempts = new Map<string, number>();
    const run = await runConcurrentEvaluations(jobs(10), {
      concurrency: 5,
      maxRetries: 1,
      execute: (job) => {
        const seen = (attempts.get(job.id) ?? 0) + 1;
        attempts.set(job.id, seen);
        if (seen === 1) throw new Error('simulated transient');
        return job.id;
      },
    });
    expect(run.metrics).toMatchObject({ submitted: 10, completed: 10, failed: 0, lost: 0, retries: 10 });
    expect(new Set(run.results.map((result) => result.jobId)).size).toBe(10);
  });

  it('拒绝重复 job id，避免 Evaluation 重复写入', async () => {
    await expect(runConcurrentEvaluations([jobs(1)[0], jobs(1)[0]], {
      concurrency: 2,
      execute: () => 'never',
    })).rejects.toThrow('重复');
  });
});
