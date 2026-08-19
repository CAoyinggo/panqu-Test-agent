// Test Suite（Phase 39.1）：真正的测试集合
// Suite 只维护 caseIds 引用关系（不复制 TestCase 数据）。
// 能力：创建 / 修改 / 复制 / 归档 / 恢复 / 添加移除 Case / 按 Tag 过滤。
// 持久化复用平台 Repository<T>（同存储后端，纳入备份/恢复/审计体系）。

import type { Entity, Repository } from '../storage/repository.js';
import { generateEntityId } from '../storage/repository.js';

/** Suite 状态 */
export type TestSuiteStatus = 'ACTIVE' | 'ARCHIVED';

/** Test Suite 实体 */
export interface TestSuite extends Entity {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  /** 引用的 TestCase id 列表（不复制数据） */
  caseIds: string[];
  tags?: string[];
  status: TestSuiteStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建 Suite 输入 */
export interface CreateSuiteInput {
  projectId: string;
  name: string;
  description?: string;
  caseIds?: string[];
  tags?: string[];
  createdBy: string;
  now?: () => string;
}

export class TestSuiteService {
  constructor(private readonly repo: Repository<TestSuite>) {}

  async create(input: CreateSuiteInput): Promise<TestSuite> {
    const now = input.now ? input.now() : new Date().toISOString();
    const suite: TestSuite = {
      id: generateEntityId('suite'),
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      caseIds: [...(input.caseIds ?? [])],
      tags: [...(input.tags ?? [])],
      status: 'ACTIVE',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.create(suite);
    return suite;
  }

  async get(id: string): Promise<TestSuite | null> {
    return this.repo.get(id);
  }

  async list(filter?: Partial<TestSuite>): Promise<TestSuite[]> {
    return this.repo.query(filter ?? {});
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  /** 修改基础信息（name / description / tags） */
  async update(
    id: string,
    input: { name?: string; description?: string; tags?: string[] },
  ): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    const updated: TestSuite = {
      ...suite,
      name: input.name ?? suite.name,
      description: input.description === undefined ? suite.description : input.description,
      tags: input.tags ?? suite.tags,
      updatedAt: new Date().toISOString(),
    };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 添加 Case（去重） */
  async addCases(id: string, caseIds: string[]): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    const merged = [...new Set([...suite.caseIds, ...caseIds])];
    const updated = { ...suite, caseIds: merged, updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 移除 Case */
  async removeCases(id: string, caseIds: string[]): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    const removed = new Set(caseIds);
    const updated = { ...suite, caseIds: suite.caseIds.filter((c) => !removed.has(c)), updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 归档 */
  async archive(id: string): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    const updated = { ...suite, status: 'ARCHIVED' as const, updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 恢复 */
  async restore(id: string): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    const updated = { ...suite, status: 'ACTIVE' as const, updatedAt: new Date().toISOString() };
    await this.repo.update(id, updated);
    return updated;
  }

  /** 复制：生成新 Suite（仅复制配置与引用，不复制数据） */
  async copy(id: string, by: string, opts: { name?: string; now?: () => string } = {}): Promise<TestSuite> {
    const suite = await this.repo.get(id);
    if (!suite) throw new Error(`Test Suite 不存在：${id}`);
    return this.create({
      projectId: suite.projectId,
      name: opts.name ?? `${suite.name}（副本）`,
      description: suite.description,
      caseIds: [...suite.caseIds],
      tags: [...(suite.tags ?? [])],
      createdBy: by,
      now: opts.now,
    });
  }

  /** 按 Tag 过滤（含多 Tag，OR 语义） */
  async listByTags(tags: string[]): Promise<TestSuite[]> {
    if (tags.length === 0) return this.list();
    const all = await this.list();
    return all.filter((s) => (s.tags ?? []).some((t) => tags.includes(t)));
  }

  /** 校验给定 caseIds 均存在（引用完整性；缺失返回缺失列表） */
  async missingCases(caseIds: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const cid of caseIds) {
      if (!(await this.repo.get(cid))) missing.push(cid);
    }
    return missing;
  }

  /** 解析 Suite → 去重后的 caseIds（供 Plan 执行展开） */
  async resolveCaseIds(suiteIds: string[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const sid of suiteIds) {
      const suite = await this.repo.get(sid);
      if (suite) for (const cid of suite.caseIds) ids.add(cid);
    }
    return [...ids];
  }
}
