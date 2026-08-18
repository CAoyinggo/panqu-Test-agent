// LLM Provider 工厂：根据配置/环境变量创建具体 Provider
// 支持：mock（默认，离线测试用）/ openai-compatible / deepseek / glm / doubao / anthropic-compatible
// 配置一律来自环境变量，禁止在代码中写入 API Key。
// Phase 20.1：支持主备模型（LLM_MODEL / LLM_FALLBACK_MODEL），主失败（Timeout/429/5xx/网络）自动回退，
//           并可选提供确定性回退内容，保证流程可继续、行为可复现。
import type { LLMProvider } from './types.js';
import { MockLLMProvider } from './mock-llm.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { FallbackLLMProvider } from './fallback-provider.js';
import type { LLMFallbackListener } from './llm-errors.js';

/** LLM 配置（通常源自环境变量） */
export interface LLMConfig {
  /** Provider 类型：mock / openai-compatible / deepseek / glm / doubao / anthropic-compatible */
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 主模型 */
  model?: string;
  /** 回退模型（可选） */
  fallbackModel?: string;
  /** 超时（ms） */
  timeoutMs?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 采样温度 */
  temperature?: number;
  /** 确定性回退内容：主+备都失败时返回该固定内容（可选） */
  deterministicFallback?: string;
  /** 回退事件监听（观测/审计） */
  onFallback?: LLMFallbackListener;
}

/** 环境变量前缀 */
const ENV_PREFIX = 'LLM_';

/** 读取数值型环境变量 */
function numEnv(env: Record<string, string | undefined>, key: string): number | undefined {
  const v = env[`${ENV_PREFIX}${key}`];
  return v !== undefined && v !== '' ? Number(v) : undefined;
}

/**
 * 从环境变量加载 LLM 配置。
 * LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_FALLBACK_MODEL /
 * LLM_TIMEOUT / LLM_MAX_TOKENS / LLM_TEMPERATURE
 */
export function loadLLMConfigFromEnv(env: Record<string, string | undefined> = process.env): LLMConfig {
  return {
    provider: env[`${ENV_PREFIX}PROVIDER`],
    baseUrl: env[`${ENV_PREFIX}BASE_URL`],
    apiKey: env[`${ENV_PREFIX}API_KEY`],
    model: env[`${ENV_PREFIX}MODEL`],
    fallbackModel: env[`${ENV_PREFIX}FALLBACK_MODEL`],
    timeoutMs: numEnv(env, 'TIMEOUT'),
    maxTokens: numEnv(env, 'MAX_TOKENS'),
    temperature: numEnv(env, 'TEMPERATURE'),
  };
}

/** 归一化 provider 类型（deepseek/glm/doubao 均为 OpenAI 兼容协议） */
function normalizeProvider(provider?: string): string {
  const p = (provider ?? '').toLowerCase().trim();
  if (!p || p === 'mock') return 'mock';
  // DeepSeek / GLM / Doubao 均提供 OpenAI 兼容端点
  if (p === 'deepseek' || p === 'glm' || p === 'doubao' || p === 'openai-compatible' || p === 'anthropic-compatible') {
    return 'openai-compatible';
  }
  throw new Error(`不支持的 LLM Provider：${provider}（可选 mock / deepseek / glm / doubao / openai-compatible / anthropic-compatible）`);
}

/**
 * 根据配置创建 LLM Provider。无配置时默认返回 Mock（保证离线可测）。
 * 配置了 fallbackModel 时返回 FallbackLLMProvider（主 → 备 → 确定性兜底）。
 */
export function createLLMProvider(config?: LLMConfig): LLMProvider {
  const cfg = config ?? loadLLMConfigFromEnv();
  const kind = normalizeProvider(cfg.provider);
  if (kind === 'mock') {
    return new MockLLMProvider();
  }

  const primary = new OpenAICompatibleProvider(cfg);
  const fallback = cfg.fallbackModel ? new OpenAICompatibleProvider({ ...cfg, model: cfg.fallbackModel }) : undefined;

  if (fallback || cfg.deterministicFallback !== undefined) {
    return new FallbackLLMProvider({
      primary,
      fallback,
      deterministicFallback: cfg.deterministicFallback,
      onFallback: cfg.onFallback,
    });
  }
  return primary;
}
