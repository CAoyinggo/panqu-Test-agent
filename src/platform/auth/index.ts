// Authentication（Phase 25.3）：真实用户 + JWT 认证
// 链路：POST /auth/login → JWT → Bearer → Auth Middleware → User → RBAC → Service。

export { hashPassword, verifyPassword } from './password.js';
export { DEFAULT_SEED_USERS, UserStore } from './user-store.js';
export type { SeedUserSpec } from './user-store.js';
export { signJwt, verifyJwt, decodeJwt } from './jwt.js';
export type { JwtPayload, JwtVerifyOptions } from './jwt.js';
export { AuthService } from './auth-service.js';
export type { AuthTokens, AuthServiceOptions } from './auth-service.js';
export { toPublicUser } from './user.js';
export type { User, UserRecord, UserScopes, UserStatus } from './user.js';
