// RBAC / Access Chain / Platform Gate（Phase 24.5）

export {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  approvalPermissionFor,
  listPermissions,
} from './rbac.js';
export type { Role, Permission } from './rbac.js';

export { evaluateAccessChain } from './access-chain.js';
export type { AccessRequest, AccessDecision, AccessVerdict } from './access-chain.js';

export { PlatformGate } from './platform-gate.js';
export type { GateRequest, GateOutcome } from './platform-gate.js';

// Phase 25.3：资源作用域（Project / Environment / Business Scope）
export {
  isAdmin,
  canAccessProject,
  canAccessEnvironment,
  canAccessBusiness,
  assertProjectAccess,
  assertEnvironmentAccess,
  assertRunAccess,
  filterProjectsByScope,
} from './scopes.js';
export type { Scopes, ScopeSubject } from './scopes.js';
