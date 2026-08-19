// 单元测试：共享脱敏模块（Phase 28.3）
// 覆盖：敏感字段掩码 / 嵌套对象 / 数组 / 非对象值透传 / 深度限制 / 平台与 Agent 共用同一实现。

import { describe, it, expect } from 'vitest';
import { redactSensitive, SENSITIVE_KEYS } from '../../src/core/redact.js';
// 兼容再导出：Agent Tool 层仍可从 tool.js 获取同一实现
import { redactSensitive as redactFromTool } from '../../src/agents/tools/tool.js';

describe('redactSensitive：敏感信息脱敏', () => {
  it('敏感字段值被掩码为 ***', () => {
    const out = redactSensitive({ password: 'secret', api_key: 'k', name: 'ok' }) as Record<string, unknown>;
    expect(out).toEqual({ password: '***', api_key: '***', name: 'ok' });
  });

  it('嵌套对象与数组递归脱敏', () => {
    const out = redactSensitive({ headers: { Authorization: 'Bearer x', 'X-Api-Key': 'y' }, arr: [{ token: 't', v: 1 }] }) as Record<string, unknown>;
    expect((out.headers as Record<string, unknown>).Authorization).toBe('***');
    expect((out.headers as Record<string, unknown>)['X-Api-Key']).toBe('***');
    expect((out.arr as unknown[])[0]).toEqual({ token: '***', v: 1 });
  });

  it('非对象值原样透传', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  it('深度受限：超过 6 层深的对象返回占位 [object]', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = redactSensitive(deep) as Record<string, any>;
    // g 位于深度 7（超出上限），返回占位；外层保持对象结构
    expect(out.a.b.c.d.e.f.g).toBe('[object]');
    expect(typeof out.a.b.c.d.e).toBe('object');
  });

  it('SENSITIVE_KEYS 覆盖常用敏感字段名', () => {
    for (const k of ['password', 'token', 'secret', 'authorization', 'api_key', 'private_key', 'cookie']) {
      expect(SENSITIVE_KEYS).toContain(k);
    }
  });

  it('平台 AuditLog 与 Agent Tool 使用同一实现（单一来源）', () => {
    expect(redactFromTool).toBe(redactSensitive);
    expect(redactFromTool({ password: 'x' })).toEqual({ password: '***' });
  });
});
