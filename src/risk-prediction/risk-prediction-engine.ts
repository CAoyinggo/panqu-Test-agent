// Risk Prediction Engine：确定性统计风险预测（Phase 22.3）
// 因子：历史频率(0.3) + 时间衰减(0.3) + 趋势(0.15) + 变更信号(0.15) + 失败聚集(0.1)。
// 不引入 ML 平台，全部可复现。

import { clamp01, levelOf, CHANGE_TYPE_BASE_RISK } from '../intelligence/index.js';
import type {
  ChangeSignal,
  ExecutionSample,
  PredictedCaseRisk,
  PredictedDimensionRisk,
  PredictionConfig,
} from './risk-prediction-schema.js';

export const FAILURE_PREDICTION_WEIGHTS = {
  historical: 0.3,
  recencyWeighted: 0.3,
  trend: 0.15,
  change: 0.15,
  clustering: 0.1,
} as const;

/** 失败样本统计 */
export interface FailureStats {
  total: number;
  failures: number;
  overallRate: number;
  recentRate: number;
  olderRate: number;
  consecutiveFailures: number;
  rate: number;
  /** 时间衰减加权失败率 */
  recencyWeighted: number;
  /** 最近窗口大小 */
  recentWindow: number;
  /** 趋势（最近窗口 - 更早窗口，恶化为正） */
  trend: number;
}

/**
 * 统计样本：历史频率、时间衰减加权、最近/更早窗口趋势、连续失败聚集。
 * samples 为空时全部因子为 0。
 */
export function computeFailureStats(
  samples: ExecutionSample[],
  config: Required<Pick<PredictionConfig, 'recentWindow' | 'decayPerDay'>>,
  now: number,
): FailureStats {
  if (samples.length === 0) {
    return { total: 0, failures: 0, overallRate: 0, recentRate: 0, olderRate: 0, consecutiveFailures: 0, rate: 0, recencyWeighted: 0, recentWindow: config.recentWindow, trend: 0 };
  }
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  const total = sorted.length;
  const failures = sorted.filter((s) => !s.passed).length;
  const overallRate = failures / total;

  // 时间衰减加权失败率：w = decay^ageDays
  let weightSum = 0;
  let failWeightSum = 0;
  for (const s of sorted) {
    const ageMs = now - new Date(s.at).getTime();
    const ageDays = Math.max(0, ageMs / 86400000);
    const w = Math.pow(config.decayPerDay, ageDays);
    weightSum += w;
    if (!s.passed) failWeightSum += w;
  }
  const recencyWeighted = weightSum > 0 ? failWeightSum / weightSum : 0;

  // 趋势：最近窗口 vs 更早窗口
  const recent = sorted.slice(-config.recentWindow);
  const older = sorted.slice(0, Math.max(0, sorted.length - config.recentWindow));
  const recentRate = recent.length > 0 ? recent.filter((s) => !s.passed).length / recent.length : 0;
  const olderRate = older.length > 0 ? older.filter((s) => !s.passed).length / older.length : 0;
  // 恶化为正（trend factor），改善为 0
  const rate = Math.max(0, recentRate - olderRate);

  // 失败聚集：末尾连续失败数
  let consecutiveFailures = 0;
  for (let i = sorted.length - 1; i >= 0 && !sorted[i].passed; i -= 1) consecutiveFailures += 1;

  return {
    total,
    failures,
    overallRate,
    recentRate,
    olderRate,
    consecutiveFailures,
    rate,
    recencyWeighted,
    recentWindow: config.recentWindow,
    trend: rate,
  };
}

