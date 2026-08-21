import { describe, expect, it } from 'vitest';
import { adaptiveScale, canAssignWorker } from '../../src/cost/governance.js';

describe('Phase 52 Adaptive Worker Scaling', () => {
  const policy = { minWorkers: 1, maxWorkers: 5, jobsPerWorker: 20, scaleUpQueueAgeMs: 30_000, cooldownMs: 60_000 };
  it('队列上升扩容、队列为空缩容、cooldown 防震荡且不超安全边界', () => {
    expect(adaptiveScale({ queueLength: 100, oldestQueueAgeMs: 40_000, utilization: 0.9, priority: 0.9, estimatedCost: 5, currentWorkers: 1, now: 100_000 }, policy).desiredWorkers).toBe(5);
    expect(adaptiveScale({ queueLength: 0, oldestQueueAgeMs: 0, utilization: 0, priority: 0, estimatedCost: 0, currentWorkers: 5, now: 200_000 }, policy).desiredWorkers).toBe(1);
    expect(adaptiveScale({ queueLength: 0, oldestQueueAgeMs: 0, utilization: 0, priority: 0, estimatedCost: 0, currentWorkers: 5, now: 110_000 }, policy, 100_000).action).toBe('HOLD');
  });
  it('Scheduler 拒绝超出并发、CPU 或内存容量的 Worker', () => {
    expect(canAssignWorker({ id: 'w', capacity: { maxConcurrentJobs: 2, cpuLimit: 80, memoryLimitMb: 1024 }, activeJobs: 2, cpuUsed: 70, memoryUsedMb: 500 })).toBe(false);
  });
});
