// 单元测试：src/core/assertion-engine.ts
// 覆盖 runGenericAssertions / parseAssertionRules / extractValue / 工厂函数 / 组合模式
import { describe, it, expect } from 'vitest';
import {
  runGenericAssertions,
  parseAssertionRules,
  extractValue,
  assertAll,
  assertAny,
  assertSoft,
  rule,
} from '../../src/core/assertion-engine.js';
import type { AssertionContext, AssertionGroup } from '../../src/core/assertion-engine.js';

const context: AssertionContext = {
  response: {
    status: 200,
    json: { code: 1, data: [{ id: 1, name: 'A' }], total: 1 },
    headers: { 'content-type': 'application/json' },
    durationMs: 100,
  },
  submit: { taskId: 123, status: '完成' },
  billing: { cost: 10, actualConsumed: 240 },
  metrics: { durationMs: 100, apiCalls: 5 },
  custom: { user: 'admin', tags: ['P0'] },
};

describe('assertion-engine - extractValue', () => {
  it('response.status → 200', () => {
    expect(extractValue(context, 'response', 'status')).toBe(200);
  });
  it('response.json.code → 1', () => {
    expect(extractValue(context, 'response', 'json.code')).toBe(1);
  });
  it('response.json.data[0].id → 1', () => {
    expect(extractValue(context, 'response', 'json.data[0].id')).toBe(1);
  });
  it('response.json.data[*].name → ["A"]', () => {
    expect(extractValue(context, 'response', 'json.data[*].name')).toEqual(['A']);
  });
  it('submit.status → "完成"', () => {
    expect(extractValue(context, 'submit', 'status')).toBe('完成');
  });
  it('billing.cost → 10', () => {
    expect(extractValue(context, 'billing', 'cost')).toBe(10);
  });
  it('metrics.durationMs → 100', () => {
    expect(extractValue(context, 'metrics', 'durationMs')).toBe(100);
  });
  it('custom.user → "admin"', () => {
    expect(extractValue(context, 'custom', 'user')).toBe('admin');
  });
});

describe('assertion-engine - parseAssertionRules', () => {
  it('数组入参被解析为 all 模式 group', () => {
    const r1 = rule('response', 'status', 'equals', 200);
    const r2 = rule('response', 'json.code', 'equals', 1);
    const group = parseAssertionRules([r1, r2]);
    expect(group.mode).toBe('all');
    expect(group.rules).toEqual([r1, r2]);
  });

  it('对象入参原样返回（同一引用）', () => {
    const input: AssertionGroup = {
      mode: 'any',
      rules: [rule('response', 'status', 'equals', 200)],
    };
    expect(parseAssertionRules(input)).toBe(input);
  });
});

describe('assertion-engine - 工厂函数', () => {
  const r1 = rule('response', 'status', 'equals', 200);
  const r2 = rule('response', 'json.code', 'exists');

  it('rule() 构造单条断言规则', () => {
    expect(r1).toMatchObject({
      target: 'response',
      path: 'status',
      operator: 'equals',
      expected: 200,
    });
    expect(r1.message).toBeUndefined();
  });

  it('assertAll() 返回 all 模式组', () => {
    expect(assertAll(r1, r2)).toEqual({ mode: 'all', rules: [r1, r2] });
  });
  it('assertAny() 返回 any 模式组', () => {
    expect(assertAny(r1, r2)).toEqual({ mode: 'any', rules: [r1, r2] });
  });
  it('assertSoft() 返回 soft 模式组', () => {
    expect(assertSoft(r1, r2)).toEqual({ mode: 'soft', rules: [r1, r2] });
  });
});

describe('assertion-engine - all 模式（AND，短路）', () => {
  it('全部通过：返回 3 条结果且全部 pass', async () => {
    const config = assertAll(
      rule('response', 'status', 'equals', 200),
      rule('response', 'json.code', 'equals', 1),
      rule('response', 'json.total', 'equals', 1),
    );
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it('遇到失败立即短路：第 2 条失败，仅返回 2 条结果（第 3 条不执行）', async () => {
    const config = assertAll(
      rule('response', 'status', 'equals', 200), // pass
      rule('response', 'json.code', 'equals', 999), // fail → 短路
      rule('response', 'json.total', 'equals', 1), // 不执行
    );
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(2);
    expect(results[0].pass).toBe(true);
    expect(results[1].pass).toBe(false);
  });
});

describe('assertion-engine - any 模式（OR，短路）', () => {
  it('第 1 条失败、第 2 条通过：短路返回 2 条结果', async () => {
    const config = assertAny(
      rule('response', 'status', 'equals', 404), // fail
      rule('response', 'status', 'equals', 200), // pass → 短路
      rule('response', 'json.code', 'equals', 1), // 不执行
    );
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(2);
    expect(results[0].pass).toBe(false);
    expect(results[1].pass).toBe(true);
  });

  it('全部失败：返回 3 条结果且全部不通过', async () => {
    const config = assertAny(
      rule('response', 'status', 'equals', 404),
      rule('response', 'json.code', 'equals', 999),
      rule('response', 'json.total', 'equals', 999),
    );
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.pass)).toBe(true);
  });

  it('combinator:"or" 作为 any 的别名', async () => {
    const config: AssertionGroup = {
      combinator: 'or',
      rules: [
        rule('response', 'status', 'equals', 404), // fail
        rule('response', 'status', 'equals', 200), // pass → 短路
        rule('response', 'json.code', 'equals', 1), // 不执行
      ],
    };
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(2);
    expect(results[0].pass).toBe(false);
    expect(results[1].pass).toBe(true);
  });
});

describe('assertion-engine - soft 模式（收集全部，不中断）', () => {
  it('2 通过 + 2 失败：返回 4 条结果（全部收集）', async () => {
    const config = assertSoft(
      rule('response', 'status', 'equals', 200), // pass
      rule('response', 'json.code', 'equals', 999), // fail
      rule('response', 'json.total', 'equals', 1), // pass
      rule('response', 'status', 'equals', 404), // fail
    );
    const results = await runGenericAssertions(config, context);
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.pass)).toHaveLength(2);
    expect(results.filter((r) => !r.pass)).toHaveLength(2);
  });
});

describe('assertion-engine - 嵌套组合', () => {
  it('all 模式内嵌 any 子组：子组首条通过即短路，结果扁平展开', async () => {
    const config = assertAll(
      rule('response', 'status', 'equals', 200), // pass
      assertAny(
        rule('response', 'json.code', 'equals', 1), // pass → any 短路
        rule('response', 'json.total', 'equals', 1), // 不执行
      ),
      rule('response', 'json.total', 'equals', 1), // pass
    );
    const results = await runGenericAssertions(config, context);
    // rule1 + 子组(1 条) + rule3 = 3 条，全部通过
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

describe('assertion-engine - CheckResult 扩展字段', () => {
  it('结果包含 assertionType/path/operator/expected/actual/durationMs', async () => {
    const config = [rule('response', 'status', 'equals', 200, 'HTTP 200')];
    const results = await runGenericAssertions(config, context);
    const r = results[0];
    expect(r.pass).toBe(true);
    expect(r.name).toBe('HTTP 200');
    expect(r.assertionType).toBe('response');
    expect(r.path).toBe('status');
    expect(r.operator).toBe('equals');
    expect(r.expected).toBe(200);
    expect(r.actual).toBe(200);
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});
