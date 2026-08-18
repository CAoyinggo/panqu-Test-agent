// Continuous Learning 模块统一导出（Phase 22.7）
export {
  DEFAULT_LEARNING_CONFIG,
  type LearningConfig,
  type LearningState,
  type ExecutionEvidence,
  type LearningUpdate,
  type LearningAppliedCase,
} from './learning-schema.js';

export {
  weightDecay,
  suggestedPriority,
  createLearningState,
  applyEvidence,
  decayLearningState,
  ContinuousLearner,
} from './continuous-learning.js';
