// 单元测试：LLM 运行时配置（Phase 20.1，src/config/llm.ts）
// 覆盖：CLI 覆盖项合并、无配置默认 Mock、路由档位联动、配置摘要脱敏
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRuntimeLLM,
  resolveLLMConfig,
  describeLLMConfig,
} from '../../src/config/llm.js';
import { MockLLMProvider, FallbackLLMProvider, modelRouter } from '../../src/llm/index.js';

describe('config/llm - Phase 20.1 运行时配置', () => {
  beforeEach(() => {
    for (const k of [
      'LLM_PROVIDER',
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'LLM_FALLBACK_MODEL',
      'LLM_HIGH_MODEL',
      'LLM_MEDIUM_MODEL',
      'LLM_SMALL_MODEL',
    ]) delete process.env[k];
    // 重置单例档位为默认（避免测试间污染）
    modelRouter.setTiers({ high: 'gpt-4o', medium: 'gpt-4o-mini', small: 'gpt-4o-mini' });
  });

  it('无任何配置时返回 Mock（离线可测）', () => {
    const llm = createRuntimeLLM();
    expect(llm).toBeInstanceOf(MockLLMProvider);
    expect(llm.name).toBe('mock');
  });

  it('CLI 覆盖项与环境变量合并（CLI 优先）', () => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.LLM_MODEL = 'deepseek-chat';
    const cfg = resolveLLMConfig({ model: 'deepseek-v3', fallbackModel: 'deepseek-reasoner', maxTokens: 4096 });
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.model).toBe('deepseek-v3');
    expect(cfg.fallbackModel).toBe('deepseek-reasoner');
    expect(cfg.maxTokens).toBe(4096);
  });

  it('配置主备模型时返回 FallbackLLMProvider', () => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.LLM_MODEL = 'deepseek-chat';
    process.env.LLM_FALLBACK_MODEL = 'deepseek-reasoner';
    const llm = createRuntimeLLM();
    expect(llm).toBeInstanceOf(FallbackLLMProvider);
    expect((llm as FallbackLLMProvider).fallbackProvider).toBeDefined();
  });

  it('环境变量档位联动 ModelRouter', () => {
    process.env.LLM_HIGH_MODEL = 'glm-4-plus';
    process.env.LLM_SMALL_MODEL = 'glm-4-flash';
    const info = describeLLMConfig();
    expect(info.tiers.high).toBe('glm-4-plus');
    expect(info.tiers.small).toBe('glm-4-flash');
    expect(modelRouter.route('rca').model).toBe('glm-4-plus');
  });

  it('配置摘要不泄露 API Key', () => {
    process.env.LLM_PROVIDER = 'deepseek';
    process.env.LLM_API_KEY = 'sk-secret-123';
    const info = describeLLMConfig();
    expect(info.provider).toBe('deepseek');
    expect(JSON.stringify(info)).not.toContain('sk-secret-123');
  });
});
