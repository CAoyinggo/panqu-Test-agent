// 单元测试：共享脱敏模块（Phase 28.3）
// 覆盖：敏感字段掩码 / 嵌套对象 / 数组 / 非对象值透传 / 深度限制 / 平台与 Agent 共用同一实现。

import { describe, it, expect, vi } from 'vitest';
import { redactSensitive, redactSensitiveText, SENSITIVE_KEYS } from '../../src/core/redact.js';
// 兼容再导出：Agent Tool 层仍可从 tool.js 获取同一实现
import { redactSensitive as redactFromTool } from '../../src/agents/tools/tool.js';
import { logger, setNoColor } from '../../src/utils/logger.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';

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

  it('深度受限：深层对象返回占位，深层字符串仍必须脱敏', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = redactSensitive(deep) as Record<string, any>;
    // g 位于深度 7（超出上限），返回占位；外层保持对象结构
    expect(out.a.b.c.d.e.f.g).toBe('[object]');
    expect(typeof out.a.b.c.d.e).toBe('object');
    expect(redactSensitive('Bearer deeply-nested-secret', 7)).toBe('Bearer ***');
  });

  it('SENSITIVE_KEYS 覆盖常用敏感字段名', () => {
    for (const k of ['password', 'token', 'secret', 'authorization', 'api_key', 'private_key', 'cookie']) {
      expect(SENSITIVE_KEYS).toContain(k);
    }
  });

  it('preserves non-secret auth metadata without weakening credential redaction', () => {
    expect(redactSensitive({
      authPolicy: 'AUTH_REQUIRED',
      authenticationMode: 'oauth2',
      Authorization: 'Bearer real-secret',
      auth: 'real-secret',
      authToken: 'real-secret',
      'X-Api-Key': 'real-secret',
    })).toEqual({
      authPolicy: 'AUTH_REQUIRED',
      authenticationMode: 'oauth2',
      Authorization: '***',
      auth: '***',
      authToken: '***',
      'X-Api-Key': '***',
    });
  });

  it('平台 AuditLog 与 Agent Tool 使用同一实现（单一来源）', () => {
    expect(redactFromTool).toBe(redactSensitive);
    expect(redactFromTool({ password: 'x' })).toEqual({ password: '***' });
  });

  it('自由文本中的凭证、Authorization、URL 密码和 API Key 被脱敏', () => {
    const input = 'password=hunter2 Authorization: Bearer abc.def token=tok123 https://user:dbpass@example.test sk-1234567890abcdef';
    const output = redactSensitiveText(input);
    for (const secret of ['hunter2', 'abc.def', 'tok123', 'dbpass', 'sk-1234567890abcdef']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('***');
  });

  it('自由文本中完整遮盖 Basic Authorization、Cookie 链和带空格的引号密码', () => {
    const output = redactSensitiveText([
      'Authorization: Basic dXNlcjpwYXNz',
      'Authorization: Digest username=alice, realm=admin, nonce=deadbeef, response=secret',
      'Cookie: sid=abc; csrf=def',
      'password="secret world"',
      'token=unquoted secret words',
    ].join('\n'));
    for (const secret of ['dXNlcjpwYXNz', 'username=alice', 'nonce=deadbeef', 'sid=abc', 'csrf=def', 'secret world', 'unquoted secret words']) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('Authorization: ***');
    expect(output).toContain('Cookie: ***');
    expect(output).toContain('password="***"');
  });

  it('日志写出前强制脱敏', () => {
    setNoColor(true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      logger.info('password=log-secret Bearer bearer-secret');
      const rendered = spy.mock.calls.flat().join(' ');
      expect(rendered).not.toContain('log-secret');
      expect(rendered).not.toContain('bearer-secret');
      expect(rendered).toContain('***');
    } finally {
      spy.mockRestore();
      setNoColor(false);
    }
  });

  it('LLM Provider 输出返回调用方前强制脱敏，并保持 JSON 可解析', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: '{"token":"llm-secret","message":"Bearer model-secret"}',
    });
    const response = await llm.generate({ messages: [{ role: 'user', content: 'test' }] });
    expect(response.content).not.toContain('llm-secret');
    expect(response.content).not.toContain('model-secret');
    expect(JSON.parse(response.content)).toEqual({ token: '***', message: 'Bearer ***' });
  });
});
