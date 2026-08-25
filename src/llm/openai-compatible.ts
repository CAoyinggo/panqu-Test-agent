// OpenAI-Compatible LLM Provider：兼容任何 OpenAI Chat Completions 协议的模型服务
// （DeepSeek / GLM / Doubao / 各类网关）均可通过配置切换，无需改动代码。
// 遵循约束：不硬编码 API Key，一律从传入配置（源自环境变量）读取。
//
// 硬化点（Signal / Token / Retry 基础）：
// - Signal：调用方 signal 与 Provider 超时控制器「链接」后传给 fetch ——
//   调用方取消真实中止 HTTP 请求，且调用方传 signal 时 Provider 自身超时依然生效
//   （旧实现 request.signal ?? controller.signal 二选一，传 signal 即丢失超时）。
// - Token/温度：LLM_MAX_TOKENS / --max-tokens / LLM_TEMPERATURE 经 LLMConfig
//   真正进入请求体（旧实现被忽略，硬编码 2048/0.2）。
// - 错误：HTTP 非 2xx 抛结构化 LLMError（状态码 + Retry-After 毫秒），
//   供重试策略精确分类（429/5xx 重试，4xx 参数/鉴权错误不重试）。
import { sanitizeLLMResponse, type LLMProvider, type LLMRequest, type LLMResponse, type LLMMessage } from './types.js';
import type { LLMConfig } from './provider.js';
import { LLMError, parseRetryAfterMs } from './llm-errors.js';

/** OpenAI Chat Completions 请求体（最小子集） */
interface OpenAIRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

/** OpenAI Chat Completions 响应体（最小子集） */
interface OpenAIResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** 把调用方 signal 与 Provider 超时控制器链接为一个信号（任一触发即中止 fetch，保留原因） */
function linkSignals(caller: AbortSignal | undefined, timeout: AbortController): AbortSignal {
  if (!caller) return timeout.signal;
  if (caller.aborted) {
    timeout.abort(caller.reason);
    return timeout.signal;
  }
  caller.addEventListener('abort', () => timeout.abort(caller.reason), { once: true });
  return timeout.signal;
}

/** OpenAI 兼容协议 Provider */
export class OpenAICompatibleProvider implements LLMProvider {
  name = 'openai-compatible';

  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;
  /** 默认最大输出 token（LLM_MAX_TOKENS / --max-tokens；请求级 request.maxTokens 优先） */
  private maxTokens?: number;
  /** 默认采样温度（LLM_TEMPERATURE；请求级 request.temperature 优先） */
  private temperature?: number;

  constructor(config: LLMConfig) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? 'default';
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('LLM 未配置：缺少 baseUrl 或 apiKey（请设置 LLM_BASE_URL / LLM_API_KEY 环境变量）');
    }
    const t0 = Date.now();
    // 模型按请求路由（ModelRouter 注入 request.model）；未指定用 Provider 默认模型
    const model = request.model ?? this.model;
    const controller = new AbortController();
    // 调用方 signal 与超时控制器链接：任一触发即真实中止底层 fetch
    const signal = linkSignals(request.signal, controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: OpenAIRequestBody = {
      model,
      messages: request.messages.map((m: LLMMessage) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? this.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? this.maxTokens ?? 2048,
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    try {
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const raw = (await resp.json().catch(() => ({}))) as OpenAIResponseBody;
        const message = `LLM 请求失败（HTTP ${resp.status}）：${raw.error?.message ?? resp.statusText}`;
        throw new LLMError(message, {
          kind: 'http',
          status: resp.status,
          message,
          retryAfterMs: parseRetryAfterMs(resp.headers.get('retry-after')),
        });
      }

      const raw = (await resp.json()) as OpenAIResponseBody;
      const content = raw.choices?.[0]?.message?.content ?? '';
      return sanitizeLLMResponse({
        content,
        usage: {
          inputTokens: raw.usage?.prompt_tokens,
          outputTokens: raw.usage?.completion_tokens,
        },
        model,
        latencyMs: Date.now() - t0,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
