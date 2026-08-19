// Project Registry（Phase 24.1 / 25.1）：内存注册表 + JSON / SQLite 持久化
// 提供 create / get / list / update / delete / 环境查找与校验。
// 存储可替换：memory（进程内） / json（文件） / sqlite（DatabaseSync，同步 API 保持一致）。

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureDir, readJson, writeJson } from '../../utils/fs-utils.js';
import { ensureCollection } from '../storage/sqlite/database.js';
import type { StorageKind } from '../storage/storage-factory.js';
import {
  findEnvironment,
  validateEnvironments,
  standardEnvironments,
  type Environment,
  type Project,
  type ProjectCreateInput,
} from './project-schema.js';

/** Registry 选项 */
export interface ProjectRegistryOptions {
  /** JSON 持久化文件（默认 output/platform/projects.json） */
  file?: string;
  /** 是否启用磁盘持久化（默认 true；测试可关闭） */
  persist?: boolean;
  /** 时间源（测试确定性用） */
  now?: () => string;
  /** 存储后端：memory | json | sqlite（默认 json） */
  storage?: StorageKind;
  /** storage === 'sqlite' 时需要的共享连接 */
  sqliteDb?: DatabaseSync;
}

const PROJECT_COLLECTION = 'projects';

export class ProjectRegistry {
  private projects = new Map<string, Project>();
  private readonly file: string;
  private readonly persist: boolean;
  private readonly now: () => string;
  private readonly storage: StorageKind;
  private readonly sqliteDb?: DatabaseSync;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.storage = opts.storage ?? 'json';
    this.persist = opts.persist ?? true;
    this.file = opts.file ?? path.join(process.env.TESTFLOW_OUTPUT_DIR || 'output', 'platform', 'projects.json');
    this.now = opts.now ?? (() => new Date().toISOString());
    this.sqliteDb = opts.sqliteDb;
    if (this.storage === 'sqlite') {
      if (!this.sqliteDb) throw new Error('storage=sqlite 需要 sqliteDb 连接');
      ensureCollection(this.sqliteDb, PROJECT_COLLECTION);
    }
    if (this.persist) this.load();
  }

  /** 创建项目（id 唯一；默认环境必须存在；environments 缺省时使用标准五环境） */
  create(input: ProjectCreateInput): Project {
    if (this.projects.has(input.id)) {
      throw new Error(`Project 已存在：${input.id}`);
    }
    const environments = input.environments ?? standardEnvironments();
    const envErrors = validateEnvironments(environments);
    if (envErrors.length) throw new Error(`Project 环境非法：${envErrors.join('；')}`);
    const defaultEnvironment = input.defaultEnvironment ?? environments[0]?.id ?? '';
    if (!findEnvironment({ id: input.id, name: input.name, businesses: [], environments, defaultEnvironment, createdAt: '', updatedAt: '' }, defaultEnvironment)) {
      throw new Error(`默认环境不存在：${defaultEnvironment}`);
    }
    const ts = this.now();
    const project: Project = {
      id: input.id,
      name: input.name,
      businesses: input.businesses ?? [],
      environments,
      defaultEnvironment,
      testPolicy: input.testPolicy,
      releasePolicy: input.releasePolicy,
      createdAt: ts,
      updatedAt: ts,
    };
    this.projects.set(project.id, project);
    this.save();
    return project;
  }

  get(id: string): Project | null {
    return this.projects.get(id) ?? null;
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  /** 更新项目（name / businesses / testPolicy / releasePolicy；环境经 updateEnvironments） */
  update(id: string, input: Partial<Pick<Project, 'name' | 'businesses' | 'testPolicy' | 'releasePolicy'>>): Project {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project 不存在：${id}`);
    const next: Project = { ...p, ...input, updatedAt: this.now() };
    this.projects.set(id, next);
    this.save();
    return next;
  }

  delete(id: string): void {
    if (!this.projects.delete(id)) throw new Error(`Project 不存在：${id}`);
    this.save();
  }

  /** 替换项目环境集（保持默认环境有效） */
  updateEnvironments(id: string, environments: Environment[]): Project {
    const p = this.projects.get(id);
    if (!p) throw new Error(`Project 不存在：${id}`);
    const envErrors = validateEnvironments(environments);
    if (envErrors.length) throw new Error(`环境非法：${envErrors.join('；')}`);
    const defaultEnvironment = environments.some((e) => e.id === p.defaultEnvironment)
      ? p.defaultEnvironment
      : (environments[0]?.id ?? '');
    const next: Project = { ...p, environments, defaultEnvironment, updatedAt: this.now() };
    this.projects.set(id, next);
    this.save();
    return next;
  }

  /** 按 id/name 查找项目内环境（环境隔离入口） */
  getEnvironment(projectId: string, envIdOrName: string): Environment | null {
    const p = this.projects.get(projectId);
    if (!p) return null;
    return findEnvironment(p, envIdOrName);
  }

  private load(): void {
    if (this.storage === 'sqlite') {
      const rows = this.sqliteDb!
        .prepare(`SELECT data FROM "${PROJECT_COLLECTION}"`)
        .all() as { data: string }[];
      for (const r of rows) {
        const p = JSON.parse(r.data) as Project;
        this.projects.set(p.id, p);
      }
      return;
    }
    const data = readJson<Project[]>(this.file);
    if (Array.isArray(data)) {
      for (const p of data) this.projects.set(p.id, p);
    }
  }

  private save(): void {
    if (!this.persist) return;
    if (this.storage === 'sqlite') {
      const stmt = this.sqliteDb!.prepare(
        `INSERT OR REPLACE INTO "${PROJECT_COLLECTION}" (id, data) VALUES (?, ?)`,
      );
      for (const p of this.projects.values()) stmt.run(p.id, JSON.stringify(p));
      return;
    }
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, `${JSON.stringify([...this.projects.values()], null, 2)}\n`, 'utf-8');
  }

  /** 测试/重置用 */
  clear(): void {
    this.projects.clear();
    if (this.storage === 'sqlite') {
      this.sqliteDb!.exec(`DELETE FROM "${PROJECT_COLLECTION}"`);
    } else if (this.persist && fs.existsSync(this.file)) {
      fs.rmSync(this.file, { force: true });
    }
  }

  /** 26.6：恢复用——直接注入快照记录（保留原 id / createdAt / updatedAt，不经 create 重生成时间戳） */
  importAll(records: Project[]): void {
    for (const p of records) this.projects.set(p.id, p);
    this.save();
  }
}

/** 便捷单例（平台默认注册表） */
export function createDefaultRegistry(opts?: ProjectRegistryOptions): ProjectRegistry {
  return new ProjectRegistry(opts);
}
