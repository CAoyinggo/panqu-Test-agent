// Quality 模块统一导出（Phase 21.7 Quality Optimization）
export {
  QUALITY_WEIGHTS,
  computeTestQualityScore,
  gradeOf,
  generateQualityId,
  normalizeCreateQualityInput,
  type QualityMetricsInput,
  type QualityGrade,
  type QualityRecord,
  type CreateQualityInput,
} from './quality-schema.js';

export {
  QualityTracker,
  createQualityTracker,
  type TrendPoint,
  type TrendDimension,
} from './quality-tracker.js';

export {
  FlakyLifecycle,
  createFlakyLifecycle,
  FLAKY_LIFECYCLE_STATUSES,
  DEFAULT_FLAKY_LIFECYCLE_CONFIG,
  type FlakyLifecycleStatus,
  type FlakyLifecycleEvent,
  type FlakyCaseState,
  type FlakyLifecycleConfig,
} from './flaky-lifecycle.js';
