// Knowledge 模块统一导出（Phase 21.5 Knowledge Optimization）
export {
  KNOWLEDGE_TYPES,
  generateKnowledgeId,
  normalizeCreateKnowledgeInput,
  type KnowledgeType,
  type KnowledgeStatus,
  type KnowledgeEntry,
  type CreateKnowledgeInput,
} from './knowledge-schema.js';

export {
  KnowledgeStore,
  createKnowledgeStore,
  DEFAULT_LIFECYCLE_CONFIG,
  type KnowledgeLifecycleConfig,
  type LifecycleTransition,
} from './knowledge-store.js';

export {
  adviseFromKnowledge,
  failureRateOf,
  boostedTagsFromAdvice,
  PRIORITY_BOOST_THRESHOLD,
  type FailureStats,
  type KnowledgeAdvice,
  type AdviceContext,
} from './knowledge-advisor.js';
