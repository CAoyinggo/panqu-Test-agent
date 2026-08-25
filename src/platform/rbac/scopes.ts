// RBAC 作用域（Phase 25.3）：Project / Environment / Business Scope
// 在角色权限之上叠加资源范围：QA-A → project-a/test-staging；QA-B → project-b/test。
// 任何一层失败即拒绝；ADMIN 视为全局（可访问全部作用域）。

import type { User, UserScopes } from '../auth/user.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

export type { UserScopes } from '../auth/user.js';
export type Scopes = UserScopes;

export type ScopeSubject = Pick<User, 'roles' | 'scopes'>;

/** 是否全局管理员（拥有全部作用域） */
export function isAdmin(user: ScopeSubject): boolean {
  return user.roles.includes('ADMIN');
}

/** 项目作用域：无限制（缺省）或显式包含 */
export function canAccessProject(user: ScopeSubject, projectId: string): boolean {
  if (isAdmin(user)) return true;
  const projects = user.scopes?.projects;
  if (projects && projects.length > 0) return projects.includes(projectId);
  return true;
}

/** 环境作用域：无限制（缺省）或显式包含 */
export function canAccessEnvironment(user: ScopeSubject, environment: string): boolean {
  if (isAdmin(user)) return true;
  const envs = user.scopes?.environments;
  if (envs && envs.length > 0) return envs.includes(environment);
  return true;
}

/** 业务作用域：无限制（缺省）或显式包含 */
export function canAccessBusiness(user: ScopeSubject, businessId: string): boolean {
  if (isAdmin(user)) return true;
  const bs = user.scopes?.businesses;
  if (bs && bs.length > 0) return bs.includes(businessId);
  return true;
}

/** 断言式项目访问（Service / API 调用） */
export function assertProjectAccess(user: ScopeSubject, projectId: string): void {
  if (!canAccessProject(user, projectId)) {
    throw new CodedError(ErrorCode.AUTH_FORBIDDEN, `无权访问项目 ${projectId}`);
  }
}

/** 断言式环境访问 */
export function assertEnvironmentAccess(user: ScopeSubject, environment: string): void {
  if (!canAccessEnvironment(user, environment)) {
    throw new CodedError(ErrorCode.AUTH_FORBIDDEN, `无权访问环境 ${environment}`);
  }
}

/** 断言式项目 + 环境访问（创建 Run 时用） */
export function assertRunAccess(user: ScopeSubject, projectId: string, environment: string): void {
  assertProjectAccess(user, projectId);
  assertEnvironmentAccess(user, environment);
}

/** 过滤项目列表为当前用户可见集合 */
export function filterProjectsByScope<T extends { id: string }>(user: ScopeSubject | undefined, projects: T[]): T[] {
  if (!user) return projects;
  return projects.filter((p) => canAccessProject(user, p.id));
}
