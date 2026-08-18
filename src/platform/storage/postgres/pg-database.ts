// PostgreSQL 数据库管理（Phase 25.2）
// 基于 node-postgres（pg）连接池；提供连接 / 迁移 / 事务工具。
// 上层 Service 不感知数据库类型：仅通过 Repository<T> 访问。

import { Pool, type PoolConfig } from 'pg';

/** 从 DATABASE_URL 或默认配置创建连接池 */
export function createPostgresPool(opts?: { connectionString?: string; config?: PoolConfig }): Pool {
  return new Pool({
    connectionString: opts?.connectionString ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    ...opts?.config,
  });
}

/** 确保集合表存在（幂等迁移）。表结构同 SQLite：{id TEXT PRIMARY KEY, data JSONB} */
export async function ensureCollection(pool: Pool, collection: string): Promise<void> {
  const ident = sanitizeIdent(collection);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${ident}" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
  );
}

/** 事务包装（失败回滚） */
export async function withTransaction<T>(pool: Pool, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
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
    client.release();
  }
}

/** 校验并返回集合名（防 SQL 注入） */
function sanitizeIdent(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`非法集合名：${name}`);
  }
  return name;
}

/** 建表 SQL（供测试断言） */
export function collectionTableSql(collection: string): string {
  const ident = sanitizeIdent(collection);
  return `CREATE TABLE IF NOT EXISTS "${ident}" (id TEXT PRIMARY KEY, data JSONB NOT NULL)`;
}
