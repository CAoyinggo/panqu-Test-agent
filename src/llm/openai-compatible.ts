// OpenAI-Compatible LLM Provider：兼容任何 OpenAI Chat Completions 协议的模型服务
// （DeepSeek / GLM / Doubao / 各类网关）均可通过配置切换，无需改动代码。
// 遵循约束：不硬编码 API Key，一律从传入配置（源自环境变量）读取。
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from './types.js';
import type { LLMConfig } from './provider.js';

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

/** OpenAI 兼容协议 Provider */
export class OpenAICompatibleProvider implements LLMProvider {
  name = 'openai-compatible';

  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(config: LLMConfig) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? 'default';
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('LLM 未配置：缺少 baseUrl 或 apiKey（请设置 LLM_BASE_URL / LLM_API_KEY 环境变量）');
    }
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: OpenAIRequestBody = {
      model: this.model,
      messages: request.messages.map((m: LLMMessage) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 2048,
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
        signal: request.signal ?? controller.signal,
      });

      const raw = (await resp.json()) as OpenAIResponseBody;
      if (!resp.ok) {
        throw new Error(`LLM 请求失败（HTTP ${resp.status}）：${raw.error?.message ?? resp.statusText}`);
      }

      const content = raw.choices?.[0]?.message?.content ?? '';
      return {
        content,
        usage: {
          inputTokens: raw.usage?.prompt_tokens,
          outputTokens: raw.usage?.completion_tokens,
        },
        model: this.model,
        latencyMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
