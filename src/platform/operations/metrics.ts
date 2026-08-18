// Platform Metrics + SLO（Phase 24.8）：从平台数据计算运维指标
// 说明：可计算指标用真实数据计算；依赖额外遥测（RCA/Flaky/Healing/Cost/API 延迟）
//       的指标若未接入返回 null（tracked=false），不虚构数值。
// SLO 为平台内部健康指标，非对外承诺的正式 SLA。

import type { TestRun } from '../runs/run-schema.js';
import type { TestJob } from '../scheduler/test-job.js';
import type { TestWorker } from '../workers/worker.js';
import type { ApprovalRequest } from '../approval-center/approval-schema.js';
import type { AuditEntry } from '../audit/audit-log.js';

/** 指标计算输入 */
export interface MetricsInput {
  runs: TestRun[];
  jobs: TestJob[];
  workers: TestWorker[];
  approvals: ApprovalRequest[];
  audit: AuditEntry[];
  /** API 请求延迟样本（毫秒） */
  apiLatencyMs?: number[];
  /** 审批决策延迟样本（毫秒） */
  gateLatencyMs?: number[];
  /** 成本数据（可选） */
  costs?: { llm?: number; execution?: number };
}

export interface MetricValue {
  value: number | null;
  tracked: boolean;
  unit?: string;
}

export interface PlatformMetrics {
  runSuccessRate: MetricValue;
  queueLength: number;
  workerUtilization: MetricValue;
  avgRunDurationMs: MetricValue;
  p95RunDurationMs: MetricValue;
  rcaAccuracy: MetricValue;
  releaseBlockRate: MetricValue;
  flakyRate: MetricValue;
  healingRate: MetricValue;
  humanApprovalRate: MetricValue;
  llmCost: MetricValue;
  executionCost: MetricValue;
  costPerRun: MetricValue;
  costPerFeature: MetricValue;
}

export interface PlatformSlo {
  schedulerAvailability: MetricValue;
  workerAvailability: MetricValue;
  runStartLatencyMs: MetricValue;
  p95ApiLatencyMs: MetricValue;
  releaseGateLatencyMs: MetricValue;
  queueFailureRate: MetricValue;
}

/** p 分位数（输入已排序）；空数组返回 null */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(a: number, b: number): number {
  if (b === 0) return 0;
  return Number(((a / b) * 100).toFixed(1));
}

function num(v: number | null): MetricValue {
  return { value: v, tracked: v !== null };
}

/** 平台核心指标（任务书 16 至少清单） */
export function computePlatformMetrics(input: MetricsInput): PlatformMetrics {
  const { runs, jobs, workers, approvals, audit, apiLatencyMs = [], gateLatencyMs = [], costs } = input;

  const completed = runs.filter((r) => r.status === 'COMPLETED');
  const failed = runs.filter((r) => r.status === 'FAILED');
  const successRate = pct(completed.length, completed.length + failed.length);

  // Run 时长（COMPLETED 且具备 started/finished）
  const durations = completed
    .map((r) => (r.startedAt && r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null))
    .filter((v): v is number => v !== null && v >= 0)
    .sort((a, b) => a - b);

  // Worker 利用率：占用 / (健康 Worker 容量)
  const healthy = workers.filter((w) => w.health === 'healthy');
  const capacity = healthy.reduce((s, w) => s + w.maxConcurrency, 0);
  const busy = healthy.reduce((s, w) => s + w.busy, 0);
  const workerUtilization = capacity > 0 ? Number(((busy / capacity) * 100).toFixed(1)) : 0;

  // 人类审批率：已决（APPROVED/REJECTED）占全部审批
  const decidedApprovals = approvals.filter((a) => a.status === 'APPROVED' || a.status === 'REJECTED').length;
  const humanApprovalRate = pct(decidedApprovals, approvals.length);

  // 发布拦截率：audit release 记录中非 success 占比
  const releaseEntries = audit.filter((e) => e.action === 'release');
  const releaseBlocked = releaseEntries.filter((e) => e.result !== 'success').length;
  const releaseBlockRate = releaseEntries.length > 0 ? pct(releaseBlocked, releaseEntries.length) : null;

  // 成本
  const llm = costs?.llm ?? null;
  const exec = costs?.execution ?? null;
  const totalCost = llm !== null && exec !== null ? llm + exec : llm ?? exec;
  const features = new Set(runs.map((r) => r.feature).filter(Boolean)).size;
  const costPerRun = totalCost !== null && runs.length > 0 ? totalCost / runs.length : null;
  const costPerFeature = totalCost !== null && features > 0 ? totalCost / features : null;

  return {
    runSuccessRate: { value: successRate, tracked: true, unit: '%' },
    queueLength: jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RETRY').length,
    workerUtilization: { value: workerUtilization, tracked: true, unit: '%' },
    avgRunDurationMs: num(mean(durations)),
    p95RunDurationMs: num(percentile(durations, 95)),
    // 依赖 RCA 评估遥测：当前平台未接入
    rcaAccuracy: { value: null, tracked: false, unit: '%' },
    releaseBlockRate: num(releaseBlockRate),
    flakyRate: { value: null, tracked: false, unit: '%' },
    healingRate: { value: null, tracked: false, unit: '%' },
    humanApprovalRate: { value: humanApprovalRate, tracked: true, unit: '%' },
    llmCost: num(llm),
    executionCost: num(exec),
    costPerRun: num(costPerRun),
    costPerFeature: num(costPerFeature),
  };
}

/** 平台 SLO（内部健康指标，非正式 SLA） */
export function computePlatformSlo(input: MetricsInput): PlatformSlo {
  const { runs, jobs, workers, approvals, apiLatencyMs = [], gateLatencyMs = [] } = input;

  // 队列失败率：FAILED Job / 全部 Job
  const queueFailureRate = jobs.length > 0 ? pct(jobs.filter((j) => j.status === 'FAILED').length, jobs.length) : 0;
  const schedulerAvailability = queueFailureRate > 0 ? Number((100 - queueFailureRate).toFixed(1)) : 100;

  // Worker 可用性：healthy / 全部
  const workerAvailability = workers.length > 0 ? pct(workers.filter((w) => w.health === 'healthy').length, workers.length) : 100;

  // Run 启动延迟：startedAt - createdAt
  const startLatency = runs
    .map((r) => (r.startedAt ? Date.parse(r.startedAt) - Date.parse(r.createdAt) : null))
    .filter((v): v is number => v !== null && v >= 0);
  const runStartLatencyMs = mean(startLatency);

  // API 延迟
  const sortedApi = [...apiLatencyMs].sort((a, b) => a - b);
  const p95Api = percentile(sortedApi, 95);

  // Release Gate 延迟：decidedAt - createdAt；空时回退到注入样本
  const gateDelays = approvals
    .map((a) => (a.decidedAt ? Date.parse(a.decidedAt) - Date.parse(a.createdAt) : null))
    .filter((v): v is number => v !== null && v >= 0);
  const gateLatency = mean(gateDelays.length > 0 ? gateDelays : gateLatencyMs);

  return {
    schedulerAvailability: { value: schedulerAvailability, tracked: true, unit: '%' },
    workerAvailability: { value: workerAvailability, tracked: true, unit: '%' },
    runStartLatencyMs: num(runStartLatencyMs),
    p95ApiLatencyMs: num(p95Api),
    releaseGateLatencyMs: num(gateLatency),
    queueFailureRate: { value: queueFailureRate, tracked: true, unit: '%' },
  };
}