/** 计算用例失败概率（确定性） */
export function predictCaseFailure(
  samples: ExecutionSample[],
  options: {
    caseId: string;
    changeImpact?: number;
    changes?: ChangeSignal[];
    config?: PredictionConfig;
    now?: string | number;
  },
): PredictedCaseRisk {
  const now = options.now === undefined ? Date.now() : typeof options.now === 'number' ? options.now : new Date(options.now).getTime();
  const recentWindow = options.config?.recentWindow ?? 5;
  const decayPerDay = options.config?.decayPerDay ?? 0.95;
  const reference = options.config?.referenceSamples ?? 30;

  const stats = computeFailureStats(samples, { recentWindow, decayPerDay }, now);
  const changeImpact = clamp01(options.changeImpact);

  const factors = {
    historical: stats.overallRate,
    recencyWeighted: stats.recencyWeighted,
    trend: clamp01(stats.rate),
    change: changeImpact,
    clustering: Math.min(1, stats.consecutiveFailures / 3),
  };

  const probability =
    factors.historical * FAILURE_PREDICTION_WEIGHTS.historical +
    factors.recencyWeighted * FAILURE_PREDICTION_WEIGHTS.recencyWeighted +
    factors.trend * FAILURE_PREDICTION_WEIGHTS.trend +
    factors.change * FAILURE_PREDICTION_WEIGHTS.change +
    factors.clustering * FAILURE_PREDICTION_WEIGHTS.clustering;

  // 证据（可解释）
  const evidence: string[] = [];
  if (stats.total > 0) evidence.push(`过去 ${stats.total} 次失败 ${stats.failures} 次（${(stats.overallRate * 100).toFixed(0)}%）`);
  if (stats.recentWindow > 0 && stats.recentRate > 0) {
    evidence.push(`最近 ${stats.recentWindow} 次失败 ${Math.round(stats.recentRate * stats.recentWindow)} 次`);
  }
  if (stats.consecutiveFailures > 0) evidence.push(`连续失败 ${stats.consecutiveFailures} 次`);
  if (factors.trend > 0) evidence.push(`失败趋势恶化 ${(factors.trend * 100).toFixed(0)}%`);
  if (changeImpact > 0) evidence.push(`关联变更影响 ${(changeImpact * 100).toFixed(0)}%`);

  // 置信度：样本量 + 证据数
  const dataStrength = Math.min(1, stats.total / reference);
  const confidence = Math.round(Math.min(0.95, 0.25 + dataStrength * 0.5 + evidence.length * 0.04) * 100) / 100;

  return {
    caseId: options.caseId,
    failureProbability: Math.round(clamp01(probability) * 10000) / 10000,
    riskLevel: levelOf(clamp01(probability)),
    confidence,
    evidence,
    factors,
  };
}

/**
 * 聚合维度风险（Feature / Model / Environment）：
 * riskScore = 各用例失败概率加权平均（权重 = 置信度，数据越足越可信）。
 */
export function predictDimensionRisk(
  key: string,
  cases: Array<{ caseId: string; failureProbability: number; confidence: number }>,
): PredictedDimensionRisk {
  if (cases.length === 0) {
    return { key, riskScore: 0, riskLevel: 'LOW', confidence: 0, caseCount: 0, evidence: ['无历史数据'] };
  }
  let weighted = 0;
  let weightSum = 0;
  for (const c of cases) {
    const w = 0.3 + c.confidence * 0.7;
    weighted += c.failureProbability * w;
    weightSum += w;
  }
  const riskScore = clamp01(weighted / weightSum);
  const confidence = Math.round(Math.min(0.95, 0.3 + cases.length * 0.1) * 100) / 100;
  const highCount = cases.filter((c) => levelOf(c.failureProbability) === 'HIGH').length;
  const evidence: string[] = [`覆盖 ${cases.length} 个用例`];
  if (highCount > 0) evidence.push(`${highCount} 个用例为高风险`);
  return {
    key,
    riskScore: Math.round(riskScore * 10000) / 10000,
    riskLevel: levelOf(riskScore),
    confidence,
    caseCount: cases.length,
    evidence,
  };
}

export { CHANGE_TYPE_BASE_RISK };
