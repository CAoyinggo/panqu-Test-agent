// 单元测试：Idempotency Store（Phase 24.7）
// 覆盖：begin / complete / repeated 返回既有结果 / has / clear /
//       kind 隔离（不同操作种类同键互不干扰）/ 重复 complete 幂等。

import { describe, it, expect } from 'vitest';
import { IdempotencyStore } from '../../src/platform/service/index.js';
import { InMemoryRepository } from '../../src/platform/storage/index.js';
import type { IdempotencyRecord } from '../../src/platform/service/index.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

function makeStore(): IdempotencyStore {
  const repo = new InMemoryRepository<IdempotencyRecord>('idem');
  return new IdempotencyStore(repo, { now: () => FIXED_ISO });
}

describe('IdempotencyStore', () => {
  it('begin 首次返回 repeated=false，并创建占位记录', async () => {
    const s = makeStore();
    const r = await s.begin('run', 'ABC');
    expect(r.repeated).toBe(false);
    expect(r.resultId).toBeNull();
    expect(await s.has('run', 'ABC')).toBe(true);
  });

  it('同一 key 重复 begin 返回 repeated=true 与既有结果', async () => {
    const s = makeStore();
    await s.begin('run', 'ABC');
    await s.complete('run', 'ABC', 'run-1');
    const r = await s.begin('run', 'ABC');
    expect(r.repeated).toBe(true);
    expect(r.resultId).toBe('run-1');
  });

  it('complete 绑定结果；重复 begin 不产生重复 Run', async () => {
    const s = makeStore();
    await s.begin('run', 'KEY-1');
    await s.complete('run', 'KEY-1', 'run-42');
    // 第二次请求：直接返回既有 runId，不再创建
    const second = await s.begin('run', 'KEY-1');
    expect(second.repeated).toBe(true);
    expect(second.resultId).toBe('run-42');
  });

  it('complete 绑定不存在 key 时创建完整记录', async () => {
    const s = makeStore();
    await s.complete('run', 'X', 'run-9');
    expect(await s.has('run', 'X')).toBe(true);
    const r = await s.begin('run', 'X');
    expect(r.repeated).toBe(true);
    expect(r.resultId).toBe('run-9');
  });

  it('kind 隔离：不同操作种类同 key 互不干扰', async () => {
    const s = makeStore();
    await s.begin('run', 'ABC');
    await s.complete('run', 'ABC', 'run-1');
    await s.begin('defect', 'ABC');
    await s.complete('defect', 'ABC', 'def-1');
    const run = await s.begin('run', 'ABC');
    const defect = await s.begin('defect', 'ABC');
    expect(run.resultId).toBe('run-1');
    expect(defect.resultId).toBe('def-1');
  });

  it('clear 清空全部记录', async () => {
    const s = makeStore();
    await s.complete('run', 'A', 'r1');
    await s.complete('defect', 'B', 'd1');
    expect(await s.has('run', 'A')).toBe(true);
    await s.clear();
    expect(await s.has('run', 'A')).toBe(false);
    expect(await s.has('defect', 'B')).toBe(false);
  });
});
