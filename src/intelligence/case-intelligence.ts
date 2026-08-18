// Case Intelligence：单用例综合智能评分（Phase 22.1）
// 输入九维确定性指标，输出 CaseIntelligence（含 testValue）。

import {
  clamp01,
  computeTestValue,
  levelOf,
  type TestValueWeights,
  DEFAULT_TEST_VALUE_WEIGHTS,
} from './intelligence-score.js';

/** 用例级智能输入（各维度 0~1） */
export interface CaseIntelligenceInput {
  caseId: string;
  /** 风险评分（来自 Risk Agent / 特征） */
  riskScore?: number;
  /** 变更影响（该用例受变更影响程度） */
  changeImpact?: number;
  /** 历史失败率 */
  historicalFailureRate?: number;
  /** Flaky 占比（flaky 次数/运行次数） */
  flakyRate?: number;
  /** 缺陷密度（关联缺陷数归一） */
  defectDensity?: number;
  /** 覆盖率价值（未覆盖缺口越大越高） */
  coverageValue?: number;
  /** 执行成本归一（越高越贵） */
  executionCost?: number;
  /** 业务关键度（越高越关键） */
  businessCriticality?: number;
}

/** 用例智能结果 */
export interface CaseIntelligence {
  caseId: string;
  riskScore: number;
  changeImpact: number;
  historicalFailureRate: number;
  flakyRate: number;
  defectDensity: number;
  coverageValue: number;
  executionCost: number;
  businessCriticality: number;
  /** 各维度归一值（含 flakyPenalty） */
  dimensions: Record<string, number>;
  /** TestValue 原始值 */
  testValue: number;
  /** TestValue 归一 0~1 */
  testValueNormalized: number;
  level: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** 计算单用例智能评分（确定性，无 LLM） */
export function computeCaseIntelligence(
  input: CaseIntelligenceInput,
  weights: TestValueWeights = DEFAULT_TEST_VALUE_WEIGHTS,
): CaseIntelligence {
  const metrics = {
    risk: clamp01(input.riskScore),
    changeImpact: clamp01(input.changeImpact),
    historicalFailure: clamp01(input.historicalFailureRate),
    flakyRate: clamp01(input.flakyRate),
    defectDensity: clamp01(input.defectDensity),
    coverageValue: clamp01(input.coverageValue),
    executionCost: clamp01(input.executionCost),
    businessCriticality: clamp01(input.businessCriticality),
  };
  const { testValue, normalized } = computeTestValue(metrics, weights);
  return {
    caseId: input.caseId,
    riskScore: metrics.risk,
    changeImpact: metrics.changeImpact,
    historicalFailureRate: metrics.historicalFailure,
    flakyRate: metrics.flakyRate,
    defectDensity: metrics.defectDensity,
    coverageValue: metrics.coverageValue,
    executionCost: metrics.executionCost,
    businessCriticality: metrics.businessCriticality,
    dimensions: {
      risk: metrics.risk,
      changeImpact: metrics.changeImpact,
      historicalFailure: metrics.historicalFailure,
      flakyRate: metrics.flakyRate,
      defectDensity: metrics.defectDensity,
      coverageValue: metrics.coverageValue,
      executionCost: metrics.executionCost,
      businessCriticality: metrics.businessCriticality,
      flakyPenalty: Math.round(metrics.flakyRate * weights.flakyPenalty * 10000) / 10000,
    },
    testValue,
    testValueNormalized: normalized,
    level: levelOf(normalized),
  };
}
