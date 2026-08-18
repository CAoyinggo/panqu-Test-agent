// LLM 运行时配置（Phase 20.1）：统一加载 LLM_* 环境变量与 CLI 覆盖项，
// 联动 ModelRouter 档位（LLM_HIGH_MODEL / LLM_MEDIUM_MODEL / LLM_SMALL_MODEL），
// 并创建可用的 LLM Provider（含主备回退链）。
// 设计目标：所有 Agent 通过本模块获取 LLM，不直接触碰环境变量；未配置时默认 Mock（离线可测）。
import {
  loadLLMConfigFromEnv,
  createLLMProvider,
  applyTiersFromEnv,
  modelRouter,
  type LLMConfig,
  type LLMProvider,
} from '../llm/index.js';

/** CLI 可覆盖的 LLM 参数 */
export interface LLMCliOverrides {
  provider?: string;
  model?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/** 合并环境变量 + CLI 覆盖，生成 LLM 配置 */
export function resolveLLMConfig(overrides?: LLMCliOverrides): LLMConfig {
  const fromEnv = loadLLMConfigFromEnv();
  return {
    ...fromEnv,
    ...(overrides?.provider ? { provider: overrides.provider } : {}),
    ...(overrides?.model ? { model: overrides.model } : {}),
    ...(overrides?.fallbackModel ? { fallbackModel: overrides.fallbackModel } : {}),
    ...(overrides?.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides?.maxTokens ? { maxTokens: overrides.maxTokens } : {}),
  };
}

/**
 * 创建运行时 LLM Provider：
 * 1) 应用环境变量档位到 ModelRouter（LLM_HIGH_MODEL 等）；
 * 2) 无 provider 配置时返回 Mock（保证离线可测）；
 * 3) 有配置时返回真实 Provider（主 → 备 → 确定性兜底）。
 */
export function createRuntimeLLM(overrides?: LLMCliOverrides): LLMProvider {
  applyTiersFromEnv(modelRouter);
  const cfg = resolveLLMConfig(overrides);
  if (!cfg.provider) {
    return createLLMProvider({ provider: 'mock' });
  }
  return createLLMProvider(cfg);
}

/** 当前 LLM 配置摘要（供预检/健康检查，脱敏后返回） */
export function describeLLMConfig(overrides?: LLMCliOverrides): {
  provider: string;
  model: string;
  fallbackModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  tiers: { high: string; medium: string; small: string };
} {
  applyTiersFromEnv(modelRouter);
  const cfg = resolveLLMConfig(overrides);
  return {
    provider: cfg.provider ?? 'mock',
    model: cfg.model ?? 'mock',
    fallbackModel: cfg.fallbackModel,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    tiers: {
      high: modelRouter.resolveModel('high'),
      medium: modelRouter.resolveModel('medium'),
      small: modelRouter.resolveModel('small'),
    },
  };
}
