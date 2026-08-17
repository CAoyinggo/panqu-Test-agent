// 单元测试：src/core/path-extractor.ts
// 覆盖 extractPath / pathExists / formatValue / extractPathWithMeta
import { describe, it, expect } from 'vitest';
import {
  extractPath,
  pathExists,
  formatValue,
  extractPathWithMeta,
} from '../../src/core/path-extractor.js';

const obj = {
  body: {
    data: [
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ],
    total: 2,
    model: 'wan3.0',
  },
  headers: { 'content-type': 'application/json' },
  status: 200,
  nested: { a: { b: { c: { d: 'deep' } } } },
};

describe('path-extractor - extractPath', () => {
  it('数组索引访问 body.data[0].id', () => {
    expect(extractPath(obj, 'body.data[0].id')).toBe(1);
  });

  it('数组索引访问 body.data[1].name', () => {
    expect(extractPath(obj, 'body.data[1].name')).toBe('B');
  });

  it('通配符 body.data[*].name 返回所有元素 name 数组', () => {
    expect(extractPath(obj, 'body.data[*].name')).toEqual(['A', 'B']);
  });

  it('普通字段 body.total', () => {
    expect(extractPath(obj, 'body.total')).toBe(2);
  });

  it('普通字段 body.model', () => {
    expect(extractPath(obj, 'body.model')).toBe('wan3.0');
  });

  it('含连字符的 key headers.content-type', () => {
    expect(extractPath(obj, 'headers.content-type')).toBe('application/json');
  });

  it('顶层字段 status', () => {
    expect(extractPath(obj, 'status')).toBe(200);
  });

  it('深层嵌套 nested.a.b.c.d', () => {
    expect(extractPath(obj, 'nested.a.b.c.d')).toBe('deep');
  });

  it('不存在的字段返回 undefined', () => {
    expect(extractPath(obj, 'body.nonexistent')).toBeUndefined();
  });

  it('数组越界索引返回 undefined', () => {
    expect(extractPath(obj, 'body.data[99].id')).toBeUndefined();
  });

  it('通配符下无匹配返回空数组', () => {
    expect(extractPath(obj, 'body.data[*].nonexistent')).toEqual([]);
  });

  it('空路径返回 undefined', () => {
    expect(extractPath(obj, '')).toBeUndefined();
  });

  it('null 对象返回 undefined', () => {
    expect(extractPath(null, 'x')).toBeUndefined();
  });
});

describe('path-extractor - pathExists', () => {
  it('存在的路径返回 true', () => {
    expect(pathExists(obj, 'body.total')).toBe(true);
  });

  it('不存在的路径返回 false', () => {
    expect(pathExists(obj, 'body.nonexistent')).toBe(false);
  });
});

describe('path-extractor - formatValue', () => {
  it('undefined → "undefined"', () => {
    expect(formatValue(undefined)).toBe('undefined');
  });
  it('null → "null"', () => {
    expect(formatValue(null)).toBe('null');
  });
  it('字符串带双引号', () => {
    expect(formatValue('hello')).toBe('"hello"');
  });
  it('数字', () => {
    expect(formatValue(42)).toBe('42');
  });
  it('布尔', () => {
    expect(formatValue(true)).toBe('true');
  });
  it('对象 JSON 序列化', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('path-extractor - extractPathWithMeta', () => {
  it('body.data[0].id：返回值、parent 为数组元素、lastKey 为 id', () => {
    const meta = extractPathWithMeta(obj, 'body.data[0].id');
    expect(meta.value).toBe(1);
    expect(meta.matched).toBe(true);
    expect(meta.path).toBe('body.data[0].id');
    expect(meta.parent).toEqual({ id: 1, name: 'A' });
    expect(meta.lastKey).toBe('id');
  });

  it('body.nonexistent：未匹配，parent 为 body、lastKey 为 nonexistent', () => {
    const meta = extractPathWithMeta(obj, 'body.nonexistent');
    expect(meta.value).toBeUndefined();
    expect(meta.matched).toBe(false);
    expect(meta.path).toBe('body.nonexistent');
    expect(meta.parent).toEqual({
      data: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
      total: 2,
      model: 'wan3.0',
    });
    expect(meta.lastKey).toBe('nonexistent');
  });

  it('body.data[*].name：通配符收集结果，parent 为 data 数组、lastKey 为 *', () => {
    const meta = extractPathWithMeta(obj, 'body.data[*].name');
    expect(meta.value).toEqual(['A', 'B']);
    expect(meta.matched).toBe(true);
    expect(meta.path).toBe('body.data[*].name');
    expect(meta.parent).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
    expect(meta.lastKey).toBe('*');
  });

  it('status：顶层字段，parent 为整个对象、lastKey 为 status', () => {
    const meta = extractPathWithMeta(obj, 'status');
    expect(meta.value).toBe(200);
    expect(meta.matched).toBe(true);
    expect(meta.path).toBe('status');
    expect(meta.parent).toBe(obj);
    expect(meta.lastKey).toBe('status');
  });
});
