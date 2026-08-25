// Usage Meter / Budget Manager：用量实时计量与预算管理（横切层）。
//
// 修复的旧问题：预算属于「流程结束 → importTrace 从 Trace 统计」的事后记账，
// 超限不会停止任何在途执行。新语义：
//
//   LLM Decorator（AgentRuntime.generate 每次调用）
//      ↓ beforeLLM：预留额度（估算 = route.maxTokens）+ STOP 检查
//      ↓ settleLLM：释放预留 → 实际 token 实时扣减 → 超限立即 STOP
//   Tool Decorator（ToolRegistry.call 每次调用）
//      ↓ beforeTool / afterTool：次数实时扣减 → 超限立即 STOP
//   Case 级（Runner 每条用例）
//      ↓ beforeCase / afterCase：maxCases 实时参与执行
//        ↓
//   UsageMeter（本模块）→ AgentBudget（计数与上限判定）
//
// 预留语义（防并发超支）：调用前按估算预留，预留失败（已用+预留>上限）立即 STOP；
// 调用完成后按实际用量结算（多预留的释放）。达到上限 → stopped=true，
// 后续 LLM/Tool/Case/Stage 全部立即失败（fail-fast），不再执行。
import type { AgentBudget } from './budget.js';
import { CodedError, ErrorCode } from '../../core/errors.js';

/** 预算超限错误：立即 STOP 信号（调用方不得重试 / 不得继续调度） */
export class BudgetExceededError extends CodedError {
  constructor(public readonly reasons: string[]) {
    super(ErrorCode.BUDGET_EXCEEDED, `预算超限（STOP）：${reasons.join('，')}`, { details: { reasons } });
    this.name = 'BudgetExceededError';
  }
}

export interface UsageMeterOptions {
  /** 预算（缺省只计量不限额） */
  budget?: AgentBudget;
  /** 单次 LLM 调用的默认预留 token（估算；route.maxTokens 优先） */
  defaultReserveTokens?: number;
}

/** 用量计量器 + 预算管理器 */
export class UsageMeter {
  private readonly budget?: AgentBudget;
  private readonly defaultReserveTokens: number;
  /** 已预留未结算的 token（并发在途 LLM 调用） */
  private reservedTokens = 0;
  /** 并发在途调用次数也必须预留，避免多个请求同时穿透 max*Calls。 */
  private reservedLLMCalls = 0;
  private reservedToolCalls = 0;
  private stopped = false;
  private stopReasons: string[] = [];

  constructor(options: UsageMeterOptions = {}) {
    this.budget = options.budget;
    this.defaultReserveTokens = options.defaultReserveTokens ?? 2_000;
  }

  /** 是否已 STOP（超限后所有新执行立即失败） */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** STOP 原因（超限项列表） */
  get reasons(): string[] {
    return [...this.stopReasons];
  }

  /** maxConcurrency 预算钳制（与 Plan.maxConcurrency / options.concurrency 取 min） */
  get maxConcurrencyClamp(): number | undefined {
    return this.budget?.limits.maxConcurrency;
  }

  /** maxCases 预算上限（与 Plan.maxCases 取 min） */
  get maxCasesClamp(): number | undefined {
    return this.budget?.limits.maxCases;
  }

  /** 当前累计 token（实时，非流程结束统计） */
  get tokensUsed(): number {
    return this.budget?.status().tokensUsed ?? 0;
  }

  /**
   * LLM 调用前：预留额度 + STOP 检查。
   * - 已 STOP → 抛 BudgetExceededError（fail-fast，不发起请求）；
   * - 预留后超限（已用 + 预留 > maxTokens）→ STOP 并抛错（防并发在途调用合计超支）。
   */
  beforeLLM(estimateOutputTokens?: number, estimateInputTokens = 0): number {
    this.assertRunning();
    const reserve = Math.max(1, estimateOutputTokens ?? this.defaultReserveTokens) + Math.max(0, estimateInputTokens);
    if (this.budget) {
      const s = this.budget.status();
      const callLimit = this.budget.limits.maxLLMCalls;
      if (callLimit !== undefined && s.llmCalls + this.reservedLLMCalls >= callLimit) {
        this.stop(['maxLLMCalls']);
        throw new BudgetExceededError(this.reasons);
      }
      const limit = this.budget.limits.maxTokens;
      if (limit !== undefined && s.tokensUsed + this.reservedTokens + reserve > limit) {
        this.stop(['maxTokens']);
        throw new BudgetExceededError(this.reasons);
      }
    }
    this.reservedTokens += reserve;
    this.reservedLLMCalls += 1;
    return reserve;
  }

