// LLM 统一类型定义
// 定义了 LLMProvider 接口、请求/响应结构，供各 Agent 与 Provider 实现使用。

import { redactSensitiveText } from '../core/redact.js';

/** 消息角色 */
export type LLMRole = 'system' | 'user' | 'assistant';

/** 单条对话消息 */
export interface LLMMessage {
  role: LLMRole;
  content: string;
}

/** LLM 生成请求 */
export interface LLMRequest {
  messages: LLMMessage[];
  /** 采样温度（0~1，越低越确定） */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 是否要求返回结构化 JSON（Provider 提示词层辅助，不保证硬性约束） */
  jsonMode?: boolean;
  /** 取消信号（用于超时/中断） */
  signal?: AbortSignal;
  /** 指定模型（由 ModelRouter 注入；Provider 未指定时用自身配置的默认模型） */
  model?: string;
}

/** LLM 生成响应 */
export interface LLMResponse {
  content: string;
  /** token 用量统计（可选） */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 实际使用的模型名 */
  model?: string;
  /** 本次请求耗时（毫秒） */
  latencyMs: number;
}

/** LLM Provider 接口：所有模型实现（真实 / Mock）都必须遵循 */
export interface LLMProvider {
  /** Provider 名称（如 mock / deepseek / openai-compatible） */
  name: string;
  /** 生成回复 */
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/** Provider/Runtime 返回前统一清洗自由文本，避免模型复述 Prompt 中的凭证。 */
export function sanitizeLLMResponse(response: LLMResponse): LLMResponse {
  return { ...response, content: redactSensitiveText(response.content) };
}

/** 解析 LLMResponse.content 为 JSON（LLM 返回非法 JSON 时抛错） */
export function parseLLMJson<T = unknown>(response: LLMResponse): T {
  if (!response.content) {
    throw new Error('LLM 返回空响应');
  }
  let text = response.content.trim();
  // 容忍被 ```json ... ``` 包裹的输出
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`LLM 返回非法 JSON：${(e as Error).message}（前 200 字符：${text.slice(0, 200)}）`);
  }
}
