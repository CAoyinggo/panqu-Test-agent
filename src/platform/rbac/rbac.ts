// RBAC（Phase 24.5）：角色 / 权限矩阵
// 最终链路：User → RBAC → Tool Permission → Environment Policy → Approval → Execute。
// 任何角色（含 ADMIN）都不能绕过 RBAC 与后续环境安全策略（见 access-chain.ts）。

/** 平台角色 */
export type Role =
  | 'ADMIN'
  | 'QA'
  | 'DEVELOPER'
  | 'RELEASE_MANAGER'
  | 'FINANCE'
  | 'PROJECT_OWNER'
  | 'VIEWER'
  | 'SERVICE_ACCOUNT';

/** 平台角色清单（单一权威源：守卫 / 校验 / 文档共用，防止角色漂移） */
export const ROLES: readonly Role[] = ['ADMIN', 'QA', 'DEVELOPER', 'RELEASE_MANAGER', 'FINANCE', 'PROJECT_OWNER', 'VIEWER', 'SERVICE_ACCOUNT'];

/** 角色类型守卫：非法字符串（如 X-Role: HACKER）不被当作合法 Role（防身份伪造升级） */
export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/** 平台权限（任务书 24.5 至少清单） */
export type Permission =
  | 'PROJECT_READ'
  | 'PROJECT_WRITE'
  | 'TEST_RUN'
  | 'TEST_CANCEL'
  | 'TEST_RETRY'
  | 'ASSET_READ'
  | 'ASSET_WRITE'
  | 'DEFECT_CREATE'
  | 'HEALING_APPROVE'
  | 'RELEASE_APPROVE'
  | 'PRODUCTION_ACCESS'
  // 27.2：运维只读（审计日志 / 遥测成本 / Job / Worker 基础设施状态）
  | 'OPS_READ'
  // Phase 52：成本全局读取与生产治理修改（专用权限，不复用 Release 审批）。
  | 'COST_READ_ALL'
  | 'COST_MANAGE';

/** 全部权限（ADMIN 持有） */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'PROJECT_READ',
  'PROJECT_WRITE',
  'TEST_RUN',
  'TEST_CANCEL',
  'TEST_RETRY',
  'ASSET_READ',
  'ASSET_WRITE',
  'DEFECT_CREATE',
  'HEALING_APPROVE',
  'RELEASE_APPROVE',
  'PRODUCTION_ACCESS',
  'OPS_READ',
  'COST_READ_ALL',
  'COST_MANAGE',
];

/** 角色 → 权限矩阵（单一策略源） */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: ALL_PERMISSIONS,
  QA: [
    'PROJECT_READ',
    'TEST_RUN',
    'TEST_CANCEL',
    'TEST_RETRY',
    'ASSET_READ',
    'ASSET_WRITE',
    'DEFECT_CREATE',
  ],
  DEVELOPER: ['PROJECT_READ', 'TEST_RUN', 'TEST_RETRY', 'ASSET_READ', 'DEFECT_CREATE'],
  RELEASE_MANAGER: [
    'PROJECT_READ',
    'PROJECT_WRITE',
    'TEST_RUN',
    'TEST_CANCEL',
    'TEST_RETRY',
    'ASSET_READ',
    'DEFECT_CREATE',
    'HEALING_APPROVE',
    'RELEASE_APPROVE',
    'PRODUCTION_ACCESS',
    'OPS_READ',
  ],
  FINANCE: ['PROJECT_READ', 'OPS_READ', 'COST_READ_ALL', 'COST_MANAGE'],
  PROJECT_OWNER: ['PROJECT_READ', 'PROJECT_WRITE', 'OPS_READ', 'COST_READ_ALL', 'COST_MANAGE'],
  VIEWER: ['PROJECT_READ', 'ASSET_READ'],
  SERVICE_ACCOUNT: ['TEST_RUN', 'ASSET_READ', 'DEFECT_CREATE', 'OPS_READ'],
};

/** 判断角色是否具备某权限 */
export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * 审批动作 → 所需审批权限：
 * - healing 相关 → HEALING_APPROVE
 * - release / production / 其余高风险 → RELEASE_APPROVE
 */
export function approvalPermissionFor(action: string): Permission {
  if (/healing/i.test(action)) return 'HEALING_APPROVE';
  return 'RELEASE_APPROVE';
}

/** 列出角色的全部权限（审计 / 调试用） */
export function listPermissions(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
