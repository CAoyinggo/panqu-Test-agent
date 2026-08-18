// Agent Tracer：观测并记录每个 Agent 的执行指标（Phase 17）
// startSpan / endSpan 包裹一次 Agent 执行；recordLLM / recordTool / recordRetry /
// recordFallback / recordError 在 Agent 执行期间由包装层上报；toTrace 汇总整轮。
import { AgentTrace, AgentTraceSpan, summarizeTrace } from './observability-schema.js';

/** 单条成本估算参数 */
export interface CostConfig {
  /** 每 1K input token 成本 */
  inputPer1k?: number;
  /** 每 1K output token 成本 */
  outputPer1k?: number;
}

/** 默认成本（单位：美元/1K token，估算值，可通过配置覆盖） */
const DEFAULT_COST: CostConfig = { inputPer1k: 0.001, outputPer1k: 0.002 };

/** Agent Tracer */
export class AgentTracer {
  private spans = new Map<string, AgentTraceSpan>();
  private order: string[] = [];
  private ended = new Set<string>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly taskId: string,
    private readonly meta: { feature?: string; environment?: string } = {},
    private readonly cost: CostConfig = DEFAULT_COST,
  ) {}

  /** 开始一个阶段，返回 span id（未结束的 span 不进入汇总） */
  startSpan(agent: string, stage: string): string {
    const id = `${agent}:${stage}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
    this.spans.set(id, {
      agent,
      stage,
      startAt: Date.now(),
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      toolDurationMs: 0,
      retryCount: 0,
      fallbackCount: 0,
      success: false,
      status: 'error',
    });
    this.order.push(id);
    return id;
  }

  /** 结束一个阶段，写入结果指标 */
  endSpan(spanId: string, partial: Partial<AgentTraceSpan> = {}): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    span.durationMs = Date.now() - span.startAt;
    this.ended.add(spanId);
    Object.assign(span, partial);
    // Token/成本：优先显式传入的最终值，缺省用 recordLLM 累计值
    const inputTokens = partial.inputTokens ?? span.inputTokens ?? 0;
    const outputTokens = partial.outputTokens ?? span.outputTokens ?? 0;
    span.inputTokens = inputTokens;
    span.outputTokens = outputTokens;
    span.llmCost = this.estimateCost(inputTokens, outputTokens);
    // 状态：错误 > 回退 > 正常（基于合并后的 span 实际值）
    if (span.error) {
      span.success = false;
      span.status = 'error';
    } else if (span.fallbackCount > 0) {
      span.success = true;
      span.status = 'fallback';
    } else {
      span.success = true;
      span.status = 'ok';
    }
  }

  /** 记录一次 LLM 调用（由 Agent 包装层调用） */
  recordLLM(agent: string, inputTokens: number, outputTokens: number, latencyMs: number): void {
    for (const id of [...this.order].reverse()) {
      const s = this.spans.get(id);
      if (s && s.agent === agent && s.durationMs === 0) {
        s.llmCalls++;
        s.inputTokens = (s.inputTokens ?? 0) + inputTokens;
        s.outputTokens = (s.outputTokens ?? 0) + outputTokens;
        return;
      }
    }
  }

  /** 记录一次 Tool 调用 */
  recordTool(agent: string, durationMs: number): void {
    for (const id of [...this.order].reverse()) {
      const s = this.spans.get(id);
      if (s && s.agent === agent && s.durationMs === 0) {
        s.toolCalls++;
        s.toolDurationMs += durationMs;
        return;
      }
    }
  }

  /** 记录一次重试 */
  recordRetry(agent: string): void {
    const s = this.activeSpan(agent);
    if (s) s.retryCount++;
  }

  /** 记录一次回退（LLM→规则） */
  recordFallback(agent: string): void {
    const s = this.activeSpan(agent);
    if (s) s.fallbackCount++;
  }

  /** 记录错误 */
  recordError(agent: string, message: string): void {
    const s = this.activeSpan(agent);
    if (s) {
      s.error = message;
      s.success = false;
      s.status = 'error';
    }
  }

  /** 成本估算 */
  private estimateCost(inputTokens: number, outputTokens: number): number {
    return ((inputTokens / 1000) * (this.cost.inputPer1k ?? 0)) + ((outputTokens / 1000) * (this.cost.outputPer1k ?? 0));
  }

  private activeSpan(agent: string): AgentTraceSpan | undefined {
    for (const id of [...this.order].reverse()) {
      const s = this.spans.get(id);
      if (s && s.agent === agent && s.durationMs === 0) return s;
    }
    return undefined;
  }

  /** 生成整轮 Trace */
  toTrace(): AgentTrace {
    const spans = this.order
      .filter((id) => this.ended.has(id))
      .map((id) => this.spans.get(id))
      .filter((s): s is AgentTraceSpan => !!s);
    const trace: AgentTrace = {
      taskId: this.taskId,
      feature: this.meta.feature,
      environment: this.meta.environment,
      spans,
      totalLatencyMs: spans.reduce((s, x) => s + x.durationMs, 0),
      totalTokens: 0,
      llmCallTotal: 0,
      toolCallTotal: 0,
      fallbackTotal: 0,
      errorTotal: 0,
      summary: '',
      createdAt: new Date().toISOString(),
    };
    return summarizeTrace(trace);
  }

  /** 活动 span 数（未结束） */
  activeCount(): number {
    return [...this.spans.values()].filter((s) => s.durationMs === 0).length;
  }

  /** 重置 */
  reset(): void {
    this.spans.clear();
    this.order = [];
  }
}
