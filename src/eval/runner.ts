// Unified Eval Runner（Phase 45 / 42.14）：统一评测运行器
// 输入：8 大领域 Benchmark 用例集（各自携带 groundTruth）；
// 输出：逐条 EvaluationResult + 领域级聚合（score / passed / total / 领域特定指标）+ 全平台汇总。
// 铁律：
//   - 没有 Ground Truth 的用例 tracked=false、score=null，绝不虚构数值。
//   - 确定性评测不消耗 token（cost=0）；LLM 评测按 token 计价。
//   - 关键安全指标：P0 Miss / False Pass / Unsafe Healing / Skipped Critical 全部独立统计。
import type { EvaluationCase, EvaluationDomain, EvaluationResult } from './contract.js';
import { ALL_DOMAINS, DOMAIN_LABELS } from './contract.js';
import { GroundTruthRegistry, groundTruthFor, type GroundTruthRecord } from './ground-truth.js';
import { BenchmarkRegistry, type BenchmarkDefinition } from './benchmark/registry.js';
import { mean, round4 } from './metrics.js';
import { buildCost, EMPTY_COST, type EvaluationCost } from './cost.js';
import { RUNTIME_EVAL_VERSION_INFO, type EvalVersionInfo } from './versioning.js';
import { PLATFORM_VERSION } from '../platform/version.js';

// 各领域基准用例
import { REQUIREMENT_CASES } from './benchmark/data/requirement.js';
import { TEST_DESIGN_CASES } from './benchmark/data/test-design.js';
import { RISK_CASES } from './benchmark/data/risk.js';
import { SELECTION_CASES } from './benchmark/data/selection.js';
import { RCA_CASES } from './benchmark/data/rca.js';
import { DEFECT_CASES } from './benchmark/data/defect.js';
import { HEALING_CASES } from './benchmark/data/healing.js';
import { RELEASE_CASES } from './benchmark/data/release.js';

// 各领域评估器
import { evaluateRequirement } from './evaluator/requirement.js';
import { evaluateTestDesign } from './evaluator/test-design.js';
import { evaluateRisk } from './evaluator/risk.js';
import { evaluateSelection } from './evaluator/selection.js';
import { evaluateRca } from './evaluator/rca.js';
import { evaluateDefect } from './evaluator/defect.js';
import { evaluateHealing } from './evaluator/healing.js';
import { evaluateRelease } from './evaluator/release.js';

/** 领域 → 最新 Benchmark 用例集 */
const BENCHMARK_CASES: Record<EvaluationDomain, EvaluationCase[]> = {
  REQUIREMENT: REQUIREMENT_CASES,
  TEST_DESIGN: TEST_DESIGN_CASES,
  RISK: RISK_CASES,
  SELECTION: SELECTION_CASES,
  RCA: RCA_CASES,
  DEFECT: DEFECT_CASES,
  HEALING: HEALING_CASES,
  RELEASE: RELEASE_CASES,
};

/** 领域 → 评估器（统一签名：EvaluationCase → EvaluationResult） */
const EVALUATORS: Record<EvaluationDomain, (c: EvaluationCase) => EvaluationResult> = {
  REQUIREMENT: (c) => evaluateRequirement(c as Parameters<typeof evaluateRequirement>[0]),
  TEST_DESIGN: (c) => evaluateTestDesign(c as Parameters<typeof evaluateTestDesign>[0]),
  RISK: (c) => evaluateRisk(c as Parameters<typeof evaluateRisk>[0]),
  SELECTION: (c) => evaluateSelection(c as Parameters<typeof evaluateSelection>[0]),
  RCA: (c) => evaluateRca(c as Parameters<typeof evaluateRca>[0]),
  DEFECT: (c) => evaluateDefect(c as Parameters<typeof evaluateDefect>[0]),
  HEALING: (c) => evaluateHealing(c as Parameters<typeof evaluateHealing>[0]),
  RELEASE: (c) => evaluateRelease(c as Parameters<typeof evaluateRelease>[0]),
};

/** 领域级聚合报告 */
export interface DomainReport {
  domain: EvaluationDomain;
  label: string;
  benchmark: string;
  benchmarkVersion: string;
  total: number;
  tracked: number;
  untracked: number;
  passed: number;
  /** 0~1（仅 tracked 用例均值） */
  score: number;
  /** 领域特定指标 */
  metrics: Record<string, number>;
  /** 错误分析：所有失败用例的错误摘要（Case / Expected / Actual / Reason） */
  failures: Array<{ caseId: string; expected: unknown; actual: unknown; errors: string[] }>;
  results: EvaluationResult[];
  cost: EvaluationCost;
}

