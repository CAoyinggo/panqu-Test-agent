// Business 模块统一导出（Phase 21.1 Multi-Business）
export {
  BUSINESS_JSON_SCHEMA,
  normalizeBusinessDefinition,
  validateBusinessDefinition,
  type BusinessDefinition,
  type RiskPolicy,
  type TestPolicy,
} from './business-schema.js';
export {
  BusinessRegistry,
  createBusinessRegistry,
  getBusinessRegistry,
  resetBusinessRegistry,
  type BusinessEntry,
} from './registry.js';
export {
  DefaultBusinessAdapter,
  createBusinessAdapter,
  type BusinessAdapter,
} from './adapters/business-adapter.js';
export {
  BUSINESS_DEFS_DIR_ENV,
  initBusinessRegistry,
  loadBuiltinBusinesses,
  loadBusinessDefinitionsFromDir,
  type InitBusinessRegistryOptions,
} from './loader.js';
export {
  BUILTIN_BUSINESSES,
  WAN3_BUSINESS,
  IMAGE_GENERATION_BUSINESS,
  CHAT_BUSINESS,
  MUSIC_BUSINESS,
  DIGITAL_HUMAN_BUSINESS,
  WORKFLOW_BUSINESS,
} from './definitions/index.js';
