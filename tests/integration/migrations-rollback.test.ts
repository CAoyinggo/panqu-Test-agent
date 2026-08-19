// Phase 31 迁移回滚闭环 — Integration（真实 SQLite 数据目录）
// DEBT-09：验证 backup → migrate → rollback → restore 完整链：
//   1. 升级前全量快照备份（collectSnapshot）
//   2. 模拟迁移升级失败需回滚：revertSqliteMigration 回滚 schema（集合表 + _migrations 记录删除）
//   3. 回滚后数据表消失（schema 层回到 v0）
//   4. 重新应用迁移恢复 schema，再 restore 备份 → Count / Checksum / Key ID 三一致
// 结论：只要升级前有备份，迁移回滚不会造成数据永久丢失。

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { collectSnapshot, restoreSnapshot, verifyRestore, snapshotTotal } from '../../src/platform/ops/backup.js';
import { ALL_COLLECTIONS, applySqliteMigrations, listAppliedSqlite, revertSqliteMigration } from '../../src/platform/ops/migrations.js';
import { createSqliteDatabase, sqliteDataFile } from '../../src/platform/storage/sqlite/database.js';

const cleaned: string[] = [];
function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `panqu-rollback-${label}-`));
  cleaned.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of cleaned.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
  }
});

function makeSqliteBundle(dir: string): PlatformBundle {
  return createPlatformService({ seedProject: true, seedUsers: true, dataDir: dir, storage: 'sqlite', jwtSecret: 'rollback-secret' });
}

describe('31.1 迁移回滚闭环：backup → migrate → rollback → restore', () => {
  it('升级前备份；回滚 schema 后表消失；重新应用 + 恢复备份 → 三一致', async () => {
    const dir = tempDir('a');
    const a = makeSqliteBundle(dir);
    await a.auth.ensureSeeded();
    await a.testAssets.importCatalog();

    // 制造真实数据：项目 + Run（QUEUED 亦保留）+ 审计 + 遥测 + 成本
    await a.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'rb-test', role: 'ADMIN', feature: 'rb-rollback',
    });
    await a.service.createRun({
      projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'rb-test', role: 'ADMIN', feature: 'rb-rollback-2',
    });

    // ① 升级前备份
    const snapshot = await collectSnapshot(a);
    expect(snapshotTotal(snapshot)).toBeGreaterThan(0);
    expect(await a.scheduler.pendingCount()).toBeGreaterThanOrEqual(1);

    // ② 模拟升级失败 → 回滚 schema（独立连接直接操作数据文件）
    const db = createSqliteDatabase(sqliteDataFile(dir));
    expect(listAppliedSqlite(db)).toContain('v1');
    for (const c of ALL_COLLECTIONS) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(c) as { name: string } | undefined;
      expect(row?.name).toBe(c);
    }
    expect(revertSqliteMigration(db)).toBe('v1');

    // ③ 回滚后：集合表全部删除、_migrations 记录清空（schema 回到 v0）
    for (const c of ALL_COLLECTIONS) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(c) as { name: string } | undefined;
      expect(row).toBeUndefined();
    }
    expect(listAppliedSqlite(db)).toEqual([]);

    // ④ 重新应用迁移恢复 schema（幂等恢复基础设施）
    expect(applySqliteMigrations(db)).toContain('v1');
    expect(listAppliedSqlite(db)).toContain('v1');
    db.close();

    // ⑤ 全新 bundle 打开同目录 → restore 升级前备份 → 三一致校验
    const b = makeSqliteBundle(dir);
    await b.auth.ensureSeeded();
    const result = await restoreSnapshot(b, snapshot);
    expect(result.stores).toBe(ALL_COLLECTIONS.length);
    expect(result.restored).toBe(snapshotTotal(snapshot));

    const verify = await verifyRestore(b, snapshot);
    expect(verify.ok).toBe(true);
    expect(verify.countMatch).toBe(true);
    expect(verify.checksumMatch).toBe(true);
    expect(verify.idMismatch).toEqual([]);

    // 数据可查：Run 原样保留（含 QUEUED Job 按「禁止自动重触发」置 CANCELLED）
    const runs = await b.service.listRuns();
    expect(runs.length).toBe(2);
    expect(await b.scheduler.pendingCount()).toBe(0);
  });
});

describe('31.2 回滚语义（down）单元级断言', () => {
  it('回滚只删除迁移创建的表，不破坏 _migrations 基础设施（重新应用可恢复）', () => {
    const db = createSqliteDatabase(':memory:');
    applySqliteMigrations(db);
    // 回滚前 16 集合 + _migrations 共 17 表
    expect(listAppliedSqlite(db)).toContain('v1');
    revertSqliteMigration(db);
    // _migrations 表本身保留（基础设施），仅记录删除
    const migTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`).get() as { name: string } | undefined;
    expect(migTable?.name).toBe('_migrations');
    expect(listAppliedSqlite(db)).toEqual([]);
    db.close();
  });
});
