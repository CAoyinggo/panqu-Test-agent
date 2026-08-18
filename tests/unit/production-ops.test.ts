// 单元测试：Production Ops（Phase 25.8）
// 覆盖：迁移工具函数（_migrations 表 / 已应用列表 / 幂等）、快照版本校验、Preflight 汇总。

import { describe, it, expect } from 'vitest';
import { createSqliteDatabase } from '../../src/platform/storage/sqlite/database.js';
import {
  applySqliteMigrations,
  listAppliedSqlite,
  MIGRATIONS,
} from '../../src/platform/ops/migrations.js';
import { restoreSnapshot, snapshotTotal } from '../../src/platform/ops/backup.js';
import type { PlatformSnapshot } from '../../src/platform/ops/backup.js';
import { preflightSummary, type PlatformCheck } from '../../src/platform/ops/preflight.js';

describe('Phase 25.8 Production Ops（单元）', () => {
  it('迁移：v1 建立全部 15 集合表，_migrations 记录幂等', () => {
    const db = createSqliteDatabase(':memory:');
    const applied = applySqliteMigrations(db);
    expect(applied).toContain('v1');
    // 15 集合表均可写（以 runs / telemetry-events 抽查）
    db.prepare('INSERT INTO "runs" (id, data) VALUES (?, ?)').run('x', JSON.stringify({ id: 'x' }));
    db.prepare('INSERT INTO "telemetry-events" (id, data) VALUES (?, ?)').run('y', JSON.stringify({ id: 'y' }));
    // 重复应用为空
    expect(applySqliteMigrations(db)).toEqual([]);
    expect(listAppliedSqlite(db)).toEqual(MIGRATIONS.map((m) => m.id));
    db.close();
  });

  it('快照：版本不匹配拒绝恢复；快照计数汇总正确', async () => {
    const bad = { version: 99 as const, exportedAt: '', stores: [] };
    await expect(restoreSnapshot({} as never, bad as unknown as PlatformSnapshot)).rejects.toThrow(/版本不兼容/);
    const snap: PlatformSnapshot = {
      version: 1,
      exportedAt: 't',
      stores: [
        { store: 'runs', count: 2, data: [{ id: 'a' }, { id: 'b' }] },
        { store: 'users', count: 0, data: [] },
      ],
    };
    expect(snapshotTotal(snap)).toBe(2);
  });

  it('Preflight 汇总：仅 BLOCK 阻断，WARN 不阻断', () => {
    const checks: PlatformCheck[] = [
      { name: 'a', ok: true, level: 'PASS', detail: '' },
      { name: 'b', ok: false, level: 'WARN', detail: '' },
    ];
    expect(preflightSummary(checks)).toEqual({ ok: true, pass: 1, warn: 1, block: 0 });
    const blocked = [...checks, { name: 'c', ok: false, level: 'BLOCK' as const, detail: '' }];
    expect(preflightSummary(blocked).ok).toBe(false);
  });
});
