import { describe, expect, it } from 'vitest';
import { CostGovernanceService } from '../../src/cost/governance.js';
import { EvaluationQueue } from '../../src/eval/scale/evaluation-queue.js';
import { EvaluationWorkerPool } from '../../src/eval/scale/worker-pool.js';

describe('Phase 52 Scaling E2E', () => {
  it('Queue → Desired Workers → Worker Pool → Lost Evaluation=0', async () => {
    const queue = new EvaluationQueue<number>();
    for (let i = 0; i < 40; i++) queue.enqueue({ id: `job-${i}`, projectId: 'a', domains: ['RISK'], payload: i });
    const service = new CostGovernanceService();
    const decision = service.scale({ queueLength: 40, oldestQueueAgeMs: 60_000, utilization: 0.9, priority: 0.9, estimatedCost: 4, currentWorkers: 1 }, { minWorkers: 1, maxWorkers: 4, jobsPerWorker: 20, scaleUpQueueAgeMs: 30_000, cooldownMs: 0 }, 'owner');
    const workers = new EvaluationWorkerPool(queue, decision.desiredWorkers, (job) => job.payload! * 2);
    const result = await workers.drain();
    expect(result.metrics.completed).toBe(40);
    expect(result.results.size).toBe(40);
    expect(queue.counts()).toMatchObject({ QUEUED: 0, RUNNING: 0, FAILED: 0, COMPLETED: 40 });
  });
});