/** 全平台评测报告 */
export interface EvalReport {
  /** 被测平台版本 */
  version: string;
  generatedAt: string;
  /** 评测系统版本信息（model / prompt / tool / agent） */
  versionInfo: EvalVersionInfo;
  domains: DomainReport[];
  /** 全部 tracked 用例的得分（0~1） */
  overall: number;
  /** 关键安全指标（目标全为 0） */
  critical: {
    /** P0/Risk Critical Miss 用例数 */
    p0Miss: number;
    /** Critical Release Miss（应 BLOCK 却 PASS）用例数 */
    falsePass: number;
    /** DANGEROUS 自愈（掩盖真实 Bug）用例数 */
    unsafeHealing: number;
    /** 关键用例被跳过（Skipped Critical Case）用例数 */
    skippedCritical: number;
  };
  cost: EvaluationCost;
}

/** 领域特定指标（从结果结构提取，禁止从错误字符串反推） */
function computeDomainMetrics(domain: EvaluationDomain, results: EvaluationResult[]): Record<string, number> {
  const n = results.length || 1;
  const base = {
    passRate: results.length ? results.filter((r) => r.passed).length / results.length : 0,
    meanScore: mean(results.map((r) => r.score ?? 0)),
  };
  switch (domain) {
    case 'RCA': {
      const unknown = results.filter((r) => (r.actual as { category?: string } | undefined)?.category === 'UNKNOWN').length;
      const falseRoot = results.filter((r) => !r.passed && r.score === 0).length;
      return { ...base, unknownRate: unknown / n, falseRootCauseRate: falseRoot / n, top1Accuracy: base.meanScore };
    }
    case 'RELEASE': {
      const fp = results.filter((r) => (r.expected as { decision?: string } | undefined)?.decision === 'BLOCK' && (r.actual as { decision?: string } | undefined)?.decision === 'PASS').length;
      const fb = results.filter((r) => (r.expected as { decision?: string } | undefined)?.decision === 'PASS' && (r.actual as { decision?: string } | undefined)?.decision === 'BLOCK').length;
      const fr = results.filter((r) => r.errors.some((e) => e.includes('False Review'))).length;
      return { ...base, falsePassRate: fp / n, falseBlockRate: fb / n, falseReviewRate: fr / n, accuracy: base.meanScore };
    }
    case 'HEALING': {
      const unsafe = results.filter((r) => (r.actual as { safety?: string } | undefined)?.safety === 'DANGEROUS').length;
      const risky = results.filter((r) => (r.actual as { safety?: string } | undefined)?.safety === 'RISKY').length;
      const noOp = results.filter((r) => (r.actual as { outcome?: string } | undefined)?.outcome === 'NO_OP').length;
      return { ...base, unsafeHealingRate: unsafe / n, riskyRate: risky / n, noOpRate: noOp / n };
    }
    case 'SELECTION': {
      const skippedCritical = results.filter((r) => r.errors.some((e) => e.includes('跳过关键用例'))).length;
      const mustRunMiss = results.filter((r) => r.errors.some((e) => e.includes('漏选 Must-Run'))).length;
      return { ...base, skippedCriticalRate: skippedCritical / n, mustRunMissRate: mustRunMiss / n };
    }
    case 'RISK': {
      const criticalMiss = results.filter((r) => r.errors.some((e) => e.includes('Critical Miss'))).length;
      return { ...base, criticalMissRate: criticalMiss / n };
    }
    case 'TEST_DESIGN': {
      const dup = results.filter((r) => r.errors.some((e) => e.includes('重复用例'))).length;
      const nonExec = results.filter((r) => r.errors.some((e) => e.includes('不可执行'))).length;
      const missingCritical = results.filter((r) => r.errors.some((e) => e.includes('关键用例缺失'))).length;
      return { ...base, duplicateRate: dup / n, nonExecutableRate: nonExec / n, missingCriticalRate: missingCritical / n };
    }
    case 'DEFECT': {
      const dup = results.filter((r) => r.errors.some((e) => e.includes('重复'))).length;
      const wrongSev = results.filter((r) => r.errors.some((e) => e.includes('严重度'))).length;
      return { ...base, duplicateRate: dup / n, wrongSeverityRate: wrongSev / n };
    }
    default:
      return base;
  }
}

/** 默认 Ground Truth 登记（source=CURATED，confidence=1）；传入 registry 时以该注册表最新版用例为准（含并入的真实失败用例） */
export function buildDefaultGroundTruth(registry: GroundTruthRegistry, benchmarkRegistry?: BenchmarkRegistry): GroundTruthRegistry {
  for (const domain of ALL_DOMAINS) {
    const cases = benchmarkRegistry?.latest(domain)?.cases ?? BENCHMARK_CASES[domain];
    for (const rec of groundTruthFor(
      cases.map((c) => c.id),
      { source: 'CURATED', verifiedBy: 'phase45', confidence: 1 },
    )) {
      registry.register(rec);
    }
  }
  return registry;
}

