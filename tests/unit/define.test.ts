// 单元测试：src/cases/define.ts
// 覆盖 assert / assertAll / assertAny / assertSoft / assertRules / defineCase
import { describe, it, expect } from 'vitest';
import {
  defineCase,
  assertRules,
  assertAll,
  assertAny,
  assertSoft,
  assert,
} from '../../src/cases/define.js';
import type { TaskDef } from '../../src/core/types.js';

describe('define.ts - assert()', () => {
  it('带 expected 与 message 时构造完整规则', () => {
    const r = assert('response', 'status', 'equals', 200, 'HTTP 200');
    expect(r).toEqual({
      target: 'response',
      path: 'status',
      operator: 'equals',
      expected: 200,
      message: 'HTTP 200',
    });
  });

  it('仅必填字段时 expected/message 为 undefined', () => {
    const r = assert('response', 'json.code', 'exists');
    expect(r).toMatchObject({
      target: 'response',
      path: 'json.code',
      operator: 'exists',
    });
    expect(r.expected).toBeUndefined();
    expect(r.message).toBeUndefined();
  });
});

describe('define.ts - assertAll()', () => {
  it('返回 all 模式断言组，rules 长度与入参一致', () => {
    const r1 = assert('response', 'status', 'equals', 200);
    const r2 = assert('response', 'json.code', 'exists');
    const g = assertAll(r1, r2);
    expect(g.mode).toBe('all');
    expect(g.rules).toHaveLength(2);
    expect(g.rules).toEqual([r1, r2]);
  });
});

describe('define.ts - assertAny()', () => {
  it('返回 any 模式断言组', () => {
    const r1 = assert('response', 'status', 'equals', 200);
    const r2 = assert('response', 'status', 'equals', 404);
    const g = assertAny(r1, r2);
    expect(g.mode).toBe('any');
    expect(g.rules).toHaveLength(2);
    expect(g.rules).toEqual([r1, r2]);
  });
});

describe('define.ts - assertSoft()', () => {
  it('返回 soft 模式断言组', () => {
    const r1 = assert('response', 'status', 'equals', 200);
    const r2 = assert('response', 'json.code', 'exists');
    const g = assertSoft(r1, r2);
    expect(g.mode).toBe('soft');
    expect(g.rules).toHaveLength(2);
    expect(g.rules).toEqual([r1, r2]);
  });
});

describe('define.ts - assertRules()', () => {
  it('接受数组入参，返回 all 模式断言组', () => {
    const r1 = assert('response', 'status', 'equals', 200);
    const r2 = assert('response', 'json.code', 'exists');
    const g = assertRules([r1, r2]);
    expect(g.mode).toBe('all');
    expect(g.rules).toHaveLength(2);
    expect(g.rules).toEqual([r1, r2]);
  });
});

describe('define.ts - defineCase()', () => {
  it('原样返回输入对象（同一引用）', () => {
    const def: TaskDef = { name: 'demo-case', scene: 'video' };
    const result = defineCase(def);
    expect(result).toBe(def);
    expect(result).toEqual({ name: 'demo-case', scene: 'video' });
  });

  it('保留完整字段（含 assert 配置）', () => {
    const def: TaskDef = {
      name: 'wan3-quanneng',
      scene: 'video',
      model_id: 'wan3.0',
      tags: ['P0', 'regression'],
      assert: assertRules([assert('response', 'status', 'equals', 200)]),
    };
    const result = defineCase(def);
    expect(result).toBe(def);
    expect(result.name).toBe('wan3-quanneng');
    expect(result.scene).toBe('video');
    expect(result.model_id).toBe('wan3.0');
    expect(result.tags).toEqual(['P0', 'regression']);
    expect(result.assert).toBeDefined();
    expect(result.assert!.mode).toBe('all');
  });
});
