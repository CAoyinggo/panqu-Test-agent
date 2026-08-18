// 单元测试：RBAC 资源作用域（Phase 25.3）
// 覆盖：Project / Environment / Business Scope；ADMIN 全局；断言式访问；列表过滤。
// 场景：QA-A → wan3 / test+staging；QA-B → order / test；越权一律拒绝。

import { describe, it, expect } from 'vitest';
import {
  canAccessProject,
  canAccessEnvironment,
  canAccessBusiness,
  assertRunAccess,
  filterProjectsByScope,
} from '../../src/platform/rbac/scopes.js';
import type { User } from '../../src/platform/auth/user.js';

const qaA: User = {
  id: 'u-qa-a', username: 'qa-a', displayName: 'QA-A', roles: ['QA'], status: 'ACTIVE', createdAt: '',
  scopes: { projects: ['wan3'], environments: ['test', 'staging'] },
};

const qaB: User = {
  id: 'u-qa-b', username: 'qa-b', displayName: 'QA-B', roles: ['QA'], status: 'ACTIVE', createdAt: '',
  scopes: { projects: ['order'], environments: ['test'] },
};

const unrestricted: User = {
  id: 'u-dev', username: 'developer', displayName: 'DEV', roles: ['DEVELOPER'], status: 'ACTIVE', createdAt: '',
  scopes: { environments: ['dev', 'test'] },
};

const admin: User = {
  id: 'u-admin', username: 'admin', displayName: 'ADMIN', roles: ['ADMIN'], status: 'ACTIVE', createdAt: '',
};

const noScopes: User = {
  id: 'u-x', username: 'x', displayName: 'X', roles: ['VIEWER'], status: 'ACTIVE', createdAt: '',
};

describe('Project Scope', () => {
  it('QA-A 可访问 wan3，不可访问 order（项目隔离）', () => {
    expect(canAccessProject(qaA, 'wan3')).toBe(true);
    expect(canAccessProject(qaA, 'order')).toBe(false);
  });

  it('QA-B 可访问 order，不可访问 wan3', () => {
    expect(canAccessProject(qaB, 'order')).toBe(true);
    expect(canAccessProject(qaB, 'wan3')).toBe(false);
  });

  it('无项目作用域 = 全部项目；ADMIN 不受限制', () => {
    expect(canAccessProject(noScopes, 'anything')).toBe(true);
    expect(canAccessProject(unrestricted, 'order')).toBe(true);
    expect(canAccessProject(admin, 'order')).toBe(true);
  });
});

describe('Environment Scope', () => {
  it('QA-A 可访问 test/staging，不可访问 production', () => {
    expect(canAccessEnvironment(qaA, 'test')).toBe(true);
    expect(canAccessEnvironment(qaA, 'staging')).toBe(true);
    expect(canAccessEnvironment(qaA, 'production')).toBe(false);
  });

  it('QA-B 仅可访问 test；DEVELOPER 仅 dev/test；ADMIN 全部', () => {
    expect(canAccessEnvironment(qaB, 'test')).toBe(true);
    expect(canAccessEnvironment(qaB, 'staging')).toBe(false);
    expect(canAccessEnvironment(unrestricted, 'dev')).toBe(true);
    expect(canAccessEnvironment(unrestricted, 'production')).toBe(false);
    expect(canAccessEnvironment(admin, 'production')).toBe(true);
  });
});

describe('Business Scope', () => {
  it('有业务作用域时仅限指定业务；无则全部', () => {
    const user: User = {
      id: 'u-b', username: 'b', displayName: 'B', roles: ['QA'], status: 'ACTIVE', createdAt: '',
      scopes: { businesses: ['text-to-video'] },
    };
    expect(canAccessBusiness(user, 'text-to-video')).toBe(true);
    expect(canAccessBusiness(user, 'video-editor')).toBe(false);
    expect(canAccessBusiness(noScopes, 'video-editor')).toBe(true);
    expect(canAccessBusiness(admin, 'video-editor')).toBe(true);
  });
});

describe('断言式访问', () => {
  it('越权项目或环境 → 抛错', () => {
    expect(() => assertRunAccess(qaA, 'wan3', 'test')).not.toThrow();
    expect(() => assertRunAccess(qaA, 'order', 'test')).toThrow(/无权访问项目 order/);
    expect(() => assertRunAccess(qaA, 'wan3', 'production')).toThrow(/无权访问环境 production/);
    // ADMIN 全通过
    expect(() => assertRunAccess(admin, 'order', 'production')).not.toThrow();
  });
});

describe('项目列表过滤', () => {
  it('filterProjectsByScope 仅保留可见项目', () => {
    const projects = [{ id: 'wan3' }, { id: 'order' }, { id: 'other' }];
    expect(filterProjectsByScope(qaA, projects).map((p) => p.id)).toEqual(['wan3']);
    expect(filterProjectsByScope(qaB, projects).map((p) => p.id)).toEqual(['order']);
    expect(filterProjectsByScope(undefined, projects)).toHaveLength(3);
    expect(filterProjectsByScope(admin, projects)).toHaveLength(3);
  });
});
