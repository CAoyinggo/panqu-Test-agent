// Failure Prediction 模块统一导出（Phase 22.5）
export {
  type FailurePredictionInput,
  type PredictedFailureCategory,
  type FailurePrediction,
  type FailurePredictionConfig,
  FAILURE_PREDICTION_CONFIG_DEFAULTS,
} from './failure-prediction-schema.js';

export {
  predictFailure,
  predictFailureBatch,
  FAILURE_PREDICTOR_WEIGHTS,
} from './failure-prediction-engine.js';
