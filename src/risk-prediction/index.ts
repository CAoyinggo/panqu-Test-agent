// Risk Prediction 模块统一导出（Phase 22.3）
export {
  type ExecutionSample,
  type ChangeSignal,
  type PredictedRiskLevel,
  type PredictedCaseRisk,
  type PredictedDimensionRisk,
  type PredictionConfig,
} from './risk-prediction-schema.js';

export {
  predictCaseFailure,
  predictDimensionRisk,
  computeFailureStats,
  FAILURE_PREDICTION_WEIGHTS,
  type FailureStats,
  CHANGE_TYPE_BASE_RISK,
} from './risk-prediction-engine.js';
