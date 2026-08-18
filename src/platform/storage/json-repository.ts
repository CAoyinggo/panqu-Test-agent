// JSON Repository（Phase 24.2）：文件持久化实现，兼容现有 JSON 产物习惯
// 每个 Repository 对应一个集合文件；写入前原子落盘（临时文件 + rename）。

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../../utils/fs-utils.js';
import {
  generateEntityId,
  type Entity,
  type Repository,
} from './repository.js';

export class JsonRepository<T extends Entity> implements Repository<T> {
  private cache: Map<string, T> | null = null;
  private readonly file: string;

  constructor(
    file: string,
    private readonly prefix = 'ent',
  ) {
    this.file = file;
  }

  private load(): Map<string, T> {
    if (this.cache) return this.cache;
    const map = new Map<string, T>();
    if (fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as T[];
        if (Array.isArray(data)) for (const e of data) map.set(e.id, e);
      } catch {
        /* 损坏文件按空处理 */
      }
    }
    this.cache = map;
    return map;
  }

  private async save(): Promise<void> {
    const rows = [...this.load().values()];
    ensureDir(path.dirname(this.file));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const id = input.id ?? generateEntityId(this.prefix);
    const map = this.load();
    if (map.has(id)) throw new Error(`实体已存在：${id}`);
    const entity = { ...(input as object), id } as T;
    map.set(id, entity);
    await this.save();
    return entity;
  }

  async get(id: string): Promise<T | null> {
    return this.load().get(id) ?? null;
  }

  async update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T> {
    const map = this.load();
    const cur = map.get(id);
    if (!cur) throw new Error(`实体不存在：${id}`);
    const next = { ...cur, ...input, id } as T;
    map.set(id, next);
    await this.save();
    return next;
  }

  async delete(id: string): Promise<void> {
    const map = this.load();
    if (!map.delete(id)) throw new Error(`实体不存在：${id}`);
    await this.save();
  }

  async query(filter?: Partial<T>, q?: { limit?: number; offset?: number }): Promise<T[]> {
    let rows = [...this.load().values()];
    if (filter) {
      rows = rows.filter((r) =>
        Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      );
    }
    const offset = q?.offset ?? 0;
    const limit = q?.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.load().size;
  }

  async clear(): Promise<void> {
    this.cache = new Map();
    if (fs.existsSync(this.file)) fs.rmSync(this.file, { force: true });
  }
}
