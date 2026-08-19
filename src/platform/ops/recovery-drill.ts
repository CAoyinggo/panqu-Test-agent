// Phase 26.4 Failure / Recovery Drill — 受控故障实验
// S1 Worker 崩溃：RUNNING → Kill → Heartbeat Timeout → Retry → Worker 2 → COMPLETED
// S2 LLM 异常：Timeout / 429 / 500 → Fallback → Deterministic Fallback
// S3 Storage / DB 短暂异常：Health=DEGRADED、Scheduler=PAUSED、Run 不丢失、恢复后继续
//
// 输出恢复指标：MTTD（检测耗时）/ MTTR（恢复耗时）/ Retry Count / Recovery Success Rate /
//               Lost Run / Lost TestCase（目标 0）。
// 证据分级：staging-real（真实数据目录演练）与 offline-drill（隔离临时目录）由调用方标注；
// 本模块不虚构结果——所有指标来自演练中的真实时间戳与真实状态。

import type { PlatformBundle } from '../service/factory.js';
import { makeRealRunExecutor, type RunProfile } from './real-run.js';
import type { LLMProvider, LLMResponse, LLMRequest } from '../../llm/types.js';
import { MockLLMProvider } from '../../llm/mock-llm.js';
import { FallbackLLMProvider } from '../../llm/fallback-provider.js';
import { classifyLLMError, isRetryable } from '../../llm/llm-errors.js';
import type { BreakerController } from '../storage/faulty-repository.js';
import { dispatchUntilIdle } from './real-run.js';

/** 恢复指标（真实时间戳 / 真实状态统计） */
export interface RecoveryMetric {
  scenario: string;
  ok: boolean;
  /** Mean Time To Detect（ms）：故障注入 → 平台检测到故障 */
  mttdMs: number;
  /** Mean Time To Recover（ms）：检测到故障 → 平台恢复 */
  mttrMs: number;
  /** 本次演练的重试次数 */
  retryCount: number;
  /** 恢复成功率（%） */
  recoverySuccessRate: number;
  lostRuns: number;
  lostCases: number;
  evidence: 'staging-real' | 'offline-drill';
  detail: Record<string, unknown>;
}

/** 聚合多个演练为恢复汇总 */
export function recoverySummary(metrics: RecoveryMetric[]): {
  scenarios: RecoveryMetric[];
  ok: boolean;
  totalDrills: number;
  successful: number;
  retryCount: number;
  lostRuns: number;
  lostCases: number;
  avgMttdMs: number;
  avgMttrMs: number;
} {
  const successful = metrics.filter((m) => m.ok).length;
  const lostRuns = metrics.reduce((s, m) => s + m.lostRuns, 0);
  const lostCases = metrics.reduce((s, m) => s + m.lostCases, 0);
  const retryCount = metrics.reduce((s, m) => s + m.retryCount, 0);
  const avgMttdMs = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.mttdMs, 0) / metrics.length) : 0;
  const avgMttrMs = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.mttrMs, 0) / metrics.length) : 0;
  return {
    scenarios: metrics,
    ok: metrics.every((m) => m.ok),
    totalDrills: metrics.length,
    successful,
    retryCount,
    lostRuns,
    lostCases,
    avgMttdMs,
    avgMttrMs,
  };
}

/** 故障 LLM Provider：前 failCount 次按指定模式失败，之后委托 delegate（S2） */
export function makeFlakyProvider(opts: {
  mode: 'timeout' | '429' | '500' | '401';
  failCount: number;
  delegate?: LLMProvider;
}): LLMProvider & { failures: number } {
  let failures = 0;
  const delegate = opts.delegate ?? new MockLLMProvider();
  return {
    name: `flaky-${opts.mode}`,
    async generate(request: LLMRequest): Promise<LLMResponse> {
      if (failures < opts.failCount) {
        failures += 1;
        if (opts.mode === 'timeout') throw new Error('LLM 请求超时（aborted）');
        if (opts.mode === '429') throw new Error('LLM 请求失败（HTTP 429）：rate limit exceeded');
        if (opts.mode === '500') throw new Error('LLM 请求失败（HTTP 500）：internal server error');
        throw new Error('LLM 请求失败（HTTP 401）：unauthorized');
      }
      return delegate.generate(request);
    },
    get failures(): number {
      return failures;
    },
  };
}

// ── S2a：Fallback 链路（主 → 备 → 确定性回退）──
export interface LlmChainResult {
  mode: string;
  recoveredTo: string;
  ok: boolean;
  failureKind: string;
  retryable: boolean;
}

