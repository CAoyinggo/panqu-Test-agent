// Change Intelligence：变更风险评分（Phase 22.1）
// 基于变更类型高危度 + 影响范围 + 受影响范围历史失败率，评估单次变更的风险。

import { clamp01, levelOf, logNormalize } from './intelligence-score.js';

/** 变更类型高危加成（0~1） */
export const CHANGE_TYPE_BASE_RISK: Record<string, number> = {
  pricing: 0.25,
  model: 0.2,
  code: 0.15,
  api: 0.1,
  config: 0.1,
  environment: 0.1,
  requirement: 0.05,
};

/** 变更风险输入 */
export interface ChangeRiskInput {
  changeType: string;
  /** 受影响用例数 */
  affectedCases?: number;
  /** 受影响能力数 */
  affectedCapabilities?: number;
  /** 受影响业务数 */
  affectedBusinesses?: number;
  /** 受影响范围平均历史失败率 0~1 */
  historicalFailureRate?: number;
  /** 参考规模（用于对数归一化，默认 50） */
  maxScale?: number;
}

/** 变更风险结果 */
export interface ChangeRisk {
  riskScore: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  dimensions: Record<string, number>;
  reasons: string[];
}

/** 计算变更风险（确定性） */
export function computeChangeRisk(input: ChangeRiskInput): ChangeRisk {
  const maxScale = Math.max(1, input.maxScale ?? 50);
  const typeBase = CHANGE_TYPE_BASE_RISK[input.changeType] ?? 0.05;
  const caseScale = logNormalize(input.affectedCases ?? 0, maxScale);
  const capabilityScale = logNormalize(input.affectedCapabilities ?? 0, 10);
  const businessScale = logNormalize(input.affectedBusinesses ?? 0, 5);
  const histFailure = clamp01(input.historicalFailureRate);

  const score =
    typeBase * 0.4 +
    caseScale * 0.25 +
    capabilityScale * 0.15 +
    businessScale * 0.1 +
    histFailure * 0.1;

  const reasons: string[] = [];
  if (typeBase >= 0.15) reasons.push(`高风险变更类型 ${input.changeType}（基础 ${typeBase}）`);
  if (caseScale >= 0.3) reasons.push(`影响 ${input.affectedCases ?? 0} 个用例`);
  if (capabilityScale >= 0.5) reasons.push(`影响 ${input.affectedCapabilities ?? 0} 项能力`);
  if (businessScale >= 0.6) reasons.push(`影响 ${input.affectedBusinesses ?? 0} 个业务`);
  if (histFailure >= 0.3) reasons.push(`受影响范围历史失败率 ${(histFailure * 100).toFixed(0)}%`);

  return {
    riskScore: Math.round(score * 10000) / 10000,
    level: levelOf(score),
    dimensions: { typeBase, caseScale, capabilityScale, businessScale, historicalFailureRate: histFailure },
    reasons,
  };
}
