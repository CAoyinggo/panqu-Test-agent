// 单元测试：SQLite Storage（Phase 25.1）
// 覆盖：SqliteRepository 与 Memory/JSON 语义一致 + 跨实例持久化 + 事务 + 工厂接入。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteRepository,
  createSqliteDatabase,
  ensureCollection,
  withTransaction,
  sqliteDataFile,
} from '../../src/platform/storage/sqlite/index.js';
import { createRepository, type Entity, type Repository } from '../../src/platform/storage/index.js';

interface Widget extends Entity {
  name: string;
  env: string;
  score: number;
}

/** 临时文件库；返回 { db, file } */
function tmpDb(): { db: ReturnType<typeof createSqliteDatabase>; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p25s-')), 'platform.sqlite');
  return { db: createSqliteDatabase(file), file };
}

describe('SqliteRepository 基础语义（与 Memory/JSON 一致）', () => {
  it('create / get / update / delete / count / clear', async () => {
    const { db } = tmpDb();
    const r = new SqliteRepository<Widget>(db, 'widgets', 'widget');
    const w = await r.create({ name: 'a', env: 'test', score: 1 });
    expect(w.id).toMatch(/^widget-/);
    expect((await r.get(w.id))!.name).toBe('a');
    expect(await r.count()).toBe(1);
    const u = await r.update(w.id, { name: 'a2', score: 2 });
    expect(u.name).toBe('a2');
    expect((await r.get(w.id))!.score).toBe(2);
    await r.delete(w.id);
    expect(await r.get(w.id)).toBeNull();
    expect(await r.count()).toBe(0);
    await r.clear();
    db.close();
  });

  it('query 浅相等过滤 + 分页', async () => {
    const { db } = tmpDb();
    const r = new SqliteRepository<Widget>(db, 'widgets', 'widget');
    for (let i = 0; i < 5; i++) {
      await r.create({ id: `w${i}`, name: `n${i}`, env: i % 2 ? 'test' : 'dev', score: i });
    }
    const devs = await r.query({ env: 'dev' });
    expect(devs.map((d) => d.id)).toEqual(['w0', 'w2', 'w4']);
    const page = await r.query({ env: 'dev' }, { offset: 1, limit: 1 });
    expect(page.map((d) => d.id)).toEqual(['w2']);
    db.close();
  });

  it('重复 id create 抛错 / 更新删除不存在抛错', async () => {
    const { db } = tmpDb();
    const r = new SqliteRepository<Widget>(db, 'widgets', 'widget');
    await r.create({ id: 'dup', name: 'x', env: 'test', score: 0 });
    await expect(r.create({ id: 'dup', name: 'y', env: 'test', score: 1 })).rejects.toThrow(/已存在/);
    await expect(r.update('missing', { name: 'z' })).rejects.toThrow(/不存在/);
    await expect(r.delete('missing')).rejects.toThrow(/不存在/);
    db.close();
  });
});

describe('SqliteRepository 持久化', () => {
  it('写入文件后新连接可读回（跨进程持久化）', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p25s-')), 'platform.sqlite');
    const a = createSqliteDatabase(file);
    const ra = new SqliteRepository<Widget>(a, 'widgets', 'widget');
    await ra.create({ id: 'p1', name: 'persisted', env: 'production', score: 9 });
    a.close();

    const b = createSqliteDatabase(file);
    const rb = new SqliteRepository<Widget>(b, 'widgets', 'widget');
    expect((await rb.get('p1'))!.name).toBe('persisted');
    expect(await rb.count()).toBe(1);
    b.close();
  });

  it('WAL 模式下同一文件可多次开关（幂等 ensureCollection）', () => {
    const { db, file } = tmpDb();
    ensureCollection(db, 'widgets');
    ensureCollection(db, 'widgets');
    db.exec('CREATE TABLE IF NOT EXISTS "widgets" (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.close();
    const b = createSqliteDatabase(file);
    ensureCollection(b, 'widgets');
    b.close();
  });
});

describe('SqliteRepository 事务', () => {
  it('withTransaction 全部成功提交', async () => {
    const { db } = tmpDb();
    const r = new SqliteRepository<Widget>(db, 'widgets', 'widget');
    await r.transaction(async () => {
      await r.create({ id: 't1', name: 'x', env: 'test', score: 1 });
      await r.create({ id: 't2', name: 'y', env: 'test', score: 2 });
    });
    expect(await r.count()).toBe(2);
    db.close();
  });

  it('withTransaction 中途失败整体回滚', async () => {
    const { db } = tmpDb();
    const r = new SqliteRepository<Widget>(db, 'widgets', 'widget');
    await expect(
      r.transaction(async () => {
        await r.create({ id: 'r1', name: 'x', env: 'test', score: 1 });
        await r.create({ id: 'dup', name: 'y', env: 'test', score: 2 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await r.count()).toBe(0);
    db.close();
  });
});

describe('createRepository 工厂接入 sqlite', () => {
  it('同一 DatabaseSync 上多个集合共存', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p25s-')), 'platform.sqlite');
    const db = createSqliteDatabase(file);
    const runs = createRepository<Widget>('sqlite', { collection: 'runs', db });
    const jobs = createRepository<Widget>('sqlite', { collection: 'jobs', db });
    await runs.create({ id: 'r1', name: 'run', env: 'test', score: 1 });
    await jobs.create({ id: 'j1', name: 'job', env: 'test', score: 1 });
    expect(await runs.count()).toBe(1);
    expect(await jobs.count()).toBe(1);
    expect((await runs.get('r1'))!.name).toBe('run');
    expect((await jobs.get('j1'))!.name).toBe('job');
    db.close();
  });

  it('sqlite 未传 db 连接时报错', () => {
    expect(() => createRepository<Widget>('sqlite', { collection: 'w' })).toThrow(/db/);
  });
});

describe('sqliteDataFile 辅助', () => {
  it('生成统一数据文件路径', () => {
    expect(sqliteDataFile('/tmp/x')).toBe(path.join('/tmp/x', 'platform.sqlite'));
  });
});
