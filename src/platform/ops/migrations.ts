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
  // 26.2：真实 Test Case 资产（纳入备份/恢复/迁移）
  'test-assets',
  // Phase 39：QA Workflow 集合（Test Suite / Test Plan / Run Template / 资产版本 / 协作 / 报告分享）
  'test-suites',
  'test-plans',
  'run-templates',
  'asset-versions',
  'collaboration',
  'run-reports',
];

export interface MigrationContext {
  sqlite?: DatabaseSync;
  pool?: Pool;
}

export interface Migration {
  id: string;
  name: string;
  apply: (ctx: MigrationContext) => void | Promise<void>;
  /** 31.1（Phase 31）：回滚实现（down）。撤销本迁移创建的 schema 变更（幂等：表不存在忽略） */
  revert?: (ctx: MigrationContext) => void | Promise<void>;
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
    // 31.1：撤销 base-schema = 删除全部集合表（_migrations 表保留，记录由 revert 流程删除）
    revert: async (ctx) => {
      for (const collection of ALL_COLLECTIONS) {
        if (ctx.sqlite) ctx.sqlite.exec(`DROP TABLE IF EXISTS "${collection}"`);
        if (ctx.pool) await ctx.pool.query(`DROP TABLE IF EXISTS "${collection}"`);
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

// ── 回滚（down / rollback，Phase 31 / DEBT-09）──
/** 解析回滚目标：
 * - 无已应用迁移 → null（无可回滚）；
 * - 未指定 targetId → 取最新已应用迁移；
 * - 指定 targetId → 必须是最新已应用迁移（禁止跳级回滚，避免部分回滚造成 schema/数据不一致）；
 * - 目标迁移必须存在且实现 revert，否则抛错（防御：迁移不可回滚时显式失败而非静默）。 */
export function resolveRevertTarget(applied: string[], targetId?: string): Migration | null {
  if (applied.length === 0) return null;
  const latest = applied[applied.length - 1];
  const target = targetId ?? latest;
  if (target !== latest) {
    throw new Error(`仅允许回滚最新已应用迁移（已应用：${applied.join(', ')}，目标：${target}，最新：${latest}）`);
  }
  const migration = MIGRATIONS.find((m) => m.id === target);
  if (!migration) throw new Error(`迁移不存在：${target}`);
  if (!migration.revert) throw new Error(`迁移不可回滚：${target}（未实现 revert）`);
  return migration;
}

/** 回滚最新（或指定）已应用 SQLite 迁移；返回回滚的迁移 id；无可回滚返回 null */
export function revertSqliteMigration(db: DatabaseSync, targetId?: string): string | null {
  const migration = resolveRevertTarget(listAppliedSqlite(db), targetId);
  if (!migration) return null;
  migration.revert!({ sqlite: db });
  db.prepare('DELETE FROM "_migrations" WHERE id = ?').run(migration.id);
  return migration.id;
}

/** 回滚最新（或指定）已应用 PostgreSQL 迁移；返回回滚的迁移 id；无可回滚返回 null */
export async function revertPostgresMigration(pool: Pool, targetId?: string): Promise<string | null> {
  const migration = resolveRevertTarget(await listAppliedPostgres(pool), targetId);
  if (!migration) return null;
  await migration.revert!({ pool });
  await pool.query('DELETE FROM "_migrations" WHERE id = $1', [migration.id]);
  return migration.id;
}
