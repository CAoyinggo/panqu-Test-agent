// Failure Prediction Engine：确定性失败预测（Phase 22.5）
// 七因子加权：历史(0.3) + 变更(0.2) + 模型(0.1) + 环境(0.1) + 风险(0.1) + Flaky(0.1) + 缺陷(0.1)。
// 预测类别：PASS / FAIL / FLAKY / ENV。高概率用例提前优先执行。
// 全部可复现、可解释。

import { clamp01 } from '../intelligence/index.js';
import { computeFailureStats } from '../risk-prediction/index.js';
import type {
  FailurePrediction,
  FailurePredictionConfig,
  FailurePredictionInput,
} from './failure-prediction-schema.js';
import { FAILURE_PREDICTION_CONFIG_DEFAULTS } from './failure-prediction-schema.js';

/** 七因子权重（合计 1.0） */
export const FAILURE_PREDICTOR_WEIGHTS = {
  historical: 0.3,
  change: 0.2,
  model: 0.1,
  environment: 0.1,
  risk: 0.1,
  flaky: 0.1,
  defect: 0.1,
} as const;

/** 计算单个用例失败预测 */
export function predictFailure(
  input: FailurePredictionInput,
  config: FailurePredictionConfig = {},
  now: number = Date.now(),
): FailurePrediction {
  const cfg = { ...FAILURE_PREDICTION_CONFIG_DEFAULTS, ...config };
  const history = (input.historicalSamples ?? []).map((s) => ({ caseId: input.caseId, passed: s.passed, at: s.at }));
  const historicalRate = computeFailureStats(history, { recentWindow: 5, decayPerDay: 0.95 }, now).overallRate;

  const change = clamp01(input.changeImpact);
  const model = clamp01(input.modelRisk);
  const environment = clamp01(input.environmentRisk);
  const risk = clamp01(input.riskScore);
  const flaky = clamp01(input.flakyRate);
  const defect = clamp01(input.defectDensity);

  // 当前版本未执行 → 未知风险补贴（10%），确定性可复现
  const unexecuted = input.executedOnCurrentVersion === false ? 0.1 : 0;

  const probability =
    historicalRate * FAILURE_PREDICTOR_WEIGHTS.historical +
    change * FAILURE_PREDICTOR_WEIGHTS.change +
    model * FAILURE_PREDICTOR_WEIGHTS.model +
    environment * FAILURE_PREDICTOR_WEIGHTS.environment +
    risk * FAILURE_PREDICTOR_WEIGHTS.risk +
    flaky * FAILURE_PREDICTOR_WEIGHTS.flaky +
    defect * FAILURE_PREDICTOR_WEIGHTS.defect +
    unexecuted * 0.05;

  // 可解释证据
  const evidence: string[] = [];
  if (input.historicalSamples && input.historicalSamples.length > 0) {
    const fails = input.historicalSamples.filter((s) => !s.passed).length;
    evidence.push(`历史 ${input.historicalSamples.length} 次失败 ${fails} 次（${(historicalRate * 100).toFixed(0)}%）`);
  }
  if (change > 0) evidence.push(`变更影响 ${(change * 100).toFixed(0)}%`);
  if (model > 0) evidence.push(`模型风险 ${(model * 100).toFixed(0)}%`);
  if (environment > 0) evidence.push(`环境风险 ${(environment * 100).toFixed(0)}%`);
  if (risk > 0) evidence.push(`既有风险分 ${(risk * 100).toFixed(0)}%`);
  if (flaky > 0) evidence.push(`Flaky 率 ${(flaky * 100).toFixed(0)}%`);
  if (defect > 0) evidence.push(`缺陷密度 ${(defect * 100).toFixed(0)}%`);
  if (unexecuted > 0) evidence.push('当前版本尚未执行');

  // 置信度：样本量 + 证据数
  const sampleCount = input.historicalSamples?.length ?? 0;
  const dataStrength = Math.min(1, sampleCount / cfg.referenceSamples);
  const confidence = Math.round(Math.min(0.95, 0.2 + dataStrength * 0.5 + evidence.length * 0.04) * 100) / 100;

  const failureProbability = Math.round(clamp01(probability) * 10000) / 10000;

  // 类别判定（确定性顺序：Flaky 优先于 ENV）
  let predictedCategory: FailurePrediction['predictedCategory'] = 'PASS';
  if (failureProbability >= cfg.highRiskThreshold) {
    if (flaky >= cfg.flakyThreshold) predictedCategory = 'FLAKY';
    else if (environment >= cfg.environmentThreshold) predictedCategory = 'ENV';
    else predictedCategory = 'FAIL';
  }

  return {
    caseId: input.caseId,
    failureProbability,
    predictedCategory,
    confidence,
    evidence,
    factors: { historical: historicalRate, change, model, environment, risk, flaky, defect },
    suggestedOrder: 0,
  };
}

/** 批量预测：按失败概率降序（高概率提前），概率相同按 caseId 字典序 */
export function predictFailureBatch(
  inputs: FailurePredictionInput[],
  config: FailurePredictionConfig = {},
  now?: number,
): FailurePrediction[] {
  const predictions = inputs.map((i) => predictFailure(i, config, now));
  predictions.sort((a, b) => {
    if (b.failureProbability !== a.failureProbability) return b.failureProbability - a.failureProbability;
    return a.caseId.localeCompare(b.caseId);
  });
  predictions.forEach((p, idx) => {
    p.suggestedOrder = idx + 1;
  });
  return predictions;
}
