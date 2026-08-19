// 单元测试：Phase 31 迁移 down / 回滚（DEBT-09）
// 验证：SQLite / PostgreSQL 迁移可回滚（revert），回滚仅允许最新已应用迁移（防跳级），
// 回滚后集合表与 _migrations 记录同步删除，且可再次应用恢复。
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { createSqliteDatabase } from '../../src/platform/storage/sqlite/database.js';
import {
  ALL_COLLECTIONS,
  applySqliteMigrations,
  listAppliedSqlite,
  resolveRevertTarget,
  revertPostgresMigration,
  revertSqliteMigration,
} from '../../src/platform/ops/migrations.js';

function tableExists(db: ReturnType<typeof createSqliteDatabase>, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { name: string } | undefined;
  return Boolean(row);
}

describe('Migrations：down / 回滚（Phase 31 / DEBT-09）', () => {
  it('SQLite：apply → revert v1 → 集合表与记录删除 → 再 apply 恢复', () => {
    const db = createSqliteDatabase(':memory:');
    expect(applySqliteMigrations(db)).toContain('v1');
    for (const c of ALL_COLLECTIONS) expect(tableExists(db, c)).toBe(true);
    expect(listAppliedSqlite(db)).toContain('v1');

    expect(revertSqliteMigration(db)).toBe('v1');
    for (const c of ALL_COLLECTIONS) expect(tableExists(db, c)).toBe(false);
    expect(listAppliedSqlite(db)).toEqual([]);

    // 回滚后可再次应用恢复 schema
    expect(applySqliteMigrations(db)).toContain('v1');
    expect(listAppliedSqlite(db)).toContain('v1');
    for (const c of ALL_COLLECTIONS) expect(tableExists(db, c)).toBe(true);
    db.close();
  });

  it('SQLite：无已应用迁移时 revert 返回 null（幂等空操作）', () => {
    const db = createSqliteDatabase(':memory:');
    expect(revertSqliteMigration(db)).toBeNull();
    db.close();
  });

  it('resolveRevertTarget：空→null；指定非最新→throw；latest 不存在于 MIGRATIONS→throw', () => {
    expect(resolveRevertTarget([])).toBeNull();
    // 指定非最新：applied=['v1']，target='v9' ≠ latest 'v1'
    expect(() => resolveRevertTarget(['v1'], 'v9')).toThrow(/仅允许回滚最新/);
    // latest 在 MIGRATIONS 中不存在（target 未指定，取 latest 'vX'）
    expect(() => resolveRevertTarget(['vX'])).toThrow(/迁移不存在/);
    expect(() => resolveRevertTarget(['vX'], 'vX')).toThrow(/迁移不存在/);
    // 正常路径：latest 存在且实现 revert
    expect(resolveRevertTarget(['v1'])).toMatchObject({ id: 'v1' });
    expect(resolveRevertTarget(['v1'], 'v1')).toMatchObject({ id: 'v1' });
  });

  it('PostgreSQL：mock Pool 回滚 → DROP 全部集合表 + DELETE _migrations 记录', async () => {
    let dropCount = 0;
    const deletes: string[] = [];
    const pool = {
      async query(sql: string, params?: unknown[]) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS "_migrations"')) return { rows: [] };
        if (sql.includes('SELECT id FROM "_migrations"')) return { rows: [{ id: 'v1' }] };
        if (sql.includes('DROP TABLE IF EXISTS')) {
          dropCount += 1;
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM "_migrations"')) {
          deletes.push(params![0] as string);
          return { rows: [] };
        }
        return { rows: [] };
      },
      async end() {},
    } as unknown as Pool;

    expect(await revertPostgresMigration(pool)).toBe('v1');
    expect(dropCount).toBe(ALL_COLLECTIONS.length);
    expect(deletes).toEqual(['v1']);
  });

  it('PostgreSQL：无已应用迁移时 revert 返回 null', async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes('CREATE TABLE IF NOT EXISTS "_migrations"')) return { rows: [] };
        if (sql.includes('SELECT id FROM "_migrations"')) return { rows: [] };
        return { rows: [] };
      },
      async end() {},
    } as unknown as Pool;
    expect(await revertPostgresMigration(pool)).toBeNull();
  });
});
