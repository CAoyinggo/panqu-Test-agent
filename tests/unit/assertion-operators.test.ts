// 单元测试：src/core/assertion-operators.ts
// 覆盖全部已注册断言操作符（含正向与反向用例）以及注册表 API
import { describe, it, expect } from 'vitest';
import {
  applyOperatorAsync,
  listOperators,
  hasOperator,
} from '../../src/core/assertion-operators.js';
import type { AssertionRule, AssertionOperator } from '../../src/core/assertion-operators.js';

// 构造最小可用 rule（operator 字段仅作元信息，applyOperatorAsync 以第一个参数为准）
function dummyRule(op: string): AssertionRule {
  return { target: 'test', path: '', operator: op as AssertionOperator };
}

// 执行操作符的便捷封装
async function run(
  op: string,
  actual: unknown,
  expected?: unknown,
): Promise<{ pass: boolean; detail: string }> {
  return applyOperatorAsync(op, actual, expected, dummyRule(op));
}

describe('assertion-operators - 注册表 API', () => {
  it('listOperators 返回全部已注册操作符', () => {
    const ops = listOperators();
    // 注意：源码实际注册了 17 个操作符（需求文档写 16，但列出的算上 jsonSchema 共 17 个）
    expect(ops).toHaveLength(17);
    // 抽样校验关键操作符均存在
    for (const name of [
      'equals', 'notEquals', 'contains', 'notContains',
      'exists', 'notExists', 'gt', 'gte', 'lt', 'lte',
      'in', 'notIn', 'regex', 'type', 'length', 'deepEquals', 'jsonSchema',
    ]) {
      expect(ops).toContain(name);
    }
  });

  it('hasOperator 对已知/未知操作符返回正确布尔值', () => {
    expect(hasOperator('equals')).toBe(true);
    expect(hasOperator('jsonSchema')).toBe(true);
    expect(hasOperator('deepEquals')).toBe(true);
    expect(hasOperator('notARealOperator')).toBe(false);
    expect(hasOperator('')).toBe(false);
  });

  it('未知操作符返回 pass=false 且 detail 提示 unknown operator', async () => {
    const r = await applyOperatorAsync('totallyUnknown', 1, 2, dummyRule('equals'));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('unknown operator');
  });
});

