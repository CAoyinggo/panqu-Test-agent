// MockLLMProvider：离线 Agent 测试用 LLM Provider
// 不依赖任何真实 AI API，单元测试默认使用本 Provider（保证 `npm test` 离线可跑）。
// 支持：脚本化响应 / 默认响应 / 失败模式（非法 JSON / 空响应 / 抛错 / 超时）/ 调用记录 / 延迟模拟。
import type { LLMProvider, LLMRequest, LLMResponse } from './types.js';

/** 脚本化响应：可以是固定字符串，也可以是按请求动态生成的函数 */
export type MockResponseSource = string | ((request: LLMRequest) => string | Promise<string>);

/** MockLLM 失败模式 */
export interface MockFailureMode {
  /** invalid-json：返回不可解析的文本；empty：返回空串；error：generate 抛错；timeout：超时 */
  type: 'invalid-json' | 'empty' | 'error' | 'timeout';
  /** 出错消息（error 模式用） */
  message?: string;
  /** 超时毫秒（timeout 模式用） */
  timeoutMs?: number;
}

export interface MockLLMOptions {
  /** 默认响应（无脚本时使用） */
  defaultResponse?: string;
  /** 脚本化响应队列：按调用顺序逐个消费 */
  scripted?: MockResponseSource[];
  /** 模拟延迟（毫秒，默认 0） */
  delayMs?: number;
  /** 失败模式（可后续通过 setFailureMode 切换） */
  failureMode?: MockFailureMode;
}

/** MockLLMProvider：可完全离线运行的 LLM 实现 */
export class MockLLMProvider implements LLMProvider {
  name = 'mock';

  private defaultResponse: string;
  private scripted: MockResponseSource[];
  private delayMs: number;
  private failureMode: MockFailureMode | null;
  private calls: LLMRequest[] = [];
  private callIndex = 0;

  constructor(options: MockLLMOptions = {}) {
    this.defaultResponse = options.defaultResponse ?? '{"ok":true}';
    this.scripted = [...(options.scripted ?? [])];
    this.delayMs = options.delayMs ?? 0;
    this.failureMode = options.failureMode ?? null;
  }

  /** 记录一次请求（供测试断言） */
  private record(request: LLMRequest): void {
    this.calls.push(JSON.parse(JSON.stringify(request)));
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    this.record(request);

    // 延迟模拟
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    // 失败模式
    if (this.failureMode) {
      const f = this.failureMode;
      switch (f.type) {
        case 'invalid-json':
          return { content: '这不是 JSON {{', latencyMs: Date.now() - t0 };
        case 'empty':
          return { content: '', latencyMs: Date.now() - t0 };
        case 'error':
          throw new Error(f.message ?? 'MockLLM 模拟错误');
        case 'timeout': {
          await new Promise((r) => setTimeout(r, f.timeoutMs ?? 5000));
          return { content: 'timeout', latencyMs: Date.now() - t0 };
        }
      }
    }

    // 脚本化响应（按调用顺序消费，超出后回落默认）
    let content: string;
    if (this.callIndex < this.scripted.length) {
      const src = this.scripted[this.callIndex++];
      content = typeof src === 'function' ? await src(request) : src;
    } else {
      content = this.defaultResponse;
    }

    return {
      content,
      usage: { inputTokens: request.messages.reduce((s, m) => s + m.content.length, 0), outputTokens: content.length },
      model: 'mock',
      latencyMs: Date.now() - t0,
    };
  }

  // ── 测试辅助 ──

  /** 已收到的全部请求 */
  getCalls(): LLMRequest[] {
    return this.calls;
  }

  /** 调用次数 */
  getCallCount(): number {
    return this.calls.length;
  }

  /** 最近一次请求 */
  getLastCall(): LLMRequest | undefined {
    return this.calls.at(-1);
  }

  /** 重置调用记录与脚本游标（不清除脚本配置） */
  reset(): void {
    this.calls = [];
    this.callIndex = 0;
  }

  /** 设置失败模式（null 表示恢复正常） */
  setFailureMode(mode: MockFailureMode | null): void {
    this.failureMode = mode;
  }

  /** 追加脚本化响应 */
  pushScripted(...sources: MockResponseSource[]): void {
    this.scripted.push(...sources);
  }

  /** 清空脚本化响应 */
  clearScripted(): void {
    this.scripted = [];
    this.callIndex = 0;
  }

  /** 设置默认响应 */
  setDefaultResponse(content: string): void {
    this.defaultResponse = content;
  }
}
