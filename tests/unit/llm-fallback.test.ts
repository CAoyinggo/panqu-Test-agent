// 单元测试：FallbackLLMProvider 主备回退链（Phase 20.1）
// 链路：Primary →（Timeout/429/5xx/网络）→ Fallback →（同样失败）→ Deterministic Fallback。
// 非可重试错误（400/401/403 等）不触发回退，直接暴露。
import { describe, it, expect } from 'vitest';
import {
  FallbackLLMProvider,
  LLMError,
  MockLLMProvider,
  classifyLLMError,
  isRetryable,
  shouldFallback,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../src/llm/index.js';

const req: LLMRequest = { messages: [{ role: 'user', content: 'hi' }] };

/** 始终抛错的 Provider */
class ThrowingProvider implements LLMProvider {
  name: string;
  private failure: Error;
  calls = 0;
  constructor(name: string, failure: string | Error) {
    this.name = name;
    this.failure = typeof failure === 'string' ? new Error(failure) : failure;
  }
  async generate(): Promise<LLMResponse> {
    this.calls++;
    throw this.failure;
  }
}

const httpFailure = (status: number, message = `HTTP ${status}`): LLMError =>
  new LLMError(message, { kind: 'http', status, message });

describe('llm - 错误分类', () => {
  it('timeout / abort / 超时 识别为 timeout', () => {
    expect(classifyLLMError(new Error('AbortError'))).toMatchObject({ kind: 'timeout' });
    expect(classifyLLMError(new Error('LLM 请求超时（30000ms）'))).toMatchObject({ kind: 'timeout' });
    expect(classifyLLMError(new Error('请求 timed out'))).toMatchObject({ kind: 'timeout' });
  });

  it('HTTP 状态只从结构化 LLMError 读取，不解析自由文本', () => {
    expect(classifyLLMError(httpFailure(429))).toMatchObject({ kind: 'http', status: 429 });
    expect(classifyLLMError(httpFailure(503))).toMatchObject({ kind: 'http', status: 503 });
    expect(classifyLLMError(httpFailure(401))).toMatchObject({ kind: 'http', status: 401 });
    expect(classifyLLMError(new Error('LLM 请求失败（HTTP 429）：rate limit'))).toMatchObject({ kind: 'unknown' });
  });

  it('网络错误识别', () => {
    expect(classifyLLMError(new Error('fetch failed: ECONNREFUSED'))).toMatchObject({ kind: 'network' });
    expect(classifyLLMError(new Error('连接失败'))).toMatchObject({ kind: 'network' });
  });

  it('isRetryable：timeout/429/5xx/网络可回退，400/401/403 不回退', () => {
    expect(isRetryable({ kind: 'timeout', message: 't' })).toBe(true);
    expect(isRetryable({ kind: 'network', message: 'n' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 408, message: 'x' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 429, message: 'x' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 500, message: 'x' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 503, message: 'x' })).toBe(true);
    expect(isRetryable({ kind: 'http', status: 400, message: 'x' })).toBe(false);
    expect(isRetryable({ kind: 'http', status: 401, message: 'x' })).toBe(false);
    expect(isRetryable({ kind: 'http', status: 403, message: 'x' })).toBe(false);
    expect(isRetryable({ kind: 'unknown', message: 'x' })).toBe(false);
  });

  it('shouldFallback 便捷判断', () => {
    expect(shouldFallback(httpFailure(429))).toBe(true);
    expect(shouldFallback(httpFailure(400))).toBe(false);
  });
});

describe('llm - FallbackLLMProvider 回退链', () => {
  it('主成功时不调用回退', async () => {
    const primary = new MockLLMProvider({ defaultResponse: 'primary-ok' });
    const fallback = new MockLLMProvider({ defaultResponse: 'fallback-ok' });
    const events: unknown[] = [];
    const llm = new FallbackLLMProvider({ primary, fallback, onFallback: (e) => events.push(e) });
    const r = await llm.generate(req);
    expect(r.content).toBe('primary-ok');
    expect(fallback.getCallCount()).toBe(0);
    expect(events.length).toBe(0);
  });

  it('主超时 → 回退模型接管', async () => {
    const primary = new MockLLMProvider();
    primary.setFailureMode({ type: 'error', message: 'LLM 请求超时（30000ms）' });
    const fallback = new MockLLMProvider({ defaultResponse: 'fallback-ok' });
    const llm = new FallbackLLMProvider({ primary, fallback });
    const r = await llm.generate(req);
    expect(r.content).toBe('fallback-ok');
  });

  it('主 HTTP 429 → 回退模型接管', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(429, 'LLM 请求失败（HTTP 429）：rate limit'));
    const fallback = new MockLLMProvider({ defaultResponse: 'fallback-429' });
    const llm = new FallbackLLMProvider({ primary, fallback });
    const r = await llm.generate(req);
    expect(r.content).toBe('fallback-429');
    expect(primary.calls).toBe(1);
  });

  it('主 HTTP 503 → 回退模型接管', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(503, 'LLM 请求失败（HTTP 503）：unavailable'));
    const fallback = new MockLLMProvider({ defaultResponse: 'fallback-503' });
    const llm = new FallbackLLMProvider({ primary, fallback });
    const r = await llm.generate(req);
    expect(r.content).toBe('fallback-503');
  });

  it('主 HTTP 400（非可重试）不触发回退，直接抛错', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(400, 'LLM 请求失败（HTTP 400）：bad request'));
    const fallback = new MockLLMProvider({ defaultResponse: 'should-not-use' });
    const llm = new FallbackLLMProvider({ primary, fallback });
    await expect(llm.generate(req)).rejects.toThrow('HTTP 400');
    expect(fallback.getCallCount()).toBe(0);
  });

  it('主 HTTP 401（鉴权）不触发回退', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(401, 'LLM 请求失败（HTTP 401）：unauthorized'));
    const fallback = new MockLLMProvider({ defaultResponse: 'no' });
    const llm = new FallbackLLMProvider({ primary, fallback });
    await expect(llm.generate(req)).rejects.toThrow('HTTP 401');
    expect(fallback.getCallCount()).toBe(0);
  });

  it('主备都失败 → 确定性回退内容', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(429));
    const fallback = new ThrowingProvider('fallback', httpFailure(503));
    const llm = new FallbackLLMProvider({ primary, fallback, deterministicFallback: '{"ok":true}' });
    const r = await llm.generate(req);
    expect(r.content).toBe('{"ok":true}');
    expect(r.model).toBe('deterministic-fallback');
  });

  it('主失败无回退模型 + 确定性内容 → 确定性兜底', async () => {
    const primary = new ThrowingProvider('primary', 'LLM 请求超时');
    const llm = new FallbackLLMProvider({ primary, deterministicFallback: '{"fallback":1}' });
    const r = await llm.generate(req);
    expect(r.content).toBe('{"fallback":1}');
  });

  it('回退事件监听记录 from/to/attempt', async () => {
    const primary = new ThrowingProvider('primary', httpFailure(429));
    const fallback = new ThrowingProvider('fallback', httpFailure(503));
    const events: Array<{ from: string; to: string; attempt: number }> = [];
    const llm = new FallbackLLMProvider({
      primary,
      fallback,
      deterministicFallback: 'x',
      onFallback: (e) => events.push({ from: e.from, to: e.to, attempt: e.attempt }),
    });
    await llm.generate(req);
    expect(events).toEqual([
      { from: 'primary', to: 'fallback', attempt: 1 },
      { from: 'fallback', to: 'deterministic-fallback', attempt: 2 },
    ]);
  });
});