describe('assertion-operators - equals（严格相等 ===）', () => {
  it('正向：200 === 200', async () => {
    const r = await run('equals', 200, 200);
    expect(r.pass).toBe(true);
  });
  it('反向：200 !== 404', async () => {
    const r = await run('equals', 200, 404);
    expect(r.pass).toBe(false);
  });
  it('正向：字符串 "hello" === "hello"', async () => {
    const r = await run('equals', 'hello', 'hello');
    expect(r.pass).toBe(true);
  });
  it('反向：null !== undefined（严格相等不相等）', async () => {
    const r = await run('equals', null, undefined);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - notEquals（!==）', () => {
  it('正向：1 !== 2', async () => {
    const r = await run('notEquals', 1, 2);
    expect(r.pass).toBe(true);
  });
  it('反向：1 === 1（不应判为不等）', async () => {
    const r = await run('notEquals', 1, 1);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - contains（子串/数组元素）', () => {
  it('正向：字符串包含子串', async () => {
    const r = await run('contains', 'hello world', 'world');
    expect(r.pass).toBe(true);
  });
  it('反向：字符串不含子串', async () => {
    const r = await run('contains', 'hello', 'bye');
    expect(r.pass).toBe(false);
  });
  it('正向：数组包含元素', async () => {
    const r = await run('contains', [1, 2, 3], 2);
    expect(r.pass).toBe(true);
  });
  it('反向：数组不含元素', async () => {
    const r = await run('contains', [1, 2], 5);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - notContains', () => {
  it('正向：字符串不含子串', async () => {
    const r = await run('notContains', 'hello', 'bye');
    expect(r.pass).toBe(true);
  });
  it('反向：字符串含子串（不应判为不含）', async () => {
    const r = await run('notContains', 'hello', 'ell');
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - exists（非 undefined/null）', () => {
  it('正向：普通字符串存在', async () => {
    const r = await run('exists', 'val');
    expect(r.pass).toBe(true);
  });
  it('反向：undefined 不存在', async () => {
    const r = await run('exists', undefined);
    expect(r.pass).toBe(false);
  });
  it('反向：null 不存在', async () => {
    const r = await run('exists', null);
    expect(r.pass).toBe(false);
  });
  it('正向：0 存在（不视作空值）', async () => {
    const r = await run('exists', 0);
    expect(r.pass).toBe(true);
  });
  it('正向：空字符串存在（不视作空值）', async () => {
    const r = await run('exists', '');
    expect(r.pass).toBe(true);
  });
});

describe('assertion-operators - notExists（undefined/null）', () => {
  it('正向：undefined notExists', async () => {
    const r = await run('notExists', undefined);
    expect(r.pass).toBe(true);
  });
  it('正向：null notExists', async () => {
    const r = await run('notExists', null);
    expect(r.pass).toBe(true);
  });
  it('反向：有值不应判为 notExists', async () => {
    const r = await run('notExists', 'val');
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - gt（大于）', () => {
  it('正向：10 > 5', async () => {
    const r = await run('gt', 10, 5);
    expect(r.pass).toBe(true);
  });
  it('反向：3 > 5 不成立', async () => {
    const r = await run('gt', 3, 5);
    expect(r.pass).toBe(false);
  });
  it('正向：字符串 "10" 经数值强制转换后 > 5', async () => {
    const r = await run('gt', '10', 5);
    expect(r.pass).toBe(true);
  });
});

describe('assertion-operators - gte（大于等于）', () => {
  it('正向：5 >= 5', async () => {
    const r = await run('gte', 5, 5);
    expect(r.pass).toBe(true);
  });
  it('反向：3 >= 5 不成立', async () => {
    const r = await run('gte', 3, 5);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - lt（小于）', () => {
  it('正向：3 < 5', async () => {
    const r = await run('lt', 3, 5);
    expect(r.pass).toBe(true);
  });
  it('反向：10 < 5 不成立', async () => {
    const r = await run('lt', 10, 5);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - lte（小于等于）', () => {
  it('正向：5 <= 5', async () => {
    const r = await run('lte', 5, 5);
    expect(r.pass).toBe(true);
  });
  it('反向：10 <= 5 不成立', async () => {
    const r = await run('lte', 10, 5);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - in（值在列表中）', () => {
  it('正向：字符串在数组中', async () => {
    const r = await run('in', 'a', ['a', 'b']);
    expect(r.pass).toBe(true);
  });
  it('反向：字符串不在数组中', async () => {
    const r = await run('in', 'c', ['a', 'b']);
    expect(r.pass).toBe(false);
  });
  it('正向：数字在数组中', async () => {
    const r = await run('in', 1, [1, 2, 3]);
    expect(r.pass).toBe(true);
  });
});

describe('assertion-operators - notIn（值不在列表中）', () => {
  it('正向：字符串不在数组中', async () => {
    const r = await run('notIn', 'c', ['a', 'b']);
    expect(r.pass).toBe(true);
  });
  it('反向：字符串在数组中（不应判为 notIn）', async () => {
    const r = await run('notIn', 'a', ['a', 'b']);
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - regex（正则匹配）', () => {
  it('正向：邮箱匹配 ^[^@]+@', async () => {
    const r = await run('regex', 'test@example.com', '^[^@]+@');
    expect(r.pass).toBe(true);
  });
  it('反向：非邮箱不匹配 ^[^@]+@', async () => {
    const r = await run('regex', 'no-email', '^[^@]+@');
    expect(r.pass).toBe(false);
  });
});

describe('assertion-operators - type（类型校验）', () => {
  it('正向：字符串', async () => {
    expect((await run('type', 'str', 'string')).pass).toBe(true);
  });
  it('正向：数字', async () => {
    expect((await run('type', 42, 'number')).pass).toBe(true);
  });
  it('正向：数组（type=array）', async () => {
    expect((await run('type', [1], 'array')).pass).toBe(true);
  });
  it('正向：对象（type=object）', async () => {
    expect((await run('type', { a: 1 }, 'object')).pass).toBe(true);
  });
  it('正向：null（type=null）', async () => {
    expect((await run('type', null, 'null')).pass).toBe(true);
  });
  it('正向：undefined（type=undefined）', async () => {
    expect((await run('type', undefined, 'undefined')).pass).toBe(true);
  });
  it('反向：数字不匹配 string', async () => {
    expect((await run('type', 42, 'string')).pass).toBe(false);
  });
});

describe('assertion-operators - length（长度校验）', () => {
  it('正向：数组长度', async () => {
    expect((await run('length', [1, 2, 3], 3)).pass).toBe(true);
  });
  it('正向：字符串长度', async () => {
    expect((await run('length', 'hello', 5)).pass).toBe(true);
  });
  it('正向：对象键数量', async () => {
    expect((await run('length', { a: 1, b: 2 }, 2)).pass).toBe(true);
  });
  it('反向：长度不匹配', async () => {
    expect((await run('length', [1], 3)).pass).toBe(false);
  });
});

describe('assertion-operators - deepEquals（深度相等）', () => {
  it('正向：嵌套对象深度相等', async () => {
    const r = await run('deepEquals', { a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });
    expect(r.pass).toBe(true);
  });
  it('反向：值不同', async () => {
    const r = await run('deepEquals', { a: 1 }, { a: 2 });
    expect(r.pass).toBe(false);
  });
  it('正向：数组深度相等', async () => {
    const r = await run('deepEquals', [1, 2, 3], [1, 2, 3]);
    expect(r.pass).toBe(true);
  });
});

describe('assertion-operators - jsonSchema（JSON Schema 校验，基于 ajv）', () => {
  const schema = {
    type: 'object',
    required: ['text', 'tokens'],
    properties: {
      text: { type: 'string' },
      tokens: { type: 'number', minimum: 0 },
    },
  };

  it('正向：合法数据通过 schema', async () => {
    const r = await run('jsonSchema', { text: 'hello', tokens: 5 }, schema);
    expect(r.pass).toBe(true);
  });

  it('反向：text 类型错误（应为 string）不通过 schema', async () => {
    const r = await run('jsonSchema', { text: 123 }, schema);
    expect(r.pass).toBe(false);
  });

  it('无效 Schema 必须 fail-close，不得降级为 pass=true', async () => {
    await expect(run('jsonSchema', { text: 'hello' }, {
      type: 'definitely-not-a-json-schema-type',
    })).rejects.toMatchObject({ code: 'INVALID_TESTCASE' });
  });
});
