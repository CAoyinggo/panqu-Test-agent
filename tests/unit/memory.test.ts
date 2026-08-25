// 单元测试：Memory（JsonMemoryStore 持久化 / 查询 / 相似失败检索）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersistentMemory, JsonMemoryStore } from '../../src/agents/memory/json-memory.js';
import { SqliteMemoryStore } from '../../src/agents/memory/sqlite-memory.js';
import { generateMemoryId } from '../../src/agents/memory/memory-store.js';
import type { MemoryRecord } from '../../src/agents/memory/memory-store.js';
import { fileVersion, withFileLock } from '../../src/utils/atomic-fs.js';

let dir: string;
let file: string;
let store: JsonMemoryStore;

function makeRecord(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: generateMemoryId(),
    type: 'execution',
    createdAt: new Date().toISOString(),
    data: { caseId: 'wan3-001' },
    tags: [],
    ...partial,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  file = path.join(dir, 'memory.json');
  store = new JsonMemoryStore(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory - save / query', () => {
  it('save 后可在内存查询', async () => {
    await store.save(makeRecord({ type: 'execution', data: { caseId: 'wan3-001' }, tags: ['P0'] }));
    const all = await store.query();
    expect(all).toHaveLength(1);
    expect(store.count()).toBe(1);
  });

  it('save 持久化到文件，重建可恢复', async () => {
    await store.save(makeRecord({ type: 'failure', data: { caseId: 'wan3-002' } }));
    const store2 = new JsonMemoryStore(file);
    expect(store2.count()).toBe(1);
    expect((await store2.query({ type: 'failure' }))[0].data.caseId).toBe('wan3-002');
  });

  it('按类型 / 标签 / 时间范围 / limit 过滤', async () => {
    const t1 = '2026-08-01T00:00:00.000Z';
    const t2 = '2026-08-02T00:00:00.000Z';
    const t3 = '2026-08-03T00:00:00.000Z';
    await store.save(makeRecord({ id: 'r1', type: 'failure', createdAt: t1, tags: ['P0', 'model'] }));
    await store.save(makeRecord({ id: 'r2', type: 'root-cause', createdAt: t2, tags: ['model'] }));
    await store.save(makeRecord({ id: 'r3', type: 'failure', createdAt: t3, tags: ['P1'] }));

    expect((await store.query({ type: 'failure' })).map((r) => r.id).sort()).toEqual(['r1', 'r3']);
    expect((await store.query({ tags: ['model'] })).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect((await store.query({ from: t2, to: t3 })).map((r) => r.id).sort()).toEqual(['r2', 'r3']);
    expect((await store.query({ limit: 1 }))).toHaveLength(1);
  });

  it('时间倒序返回', async () => {
    await store.save(makeRecord({ id: 'old', createdAt: '2026-08-01T00:00:00.000Z' }));
    await store.save(makeRecord({ id: 'new', createdAt: '2026-08-03T00:00:00.000Z' }));
    const all = await store.query();
    expect(all[0].id).toBe('new');
  });

  it('clear 清空并持久化', async () => {
    await store.save(makeRecord());
    await store.clear();
    expect(store.count()).toBe(0);
    expect(new JsonMemoryStore(file).count()).toBe(0);
  });

  it('文件损坏时重置为空', () => {
    fs.writeFileSync(file, '{{{ 坏文件', 'utf-8');
    const s2 = new JsonMemoryStore(file);
    expect(s2.count()).toBe(0);
  });
});

describe('memory - concurrent persistence contract', () => {
  it('多实例并发写不丢记录，且不遗留共享 tmp/lock 文件', async () => {
    const stores = Array.from({ length: 8 }, () => new JsonMemoryStore(file));
    const total = 80;
    await Promise.all(Array.from({ length: total }, (_, index) =>
      stores[index % stores.length].save(makeRecord({
        id: `concurrent-${index}`,
        data: { caseId: `case-${index}` },
      })),
    ));

    const persisted = await new JsonMemoryStore(file).query();
    expect(persisted).toHaveLength(total);
    expect(new Set(persisted.map((record) => record.id)).size).toBe(total);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('CAS 合并外部实例的新版本，长生命周期实例也能刷新读取', async () => {
    const first = new JsonMemoryStore(file);
    const second = new JsonMemoryStore(file);
    await first.save(makeRecord({ id: 'from-first' }));
    await second.save(makeRecord({ id: 'from-second' }));

    expect((await first.query()).map((record) => record.id).sort()).toEqual(['from-first', 'from-second']);
    expect((await second.query()).map((record) => record.id).sort()).toEqual(['from-first', 'from-second']);
  });

  it('CAS 使用内容哈希，能识别相同 size/mtime 的内容变化', () => {
    const fixed = new Date('2026-08-22T00:00:00.000Z');
    fs.writeFileSync(file, '{"v":"aaaa"}\n');
    fs.utimesSync(file, fixed, fixed);
    const before = fileVersion(file);
    fs.writeFileSync(file, '{"v":"bbbb"}\n');
    fs.utimesSync(file, fixed, fixed);
    expect(fileVersion(file)).not.toBe(before);
  });

  it('不会把超过 staleMs 但持有进程仍存活的锁误判为陈旧锁', async () => {
    let secondEntered = false;
    const first = withFileLock(file, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }, { staleMs: 5, timeoutMs: 200, retryBaseMs: 2 });
    await new Promise((resolve) => setTimeout(resolve, 15));

    await expect(withFileLock(file, async () => {
      secondEntered = true;
    }, { staleMs: 5, timeoutMs: 25, retryBaseMs: 2 })).rejects.toThrow('文件锁获取超时');
    expect(secondEntered).toBe(false);
    await first;
  });

  it('可接管已确认死亡的本机陈旧锁，并清理仲裁文件', async () => {
    const lockFile = `${file}.lock`;
    fs.writeFileSync(lockFile, JSON.stringify({
      owner: 'dead-owner',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: Date.now() - 60_000,
    }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);

    let entered = false;
    await withFileLock(file, async () => { entered = true; }, { staleMs: 5, timeoutMs: 200, retryBaseMs: 2 });
    expect(entered).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(fs.existsSync(`${lockFile}.reclaim`)).toBe(false);
  });

  it('属主不可验证的旧格式锁默认拒绝接管', async () => {
    const lockFile = `${file}.lock`;
    fs.writeFileSync(lockFile, 'legacy-owner-uuid');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);

    await expect(withFileLock(file, async () => {}, {
      staleMs: 5,
      timeoutMs: 20,
      retryBaseMs: 2,
    })).rejects.toThrow('文件锁获取超时');
  });
});

describe('memory - getSimilarFailures', () => {
  it('按 caseId 强命中排序最高', async () => {
    await store.save(makeRecord({ id: 'a', type: 'failure', data: { caseId: 'wan3-001', category: 'MODEL_ERROR' } }));
    await store.save(makeRecord({ id: 'b', type: 'failure', data: { caseId: 'wan3-999', category: 'MODEL_ERROR' } }));
    const hits = await store.getSimilarFailures({ caseId: 'wan3-001', category: 'MODEL_ERROR' });
    expect(hits[0].id).toBe('a');
  });

  it('按标签与关键词匹配', async () => {
    await store.save(makeRecord({ id: 'a', type: 'failure', tags: ['flaky'], data: { message: '503 服务不可用' } }));
    await store.save(makeRecord({ id: 'b', type: 'execution', tags: ['flaky'], data: { message: '无关' } }));
    const hits = await store.getSimilarFailures({ caseId: 'x', tags: ['flaky'], message: '503' });
    expect(hits.some((r) => r.id === 'a')).toBe(true);
    // execution 类型不参与相似检索
    expect(hits.some((r) => r.id === 'b')).toBe(false);
  });

  it('无匹配返回空', async () => {
    expect(await store.getSimilarFailures({ caseId: 'none' })).toEqual([]);
  });
});

describe('memory - SQLite migration target', () => {
  it('持久化工厂按 .sqlite 扩展名选择 SQLite，JSON 保持默认', async () => {
    const json = await createPersistentMemory({ path: path.join(dir, 'factory') });
    expect(json).toBeInstanceOf(JsonMemoryStore);

    const sqlite = await createPersistentMemory({ path: path.join(dir, 'factory.sqlite') });
    expect(sqlite).toBeInstanceOf(SqliteMemoryStore);
    (sqlite as SqliteMemoryStore).close();
  });

  it('保持 TestMemory 写入/查询语义并支持重新打开', async () => {
    const sqliteFile = path.join(dir, 'memory.sqlite');
    const first = new SqliteMemoryStore(sqliteFile);
    await first.save(makeRecord({ id: 'sqlite-1', type: 'failure', tags: ['wan3'] }));
    first.close();

    const reopened = new SqliteMemoryStore(sqliteFile);
    expect((await reopened.query({ type: 'failure', tags: ['wan3'] })).map((record) => record.id)).toEqual(['sqlite-1']);
    reopened.close();
  });

  it('两个连接写入同一 WAL 数据库不会互相覆盖', async () => {
    const sqliteFile = path.join(dir, 'memory-concurrent.sqlite');
    const first = new SqliteMemoryStore(sqliteFile);
    const second = new SqliteMemoryStore(sqliteFile);
    try {
      await Promise.all([
        ...Array.from({ length: 20 }, (_, index) => first.save(makeRecord({ id: `a-${index}` }))),
        ...Array.from({ length: 20 }, (_, index) => second.save(makeRecord({ id: `b-${index}` }))),
      ]);
      expect(first.count()).toBe(40);
      expect(second.count()).toBe(40);
    } finally {
      first.close();
      second.close();
    }
  });
});
