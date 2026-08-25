// FallbackLLMProvider：真实 LLM 的主备回退链（任务书 20.1）。
// 链路：Primary → （Timeout/429/5xx/网络错误） → Fallback → （同样失败） → Deterministic Fallback。
// 仅对可重试错误回退；配置/鉴权类错误（400/401/403 等）直接暴露，避免掩盖真实问题。
// 确定性回退：返回预设的固定内容（如 mock 响应），保证流程可继续、行为可复现。
import { sanitizeLLMResponse, type LLMProvider, type LLMRequest, type LLMResponse } from './types.js';
import { classifyLLMError, isRetryable, type LLMFallbackListener } from './llm-errors.js';

/** 回退 Provider 选项 */
export interface FallbackLLMOptions {
  /** 主 Provider（必填） */
  primary: LLMProvider;
  /** 回退 Provider（可选；不配置则主失败直接走确定性回退或抛错） */
  fallback?: LLMProvider;
  /** 确定性回退内容（主+备都失败时返回；缺省则抛出最后的错误） */
  deterministicFallback?: string;
  /** 回退事件监听（观测/日志/审计） */
  onFallback?: LLMFallbackListener;
}

/** 主备回退 Provider */
export class FallbackLLMProvider implements LLMProvider {
  name = 'fallback';

  private readonly primary: LLMProvider;
  private readonly fallback?: LLMProvider;
  private readonly deterministicFallback?: string;
  private readonly onFallback?: LLMFallbackListener;

  constructor(options: FallbackLLMOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.deterministicFallback = options.deterministicFallback;
    this.onFallback = options.onFallback;
  }

  /** 主 Provider（供观测/预检） */
  get primaryProvider(): LLMProvider {
    return this.primary;
  }

  /** 回退 Provider（可能为空） */
  get fallbackProvider(): LLMProvider | undefined {
    return this.fallback;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    try {
      return sanitizeLLMResponse(await this.primary.generate(request));
    } catch (e) {
      const failure = classifyLLMError(e);
      // 非可重试错误（配置/鉴权等）：若配置了确定性回退则兜底，否则直接抛出
      if (!isRetryable(failure)) {
        if (this.deterministicFallback !== undefined) {
          this.onFallback?.({ from: this.primary.name, to: 'deterministic-fallback', failure, attempt: 2 });
          return this.deterministicResponse(this.deterministicFallback, t0);
        }
        throw e;
      }

      // 可重试错误：尝试回退模型
      if (this.fallback) {
        this.onFallback?.({ from: this.primary.name, to: this.fallback.name, failure, attempt: 1 });
        try {
          return sanitizeLLMResponse(await this.fallback.generate(request));
        } catch (e2) {
          const f2 = classifyLLMError(e2);
          if (this.deterministicFallback !== undefined) {
            this.onFallback?.({ from: this.fallback.name, to: 'deterministic-fallback', failure: f2, attempt: 2 });
            return this.deterministicResponse(this.deterministicFallback, t0);
          }
          throw e2;
        }
      }

      // 无回退模型：确定性兜底或抛出
      if (this.deterministicFallback !== undefined) {
        this.onFallback?.({ from: this.primary.name, to: 'deterministic-fallback', failure, attempt: 2 });
        return this.deterministicResponse(this.deterministicFallback, t0);
      }
      throw e;
    }
  }

  /** 构造确定性回退响应 */
  private deterministicResponse(content: string, t0: number): LLMResponse {
    return sanitizeLLMResponse({
      content,
      usage: { inputTokens: 0, outputTokens: content.length },
      model: 'deterministic-fallback',
      latencyMs: Date.now() - t0,
    });
  }
}
