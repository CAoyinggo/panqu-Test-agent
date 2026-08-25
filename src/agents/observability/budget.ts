// Agent Budget：AI 测试预算控制（Phase 15 预算 / Phase 17 观测）
// 限制：最大 Token / 最大 LLM 调用次数 / 最大 Agent 调用次数 / 最大 Tool 调用 /
// 最大执行时间。防止 Agent 出现「不断生成测试 → 不断执行 → 无限循环」。
import { AgentTrace } from './observability-schema.js';

/** 预算上限 */
export interface BudgetLimits {
  /** 最大 token（input + output） */
  maxTokens?: number;
  /** 最大 LLM 调用次数 */
  maxLLMCalls?: number;
  /** 最大 Agent 调用次数 */
  maxAgentCalls?: number;
  /** 最大 Tool 调用次数 */
  maxToolCalls?: number;
  /** 最大测试用例数 */
  maxCases?: number;
  /** 最大并发数 */
  maxConcurrency?: number;
  /** 最大执行时长（ms） */
  maxDurationMs?: number;
}

/** 预算使用状态 */
export interface BudgetStatus {
  tokensUsed: number;
  llmCalls: number;
  agentCalls: number;
  toolCalls: number;
  /** 已执行用例数（实时） */
  casesUsed: number;
  durationMs: number;
  /** 已超限的预算项 */
  exceeded: string[];
  /** 是否超限 */
  exceededAny: boolean;
}

/** Agent 预算 */
export class AgentBudget {
  private tokensUsed = 0;
  private llmCalls = 0;
  private agentCalls = 0;
  private toolCalls = 0;
  private casesUsed = 0;
  private readonly startedAt = Date.now();

  /** 预算上限（公开只读：UsageMeter / Runner 读取 maxCases / maxConcurrency 参与执行） */
  readonly limits: BudgetLimits;

  constructor(limits: BudgetLimits = {}) {
    this.limits = limits;
  }

  /** 统计一次 Agent 调用 */
  addAgentCall(): void {
    this.agentCalls++;
  }

  /** 统计一次 LLM 调用 + token */
  addLLMCall(inputTokens = 0, outputTokens = 0): void {
    this.llmCalls++;
    this.tokensUsed += inputTokens + outputTokens;
  }

  /** 统计一次 Tool 调用 */
  addToolCall(): void {
    this.toolCalls++;
  }

  /** 统计一条已执行用例（实时；maxCases 依据） */
  addCase(): void {
    this.casesUsed++;
  }

  /**
   * 从 Trace 导入用量（兼容保留：仅补齐未实时计量的旧调用方）。
   * 实时计费链路（UsageMeter）下不再需要 —— 计数在每次 LLM/Tool/Case 发生时已扣减，
   * 禁止在流程结束时覆盖（否则会丢弃实时数据）。
   */
  importTrace(trace: AgentTrace): void {
    this.llmCalls = Math.max(this.llmCalls, trace.llmCallTotal);
    this.toolCalls = Math.max(this.toolCalls, trace.toolCallTotal);
    this.tokensUsed = Math.max(this.tokensUsed, trace.totalTokens);
  }

  /** 当前状态 */
  status(): BudgetStatus {
    const exceeded: string[] = [];
    const now = Date.now();
    const durationMs = now - this.startedAt;

    if (this.limits.maxTokens !== undefined && this.tokensUsed >= this.limits.maxTokens) exceeded.push('maxTokens');
    if (this.limits.maxCases !== undefined && this.casesUsed >= this.limits.maxCases) exceeded.push('maxCases');
    if (this.limits.maxLLMCalls !== undefined && this.llmCalls >= this.limits.maxLLMCalls) exceeded.push('maxLLMCalls');
    if (this.limits.maxAgentCalls !== undefined && this.agentCalls >= this.limits.maxAgentCalls) exceeded.push('maxAgentCalls');
    if (this.limits.maxToolCalls !== undefined && this.toolCalls >= this.limits.maxToolCalls) exceeded.push('maxToolCalls');
    if (this.limits.maxDurationMs !== undefined && durationMs >= this.limits.maxDurationMs) exceeded.push('maxDurationMs');

    return {
      tokensUsed: this.tokensUsed,
      llmCalls: this.llmCalls,
      agentCalls: this.agentCalls,
      toolCalls: this.toolCalls,
      casesUsed: this.casesUsed,
      durationMs,
      exceeded,
      exceededAny: exceeded.length > 0,
    };
  }

  /** 检查是否可继续（任一预算超限 → 停止） */
  check(): { ok: boolean; exceeded: string[] } {
    const s = this.status();
    return { ok: !s.exceededAny, exceeded: s.exceeded };
  }

  /** 剩余额度摘要 */
  remaining(): Record<string, number | 'unlimited'> {
    const s = this.status();
    return {
      tokens: this.limits.maxTokens !== undefined ? Math.max(0, this.limits.maxTokens - s.tokensUsed) : 'unlimited',
      llmCalls: this.limits.maxLLMCalls !== undefined ? Math.max(0, this.limits.maxLLMCalls - s.llmCalls) : 'unlimited',
      agentCalls: this.limits.maxAgentCalls !== undefined ? Math.max(0, this.limits.maxAgentCalls - s.agentCalls) : 'unlimited',
      toolCalls: this.limits.maxToolCalls !== undefined ? Math.max(0, this.limits.maxToolCalls - s.toolCalls) : 'unlimited',
      durationMs: this.limits.maxDurationMs !== undefined ? Math.max(0, this.limits.maxDurationMs - s.durationMs) : 'unlimited',
    };
  }
}
