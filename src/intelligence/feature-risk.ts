// Feature Risk：功能级风险评分（Phase 22.1）
// 聚合：用例平均风险 + 最大风险 + 变更影响 + 历史失败率 + 缺陷密度 + 覆盖缺口 + 最近失败趋势

import { clamp01, levelOf } from './intelligence-score.js';

/** 功能风险输入（各维度 0~1） */
export interface FeatureRiskInput {
  feature: string;
  /** 用例平均风险 */
  avgCaseRisk?: number;
  /** 用例最大风险 */
  maxCaseRisk?: number;
  /** 变更影响 */
  changeImpact?: number;
  /** 历史失败率 */
  historicalFailureRate?: number;
  /** 缺陷密度 */
  defectDensity?: number;
  /** 覆盖缺口 = 1 - coverage */
  coverageGap?: number;
  /** 最近失败趋势（最近失败次数/最近运行次数，越高越危险） */
  recentFailureTrend?: number;
}

/** 功能风险结果 */
export interface FeatureRisk {
  feature: string;
  riskScore: number;
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  dimensions: Record<string, number>;
  reasons: string[];
}

/** 特征权重（合计 1.0） */
export const FEATURE_RISK_WEIGHTS = {
  avgCaseRisk: 0.35,
  maxCaseRisk: 0.2,
  changeImpact: 0.15,
  historicalFailureRate: 0.15,
  defectDensity: 0.1,
  coverageGap: 0.05,
} as const;

/** 计算功能风险（确定性） */
export function computeFeatureRisk(input: FeatureRiskInput): FeatureRisk {
  const d = {
    avgCaseRisk: clamp01(input.avgCaseRisk),
    maxCaseRisk: clamp01(input.maxCaseRisk),
    changeImpact: clamp01(input.changeImpact),
    historicalFailureRate: clamp01(input.historicalFailureRate),
    defectDensity: clamp01(input.defectDensity),
    coverageGap: clamp01(input.coverageGap),
    recentFailureTrend: clamp01(input.recentFailureTrend),
  };
  // 无历史趋势时用历史失败率兜底
  const histTrend = d.historicalFailureRate > 0 ? d.historicalFailureRate : d.recentFailureTrend;
  const score =
    d.avgCaseRisk * FEATURE_RISK_WEIGHTS.avgCaseRisk +
    d.maxCaseRisk * FEATURE_RISK_WEIGHTS.maxCaseRisk +
    d.changeImpact * FEATURE_RISK_WEIGHTS.changeImpact +
    d.historicalFailureRate * FEATURE_RISK_WEIGHTS.historicalFailureRate +
    d.defectDensity * FEATURE_RISK_WEIGHTS.defectDensity +
    d.coverageGap * FEATURE_RISK_WEIGHTS.coverageGap;

  const reasons: string[] = [];
  if (d.avgCaseRisk >= 0.6) reasons.push('用例平均风险高');
  if (d.maxCaseRisk >= 0.6) reasons.push(`存在高风险用例（风险 ${d.maxCaseRisk}）`);
  if (d.changeImpact >= 0.5) reasons.push('受变更影响较大');
  if (d.historicalFailureRate >= 0.3) reasons.push(`历史失败率 ${(d.historicalFailureRate * 100).toFixed(0)}%`);
  if (d.defectDensity >= 0.3) reasons.push('缺陷密度偏高');
  if (d.coverageGap >= 0.2) reasons.push(`覆盖缺口 ${(d.coverageGap * 100).toFixed(0)}%`);
  if (histTrend >= 0.3) reasons.push(`最近失败趋势 ${(histTrend * 100).toFixed(0)}%`);

  return {
    feature: input.feature,
    riskScore: Math.round(score * 10000) / 10000,
    level: levelOf(score),
    dimensions: d,
    reasons,
  };
}