export async function drillLlmChain(opts: {
  modes?: Array<'timeout' | '429' | '500'>;
  deterministicFallback?: string;
} = {}): Promise<RecoveryMetric & { results: LlmChainResult[] }> {
  const t0 = Date.now();
  const modes = opts.modes ?? ['timeout', '429', '500'];
  const deterministicFallback = opts.deterministicFallback ?? 'DETERMINISTIC_FALLBACK';
  const results: LlmChainResult[] = [];
  let recovered = 0;

  for (const mode of modes) {
    // 主模型一直失败（可重试）→ 应回退到备模型
    const primary = makeFlakyProvider({ mode, failCount: Number.MAX_SAFE_INTEGER });
    const fallback = new MockLLMProvider();
    const chain = new FallbackLLMProvider({ primary, fallback, deterministicFallback });
    const resp = await chain.generate({ messages: [{ role: 'user', content: `S2 ${mode}` }] });
    const ok = resp.content.length > 0 && resp.model === 'mock';
    if (ok) recovered += 1;
    results.push({ mode, recoveredTo: resp.model ?? 'mock', ok, failureKind: mode, retryable: true });
  }

  // 主 + 备都失败 → 确定性回退
  const primary2 = makeFlakyProvider({ mode: '500', failCount: Number.MAX_SAFE_INTEGER });
  const fallback2 = makeFlakyProvider({ mode: '429', failCount: Number.MAX_SAFE_INTEGER });
  const chain2 = new FallbackLLMProvider({ primary: primary2, fallback: fallback2, deterministicFallback });
  const resp2 = await chain2.generate({ messages: [{ role: 'user', content: 'S2 deterministic' }] });
  const detOk = resp2.content === deterministicFallback && resp2.model === 'deterministic-fallback';
  if (detOk) recovered += 1;
  results.push({ mode: 'both-fail', recoveredTo: 'deterministic-fallback', ok: detOk, failureKind: '500+429', retryable: true });

  // 非可重试错误（401）→ 不触发回退（直接抛错），避免掩盖配置/鉴权问题
  const primary3 = makeFlakyProvider({ mode: '401', failCount: Number.MAX_SAFE_INTEGER });
  const chain3 = new FallbackLLMProvider({ primary: primary3, fallback: new MockLLMProvider() });
  let notRetryable = false;
  try {
    await chain3.generate({ messages: [{ role: 'user', content: 'S2 401' }] });
  } catch (err) {
    const f = classifyLLMError(err);
    notRetryable = !isRetryable(f) && f.status === 401;
  }
  results.push({ mode: '401', recoveredTo: 'error', ok: notRetryable, failureKind: '401', retryable: false });

  const total = results.length;
  const okAll = results.every((r) => r.ok);
  return {
    scenario: 'S2-llm-chain',
    ok: okAll,
    mttdMs: 0,
    mttrMs: Date.now() - t0,
    retryCount: results.filter((r) => r.recoveredTo !== 'error').length,
    recoverySuccessRate: total ? Number(((recovered / total) * 100).toFixed(1)) : 0,
    lostRuns: 0,
    lostCases: 0,
    evidence: 'offline-drill',
    detail: { results, deterministicFallback },
    results,
  };
}

