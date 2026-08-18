// 单元测试：Platform Metrics + SLO（Phase 24.8）
// 覆盖：Run Success Rate / Queue Length / Worker Utilization / Avg & P95 Duration /
//       Release Block Rate / Human Approval Rate / SLO（Scheduler / Worker 可用性 /
//       Run Start Latency / Queue Failure Rate）/ 未追踪指标返回 null。

import { describe, it, expect } from 'vitest';
import {
  computePlatformMetrics,
  computePlatformSlo,
  percentile,
} from '../../src/platform/operations/metrics.js';
import type { TestRun } from '../../src/platform/runs/run-schema.js';
import type { TestJob } from '../../src/platform/scheduler/test-job.js';
import type { TestWorker } from '../../src/platform/workers/worker.js';
import type { ApprovalRequest } from '../../src/platform/approval-center/approval-schema.js';
import type { AuditEntry } from '../../src/platform/audit/audit-log.js';

const T0 = '2026-08-18T00:00:00.000Z';
const T1 = '2026-08-18T00:01:00.000Z'; // +60s
const T2 = '2026-08-18T00:02:00.000Z'; // +120s
const T3 = '2026-08-18T00:03:00.000Z'; // +180s

function run(partial: Partial<TestRun> & { runId: string; status: TestRun['status'] }): TestRun {
  return { projectId: 'wan3', environment: 'test', trigger: 'manual', progress: 0, createdAt: T0, ...partial };
}

function job(partial: Partial<TestJob> & { jobId: string; status: TestJob['status'] }): TestJob {
  return {
    id: `id-${partial.jobId}`,
    runId: 'r1',
    priority: 0,
    projectId: 'wan3',
    environment: 'test',
    payload: {},
    retryCount: 0,
    maxRetries: 2,
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

function worker(partial: Partial<TestWorker> & { workerId: string }): TestWorker {
  return {
    capabilities: ['general'],
    environments: ['test'],
    maxConcurrency: 2,
    health: 'healthy',
    busy: 0,
    registeredAt: T0,
    ...partial,
  };
}

describe('percentile', () => {
  it('空数组 → null；P95 计算正确', () => {
    expect(percentile([], 95)).toBeNull();
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 50)).toBe(50);
  });
});

describe('Platform Metrics', () => {
  it('Run Success Rate：COMPLETED / (COMPLETED + FAILED)', () => {
    const runs: TestRun[] = [
      run({ runId: 'a', status: 'COMPLETED' }),
      run({ runId: 'b', status: 'COMPLETED' }),
      run({ runId: 'c', status: 'FAILED' }),
    ];
    const m = computePlatformMetrics({ runs, jobs: [], workers: [], approvals: [], audit: [] });
    expect(m.runSuccessRate.value).toBe(66.7);
  });

  it('Queue Length：QUEUED + RETRY Job 计数', () => {
    const jobs: TestJob[] = [
      job({ jobId: 'j1', status: 'QUEUED' }),
      job({ jobId: 'j2', status: 'RETRY' }),
      job({ jobId: 'j3', status: 'SUCCESS' }),
      job({ jobId: 'j4', status: 'RUNNING' }),
    ];
    const m = computePlatformMetrics({ runs: [], jobs, workers: [], approvals: [], audit: [] });
    expect(m.queueLength).toBe(2);
  });

  it('Worker Utilization：busy / 健康 Worker 容量', () => {
    const workers: TestWorker[] = [
      worker({ workerId: 'w1', maxConcurrency: 2, busy: 1 }),
      worker({ workerId: 'w2', maxConcurrency: 2, busy: 2 }),
      worker({ workerId: 'w3', maxConcurrency: 2, busy: 0, health: 'down' }), // down 不计容量
    ];
    const m = computePlatformMetrics({ runs: [], jobs: [], workers, approvals: [], audit: [] });
    expect(m.workerUtilization.value).toBe(75); // (1+2) / (2+2)
  });

  it('Avg & P95 Run Duration（毫秒）', () => {
    const runs: TestRun[] = [
      run({ runId: 'a', status: 'COMPLETED', createdAt: T0, startedAt: T0, finishedAt: T1 }), // 60s
      run({ runId: 'b', status: 'COMPLETED', createdAt: T0, startedAt: T0, finishedAt: T2 }), // 120s
      run({ runId: 'c', status: 'COMPLETED', createdAt: T0, startedAt: T0, finishedAt: T3 }), // 180s
      run({ runId: 'd', status: 'RUNNING' }), // 未完成不计
    ];
    const m = computePlatformMetrics({ runs, jobs: [], workers: [], approvals: [], audit: [] });
    expect(m.avgRunDurationMs.value).toBe(120_000);
    expect(m.p95RunDurationMs.value).toBe(180_000);
  });

  it('Release Block Rate：audit release 非 success 占比', () => {
    const audit: AuditEntry[] = [
      { id: '1', entryId: '1', timestamp: T0, actor: 'a', role: 'ADMIN', action: 'release', resource: 'r', result: 'success' },
      { id: '2', entryId: '2', timestamp: T0, actor: 'a', role: 'ADMIN', action: 'release', resource: 'r', result: 'denied' },
    ];
    const m = computePlatformMetrics({ runs: [], jobs: [], workers: [], approvals: [], audit });
    expect(m.releaseBlockRate.value).toBe(50);
  });

  it('Human Approval Rate：已决审批占全部', () => {
    const approvals: ApprovalRequest[] = [
      { id: '1', approvalId: 'a1', runId: 'r', action: 'risky', riskLevel: 'risky', environment: 'production', requester: 'q', reason: 'x', evidence: [], status: 'APPROVED', createdAt: T0 },
      { id: '2', approvalId: 'a2', runId: 'r', action: 'risky', riskLevel: 'risky', environment: 'production', requester: 'q', reason: 'x', evidence: [], status: 'PENDING', createdAt: T0 },
    ];
    const m = computePlatformMetrics({ runs: [], jobs: [], workers: [], approvals, audit: [] });
    expect(m.humanApprovalRate.value).toBe(50);
  });

  it('未追踪指标（RCA / Flaky / Healing / Cost）返回 null 且 tracked=false', () => {
    const m = computePlatformMetrics({ runs: [], jobs: [], workers: [], approvals: [], audit: [] });
    expect(m.rcaAccuracy.tracked).toBe(false);
    expect(m.rcaAccuracy.value).toBeNull();
    expect(m.flakyRate.tracked).toBe(false);
    expect(m.healingRate.tracked).toBe(false);
    expect(m.llmCost.value).toBeNull();
    expect(m.executionCost.value).toBeNull();
  });

  it('旧 costs 接口回退：llm/execution 成本可用；costPerRun/Feature 不虚构（tracked=false）', () => {
    const runs: TestRun[] = [run({ runId: 'a', status: 'COMPLETED' }), run({ runId: 'b', status: 'COMPLETED' })];
    const m = computePlatformMetrics({ runs, jobs: [], workers: [], approvals: [], audit: [], costs: { llm: 100, execution: 50 } });
    expect(m.llmCost.value).toBe(100);
    expect(m.executionCost.value).toBe(50);
    // 25.4：无遥测时 costPerRun / costPerFeature 不虚构（返回 null + tracked=false）
    expect(m.costPerRun.value).toBeNull();
    expect(m.costPerRun.tracked).toBe(false);
    expect(m.costPerFeature.value).toBeNull();
  });

  it('telemetry 输入优先：真实 Cost / RCA Accuracy / Flaky / Healing 指标接入', () => {
    const runs: TestRun[] = [run({ runId: 'a', status: 'COMPLETED' })];
    const m = computePlatformMetrics({
      runs, jobs: [], workers: [], approvals: [], audit: [],
      telemetry: {
        cost: { value: 12.5, tracked: true, sampleCount: 4, unit: 'CNY' },
        executionCost: { value: null, tracked: false, unit: 'CNY' },
        costPerRun: { value: 3.125, tracked: true, sampleCount: 4, unit: 'CNY' },
        costPerFeature: { value: 6.25, tracked: true, sampleCount: 2, unit: 'CNY' },
        rcaAccuracy: { value: 80, tracked: true, sampleCount: 5, unit: '%' },
        flakyRate: { value: 20, tracked: true, sampleCount: 5, unit: '%' },
        healingRate: { value: 75, tracked: true, sampleCount: 4, unit: '%' },
      },
    });
    expect(m.llmCost.value).toBe(12.5);
    expect(m.costPerRun.value).toBe(3.125);
    expect(m.costPerFeature.value).toBe(6.25);
    expect(m.rcaAccuracy.value).toBe(80);
    expect(m.flakyRate.value).toBe(20);
    expect(m.healingRate.value).toBe(75);
  });
});

