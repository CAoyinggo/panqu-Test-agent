// UserStore（Phase 25.3）：Repository<UserRecord> 持久化 + 幂等种子用户
// 用户可落 SQLite / PostgreSQL / JSON；AuthService 与 API 均通过本存储访问。

import type { Repository } from '../storage/repository.js';
import { hashPassword } from './password.js';
import type { User, UserRecord, UserScopes } from './user.js';

export interface SeedUserSpec {
  id: string;
  username: string;
  displayName: string;
  password: string;
  roles: string[];
  email?: string;
  scopes?: UserScopes;
}

/** 默认种子用户（development/test 模式；production 由运维显式配置或禁用默认口令） */
export const DEFAULT_SEED_USERS: SeedUserSpec[] = [
  { id: 'u-admin', username: 'admin', displayName: '平台管理员', password: 'admin123', roles: ['ADMIN'] },
  {
    id: 'u-qa-a', username: 'qa-a', displayName: 'QA-A', password: 'qa123456', roles: ['QA'],
    scopes: { projects: ['wan3'], environments: ['test', 'staging'] },
  },
  {
    id: 'u-qa-b', username: 'qa-b', displayName: 'QA-B', password: 'qa123456', roles: ['QA'],
    scopes: { projects: ['order'], environments: ['test'] },
  },
  {
    id: 'u-dev', username: 'developer', displayName: '开发者', password: 'dev123456', roles: ['DEVELOPER'],
    scopes: { environments: ['dev', 'test'] },
  },
  { id: 'u-release', username: 'release-mgr', displayName: '发布经理', password: 'release123', roles: ['RELEASE_MANAGER'] },
  { id: 'u-viewer', username: 'viewer', displayName: '只读用户', password: 'view123456', roles: ['VIEWER'] },
  { id: 'u-svc', username: 'svc-ci', displayName: 'CI 服务账号', password: 'svc-ci-token', roles: ['SERVICE_ACCOUNT'] },
];

/** 用户存储（幂等种子；按 id / username 检索） */
export class UserStore {
  private seeded = false;
  private seeding?: Promise<number>;

  constructor(private readonly repo: Repository<UserRecord>) {}

  /** 幂等种子：仅创建不存在的用户；并发调用共享同一 in-flight 结果 */
  async seed(specs: SeedUserSpec[] = DEFAULT_SEED_USERS): Promise<number> {
    if (this.seeded) return 0;
    if (this.seeding) return this.seeding;
    this.seeding = this.doSeed(specs);
    try {
      return await this.seeding;
    } finally {
      this.seeding = undefined;
    }
  }

  private async doSeed(specs: SeedUserSpec[]): Promise<number> {
    let created = 0;
    for (const s of specs) {
      if (await this.repo.get(s.id)) continue;
      const passwordHash = await hashPassword(s.password);
      await this.repo.create({
        id: s.id,
        username: s.username,
        displayName: s.displayName,
        email: s.email,
        roles: s.roles,
        status: 'ACTIVE',
        scopes: s.scopes,
        createdAt: new Date().toISOString(),
        passwordHash,
      });
      created += 1;
    }
    this.seeded = true;
    return created;
  }

  async getById(id: string): Promise<UserRecord | null> {
    return this.repo.get(id);
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    const all = await this.repo.query({});
    return all.find((u) => u.username === username) ?? null;
  }

  async list(): Promise<User[]> {
    const all = await this.repo.query({});
    return all.map(({ passwordHash: _ph, ...u }) => u);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** 创建或更新用户（含密码哈希） */
  async upsert(u: UserRecord): Promise<UserRecord> {
    const existing = await this.repo.get(u.id);
    if (existing) return this.repo.update(u.id, u);
    return this.repo.create(u);
  }

  /** 设置用户状态（启用 / 禁用） */
  async setStatus(id: string, status: User['status']): Promise<UserRecord | null> {
    const existing = await this.repo.get(id);
    if (!existing) return null;
    return this.repo.update(id, { status });
  }
}