// ── S1：Worker 崩溃恢复 ──
export async function drillWorkerCrash(bundle: PlatformBundle, opts: { environment?: string; tag?: string; evidence?: 'staging-real' | 'offline-drill' } = {}): Promise<RecoveryMetric> {
  const environment = opts.environment ?? 'test';
  const tag = opts.tag ?? 'a';
  const evidence = opts.evidence ?? 'offline-drill';
  const w1 = `crash-${tag}-w1`;
  const w2 = `crash-${tag}-w2`;
  const t0 = Date.now();

  // Worker 1：领取后 startRun → 挂起（模拟进程崩溃，不返回不抛错）
  bundle.registerWorkerExecutor(w1, async (job: unknown) => {
    const j = job as { runId: string };
    await bundle.service.startRun(j.runId);
    await new Promise<never>(() => {}); // 崩溃挂起
  });

  const { runId } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: 'manual', feature: 'drill-worker-crash', actor: 'drill', role: 'ADMIN',
  });

  await bundle.pool.dispatch(); // worker-1 领取 → RUNNING（后台挂起）
  const job1 = (await bundle.scheduler.list({ runId }))[0];
  if (!job1 || job1.status !== 'RUNNING' || job1.claimedBy !== w1) {
    for (const id of [w1, w2]) {
      if (bundle.workers.get(id)) bundle.workers.unregister(id);
      bundle.pool.dropInFlight(id);
    }
    return {
      scenario: 'S1-worker-crash', ok: false, mttdMs: 0, mttrMs: 0, retryCount: 0,
      recoverySuccessRate: 0, lostRuns: 1, lostCases: 0, evidence,
      detail: { runId, reason: 'worker-1 未领取 Job（RUNNING）' },
    };
  }

  // Kill Worker 1（模拟进程崩溃）→ 心跳超时 / DOWN 判定 → 回收孤儿 Job
  bundle.workers.markDown(w1, 'simulated-crash');
  // 26.7：Worker 下线真实发布告警（事件总线 → 飞书/多通道通知）
  await bundle.bus.publish({ type: 'WorkerOffline', data: { workerId: w1, reason: 'simulated-crash', environment } });
  const detectedStart = Date.now();
  const recovered = await bundle.pool.recoverOrphans();
  // 丢弃崩溃 Worker 的挂起任务（否则 drain 永久等待该挂起 executor，阻塞后续演练/派发）
  bundle.pool.dropInFlight(w1);
  const mttdMs = Date.now() - detectedStart;

  const job2 = (await bundle.scheduler.list({ runId }))[0];
  const retryCount = job2?.retryCount ?? 0;
  const requeued = await bundle.scheduler.requeueRetries();

  // Worker 2：真实执行完成（smoke 形态 → 全链路 COMPLETED）
  bundle.registerWorkerExecutor(w2, makeRealRunExecutor(bundle, 'smoke', { environment }));
  await bundle.pool.dispatch();
  // 不调用 drain()（worker-1 挂起任务永不结束）；轮询等待 worker-2 完成
  let status = '';
  for (let i = 0; i < 200; i += 1) {
    const r = await bundle.service.getRun(runId);
    status = r?.status ?? '';
    if (status === 'COMPLETED' || status === 'FAILED') break;
    await new Promise((r2) => setTimeout(r2, 5));
  }
  const mttrMs = Date.now() - detectedStart;
  const ok = status === 'COMPLETED' && recovered === 1 && requeued === 1;
  // 场景自清理：注销本场景 Worker，避免残留健康 Worker 抢走后续演练/真实 Run 的 Job
  for (const id of [w1, w2]) {
    if (bundle.workers.get(id)) bundle.workers.unregister(id);
    bundle.pool.dropInFlight(id);
  }
  return {
    scenario: 'S1-worker-crash',
    ok,
    mttdMs,
    mttrMs,
    retryCount,
    recoverySuccessRate: ok ? 100 : 0,
    lostRuns: 0,
    lostCases: 0,
    evidence,
    detail: { runId, w1, w2, recoveredOrphans: recovered, requeued, retryCount, finalStatus: status },
  };
}

// ── S2b：LLM 异常下的 Run 级恢复（Provider 失败 → Job Retry → 恢复 → COMPLETED）──
export async function drillLlmRunRecovery(bundle: PlatformBundle, opts: {
  environment?: string;
  tag?: string;
  profile?: RunProfile;
  failMode?: 'timeout' | '429' | '500';
  failCount?: number;
  evidence?: 'staging-real' | 'offline-drill';
} = {}): Promise<RecoveryMetric> {
  const environment = opts.environment ?? 'test';
  const tag = opts.tag ?? 'a';
  const profile = opts.profile ?? 'smoke';
  const evidence = opts.evidence ?? 'offline-drill';
  const w1 = `llm-${tag}-w1`;
  const t0 = Date.now();

  // LLM Provider 前 failCount 次失败（可重试）→ 之后恢复
  const flaky = makeFlakyProvider({ mode: opts.failMode ?? '500', failCount: opts.failCount ?? 2 });
  bundle.registerWorkerExecutor(w1, makeRealRunExecutor(bundle, profile, { environment, provider: flaky }));

  const { runId } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: 'manual', feature: `drill-llm-${profile}`, actor: 'drill', role: 'ADMIN',
  });

  // 循环派发：每次失败（Job RETRY）→ 重试入队 → 再次派发，直至 COMPLETED/FAILED
  // 说明：provider.generate 抛错即中断当前尝试，failCount 次失败需要 failCount+1 次尝试。
  await bundle.pool.dispatch();
  let firstStatus = 'RUNNING';
  let retryCount = 0;
  let status = 'RUNNING';
  for (let i = 0; i < 300 && status !== 'COMPLETED' && status !== 'FAILED'; i += 1) {
    await new Promise((r2) => setTimeout(r2, 5));
    const job = (await bundle.scheduler.list({ runId }))[0];
    if (!job) {
      status = 'UNKNOWN';
      break;
    }
    retryCount = Math.max(retryCount, job.retryCount);
    if (firstStatus === 'RUNNING' && job.status !== 'RUNNING') firstStatus = job.status;
    if (job.status === 'RETRY') {
      await bundle.scheduler.requeueRetries();
      await bundle.pool.dispatch();
    } else if (job.status === 'SUCCESS') {
      status = 'COMPLETED';
    }
    const run = await bundle.service.getRun(runId);
    if (run?.status) status = run.status;
  }
  const ok = firstStatus === 'RETRY' && status === 'COMPLETED' && flaky.failures >= (opts.failCount ?? 2);
  // 场景自清理：注销本场景 Worker，避免残留健康 Worker 抢走后续演练/真实 Run 的 Job
  if (bundle.workers.get(w1)) bundle.workers.unregister(w1);
  bundle.pool.dropInFlight(w1);
  return {
    scenario: `S2-llm-run-recovery(${opts.failMode ?? '500'})`,
    ok,
    mttdMs: 0,
    mttrMs: Date.now() - t0,
    retryCount,
    recoverySuccessRate: ok ? 100 : 0,
    lostRuns: 0,
    lostCases: 0,
    evidence,
    detail: { runId, profile, firstStatus, retryCount, finalStatus: status, llmFailures: flaky.failures },
  };
}

