// 单元测试：LLM 层（MockLLM / parseLLMJson / createLLMProvider / 环境变量加载）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockLLMProvider,
  parseLLMJson,
  createLLMProvider,
  loadLLMConfigFromEnv,
  FallbackLLMProvider,
} from '../../src/llm/index.js';
import type { LLMRequest } from '../../src/llm/types.js';

const req: LLMRequest = { messages: [{ role: 'user', content: 'hello' }] };

describe('llm - MockLLMProvider', () => {
  it('默认响应', async () => {
    const llm = new MockLLMProvider({ defaultResponse: '{"ok":true}' });
    const r = await llm.generate(req);
    expect(r.content).toBe('{"ok":true}');
    expect(r.model).toBe('mock');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('脚本化响应按调用顺序消费', async () => {
    const llm = new MockLLMProvider({ scripted: ['first', 'second'] });
    expect((await llm.generate(req)).content).toBe('first');
    expect((await llm.generate(req)).content).toBe('second');
    // 超出脚本后回落默认
    expect((await llm.generate(req)).content).toBe('{"ok":true}');
  });

  it('脚本支持函数动态生成', async () => {
    const llm = new MockLLMProvider({ scripted: [(r) => `len:${r.messages[0].content.length}`] });
    expect((await llm.generate(req)).content).toBe('len:5');
  });

  it('记录调用并支持重置', async () => {
    const llm = new MockLLMProvider();
    await llm.generate(req);
    await llm.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(llm.getCallCount()).toBe(2);
    expect(llm.getLastCall()!.messages[0].content).toBe('x');
    llm.reset();
    expect(llm.getCallCount()).toBe(0);
  });

  it('失败模式：invalid-json / empty / error', async () => {
    const llm = new MockLLMProvider();
    llm.setFailureMode({ type: 'invalid-json' });
    expect((await llm.generate(req)).content).toContain('不是 JSON');
    llm.setFailureMode({ type: 'empty' });
    expect((await llm.generate(req)).content).toBe('');
    llm.setFailureMode({ type: 'error', message: '网络错误' });
    await expect(llm.generate(req)).rejects.toThrow('网络错误');
    // 恢复正常
    llm.setFailureMode(null);
    expect((await llm.generate(req)).content).toBe('{"ok":true}');
  });
});

describe('llm - parseLLMJson', () => {
  it('解析标准 JSON', () => {
    const v = parseLLMJson<{ a: number }>({ content: '{"a":1}', latencyMs: 1 });
    expect(v.a).toBe(1);
  });

  it('容忍 ```json 围栏', () => {
    const v = parseLLMJson<{ a: number }>({ content: '```json\n{"a":2}\n```', latencyMs: 1 });
    expect(v.a).toBe(2);
  });

  it('空响应抛错', () => {
    expect(() => parseLLMJson({ content: '', latencyMs: 1 })).toThrow('空响应');
  });

  it('非法 JSON 抛错', () => {
    expect(() => parseLLMJson({ content: '这不是 JSON {{', latencyMs: 1 })).toThrow('非法 JSON');
  });
});

describe('llm - createLLMProvider', () => {
  beforeEach(() => {
    for (const k of [
      'LLM_PROVIDER',
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'LLM_FALLBACK_MODEL',
      'LLM_TIMEOUT',
      'LLM_MAX_TOKENS',
      'LLM_TEMPERATURE',
    ]) delete process.env[k];
  });

  it('无配置时返回 Mock', () => {
    const llm = createLLMProvider({});
    expect(llm.name).toBe('mock');
    expect(llm).toBeInstanceOf(MockLLMProvider);
  });

  it('deepseek/glm/doubao 归一化为 openai-compatible', () => {
    for (const p of ['deepseek', 'glm', 'doubao']) {
      const llm = createLLMProvider({ provider: p, baseUrl: 'https://x', apiKey: 'k' });
      expect(llm.name).toBe('openai-compatible');
    }
  });

  it('不支持的 provider 抛错', () => {
    expect(() => createLLMProvider({ provider: 'unknown' })).toThrow('不支持的 LLM Provider');
  });

  it('从环境变量加载配置', () => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.LLM_BASE_URL = 'https://api.deepseek.com';
    process.env.LLM_API_KEY = 'sk-test';
    process.env.LLM_MODEL = 'deepseek-chat';
    const llm = createLLMProvider();
    expect(llm.name).toBe('openai-compatible');
  });

  it('配置 fallbackModel 时返回 FallbackLLMProvider', () => {
    const llm = createLLMProvider({
      provider: 'deepseek',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'deepseek-chat',
      fallbackModel: 'deepseek-reasoner',
    });
    expect(llm).toBeInstanceOf(FallbackLLMProvider);
    expect((llm as FallbackLLMProvider).fallbackProvider).toBeDefined();
  });
});

describe('llm - loadLLMConfigFromEnv（Phase 20.1）', () => {
  beforeEach(() => {
    for (const k of ['LLM_MODEL', 'LLM_FALLBACK_MODEL', 'LLM_TIMEOUT', 'LLM_MAX_TOKENS', 'LLM_TEMPERATURE']) delete process.env[k];
  });

  it('读取主模型与回退模型', () => {
    process.env.LLM_MODEL = 'deepseek-chat';
    process.env.LLM_FALLBACK_MODEL = 'deepseek-reasoner';
    const cfg = loadLLMConfigFromEnv();
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.fallbackModel).toBe('deepseek-reasoner');
  });

  it('读取 timeout / maxTokens / temperature 数值', () => {
    process.env.LLM_TIMEOUT = '45000';
    process.env.LLM_MAX_TOKENS = '4096';
    process.env.LLM_TEMPERATURE = '0';
    const cfg = loadLLMConfigFromEnv();
    expect(cfg.timeoutMs).toBe(45000);
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.temperature).toBe(0);
  });

  it('未设置时保持 undefined（不产生 NaN）', () => {
    const cfg = loadLLMConfigFromEnv();
    expect(cfg.model).toBeUndefined();
    expect(cfg.fallbackModel).toBeUndefined();
    expect(cfg.timeoutMs).toBeUndefined();
    expect(cfg.maxTokens).toBeUndefined();
    expect(cfg.temperature).toBeUndefined();
  });
});
