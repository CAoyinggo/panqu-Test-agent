// 数据库迁移（Phase 25.8）：schema 版本管理
// 统一 SQLite（同步）与 PostgreSQL（异步）迁移；幂等可重复执行。
// _migrations 表记录已应用迁移；v1 建立全部集合表（id TEXT PRIMARY KEY, data JSON）。

import type { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { ensureCollection as ensureSqliteCollection } from '../storage/sqlite/database.js';
import { ensureCollection as ensurePostgresCollection } from '../storage/postgres/pg-database.js';

/** 平台全部持久化集合（与 factory 装配一致） */
export const ALL_COLLECTIONS: string[] = [
  'projects',
  'runs',
  'checkpoints',
  'jobs',
  'approvals',
  'audit',
  'idempotency',
  'users',
  'telemetry-events',
  'cost-ledger',
  'rca-verifications',
  'flaky-records',
  'healing-records',
  'release-records',
  'metric-activations',
];

export interface MigrationContext {
  sqlite?: DatabaseSync;
  pool?: Pool;
}

export interface Migration {
  id: string;
  name: string;
  apply: (ctx: MigrationContext) => void | Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 'v1',
    name: 'base-schema',
    apply: async (ctx) => {
      for (const collection of ALL_COLLECTIONS) {
        if (ctx.sqlite) ensureSqliteCollection(ctx.sqlite, collection);
        if (ctx.pool) await ensurePostgresCollection(ctx.pool, collection);
      }
    },
  },
];

function migrationsTableSql(kind: 'sqlite' | 'postgres'): string {
  return kind === 'sqlite'
    ? `CREATE TABLE IF NOT EXISTS "_migrations" (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
    : `CREATE TABLE IF NOT EXISTS "_migrations" (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`;
}

// ── SQLite（同步）──
export function ensureSqliteMigrationsTable(db: DatabaseSync): void {
  db.exec(migrationsTableSql('sqlite'));
}

export function listAppliedSqlite(db: DatabaseSync): string[] {
  ensureSqliteMigrationsTable(db);
  const rows = db.prepare('SELECT id FROM "_migrations"').all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** 应用未执行的 SQLite 迁移；返回本次应用的迁移 id（幂等） */
export function applySqliteMigrations(db: DatabaseSync): string[] {
  const applied = new Set(listAppliedSqlite(db));
  const inserted: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    m.apply({ sqlite: db });
    db.prepare('INSERT INTO "_migrations" (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    inserted.push(m.id);
  }
  return inserted;
}

// ── PostgreSQL（异步）──
export async function ensurePostgresMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(migrationsTableSql('postgres'));
}

export async function listAppliedPostgres(pool: Pool): Promise<string[]> {
  await ensurePostgresMigrationsTable(pool);
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM "_migrations"');
  return rows.map((r) => r.id);
}

/** 应用未执行的 PostgreSQL 迁移；返回本次应用的迁移 id（幂等） */
export async function applyPostgresMigrations(pool: Pool): Promise<string[]> {
  const applied = new Set(await listAppliedPostgres(pool));
  const inserted: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await m.apply({ pool });
    await pool.query('INSERT INTO "_migrations" (id, name, applied_at) VALUES ($1, $2, $3)', [m.id, m.name, new Date().toISOString()]);
    inserted.push(m.id);
  }
  return inserted;
}
