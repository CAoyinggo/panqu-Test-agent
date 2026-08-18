// SQLite 数据库管理（Phase 25.1）
// 基于 Node 内置 node:sqlite（DatabaseSync），无需原生依赖。
// 通用表结构：{id TEXT PRIMARY KEY, data TEXT}，data 为实体 JSON 序列化，
// 与 Memory / JSON Repository 语义完全一致（顶层字段浅相等过滤）。

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from '../../../utils/fs-utils.js';

/** 打开 SQLite 数据库（:memory: 或文件路径）；文件模式自动建目录并开启 WAL */
export function createSqliteDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') ensureDir(path.dirname(file));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    /* 内存库忽略 WAL */
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** 确保集合表存在（幂等） */
export function ensureCollection(db: DatabaseSync, collection: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${sanitizeIdent(collection)}" (
       id   TEXT PRIMARY KEY,
       data TEXT NOT NULL
     )`,
  );
}

/** 事务包装（可嵌套安全；失败回滚） */
export async function withTransaction<T>(db: DatabaseSync, fn: () => Promise<T>): Promise<T> {
  db.exec('BEGIN');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已回滚 */
    }
    throw err;
  }
}

/** 同步事务包装（供脚本使用） */
export function withTransactionSync<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已回滚 */
    }
    throw err;
  }
}

/** 校验并返回集合名（防 SQL 注入：仅允许字母数字下划线短横线） */
function sanitizeIdent(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`非法集合名：${name}`);
  }
  return name;
}

/** 生成统一 sqlite 数据文件路径 */
export function sqliteDataFile(dir: string): string {
  return path.join(dir, 'platform.sqlite');
}
