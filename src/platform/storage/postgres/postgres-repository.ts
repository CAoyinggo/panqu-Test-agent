// PostgreSQL Repository（Phase 25.2）：Repository<T> 的 PostgreSQL 实现
// 语义与 Memory / JSON / SQLite 完全一致：顶层字段浅相等过滤 + limit/offset 分页。
// 额外能力（超出 Repository 接口，不破坏兼容）：transaction()。
// 第一阶段能力：连接 / 迁移 / CRUD / 事务 / 分页 / 查询。

import { Pool, type PoolClient } from 'pg';
import {
  generateEntityId,
  type Entity,
  type Repository,
} from '../repository.js';
import { ensureCollection } from './pg-database.js';

export class PostgresRepository<T extends Entity> implements Repository<T> {
  private readonly table: string;
  private ensured = false;
  /** 事务期间持有专用连接，保证查询在事务内原子执行 */
  private txClient: PoolClient | null = null;

  constructor(
    private readonly pool: Pool,
    collection: string,
    private readonly prefix = 'ent',
  ) {
    this.table = collection;
  }

  /** 惰性建表（首次访问时迁移；幂等） */
  private async ensure(): Promise<void> {
    if (this.ensured) return;
    await ensureCollection(this.pool, this.table);
    this.ensured = true;
  }

  /** 查询路由：事务内走专用连接，否则走连接池 */
  private async q(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> {
    if (this.txClient) {
      const r = await this.txClient.query(text, params as never);
      return { rows: r.rows, rowCount: r.rowCount ?? null };
    }
    const r = await this.pool.query(text, params as never);
    return { rows: r.rows, rowCount: r.rowCount ?? null };
  }

  async create(input: Omit<T, 'id'> & { id?: string }): Promise<T> {
    await this.ensure();
    const id = input.id ?? generateEntityId(this.prefix);
    const entity = { ...(input as object), id } as T;
    try {
      await this.q(`INSERT INTO "${this.table}" (id, data) VALUES ($1, $2)`, [id, JSON.stringify(entity)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique constraint/i.test(msg)) throw new Error(`实体已存在：${id}`);
      throw err;
    }
    return entity;
  }

  async get(id: string): Promise<T | null> {
    await this.ensure();
    const { rows } = await this.q(`SELECT data FROM "${this.table}" WHERE id = $1`, [id]);
    const row = rows[0] as { data?: unknown } | undefined;
    return row?.data ? (row.data as T) : null;
  }

  async update(id: string, input: Partial<Omit<T, 'id'>>): Promise<T> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`实体不存在：${id}`);
    const next = { ...cur, ...input, id } as T;
    const { rowCount } = await this.q(`UPDATE "${this.table}" SET data = $1 WHERE id = $2`, [JSON.stringify(next), id]);
    if (!rowCount) throw new Error(`实体不存在：${id}`);
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.ensure();
    const { rowCount } = await this.q(`DELETE FROM "${this.table}" WHERE id = $1`, [id]);
    if (!rowCount) throw new Error(`实体不存在：${id}`);
  }

  async query(filter?: Partial<T>, q?: { limit?: number; offset?: number }): Promise<T[]> {
    await this.ensure();
    const { rows } = await this.q(`SELECT data FROM "${this.table}"`);
    let list = rows.map((r) => (r as { data: T }).data);
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
    await this.ensure();
    const { rows } = await this.q(`SELECT COUNT(*)::int AS c FROM "${this.table}"`);
    return Number((rows[0] as { c: number } | undefined)?.c ?? 0);
  }

  async clear(): Promise<void> {
    await this.ensure();
    await this.q(`DELETE FROM "${this.table}"`);
  }

  /** 事务（超出 Repository 接口的额外能力；期间所有查询走同一连接，失败整体回滚） */
  async transaction<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
    const client = await this.pool.connect();
    this.txClient = client;
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* 已回滚 */
      }
      throw err;
    } finally {
      this.txClient = null;
      client.release();
    }
  }
}
