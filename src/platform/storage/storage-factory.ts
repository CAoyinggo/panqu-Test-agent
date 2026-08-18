// Storage 工厂（Phase 24.2 / 25.1 / 25.2）：按类型创建可替换 Repository
// kind: memory | json | sqlite | postgres（全部实现同一 Repository<T> 接口）

import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import type { Entity, Repository } from './repository.js';
import { InMemoryRepository } from './memory-repository.js';
import { JsonRepository } from './json-repository.js';
import { SqliteRepository } from './sqlite/sqlite-repository.js';
import { PostgresRepository } from './postgres/postgres-repository.js';

export type StorageKind = 'memory' | 'json' | 'sqlite' | 'postgres';

/** 创建 Repository（同一实体可在不同 kind 间无缝替换） */
export function createRepository<T extends Entity>(
  kind: StorageKind,
  opts: { collection: string; prefix?: string; dir?: string; db?: DatabaseSync; pool?: Pool },
): Repository<T> {
  if (kind === 'sqlite') {
    if (!opts.db) throw new Error('sqlite 存储需要传入 db 连接（DatabaseSync）');
    return new SqliteRepository<T>(opts.db, opts.collection, opts.prefix ?? opts.collection);
  }
  if (kind === 'postgres') {
    if (!opts.pool) throw new Error('postgres 存储需要传入连接池（pg.Pool）');
    return new PostgresRepository<T>(opts.pool, opts.collection, opts.prefix ?? opts.collection);
  }
  if (kind === 'json') {
    const dir = opts.dir ?? path.join(process.env.TESTFLOW_OUTPUT_DIR || 'output', 'platform', 'data');
    return new JsonRepository<T>(path.join(dir, `${opts.collection}.json`), opts.prefix ?? opts.collection);
  }
  return new InMemoryRepository<T>(opts.prefix ?? opts.collection);
}

export { Repository } from './repository.js';
export type { Entity, Query } from './repository.js';
