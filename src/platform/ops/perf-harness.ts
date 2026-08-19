// Phase 29 性能与容量基线测量模块
// 测量对象（任务书第 19 节 / DEBT-06）：
//   1. Run 生命周期吞吐与延迟：10/50/100/500 Runs 批量下
//      createRun（RBAC + 审计 + 事件 + 调度入队）→ Scheduler → Worker → startRun/completeRun
//   2. Scheduler 队列吞吐（enqueue → next → complete）
//   3. Audit 写入吞吐（含脱敏）
//   4. Telemetry 事件写入吞吐
//   5. 内存稳定性（500 Run 批量全程 heap 增长）
// 供 Vitest 套件（tests/perf）与 CLI 门禁（scripts/perf）共用，保证单一测量源。
//
// 29.4 计时口径：统一 performance.now（µs 分辨率），消除 ms 量化噪声；
//     每项测量取 min-of-3（最快一次），滤除 GC / 调度抖动，使回归门禁只捕捉真实退化。

import { createPlatformService, type PlatformBundle } from '../service/index.js';
import { PLATFORM_VERSION } from '../version.js';
import { performance } from 'node:perf_hooks';

/** 基准批量规模（任务书第 19 节：10/50/100/500 Runs） */
export const BATCH_SIZES = [10, 50, 100, 500];

/** 每次测量的重复次数（取最快一次） */
export const MEASURE_REPEATS = 3;

/** 门禁阈值：绝对 sanity 下限 + 相对回归比例 */
export const PERF_THRESHOLDS = {
  /** createRun 吞吐下限（ops/sec） */
  minCreateOpsPerSec: 50,
  /** 完整生命周期吞吐下限（runs/sec） */
  minLifecycleOpsPerSec: 15,
  /** createRun p95 延迟上限（ms） */
  maxCreateP95Ms: 100,
  /** 全程 heap 增长上限（MB） */
  maxMemoryGrowthMb: 150,
  /** Scheduler 操作吞吐下限（ops/sec） */
  minSchedulerOpsPerSec: 100,
  /** Audit 写入吞吐下限（ops/sec） */
  minAuditOpsPerSec: 100,
  /** Telemetry 写入吞吐下限（ops/sec） */
  minTelemetryOpsPerSec: 100,
  /** 相对回归：延迟允许倍率（当前 p95 > 基线 p95 × 该值 → FAIL） */
  latencyRegressionRatio: 2.0,
  /** 相对回归：吞吐允许衰减比例（当前 ops/sec < 基线 × 该值 → FAIL） */
  throughputRegressionRatio: 0.5,
  /** 内存相对回归：允许倍率（当前增长 > 基线增长 × 该值 → FAIL） */
  memoryRegressionRatio: 3.0,
} as const;

/** 单个批量规模的 Run 生命周期指标 */
export interface RunLifecycleMetric {
  batchSize: number;
  createOpsPerSec: number;
  createP50Ms: number;
  createP95Ms: number;
  createP99Ms: number;
  createMaxMs: number;
  lifecycleOpsPerSec: number;
  lifecycleTotalMs: number;
  jobsPendingAfter: number;
}

/** 完整基准报告 */
export interface PerfReport {
  tool: string;
  version: string;
  timestamp: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  runLifecycle: RunLifecycleMetric[];
  schedulerOpsPerSec: number;
  auditOpsPerSec: number;
  telemetryOpsPerSec: number;
  memory: { heapUsedBeforeMb: number; heapUsedAfterMb: number; growthMb: number };
  totalMs: number;
}

export interface PerfRunOptions {
  now?: () => string;
}

const round = (n: number, digits = 2): number => Number(n.toFixed(digits));

