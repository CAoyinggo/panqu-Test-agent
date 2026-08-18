// Platform Service Layer（Phase 24.7）：API / CLI 共用

export { PlatformService } from './platform-service.js';
export type { PlatformServiceDeps, CreateRunRequest, RunChange } from './platform-service.js';

export { IdempotencyStore } from './idempotency.js';
export type { IdempotencyRecord } from './idempotency.js';

export { createPlatformService } from './factory.js';
export type { PlatformFactoryOptions, PlatformBundle } from './factory.js';
