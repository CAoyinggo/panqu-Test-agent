// LLM Telemetry（Phase 25.4）：透明装饰 LLMProvider，采集真实 usage（token/latency/cost）
// 通过 RunContext（AsyncLocalStorage）将每次 LLM 调用关联到 runId/projectId/feature，
// 真实数据写入 CostLedger；不改变 Provider 行为（装饰器透明透传）。

import { AsyncLocalStorage } from 'node:async_hooks';
import { sanitizeLLMResponse, type LLMProvider, type LLMRequest, type LLMResponse } from '../../llm/types.js';
import type { TelemetryService } from './telemetry-service.js';
import { redactSensitiveText } from '../../core/redact.js';

/** 当前运行上下文（LLM 调用归属） */
export interface RunTelemetryContext {
  runId: string;
  projectId?: string;
  feature?: string;
}

/** 运行上下文持有者（AsyncLocalStorage） */
export class TelemetryRunContext {
  private readonly als = new AsyncLocalStorage<RunTelemetryContext>();

  /** 在给定上下文中执行异步操作（所有 LLM 调用自动归属该 run） */
  run<T>(ctx: RunTelemetryContext, fn: () => Promise<T>): Promise<T> {
    return this.als.run(ctx, fn);
  }

  /** 当前上下文（无则 undefined） */
  get current(): RunTelemetryContext | undefined {
    return this.als.getStore();
  }
}

/** 全局默认上下文（多 Run 并发安全的入口） */
export const runContext = new TelemetryRunContext();

/** LLM 遥测装饰器：包装任意 LLMProvider，记录真实 usage 到 TelemetryService */
export class TelemetryLLMProvider implements LLMProvider {
  readonly name: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly telemetry: TelemetryService,
    private readonly ctx: TelemetryRunContext = runContext,
  ) {
    this.name = `telemetry:${inner.name}`;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const response = await this.inner.generate(request);
    const latencyMs = Date.now() - start;
    const runCtx = this.ctx.current;
    const usage = response.usage ?? { inputTokens: 0, outputTokens: 0 };
    await this.telemetry
      .recordLLM({
        runId: runCtx?.runId ?? 'unknown',
        projectId: runCtx?.projectId,
        feature: runCtx?.feature,
        model: response.model ?? this.inner.name,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        latencyMs,
        requestCount: 1,
        retryCount: 0,
      })
      .catch((err: Error) => {
        // 遥测写入失败不影响 LLM 调用本身
        console.warn(`[telemetry] LLM usage 记录失败：${redactSensitiveText(err.message)}`);
      });
    return sanitizeLLMResponse(response);
  }
}

/** 便捷工厂：包装 provider 为遥测版 */
export function withLLMTelemetry(provider: LLMProvider, telemetry: TelemetryService, ctx: TelemetryRunContext = runContext): LLMProvider {
  return new TelemetryLLMProvider(provider, telemetry, ctx);
}