/** 有序数组分位数（已排序输入） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function latencyStats(samples: number[]): { p50: number; p95: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] ?? 0 };
}

function makeBundle(opts: PerfRunOptions): PlatformBundle {
  return createPlatformService({
    seedProject: true,
    storage: 'memory',
    now: opts.now,
    // 性能基准需确定性密钥；memory 态不落盘，不存在密钥泄露面
    jwtSecret: process.env.JWT_SECRET || 'perf-bench-non-default-secret-0123456789abcdef',
  });
}

/** 单次批量测量：createRun 吞吐/延迟 + 全生命周期吞吐 */
async function measureRunLifecycleOnce(batchSize: number, opts: PerfRunOptions): Promise<RunLifecycleMetric> {
  const b = makeBundle(opts);
  // Worker 执行器：真实 Run 状态机推进（startRun → completeRun），模拟 Worker 消费
  b.registerWorkerExecutor('perf-worker', async (job: unknown) => {
    const p = job as { runId: string };
    await b.service.startRun(p.runId);
    await b.service.completeRun(p.runId);
    return { ok: true };
  });

  const createSamples: number[] = [];
  for (let i = 0; i < batchSize; i++) {
    const t0 = performance.now();
    await b.service.createRun({
      projectId: 'wan3',
      environment: 'test',
      trigger: 'manual',
      actor: 'perf',
      role: 'QA',
      feature: `perf-${batchSize}-${i}`,
    });
    createSamples.push(performance.now() - t0);
  }
  const createStats = latencyStats(createSamples);
  const createOpsPerSec = round(batchSize / (createSamples.reduce((a, c) => a + c, 0) / 1000));

  // 派发全部 Job：Worker 池（maxConcurrency=2）持续领取直至队列清空
  const d0 = performance.now();
  let guard = 0;
  while ((await b.scheduler.pendingCount()) > 0) {
    await b.pool.dispatch();
    await b.pool.drain();
    if (++guard > batchSize * 4 + 100) throw new Error(`Perf 调度未收敛（batch=${batchSize}）`);
  }
  const lifecycleTotalMs = performance.now() - d0;
  const jobsPendingAfter = await b.scheduler.pendingCount();

  return {
    batchSize,
    createOpsPerSec,
    createP50Ms: round(createStats.p50, 1),
    createP95Ms: round(createStats.p95, 1),
    createP99Ms: round(createStats.p99, 1),
    createMaxMs: round(createStats.max, 1),
    lifecycleOpsPerSec: round(batchSize / (lifecycleTotalMs / 1000)),
    lifecycleTotalMs,
    jobsPendingAfter,
  };
}

/** 批量生命周期基准：min-of-N（取生命周期最快的一次，滤除 GC/调度噪声） */
async function benchRunLifecycle(batchSize: number, opts: PerfRunOptions): Promise<RunLifecycleMetric> {
  let best: RunLifecycleMetric | null = null;
  for (let attempt = 0; attempt < MEASURE_REPEATS; attempt++) {
    const m = await measureRunLifecycleOnce(batchSize, opts);
    if (!best || m.lifecycleTotalMs < best.lifecycleTotalMs) best = m;
  }
  return best!;
}

/** min-of-N 包裹：返回最快的 ops/sec */
async function bestOf<T>(fn: () => Promise<T>, pick: (t: T) => number): Promise<number> {
  let bestVal = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < MEASURE_REPEATS; attempt++) {
    const v = pick(await fn());
    if (v < bestVal) bestVal = v;
  }
  return bestVal;
}

/** Scheduler 吞吐：enqueue → next → complete */
async function benchSchedulerOps(opts: PerfRunOptions): Promise<number> {
  return bestOf(
    async () => {
      const b = makeBundle(opts);
      const N = 2000;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const runId = `sched-${i}-${process.pid.toString(36)}`;
        await b.scheduler.enqueue({ runId, projectId: 'wan3', environment: 'test', priority: 5, requiredCapability: 'general', maxRetries: 1, payload: { runId } });
        const job = await b.scheduler.next({ environment: 'test', capability: 'general' });
        if (job) await b.scheduler.complete(job.jobId);
      }
      return N / ((performance.now() - t0) / 1000);
    },
    (v) => v,
  );
}

/** Audit 写入吞吐（含脱敏） */
async function benchAuditOps(opts: PerfRunOptions): Promise<number> {
  return bestOf(
    async () => {
      const b = makeBundle(opts);
      const N = 2000;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        await b.audit.record({ actor: 'perf', role: 'QA', action: 'run.create', resource: `perf-audit-${i}`, environment: 'test', result: 'success', detail: { runId: `r-${i}`, apiKey: 'secret-value-ok' } });
      }
      return N / ((performance.now() - t0) / 1000);
    },
    (v) => v,
  );
}

/** Telemetry 事件写入吞吐 */
async function benchTelemetryOps(opts: PerfRunOptions): Promise<number> {
  return bestOf(
    async () => {
      const b = makeBundle(opts);
      const N = 2000;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        await b.telemetry.recordExecution({ runId: `perf-tel-${i}`, projectId: 'wan3', feature: 'perf', phase: 'execution', result: 'success' });
      }
      return N / ((performance.now() - t0) / 1000);
    },
    (v) => v,
  );
}

