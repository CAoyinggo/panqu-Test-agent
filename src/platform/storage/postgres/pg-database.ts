// PostgreSQL 数据库管理（Phase 25.2）
// 基于 node-postgres（pg）连接池；提供连接 / 迁移 / 事务工具。
// 上层 Service 不感知数据库类型：仅通过 Repository<T> 访问。

import { Pool, type PoolConfig } from 'pg';

export interface PostgresPoolOptions {
  /** 显式连接串；未传时只读取 DATABASE_URL，不提供任何默认账号/数据库。 */
  connectionString?: string;
  config?: PoolConfig;
  /** production/staging 下额外拒绝 postgres/postgres 弱默认凭据。 */
  productionLike?: boolean;
}

/** 校验 PostgreSQL 连接串；错误信息不得回显可能包含密码的原值。 */
export function requirePostgresConnectionString(value?: string, productionLike = false): string {
  const connectionString = value?.trim();
  if (!connectionString) {
    throw new Error('[database] PostgreSQL 启动要求显式配置 DATABASE_URL，禁止使用默认连接');
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('[database] DATABASE_URL 不是合法的 PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('[database] DATABASE_URL 协议必须是 postgres:// 或 postgresql://');
  }
  if (productionLike) {
    const username = decodeURIComponent(parsed.username).toLowerCase();
    const password = decodeURIComponent(parsed.password).toLowerCase();
    if (username === 'postgres' && password === 'postgres') {
      throw new Error('[database] 生产环境禁止使用 postgres/postgres 默认凭据');
    }
  }
  return connectionString;
}

/** 从显式参数或 DATABASE_URL 创建连接池；永不回退 postgres/postgres。 */
export function createPostgresPool(opts: PostgresPoolOptions = {}): Pool {
  const connectionString = requirePostgresConnectionString(
    opts.connectionString ?? process.env.DATABASE_URL,
    opts.productionLike,
  );
  return new Pool({
    connectionString,
    ...opts.config,
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