  /**
   * LLM 调用成功结算：释放预留 → 按实际用量实时扣减（含 1 次调用计数）→ 超限即 STOP。
   * STOP 不抛错（本次调用已完成，STOP 生效于后续执行）。
   */
  settleLLM(reservedTokens: number, inputTokens: number, outputTokens: number): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - reservedTokens);
    this.reservedLLMCalls = Math.max(0, this.reservedLLMCalls - 1);
    if (!this.budget) return;
    this.budget.addLLMCall(inputTokens, outputTokens);
    this.checkAndStop();
  }

  /** LLM 调用失败结算：释放 token 预留（估算不是实际消耗），调用次数仍计量 */
  settleLLMFailure(reservedTokens: number): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - reservedTokens);
    this.reservedLLMCalls = Math.max(0, this.reservedLLMCalls - 1);
    if (!this.budget) return;
    this.budget.addLLMCall(0, 0);
    this.checkAndStop();
  }

  /** Tool 调用前：STOP 检查（超限后不再执行任何 Tool） */
  beforeTool(): void {
    this.assertRunning();
    if (this.budget) {
      const s = this.budget.status();
      const limit = this.budget.limits.maxToolCalls;
      if (limit !== undefined && s.toolCalls + this.reservedToolCalls >= limit) {
        this.stop(['maxToolCalls']);
        throw new BudgetExceededError(this.reasons);
      }
    }
    this.reservedToolCalls += 1;
  }

  /** Tool 调用后：次数实时扣减 → 超限即 STOP */
  afterTool(): void {
    this.reservedToolCalls = Math.max(0, this.reservedToolCalls - 1);
    if (!this.budget) return;
    this.budget.addToolCall();
    this.checkAndStop();
  }

  /** 用例执行前：STOP + maxCases 检查（超出用例数预算 → STOP 并抛错） */
  beforeCase(): void {
    this.assertRunning();
    if (this.budget) {
      const s = this.budget.status();
      const limit = this.budget.limits.maxCases;
      if (limit !== undefined && s.casesUsed >= limit) {
        this.stop(['maxCases']);
        throw new BudgetExceededError(this.reasons);
      }
    }
  }

  /** 用例执行后：用例计数实时扣减 → 超限即 STOP（停止调度后续用例） */
  afterCase(): void {
    if (!this.budget) return;
    this.budget.addCase();
    this.checkAndStop();
  }

  /** 预算状态（透传） */
  status(): { ok: boolean; exceeded: string[] } {
    if (this.stopped) return { ok: false, exceeded: this.reasons };
    return this.budget?.check() ?? { ok: true, exceeded: [] };
  }

  /** 手动 STOP（外部预算控制入口） */
  stop(reasons: string[]): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReasons = reasons;
  }

  /** 断言未 STOP，已停止则抛错 */
  private assertRunning(): void {
    if (this.stopped) throw new BudgetExceededError(this.reasons);
  }

  /**
   * 扣减后检查：花费类超限即 STOP。
   * 注意：maxAgentCalls 是阶段调度闸（runStage 入口处理：增强跳过/关键告警继续），
   * 不是花费维度 —— 不触发全局 STOP，否则会误杀 execution.run 等必要的收尾执行。
   */
  private checkAndStop(): void {
    if (this.stopped) return;
    const b = this.budget!.check();
    const spendExceeded = b.exceeded.filter((r) => r !== 'maxAgentCalls');
    if (spendExceeded.length) this.stop(spendExceeded);
  }
}
