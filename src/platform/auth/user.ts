// User 实体（Phase 25.3）：平台真实用户
// 在 RBAC 角色之上叠加资源作用域（Project / Environment / Business Scope）。

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** 资源作用域（缺省字段 = 不限；显式空数组 = 完全禁止） */
export interface UserScopes {
  /** 允许访问的项目 id */
  projects?: string[];
  /** 允许访问的环境（dev/test/staging/preprod/production） */
  environments?: string[];
  /** 允许访问的业务线 */
  businesses?: string[];
}

/** 平台用户（任务书 25.3 接口） */
export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  roles: string[];
  status: UserStatus;
  scopes?: UserScopes;
  createdAt: string;
}

/** 存储记录：User + 密码哈希 */
export interface UserRecord extends User {
  passwordHash: string;
}

/** 去掉敏感字段（不复制 passwordHash） */
export function toPublicUser(record: UserRecord): User {
  const { passwordHash: _ph, ...safe } = record;
  return safe;
}
