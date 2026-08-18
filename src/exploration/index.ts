// Exploration Testing 模块统一导出（Phase 22 通用 + Phase 23.3 生命周期接入 Regression）
export {
  DEFAULT_EXPLORATION_CONFIG,
  type ExplorationConfig,
  type ExplorationSource,
  type ExplorationCandidate,
  type ExplorationInput,
  type ExplorationResult,
  type ExplorationLifecycleStatus,
} from './exploration-schema.js';

export {
  generateExplorations,
  buildParameterCandidates,
  explorationBySource,
} from './exploration-engine.js';

export {
  runExplorationPlan,
  screenCandidate,
  classifyPermission,
  advanceExploration,
  explorationSourceStats,
  type PermissionLevel,
  type ExplorationGateResult,
  type ExplorationLifecycleState,
  type ExplorationPlan,
  type ExplorationPlanInput,
} from './exploration-lifecycle.js';
