// Stopping 模块统一导出（Phase 22.4 Adaptive Test Stopping）
export {
  DEFAULT_STOPPING_RULES,
  type StoppingInput,
  type StoppingRules,
  type StoppingCondition,
  type StoppingDecision,
} from './stopping-schema.js';

export {
  evaluateStopping,
} from './adaptive-stopping.js';
