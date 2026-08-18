// Failure Prediction Schema：失败预测数据模型（Phase 22.5）
// 在执行之前预测哪些 Case 最容易失败，高概率用例提前优先执行。
// 输入：历史失败 / Change Impact / Model / Environment / Risk / Flaky / Defect。
// 全部为确定性统计，不引入 LLM / ML 平台。

/** 失败预测输入维度（全部可选，缺失按 0 处理） */
export interface FailurePredictionInput {
  caseId: string;
  /** 历史执行样本（复用 Risk Prediction 统计因子） */
  historicalSamples?: Array<{ passed: boolean; at: string }>;
  /** 变更影响 0~1 */
  changeImpact?: number;
  /** 关联模型风险 0~1 */
  modelRisk?: number;
  /** 环境风险 0~1 */
  environmentRisk?: number;
  /** 既有风险分（Risk Agent / Intelligence）0~1 */
  riskScore?: number;
  /** Flaky 率 0~1 */
  flakyRate?: number;
  /** 缺陷密度 0~1 */
  defectDensity?: number;
  /** 是否已在当前版本执行过（未执行视为未知 → 提高预测概率） */
  executedOnCurrentVersion?: boolean;
}

/** 预测失败类别 */
export type PredictedFailureCategory = 'PASS' | 'FAIL' | 'FLAKY' | 'ENV';

/** 单个用例失败预测结果 */
export interface FailurePrediction {
  caseId: string;
  failureProbability: number;
  predictedCategory: PredictedFailureCategory;
  confidence: number;
  /** 可解释证据 */
  evidence: string[];
  /** 各因子分解 */
  factors: {
    historical: number;
    change: number;
    model: number;
    environment: number;
    risk: number;
    flaky: number;
    defect: number;
  };
  /** 建议执行顺序（概率越高越靠前，1 起） */
  suggestedOrder: number;
}

/** 失败预测配置 */
export interface FailurePredictionConfig {
  /** 高失败风险阈值（概率 ≥ 该值视为 FAIL，默认 0.5） */
  highRiskThreshold?: number;
  /** Flaky 判定阈值（默认 0.4） */
  flakyThreshold?: number;
  /** 环境判定阈值（默认 0.5） */
  environmentThreshold?: number;
  /** 参考样本量（置信度饱和线，默认 30） */
  referenceSamples?: number;
}

export const FAILURE_PREDICTION_CONFIG_DEFAULTS: Required<FailurePredictionConfig> = {
  highRiskThreshold: 0.5,
  flakyThreshold: 0.4,
  environmentThreshold: 0.5,
  referenceSamples: 30,
};
