// Platform Service Layer（Phase 24.7）：API / CLI 共用

export { PlatformService } from './platform-service.js';
export type { PlatformServiceDeps, CreateRunRequest, RunChange } from './platform-service.js';

export { IdempotencyStore } from './idempotency.js';
export type { IdempotencyRecord } from './idempotency.js';

export { createPlatformService } from './factory.js';
export type { PlatformFactoryOptions, PlatformBundle } from './factory.js';
export { platformDataDir } from './factory.js';
export { PostgresStartup, createReadyStartup } from './startup.js';
export type { PlatformStartup, PlatformStartupState, PlatformStartupStatus } from './startup.js';

export { AuthService, UserStore } from '../auth/index.js';
export type { AuthTokens, AuthServiceOptions, User, UserScopes, UserRecord, JwtPayload } from '../auth/index.js';
