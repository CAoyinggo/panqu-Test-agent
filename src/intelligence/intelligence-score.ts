// Intelligence Score：确定性评分工具（Phase 22.1）
// 统一归一化 / 等级判定 / TestValue 公式。Deterministic First：不用 LLM 计算基础指标。
// testValue = risk + changeImpact + historicalFailure + coverageValue + businessCriticality
//             - executionCost - flakyPenalty

/** 风险/价值等级 */
export type IntelligenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/** TestValue 正负项权重 */
export interface TestValueWeights {
  risk: number;
  changeImpact: number;
  historicalFailure: number;
  coverageValue: number;
  businessCriticality: number;
  executionCost: number;
  /** flakyPenalty = flakyRate × flakyPenalty */
  flakyPenalty: number;
}

export const DEFAULT_TEST_VALUE_WEIGHTS: TestValueWeights = {
  risk: 1,
  changeImpact: 1,
  historicalFailure: 1,
  coverageValue: 1,
  businessCriticality: 1,
  executionCost: 1,
  flakyPenalty: 0.5,
};

/** 截断到 0~1（接受可选数值，undefined/NaN 视为 0） */
export function clamp01(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 范围归一化：将 x 从 [min,max] 映射到 [0,1]（min===max 时返回 0.5） */
export function normalizeRange(x: number, min: number, max: number): number {
  if (!Number.isFinite(x) || min === max) return 0.5;
  return clamp01((x - min) / (max - min));
}

/** 对数归一化：log(x+1) / log(max+1)，用于规模类指标（用例数/缺陷数） */
export function logNormalize(x: number, max: number): number {
  if (x <= 0 || max <= 0) return 0;
  return clamp01(Math.log(x + 1) / Math.log(max + 1));
}

/** 等级判定：≥0.6 HIGH，≥0.3 MEDIUM，否则 LOW */
export function levelOf(score: number): IntelligenceLevel {
  if (score >= 0.6) return 'HIGH';
  if (score >= 0.3) return 'MEDIUM';
  return 'LOW';
}

/** 分数 → 0~100（报告展示） */
export function toHundred(score: number): number {
  return Math.round(clamp01(score) * 1000) / 10;
}

/**
 * 计算 TestValue：
 * testValue = Σ(正项) - executionCost - flakyRate×flakyPenalty
 * 各输入已假定为 0~1（由调用方归一）。返回原始值（可能为负）与归一化 0~1 值。
 */
export function computeTestValue(
  metrics: {
    risk: number;
    changeImpact: number;
    historicalFailure: number;
    coverageValue: number;
    businessCriticality: number;
    executionCost: number;
    flakyRate: number;
  },
  weights: TestValueWeights = DEFAULT_TEST_VALUE_WEIGHTS,
): { testValue: number; normalized: number } {
  const testValue =
    clamp01(metrics.risk) * weights.risk +
    clamp01(metrics.changeImpact) * weights.changeImpact +
    clamp01(metrics.historicalFailure) * weights.historicalFailure +
    clamp01(metrics.coverageValue) * weights.coverageValue +
    clamp01(metrics.businessCriticality) * weights.businessCriticality -
    clamp01(metrics.executionCost) * weights.executionCost -
    clamp01(metrics.flakyRate) * weights.flakyPenalty;
  // 归一化：把理论区间 [-(1+0.5), 5] 映射到 [0,1]
  const rawMax = weights.risk + weights.changeImpact + weights.historicalFailure + weights.coverageValue + weights.businessCriticality;
  const rawMin = -(weights.executionCost + weights.flakyPenalty);
  const normalized = rawMax === rawMin ? 0.5 : clamp01((testValue - rawMin) / (rawMax - rawMin));
  return { testValue: Math.round(testValue * 10000) / 10000, normalized: Math.round(normalized * 10000) / 10000 };
}

/** 覆盖率价值：未覆盖比例（覆盖缺口越大，价值越高） */
export function coverageValueOf(coverage: number): number {
  return clamp01(1 - coverage);
}
