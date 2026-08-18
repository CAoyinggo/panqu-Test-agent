// Failure Intelligence：用例失败风险评分（Phase 22.1）
// 基于历史失败率 + 最近失败 + 变更影响 + Flaky 比例 + 缺陷密度，预测失败概率。

import { clamp01, levelOf } from './intelligence-score.js';

/** 失败风险输入 */
export interface FailureRiskInput {
  caseId: string;
  /** 历史失败率 0~1 */
  historicalFailureRate?: number;
  /** 最近失败次数 */
  recentFailures?: number;
  /** 最近运行次数 */
  recentRuns?: number;
  /** 变更影响 0~1 */
  changeImpact?: number;
  /** Flaky 比例 0~1 */
  flakyRate?: number;
  /** 缺陷密度 0~1 */
  defectDensity?: number;
}

/** 失败风险结果 */
export interface FailureRisk {
  caseId: string;
  failureProbability: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  evidence: string[];
}

/** 特征权重（合计 1.0） */
export const FAILURE_RISK_WEIGHTS = {
  historicalFailureRate: 0.4,
  recentFailure: 0.25,
  changeImpact: 0.2,
  flakyRate: 0.15,
} as const;

/**
 * 计算失败概率（确定性）：
 *   failureProbability = 0.4×historical + 0.25×recent + 0.2×change + 0.15×flaky
 *   confidence 由数据量与证据数决定（数据越足置信度越高，上限 0.95）
 */
export function computeFailureRisk(input: FailureRiskInput): FailureRisk {
  const historical = clamp01(input.historicalFailureRate);
  const changeImpact = clamp01(input.changeImpact);
  const flakyRate = clamp01(input.flakyRate);
  const defectDensity = clamp01(input.defectDensity);

  const recentRuns = Math.max(0, Math.floor(input.recentRuns ?? 0));
  const recentFailures = Math.max(0, Math.floor(input.recentFailures ?? 0));
  const recentRate = recentRuns > 0 ? clamp01(recentFailures / recentRuns) : 0;

  const probability =
    historical * FAILURE_RISK_WEIGHTS.historicalFailureRate +
    recentRate * FAILURE_RISK_WEIGHTS.recentFailure +
    changeImpact * FAILURE_RISK_WEIGHTS.changeImpact +
    flakyRate * FAILURE_RISK_WEIGHTS.flakyRate;

  // 证据与置信度
  const evidence: string[] = [];
  if (historical > 0) evidence.push(`历史失败率 ${(historical * 100).toFixed(0)}%`);
  if (recentRuns > 0) evidence.push(`最近 ${recentRuns} 次失败 ${recentFailures} 次`);
  if (changeImpact > 0) evidence.push(`变更影响 ${(changeImpact * 100).toFixed(0)}%`);
  if (flakyRate > 0) evidence.push(`Flaky 比例 ${(flakyRate * 100).toFixed(0)}%`);
  if (defectDensity > 0) evidence.push(`关联缺陷密度 ${(defectDensity * 100).toFixed(0)}%`);

  const dataStrength = Math.min(1, (recentRuns + (historical > 0 ? 5 : 0)) / 30);
  const confidence = Math.round(Math.min(0.95, 0.3 + evidence.length * 0.08 + dataStrength * 0.3) * 100) / 100;

  return {
    caseId: input.caseId,
    failureProbability: Math.round(clamp01(probability) * 10000) / 10000,
    riskLevel: levelOf(clamp01(probability)),
    confidence,
    evidence,
  };
}
