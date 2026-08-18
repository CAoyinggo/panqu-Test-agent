// Defect Lifecycle 模块统一导出（Phase 21.4）
export {
  DEFECT_STATUSES,
  DEFECT_TRANSITIONS,
  canTransition,
  normalizeIngestInput,
  type DefectHistoryEntry,
  type DefectRecord,
  type DefectResolution,
  type DefectStatus,
  type IngestDefectInput,
} from './lifecycle-schema.js';
export {
  DUPLICATE_THRESHOLD,
  buildFailureSignature,
  detectDuplicate,
  scoreDuplicate,
  signatureOverlap,
  type DuplicateVerdict,
  type FailureReport,
} from './duplicate-detector.js';
export {
  DefectLifecycleTracker,
  createDefectLifecycleTracker,
  type ProcessFailureResult,
} from './defect-tracker.js';
