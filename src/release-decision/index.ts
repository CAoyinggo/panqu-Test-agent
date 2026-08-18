// Autonomous Release Decision 模块统一导出（Phase 22.8）
export {
  DEFAULT_RELEASE_DECISION_THRESHOLDS,
  type PriorityRunStats,
  type ReleaseDecisionInput,
  type ReleaseDecisionThresholds,
  type ReleaseDecision,
  type ReleaseEvidence,
  type AutonomousReleaseDecision,
} from './release-decision-schema.js';

export { decideRelease } from './release-decision-engine.js';
