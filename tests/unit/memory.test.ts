// 单元测试：Memory（JsonMemoryStore 持久化 / 查询 / 相似失败检索）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonMemoryStore } from '../../src/agents/memory/json-memory.js';
import { generateMemoryId } from '../../src/agents/memory/memory-store.js';
import type { MemoryRecord } from '../../src/agents/memory/memory-store.js';

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
    store.clear();
    expect(store.count()).toBe(0);
    expect(new JsonMemoryStore(file).count()).toBe(0);
  });

  it('文件损坏时重置为空', () => {
    fs.writeFileSync(file, '{{{ 坏文件', 'utf-8');
    const s2 = new JsonMemoryStore(file);
    expect(s2.count()).toBe(0);
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