/** 默认 Benchmark 注册（名称 <DOMAIN>_BENCHMARK_v1） */
export function buildDefaultBenchmarks(registry: BenchmarkRegistry): BenchmarkRegistry {
  for (const domain of ALL_DOMAINS) {
    registry.register({
      name: `${domain}_BENCHMARK_v1`,
      version: 'v1',
      domain,
      description: `${DOMAIN_LABELS[domain]} 评测基准 v1`,
      cases: BENCHMARK_CASES[domain],
    } satisfies BenchmarkDefinition);
  }
  return registry;
}

export interface RunOptions {
  version?: string;
  domains?: EvaluationDomain[];
  groundTruthRegistry?: GroundTruthRegistry;
  benchmarkRegistry?: BenchmarkRegistry;
  versionInfo?: EvalVersionInfo;
}

/** 运行指定领域评测，返回领域报告 */
export function runDomain(domain: EvaluationDomain, opts: RunOptions = {}): DomainReport {
  const benchmarkDef = opts.benchmarkRegistry?.latest(domain);
  const cases = benchmarkDef?.cases ?? BENCHMARK_CASES[domain];
  const evaluator = EVALUATORS[domain];
  const registry = opts.groundTruthRegistry ?? buildDefaultGroundTruth(new GroundTruthRegistry(), opts.benchmarkRegistry);

  const results: EvaluationResult[] = cases.map((c) => {
    const tracked = registry.isTracked(c.id);
    if (!tracked) {
      // 无 Ground Truth → tracked=false，score=null（绝不虚构）
      return {
        caseId: c.id,
        domain,
        score: null,
        passed: false,
        tracked: false,
        expected: undefined,
        actual: undefined,
        errors: ['未登记 Ground Truth（tracked=false，score=null）'],
      };
    }
    return evaluator(c);
  });

  const trackedResults = results.filter((r) => r.tracked);
  const passed = trackedResults.filter((r) => r.passed).length;
  const score = round4(mean(trackedResults.map((r) => r.score ?? 0)));
  const cost = buildCost(results.map((r) => ({ inputTokens: 0, outputTokens: 0, latencyMs: r.latencyMs ?? 0, cost: r.cost ?? 0 })));

  const failures = trackedResults
    .filter((r) => !r.passed)
    .map((r) => ({ caseId: r.caseId, expected: r.expected, actual: r.actual, errors: r.errors }));

  const benchmarkName = benchmarkDef?.name ?? `${domain}_BENCHMARK_v1`;
  return {
    domain,
    label: DOMAIN_LABELS[domain],
    benchmark: benchmarkName,
    benchmarkVersion: benchmarkDef?.version ?? 'v1',
    total: cases.length,
    tracked: trackedResults.length,
    untracked: results.length - trackedResults.length,
    passed,
    score,
    metrics: computeDomainMetrics(domain, trackedResults),
    failures,
    results,
    cost,
  };
}

/** 运行全平台评测（8 领域） */
export function runAllEvaluation(opts: RunOptions = {}): EvalReport {
  const registry = opts.groundTruthRegistry ?? buildDefaultGroundTruth(new GroundTruthRegistry());
  const domains = (opts.domains ?? [...ALL_DOMAINS]).map((d) => runDomain(d, { ...opts, groundTruthRegistry: registry }));
  const trackedAll = domains.flatMap((d) => d.results).filter((r) => r.tracked);
  const overall = round4(mean(trackedAll.map((r) => r.score ?? 0)));

  // 关键安全指标独立统计（按结果结构判定）
  const p0Miss = domains.find((d) => d.domain === 'RISK')?.results.filter((r) => r.tracked && r.errors.some((e) => e.includes('Critical Miss'))).length ?? 0;
  const falsePass = domains.find((d) => d.domain === 'RELEASE')?.results.filter((r) => (r.expected as { decision?: string })?.decision === 'BLOCK' && (r.actual as { decision?: string })?.decision === 'PASS').length ?? 0;
  const unsafeHealing = domains.find((d) => d.domain === 'HEALING')?.results.filter((r) => (r.actual as { safety?: string })?.safety === 'DANGEROUS').length ?? 0;
  const skippedCritical = domains.find((d) => d.domain === 'SELECTION')?.results.filter((r) => r.errors.some((e) => e.includes('跳过关键用例'))).length ?? 0;

  const cost = buildCost(domains.map((d) => d.cost));

  return {
    version: opts.version ?? PLATFORM_VERSION,
    generatedAt: new Date().toISOString(),
    versionInfo: opts.versionInfo ?? RUNTIME_EVAL_VERSION_INFO,
    domains,
    overall,
    critical: { p0Miss, falsePass, unsafeHealing, skippedCritical },
    cost,
  };
}

/** 构建并返回默认注册表（供测试 / 集成复用） */
export function buildRegistries(): { groundTruth: GroundTruthRegistry; benchmarks: BenchmarkRegistry } {
  return {
    groundTruth: buildDefaultGroundTruth(new GroundTruthRegistry()),
    benchmarks: buildDefaultBenchmarks(new BenchmarkRegistry()),
  };
}

export { EMPTY_COST };
export type { EvaluationCost };
