// Regression 模块统一导出（Phase 21.3 Continuous Regression）
export {
  CHANGE_TYPES,
  REGRESSION_TRIGGER_TYPES,
  generateRunId,
  normalizeChangeEvent,
  type ChangeEvent,
  type ChangeType,
  type ImpactAnalysis,
  type RegressionPlan,
  type RegressionRun,
  type RegressionRunStatus,
  type RegressionTriggerType,
} from './regression-schema.js';
export { analyzeChangeImpact } from './impact-analyzer.js';
export {
  assetPriority,
  planRegression,
  summarizePlan,
  type RegressionPlanOptions,
} from './regression-planner.js';
export {
  RegressionHistory,
  createRegressionHistory,
} from './regression-history.js';
export {
  RegressionScheduler,
  createRegressionScheduler,
  type RegressionOutcome,
} from './regression-scheduler.js';