describe('Platform SLO', () => {
  it('Scheduler 可用性 = 100 - 队列失败率', () => {
    const jobs: TestJob[] = [
      job({ jobId: 'j1', status: 'SUCCESS' }),
      job({ jobId: 'j2', status: 'SUCCESS' }),
      job({ jobId: 'j3', status: 'SUCCESS' }),
      job({ jobId: 'j4', status: 'FAILED' }),
    ];
    const s = computePlatformSlo({ runs: [], jobs, workers: [], approvals: [], audit: [] });
    expect(s.queueFailureRate.value).toBe(25);
    expect(s.schedulerAvailability.value).toBe(75);
  });

  it('Worker 可用性：healthy / 全部', () => {
    const workers: TestWorker[] = [
      worker({ workerId: 'w1' }),
      worker({ workerId: 'w2', health: 'down' }),
      worker({ workerId: 'w3', health: 'degraded' }),
    ];
    const s = computePlatformSlo({ runs: [], jobs: [], workers, approvals: [], audit: [] });
    expect(s.workerAvailability.value).toBe(33.3);
  });

  it('Run Start Latency：startedAt - createdAt 均值', () => {
    const runs: TestRun[] = [
      run({ runId: 'a', status: 'COMPLETED', createdAt: T0, startedAt: T1 }), // 60s
      run({ runId: 'b', status: 'COMPLETED', createdAt: T0, startedAt: T2 }), // 120s
    ];
    const s = computePlatformSlo({ runs, jobs: [], workers: [], approvals: [], audit: [] });
    expect(s.runStartLatencyMs.value).toBe(90_000);
  });

  it('P95 API Latency：来自注入样本', () => {
    const s = computePlatformSlo({ runs: [], jobs: [], workers: [], approvals: [], audit: [], apiLatencyMs: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] });
    expect(s.p95ApiLatencyMs.value).toBe(100);
  });

  it('Release Gate Latency：decidedAt - createdAt 均值', () => {
    const approvals: ApprovalRequest[] = [
      { id: '1', approvalId: 'a1', runId: 'r', action: 'risky', riskLevel: 'risky', environment: 'production', requester: 'q', reason: 'x', evidence: [], status: 'APPROVED', createdAt: T0, decidedAt: T1 },
    ];
    const s = computePlatformSlo({ runs: [], jobs: [], workers: [], approvals, audit: [] });
    expect(s.releaseGateLatencyMs.value).toBe(60_000);
  });
});
