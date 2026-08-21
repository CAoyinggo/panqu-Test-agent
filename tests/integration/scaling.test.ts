import { describe, expect, it } from 'vitest';
import { CostGovernanceService } from '../../src/cost/governance.js';
import { EvaluationQueue } from '../../src/eval/scale/evaluation-queue.js';

describe('Phase 52 Queue → Adaptive Scaling integration', () => {
  it('真实队列长度驱动扩缩容并记录 actor/trace', () => {
    const queue = new EvaluationQueue();
    for (let i = 0; i < 100; i++) queue.enqueue({ id: `job-${i}`, projectId: 'a', domains: ['RISK'], now: 1 });
    const service = new CostGovernanceService();
    const policy = { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 20, scaleUpQueueAgeMs: 30_000, cooldownMs: 0 };
    const up = service.scale({ queueLength: queue.counts().QUEUED, oldestQueueAgeMs: 60_000, utilization: 0.95, priority: 0.9, estimatedCost: 10, currentWorkers: 1, now: 100_000 }, policy, 'owner');
    expect(up).toMatchObject({ action: 'UP', desiredWorkers: 5 });
    const down = service.scale({ queueLength: 0, oldestQueueAgeMs: 0, utilization: 0, priority: 0, estimatedCost: 0, currentWorkers: 5, now: 200_000 }, policy, 'owner');
    expect(down).toMatchObject({ action: 'DOWN', desiredWorkers: 1 });
    expect(service.listAudit().filter((a) => a.action === 'WORKER_SCALE')).toHaveLength(2);
  });
});
