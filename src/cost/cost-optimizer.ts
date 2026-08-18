// Cost Optimizer：最小成本测试集合选择（Phase 21.6）
// 目标：在满足 Coverage ≥90% + Risk Coverage 100% + P0 Coverage 100% 的前提下，
// 选择总成本最小的用例集合（确定性贪心 set-cover，不引入求解器/向量库）。
// 策略：P0 必选 → 风险项按性价比贪心补齐 → 覆盖率按性价比贪心补齐。

/** 成本感知用例 */
export interface CostAwareCase {
  id: string;
  /** 预估执行成本（统一计量单位） */
  cost: number;
  /** 优先级（P0 必选） */
  priority?: string;
  /** 覆盖的覆盖项（需求点/功能点） */
  coverageItems?: string[];
  /** 覆盖的风险项 */
  riskItems?: string[];
}

/** 待覆盖全集 */
export interface SuiteUniverse {
  /** 全部覆盖项 */
  coverageItems: string[];
  /** 全部风险项 */
  riskItems: string[];
}

/** 选择约束 */
export interface SuiteConstraints {
  /** 最低覆盖率（默认 0.9） */
  minCoverage?: number;
  /** 风险项必须 100% 覆盖（默认 true） */
  requireFullRiskCoverage?: boolean;
  /** P0 用例必须 100% 入选（默认 true） */
  requireFullP0?: boolean;
}

/** 选择结果 */
export interface SuiteSelection {
  selected: CostAwareCase[];
  selectedIds: string[];
  totalCost: number;
  /** 覆盖率（已覆盖覆盖项 / 全集） */
  coverage: number;
  /** 风险覆盖率 */
  riskCoverage: number;
  /** P0 入选率 */
  p0Coverage: number;
  /** 是否满足全部约束 */
  feasible: boolean;
  reasons: string[];
}

const EPS = 1e-9;

/**
 * 选择满足约束的最小成本测试集合。
 * 贪心顺序：P0 必选 → 风险 100% → 覆盖率达标；每步按「新覆盖 / 成本」性价比选择，
 * 同分按 id 字典序保证确定性。
 */
export function selectMinimumCostSuite(
  candidates: CostAwareCase[],
  universe: SuiteUniverse,
  constraints: SuiteConstraints = {},
): SuiteSelection {
  const minCoverage = constraints.minCoverage ?? 0.9;
  const requireFullRisk = constraints.requireFullRiskCoverage ?? true;
  const requireFullP0 = constraints.requireFullP0 ?? true;
  const reasons: string[] = [];

  const selected = new Map<string, CostAwareCase>();
  const coveredCov = new Set<string>();
  const coveredRisk = new Set<string>();

  const apply = (c: CostAwareCase): void => {
    selected.set(c.id, c);
    for (const item of c.coverageItems ?? []) if (universe.coverageItems.includes(item)) coveredCov.add(item);
    for (const item of c.riskItems ?? []) if (universe.riskItems.includes(item)) coveredRisk.add(item);
  };

  const coverageOf = (): number => (universe.coverageItems.length === 0 ? 1 : coveredCov.size / universe.coverageItems.length);
  const riskCoverageOf = (): number => (universe.riskItems.length === 0 ? 1 : coveredRisk.size / universe.riskItems.length);

  // 1. P0 必选
  const p0Cases = candidates.filter((c) => (c.priority ?? '').toUpperCase() === 'P0');
  if (requireFullP0) {
    for (const c of p0Cases) apply(c);
    if (p0Cases.length > 0) reasons.push(`P0 用例 ${p0Cases.length} 条全部入选`);
  }

  // 2. 风险项 100%：贪心补齐
  if (requireFullRisk) {
    while (coveredRisk.size < universe.riskItems.length) {
      const best = pickBest(candidates, selected, (c) => (c.riskItems ?? []).filter((r) => universe.riskItems.includes(r) && !coveredRisk.has(r)).length);
      if (!best) {
        const missing = universe.riskItems.filter((r) => !coveredRisk.has(r));
        reasons.push(`风险项无法 100% 覆盖：缺少候选用例覆盖 ${missing.join(', ')}`);
        break;
      }
      apply(best);
    }
  }

  // 3. 覆盖率达标：贪心补齐
  while (coverageOf() < minCoverage) {
    const best = pickBest(candidates, selected, (c) => (c.coverageItems ?? []).filter((i) => universe.coverageItems.includes(i) && !coveredCov.has(i)).length);
    if (!best) {
      reasons.push(`覆盖率无法达到 ${(minCoverage * 100).toFixed(0)}%：候选用例覆盖项不足（当前 ${(coverageOf() * 100).toFixed(1)}%）`);
      break;
    }
    apply(best);
  }

  const selectedList = [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
  const totalCost = round6(selectedList.reduce((s, c) => s + c.cost, 0));
  const coverage = round4(coverageOf());
  const riskCoverage = round4(riskCoverageOf());
  const p0Coverage = p0Cases.length === 0 ? 1 : round4(selectedList.filter((c) => (c.priority ?? '').toUpperCase() === 'P0').length / p0Cases.length);

  const feasible =
    coverage >= minCoverage &&
    (!requireFullRisk || riskCoverage >= 1) &&
    (!requireFullP0 || p0Coverage >= 1);
  if (feasible) {
    reasons.push(`满足约束：Coverage ${(coverage * 100).toFixed(1)}% ≥ ${(minCoverage * 100).toFixed(0)}%，Risk ${(riskCoverage * 100).toFixed(0)}%，P0 ${(p0Coverage * 100).toFixed(0)}%`);
  }

  return {
    selected: selectedList,
    selectedIds: selectedList.map((c) => c.id),
    totalCost,
    coverage,
    riskCoverage,
    p0Coverage,
    feasible,
    reasons,
  };
}

/** 性价比选择：新覆盖数 / 成本最大者；同分按 id 字典序 */
function pickBest(
  candidates: CostAwareCase[],
  selected: Map<string, CostAwareCase>,
  gainOf: (c: CostAwareCase) => number,
): CostAwareCase | null {
  let best: CostAwareCase | null = null;
  let bestRatio = -1;
  for (const c of candidates) {
    if (selected.has(c.id)) continue;
    const gain = gainOf(c);
    if (gain <= 0) continue;
    const ratio = gain / Math.max(c.cost, EPS);
    if (ratio > bestRatio || (ratio === bestRatio && best !== null && c.id.localeCompare(best.id) < 0)) {
      best = c;
      bestRatio = ratio;
    }
  }
  return best;
}

/** 选择结果摘要（供报告） */
export function summarizeSuiteSelection(selection: SuiteSelection, candidateCount: number): string {
  const saved = selection.feasible ? `，相比全量执行（${candidateCount} 条）精简为 ${selection.selected.length} 条` : '（约束不可满足）';
  return `最小成本集合：${selection.selected.length}/${candidateCount} 条，总成本 ${selection.totalCost}${saved}；` +
    `Coverage ${(selection.coverage * 100).toFixed(1)}% / Risk ${(selection.riskCoverage * 100).toFixed(0)}% / P0 ${(selection.p0Coverage * 100).toFixed(0)}%`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
