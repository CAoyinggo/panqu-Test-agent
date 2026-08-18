// 单元测试：Memory 知识系统（Phase 13 升级 / 任务书第十三节）
// 覆盖：querySimilarCase / queryHistoricalRisk / queryKnownIssue / queryCoverageGap
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
    data: { caseId: 'wan3-001', feature: 'wan3' },
    tags: [],
    ...partial,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-know-'));
  file = path.join(dir, 'memory.json');
  store = new JsonMemoryStore(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory - querySimilarCase', () => {
  it('按 caseId 精确匹配（含 caseIds 数组 / 标签命中）', async () => {
    await store.save(makeRecord({ type: 'execution', data: { caseId: 'wan3-001' } }));
    await store.save(makeRecord({ type: 'failure', data: { caseIds: ['wan3-001', 'wan3-002'] } }));
    await store.save(makeRecord({ type: 'execution', data: { caseId: 'wan3-003' } }));
    await store.save(makeRecord({ type: 'flaky', data: {}, tags: ['wan3-001'] }));

    const hit = await store.querySimilarCase('wan3-001');
    expect(hit).toHaveLength(3);
    expect(new Set(hit.map((r) => r.type))).toEqual(new Set(['execution', 'failure', 'flaky']));
  });

  it('无匹配返回空数组', async () => {
    await store.save(makeRecord({ data: { caseId: 'wan3-001' } }));
    expect(await store.querySimilarCase('wan3-999')).toHaveLength(0);
  });
});

describe('memory - queryHistoricalRisk', () => {
  it('返回某功能的失败/根因/flaky 记录', async () => {
    await store.save(makeRecord({ type: 'failure', data: { feature: 'wan3', category: 'MODEL_ERROR' } }));
    await store.save(makeRecord({ type: 'root-cause', data: { feature: 'wan3' } }));
    await store.save(makeRecord({ type: 'flaky', data: { feature: 'wan3' } }));
    await store.save(makeRecord({ type: 'execution', data: { feature: 'wan3' } })); // 不应包含

    const risks = await store.queryHistoricalRisk('wan3');
    expect(risks).toHaveLength(3);
    expect(risks.every((r) => r.type !== 'execution')).toBe(true);
  });

  it('按时间倒序', async () => {
    const t1 = '2026-08-01T00:00:00.000Z';
    const t2 = '2026-08-02T00:00:00.000Z';
    await store.save(makeRecord({ id: 'a', type: 'failure', createdAt: t1, data: { feature: 'wan3' } }));
    await store.save(makeRecord({ id: 'b', type: 'flaky', createdAt: t2, data: { feature: 'wan3' } }));
    expect((await store.queryHistoricalRisk('wan3')).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('memory - queryKnownIssue', () => {
  it('返回缺陷/根因记录，可按功能过滤', async () => {
    await store.save(makeRecord({ type: 'defect', data: { feature: 'wan3', title: '模型 503' } }));
    await store.save(makeRecord({ type: 'root-cause', data: { feature: 'wan3' } }));
    await store.save(makeRecord({ type: 'defect', data: { feature: 'wan2', title: '其他' } }));
    await store.save(makeRecord({ type: 'failure', data: { feature: 'wan3' } })); // 不应包含

    expect(await store.queryKnownIssue()).toHaveLength(3);
    const wan3 = await store.queryKnownIssue('wan3');
    expect(wan3).toHaveLength(2);
    expect(wan3.every((r) => r.type !== 'failure')).toBe(true);
  });
});

describe('memory - queryCoverageGap', () => {
  it('返回 coverage-gap 记录，可按功能过滤', async () => {
    await store.save(makeRecord({ type: 'coverage-gap', data: { feature: 'wan3', gap: '1080P+10s 组合缺失' } }));
    await store.save(makeRecord({ type: 'coverage-gap', data: { feature: 'wan2', gap: '其他缺口' } }));
    await store.save(makeRecord({ type: 'execution', data: { feature: 'wan3' } })); // 不应包含

    expect(await store.queryCoverageGap()).toHaveLength(2);
    const gaps = await store.queryCoverageGap('wan3');
    expect(gaps).toHaveLength(1);
    expect((gaps[0].data as { gap: string }).gap).toBe('1080P+10s 组合缺失');
  });
});

describe('memory - 空实现兜底', () => {
  it('NoopMemory 各知识查询返回空数组', async () => {
    const { NoopMemory } = await import('../../src/agents/memory/memory-store.js');
    const noop = new NoopMemory();
    expect(await noop.querySimilarCase('x')).toEqual([]);
    expect(await noop.queryHistoricalRisk('x')).toEqual([]);
    expect(await noop.queryKnownIssue()).toEqual([]);
    expect(await noop.queryCoverageGap()).toEqual([]);
  });
});
