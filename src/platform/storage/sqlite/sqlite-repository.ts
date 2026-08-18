// SQLite Repository（Phase 25.1）：Repository<T> 的 SQLite 实现
// 语义与 Memory / JSON 完全一致：顶层字段浅相等过滤 + limit/offset 分页。
// 额外能力（超出 Repository 接口，不破坏兼容）：transaction()。

import type { DatabaseSync } from 'node:sqlite';
import {
  generateEntityId,
  type Entity,
  type Repository,
} from '../repository.js';
import { ensureCollection, withTransaction } from './database.js';

export class SqliteRepository<T extends Entity> implements Repository<T> {
  private readonly table: string;

  constructor(
    private readonly db: DatabaseSync,
    collection: string,
    private readonly prefix = 'ent',
  ) {
    this.table = collection;
    ensureCollection(db, collection);
  }

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    const id = input.id ?? generateEntityId(this.prefix);
    const entity = { ...(input as object), id } as T;
    try {
      this.db
        .prepare(`INSERT INTO "${this.table}" (id, data) VALUES (?, ?)`)
        .run(id, JSON.stringify(entity));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|PRIMARY KEY/.test(msg)) throw new Error(`实体已存在：${id}`);
      throw err;
    }
    return entity;
  }

  async get(id: string): Promise<T | null> {
    const row = this.db
      .prepare(`SELECT data FROM "${this.table}" WHERE id = ?`)
      .get(id) as { data?: string } | undefined;
    return row?.data ? (JSON.parse(row.data) as T) : null;
  }

  async update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`实体不存在：${id}`);
    const next = { ...cur, ...input, id } as T;
    this.db
      .prepare(`UPDATE "${this.table}" SET data = ? WHERE id = ?`)
      .run(JSON.stringify(next), id);
    return next;
  }

  async delete(id: string): Promise<void> {
    const result = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
    if (result.changes === 0) throw new Error(`实体不存在：${id}`);
  }

  async query(filter?: Partial<T>, q?: { limit?: number; offset?: number }): Promise<T[]> {
    const rows = this.db.prepare(`SELECT data FROM "${this.table}"`).all() as { data: string }[];
    let list = rows.map((r) => JSON.parse(r.data) as T);
    if (filter) {
      list = list.filter((r) =>
        Object.entries(filter).every(
          ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
        ),
      );
    }
    const offset = q?.offset ?? 0;
    const limit = q?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM "${this.table}"`)
      .get() as { c: number };
    return Number(row.c);
  }

  async clear(): Promise<void> {
    this.db.exec(`DELETE FROM "${this.table}"`);
  }

  /** 事务（超出 Repository 接口的额外能力；失败整体回滚） */
  async transaction<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
    return withTransaction(this.db, fn);
  }
}
