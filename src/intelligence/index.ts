// Intelligence 模块统一导出（Phase 22.1 Test Intelligence）
export {
  clamp01,
  normalizeRange,
  logNormalize,
  levelOf,
  toHundred,
  coverageValueOf,
  computeTestValue,
  DEFAULT_TEST_VALUE_WEIGHTS,
  type IntelligenceLevel,
  type TestValueWeights,
} from './intelligence-score.js';

export {
  computeCaseIntelligence,
  type CaseIntelligenceInput,
  type CaseIntelligence,
} from './case-intelligence.js';

export {
  computeFeatureRisk,
  FEATURE_RISK_WEIGHTS,
  type FeatureRiskInput,
  type FeatureRisk,
} from './feature-risk.js';

export {
  computeFailureRisk,
  FAILURE_RISK_WEIGHTS,
  type FailureRiskInput,
  type FailureRisk,
} from './failure-intelligence.js';

export {
  computeChangeRisk,
  CHANGE_TYPE_BASE_RISK,
  type ChangeRiskInput,
  type ChangeRisk,
} from './change-intelligence.js';
