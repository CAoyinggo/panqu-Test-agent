// Adaptive Prioritization Schema：动态测试优先级模型（Phase 22.2）
// 数字 score + reasons + 动态 P0-P3 升降级，确定性评分。

import { clamp01 } from '../intelligence/index.js';

/** 动态优先级 */
export type DynamicPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** 优先级评分输入（各维度 0~1） */
export interface PriorityInput {
  caseId: string;
  /** 基础优先级（现有静态优先级） */
  basePriority?: DynamicPriority;
  /** 风险评分 */
  risk?: number;
  /** 变更影响 */
  changeImpact?: number;
  /** 历史失败率 */
  historicalFailure?: number;
  /** 最近失败信号（最近失败次数/最近运行次数） */
  recentFailure?: number;
  /** 覆盖缺口（1 - coverage） */
  coverageGap?: number;
  /** 缺陷密度 */
  defectDensity?: number;
  /** Flaky 比例（flaky 作为惩罚项） */
  flakyRate?: number;
  /** 执行成本（惩罚项） */
  executionCost?: number;
  /** 业务关键度 */
  businessCriticality?: number;
}

/** 优先级评分结果 */
export interface PriorityScore {
  caseId: string;
  score: number;
  priority: DynamicPriority;
  /** 与基础优先级相比的升降（up / down / same / promoted-to-p0） */
  adjustment: 'up' | 'down' | 'same' | 'promoted-to-p0';
  reasons: string[];
}

/** 优先级评分权重（正项合计 1.0；负项独立惩罚） */
export const PRIORITY_WEIGHTS = {
  risk: 0.2,
  changeImpact: 0.15,
  historicalFailure: 0.15,
  recentFailure: 0.15,
  coverageGap: 0.15,
  defectDensity: 0.1,
  businessCriticality: 0.1,
} as const;

export const PRIORITY_PENALTIES = {
  flakyRate: 0.3,
  executionCost: 0.2,
} as const;

/** 基础优先级 → 分数基线 */
const BASE_PRIORITY_SCORE: Record<DynamicPriority, number> = { P0: 0.85, P1: 0.65, P2: 0.45, P3: 0.25 };

/**
 * 计算动态优先级评分（确定性）：
 *   score = base + Σ(正项×权重) - flakyRate×0.3 - executionCost×0.2
 * 阈值：≥0.8 → P0，≥0.6 → P1，≥0.4 → P2，否则 P3。
 * 返回评分 + reasons（仅记录产生影响的维度）。
 */
export function computePriorityScore(input: PriorityInput): PriorityScore {
  const base = BASE_PRIORITY_SCORE[input.basePriority ?? 'P2'];
  const d = {
    risk: clamp01(input.risk),
    changeImpact: clamp01(input.changeImpact),
    historicalFailure: clamp01(input.historicalFailure),
    recentFailure: clamp01(input.recentFailure),
    coverageGap: clamp01(input.coverageGap),
    defectDensity: clamp01(input.defectDensity),
    businessCriticality: clamp01(input.businessCriticality),
    flakyRate: clamp01(input.flakyRate),
    executionCost: clamp01(input.executionCost),
  };

  const positive =
    d.risk * PRIORITY_WEIGHTS.risk +
    d.changeImpact * PRIORITY_WEIGHTS.changeImpact +
    d.historicalFailure * PRIORITY_WEIGHTS.historicalFailure +
    d.recentFailure * PRIORITY_WEIGHTS.recentFailure +
    d.coverageGap * PRIORITY_WEIGHTS.coverageGap +
    d.defectDensity * PRIORITY_WEIGHTS.defectDensity +
    d.businessCriticality * PRIORITY_WEIGHTS.businessCriticality;
  const penalties = d.flakyRate * PRIORITY_PENALTIES.flakyRate + d.executionCost * PRIORITY_PENALTIES.executionCost;

  const raw = base + positive - penalties;
  const score = Math.round(clamp01(raw) * 10000) / 10000;

  const priority: DynamicPriority = score >= 0.8 ? 'P0' : score >= 0.6 ? 'P1' : score >= 0.4 ? 'P2' : 'P3';

  // 理由（仅记录显著信号）
  const reasons: string[] = [];
  if (d.risk >= 0.5) reasons.push(`风险评分 ${d.risk}`);
  if (d.changeImpact >= 0.4) reasons.push(`变更影响 ${d.changeImpact}`);
  if (d.historicalFailure >= 0.3) reasons.push(`历史失败率 ${(d.historicalFailure * 100).toFixed(0)}%`);
  if (d.recentFailure >= 0.3) reasons.push(`最近失败率 ${(d.recentFailure * 100).toFixed(0)}%`);
  if (d.coverageGap >= 0.2) reasons.push(`覆盖缺口 ${(d.coverageGap * 100).toFixed(0)}%`);
  if (d.defectDensity >= 0.3) reasons.push(`缺陷密度 ${d.defectDensity}`);
  if (d.businessCriticality >= 0.6) reasons.push(`业务关键度 ${d.businessCriticality}`);
  if (d.flakyRate >= 0.5) reasons.push(`Flaky 比例 ${(d.flakyRate * 100).toFixed(0)}%（降低优先级）`);
  if (d.executionCost >= 0.7) reasons.push(`执行成本高 ${d.executionCost}（降低优先级）`);

  const basePriority = input.basePriority ?? 'P2';
  const order: Record<DynamicPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const adjustment: PriorityScore['adjustment'] =
    priority === 'P0' && basePriority !== 'P0' ? 'promoted-to-p0'
      : order[priority] < order[basePriority] ? 'up'
      : order[priority] > order[basePriority] ? 'down'
      : 'same';

  return { caseId: input.caseId, score, priority, adjustment, reasons };
}

/**
 * 对一批用例统一评分并重排（动态优先级排序）。
 * 返回按 score 降序的 PriorityScore 列表（同分按 caseId 字典序）。
 */
export function prioritizeCases(inputs: PriorityInput[]): PriorityScore[] {
  return inputs
    .map(computePriorityScore)
    .sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId));
}
