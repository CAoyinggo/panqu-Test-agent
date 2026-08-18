// Test Assets 模块统一导出（Phase 21.2 Test Asset Management）
export {
  ASSET_RELATIONS,
  TEST_ASSET_TYPES,
  bumpVersion,
  generateAssetId,
  normalizeCreateAssetInput,
  type AssetLink,
  type AssetQuery,
  type AssetRelation,
  type CreateAssetInput,
  type TestAsset,
  type TestAssetStatus,
  type TestAssetType,
} from './asset-schema.js';
export {
  TestAssetStore,
  createTestAssetStore,
} from './asset-store.js';
export {
  assessReuse,
  findReusableCases,
  type ReuseAssessment,
  type ReuseCandidate,
} from './reuse-engine.js';