/** 运行完整基准 */
export async function runPlatformPerf(opts: PerfRunOptions = {}): Promise<PerfReport> {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();

  const runLifecycle: RunLifecycleMetric[] = [];
  for (const batchSize of BATCH_SIZES) {
    runLifecycle.push(await benchRunLifecycle(batchSize, opts));
  }
  const schedulerOpsPerSec = round(await benchSchedulerOps(opts));
  const auditOpsPerSec = round(await benchAuditOps(opts));
  const telemetryOpsPerSec = round(await benchTelemetryOps(opts));

  const heapAfter = process.memoryUsage().heapUsed;
  return {
    tool: 'test-flow',
    version: PLATFORM_VERSION,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    runLifecycle,
    schedulerOpsPerSec,
    auditOpsPerSec,
    telemetryOpsPerSec,
    memory: {
      heapUsedBeforeMb: round(heapBefore / 1e6),
      heapUsedAfterMb: round(heapAfter / 1e6),
      growthMb: round((heapAfter - heapBefore) / 1e6),
    },
    totalMs: round(performance.now() - started),
  };
}

/** 回归门禁检查：当前报告 vs 基线报告，返回逐项判定与失败列表 */
export interface GateDecision {
  ok: boolean;
  failures: string[];
  details: Array<{ name: string; baseline: number; current: number; ratio: number; rule: string }>;
}

export function evaluatePerfGate(current: PerfReport, baseline: PerfReport): GateDecision {
  const failures: string[] = [];
  const details: GateDecision['details'] = [];

  const latencyRule = `current > baseline × ${PERF_THRESHOLDS.latencyRegressionRatio} → FAIL`;
  const throughputRule = `current < baseline × ${PERF_THRESHOLDS.throughputRegressionRatio} → FAIL`;

  for (const bm of baseline.runLifecycle) {
    const cm = current.runLifecycle.find((m) => m.batchSize === bm.batchSize);
    if (!cm) continue;
    // 延迟：越高越差
    for (const [name, bVal, cVal] of [
      [`createP95Ms(batch=${bm.batchSize})`, bm.createP95Ms, cm.createP95Ms],
      [`createP99Ms(batch=${bm.batchSize})`, bm.createP99Ms, cm.createP99Ms],
    ] as const) {
      const ratio = bVal > 0 ? cVal / bVal : 0;
      details.push({ name, baseline: bVal, current: cVal, ratio: round(ratio, 2), rule: latencyRule });
      if (bVal > 0 && cVal > bVal * PERF_THRESHOLDS.latencyRegressionRatio) failures.push(name);
    }
    // 吞吐：越低越差
    for (const [name, bVal, cVal] of [
      [`createOpsPerSec(batch=${bm.batchSize})`, bm.createOpsPerSec, cm.createOpsPerSec],
      [`lifecycleOpsPerSec(batch=${bm.batchSize})`, bm.lifecycleOpsPerSec, cm.lifecycleOpsPerSec],
    ] as const) {
      const ratio = bVal > 0 ? cVal / bVal : 0;
      details.push({ name, baseline: bVal, current: cVal, ratio: round(ratio, 2), rule: throughputRule });
      if (cVal < bVal * PERF_THRESHOLDS.throughputRegressionRatio) failures.push(name);
    }
  }

  for (const name of ['schedulerOpsPerSec', 'auditOpsPerSec', 'telemetryOpsPerSec'] as const) {
    const bVal = baseline[name];
    const cVal = current[name];
    const ratio = bVal > 0 ? cVal / bVal : 0;
    details.push({ name, baseline: bVal, current: cVal, ratio: round(ratio, 2), rule: throughputRule });
    if (cVal < bVal * PERF_THRESHOLDS.throughputRegressionRatio) failures.push(name);
  }

  // 内存：全程增长相对基线
  const memRatio = baseline.memory.growthMb > 0 ? current.memory.growthMb / baseline.memory.growthMb : 0;
  details.push({ name: 'memoryGrowthMb', baseline: baseline.memory.growthMb, current: current.memory.growthMb, ratio: round(memRatio, 2), rule: `current > baseline × ${PERF_THRESHOLDS.memoryRegressionRatio} → FAIL` });
  if (baseline.memory.growthMb > 0 && current.memory.growthMb > baseline.memory.growthMb * PERF_THRESHOLDS.memoryRegressionRatio) {
    failures.push('memoryGrowthMb');
  }

  return { ok: failures.length === 0, failures, details };
}
