// Continuous Evaluation Runner（Phase 48 / 43.20 落地）
// Nightly / Weekly / Release 定时评测：真实运行 Benchmark → Compare → Detect Regression。
// 复用 Phase 45 的 runAllEvaluation 作为评测源（确定性、零 token、不虚构分数）；
// 复用 43.20 detectRegression 做回归判定（Critical Regression → Alert + Block Release）。
// 铁律：
//   - baseline 缺省取最近一次运行；首次运行无 baseline 时只记录基线、不判回归。
//   - alertSent / releaseBlocked 由判定结果决定；实际投递 Alert（通知渠道）由调度方（CLI/API）执行。
//   - 不虚构指标：分数一律来自真实 runAllEvaluation 输出。
import { randomBytes } from 'node:crypto';
import type { EvaluationDomain } from '../eval/contract.js';
import { runAllEvaluation } from '../eval/runner.js';
import { detectRegression } from './ops.js';
import { CONTINUOUS_EVAL_SCHEDULES } from './ops.js';
import { PLATFORM_VERSION } from '../platform/version.js';

export type ContinuousEvalScheduleName = 'NIGHTLY' | 'WEEKLY' | 'RELEASE';
export type ContinuousEvalTrigger = 'SCHEDULE' | 'MANUAL' | 'RELEASE_GATE';

export const CONTINUOUS_EVAL_NAMES: readonly ContinuousEvalScheduleName[] = ['NIGHTLY', 'WEEKLY', 'RELEASE'];

/** 一次 Continuous Evaluation 运行记录（历史可追溯、可审计） */
export interface ContinuousEvalRun {
  id: string;
  schedule: ContinuousEvalScheduleName;
  triggeredBy: ContinuousEvalTrigger;
  baseline: {
    overall: number;
    critical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number };
  };
  current: {
    overall: number;
    critical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number };
  };
  /** 当前各领域分（可定向观察退化集中在哪个领域） */
  domains: Record<string, number>;
  /** 当前评测成本 / 延迟（ms，全领域合计） */
  cost: number;
  latencyMs: number;
  regression: {
    regression: boolean;
    criticalRegression: boolean;
    reasons: string[];
    verdict: 'PASS' | 'REVIEW' | 'BLOCK';
  };
  /** Critical Regression → 需要 Alert（调度方投递通知渠道） */
  alertSent: boolean;
  /** BLOCK → 需要 Block Release（发布门禁联动） */
  releaseBlocked: boolean;
  /** 被测平台版本 */
  reportVersion: string;
  /** 本次运行覆盖的领域数（8 全量 / 定向子集） */
  domainCount: number;
  createdBy: string;
  createdAt: string;
}

export interface RunContinuousEvalInput {
  schedule: ContinuousEvalScheduleName;
  triggeredBy?: ContinuousEvalTrigger;
  /** 定向领域（Change Impact / Targeted Evaluation 用；缺省全量 8 领域） */
  domains?: EvaluationDomain[];
  /** 允许的普通指标下降阈值（默认 2%） */
  allowDrop?: number;
  createdBy?: string;
}

export interface ContinuousEvalRunnerOptions {
  now?: () => string;
}

/** Continuous Evaluation 历史存储（快照 / 导入复用统一持久化） */
export class ContinuousEvalStore {
  private readonly runs = new Map<string, ContinuousEvalRun>();

  constructor(private readonly opts: ContinuousEvalRunnerOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  add(input: Omit<ContinuousEvalRun, 'id' | 'createdAt'>): ContinuousEvalRun {
    const run: ContinuousEvalRun = {
      ...input,
      id: `cev-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      createdAt: this.now(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): ContinuousEvalRun | undefined {
    return this.runs.get(id);
  }

  list(filter: { schedule?: ContinuousEvalScheduleName } = {}): ContinuousEvalRun[] {
    const all = [...this.runs.values()];
    const filtered = filter.schedule ? all.filter((r) => r.schedule === filter.schedule) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 最新在前
  }

  /** 最近一次运行（作为下一次 baseline） */
  latest(schedule?: ContinuousEvalScheduleName): ContinuousEvalRun | undefined {
    return this.list(schedule ? { schedule } : {})[0];
  }

  size(): number {
    return this.runs.size;
  }

  snapshot(): ContinuousEvalRun[] {
    return [...this.runs.values()];
  }

  static import(runs: ContinuousEvalRun[]): ContinuousEvalStore {
    const s = new ContinuousEvalStore();
    for (const r of runs) s.runs.set(r.id, r);
    return s;
  }
}

export function createContinuousEvalStore(): ContinuousEvalStore {
  return new ContinuousEvalStore();
}

/**
 * 48.x：运行一次 Continuous Evaluation。
 * 1) 真实运行 Benchmark（runAllEvaluation，确定性、不虚构分数）
 * 2) baseline 取最近一次运行（无则只记录基线）
 * 3) detectRegression 判定（Critical 指标上升 → BLOCK）
 * 4) 记录 alertSent（criticalRegression）与 releaseBlocked（verdict==='BLOCK'）
 * 返回完整运行记录（含逐条 reasons），由调用方决定是否投递 Alert / 阻断发布。
 */
export function runContinuousEvaluation(
  input: RunContinuousEvalInput,
  deps: { store: ContinuousEvalStore; report?: import('../eval/runner.js').EvalReport } = { store: new ContinuousEvalStore() },
): ContinuousEvalRun {
  // report 可注入（单元测试用，模拟真实评测输出）；生产调用一律走 runAllEvaluation（不虚构分数）
  const report = deps.report ?? runAllEvaluation({ version: PLATFORM_VERSION, domains: input.domains });

  const current = {
    overall: report.overall,
    critical: { ...report.critical },
  };
  const baselineRun = deps.store.latest();

  // 首次运行（无历史 baseline）：只记录基线，不判回归（避免把自身当回归）
  let regression: { regression: boolean; criticalRegression: boolean; reasons: string[]; verdict: 'PASS' | 'REVIEW' | 'BLOCK' };
  if (!baselineRun) {
    regression = {
      regression: false,
      criticalRegression: false,
      reasons: ['首次运行：已记录基线，无历史可比较'],
      verdict: 'PASS',
    };
  } else {
    const detected = detectRegression({
      baselineOverall: baselineRun.current.overall,
      currentOverall: current.overall,
      baselineCritical: baselineRun.current.critical,
      currentCritical: current.critical,
      allowDrop: input.allowDrop,
    });
    regression = detected;
  }

  const baseline = baselineRun ? { ...baselineRun.current } : { ...current };

  const domains: Record<string, number> = {};
  for (const d of report.domains) domains[d.domain] = d.score;

  const run = deps.store.add({
    schedule: input.schedule,
    triggeredBy: input.triggeredBy ?? 'SCHEDULE',
    baseline,
    current,
    domains,
    cost: report.cost.cost,
    latencyMs: report.cost.latencyMs,
    regression,
    alertSent: regression.verdict === 'BLOCK' && regression.criticalRegression,
    releaseBlocked: regression.verdict === 'BLOCK',
    reportVersion: report.version,
    domainCount: report.domains.length,
    createdBy: input.createdBy ?? 'SYSTEM',
  });
  return run;
}

export { CONTINUOUS_EVAL_SCHEDULES };
export type { EvaluationDomain };