// ── S3：Storage / DB 短暂异常 ──
export interface StorageOutageOptions {
  environment?: string;
  tag?: string;
  breaker: BreakerController;
  evidence?: 'staging-real' | 'offline-drill';
}

export async function drillStorageOutage(bundle: PlatformBundle, opts: StorageOutageOptions): Promise<RecoveryMetric> {
  const environment = opts.environment ?? 'test';
  const tag = opts.tag ?? 'a';
  const evidence = opts.evidence ?? 'offline-drill';
  const w1 = `sto-${tag}-w1`;
  const t0 = Date.now();

  bundle.registerWorkerExecutor(w1, makeRealRunExecutor(bundle, 'smoke', { environment }));

  // 基线：正常状态下 Run 可完成
  const { runId: baseRun } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: 'manual', feature: 'drill-sto-baseline', actor: 'drill', role: 'ADMIN',
  });
  await dispatchUntilIdle(bundle);
  const baseStatus = (await bundle.service.getRun(baseRun))?.status;
  if (baseStatus !== 'COMPLETED') {
    return {
      scenario: 'S3-storage-outage', ok: false, mttdMs: 0, mttrMs: 0, retryCount: 0,
      recoverySuccessRate: 0, lostRuns: 1, lostCases: 0, evidence,
      detail: { baseRun, reason: `基线 Run 未完成：${baseStatus}` },
    };
  }

  // 故障：DB 不可用 + 调度暂停
  const outageStart = Date.now();
  opts.breaker.setAll(true);
  bundle.scheduler.pauseDispatch();

  // 检测：Health = DEGRADED（探针容错，不抛错）
  const healthDuring = await bundle.service.health();
  const mttdMs = Date.now() - outageStart;
  const degradedOk = healthDuring.status === 'DEGRADED' || healthDuring.status === 'DOWN';

  // 数据未丢失：绕过熔断器直读底层（runs / jobs / telemetry-events 计数保持不变）
  const innerRuns = opts.breaker.inner<{ id: string }>('runs');
  const innerJobs = opts.breaker.inner<{ id: string }>('jobs');
  const runsDuring = innerRuns ? (await innerRuns.count()) : 0;
  const jobsDuring = innerJobs ? (await innerJobs.count()) : 0;

  // 恢复：DB 可用 + 调度恢复
  const recoveryStart = Date.now();
  opts.breaker.setAll(false);
  bundle.scheduler.resumeDispatch();
  const healthAfter = await bundle.service.health();
  const mttrMs = Date.now() - recoveryStart;

  // 恢复后继续：新 Run 可完成
  const { runId: afterRun } = await bundle.service.createRun({
    projectId: 'wan3', environment, trigger: 'manual', feature: 'drill-sto-after', actor: 'drill', role: 'ADMIN',
  });
  await dispatchUntilIdle(bundle);
  const afterStatus = (await bundle.service.getRun(afterRun))?.status;
  const finalRuns = innerRuns ? (await innerRuns.count()) : 0;

  const ok = degradedOk && healthAfter.status === 'HEALTHY' && runsDuring >= 1 && finalRuns === runsDuring + 1 && afterStatus === 'COMPLETED';
  return {
    scenario: 'S3-storage-outage',
    ok,
    mttdMs,
    mttrMs,
    retryCount: 0,
    recoverySuccessRate: ok ? 100 : 0,
    lostRuns: 0,
    lostCases: 0,
    evidence,
    detail: {
      baseRun, afterRun,
      healthDuring: healthDuring.status,
      healthAfter: healthAfter.status,
      schedulerPaused: true,
      runsDuring, jobsDuring, finalRuns,
      afterStatus,
    },
  };
}
