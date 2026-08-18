// Observability Schema：Agent 可观测性数据模型（Phase 17）
// 记录每个 Agent 的 Token / 延迟 / LLM 成本 / Tool 调用 / 重试 / 回退 / 错误，
// 生成 Agent Trace，用于回答「Agent 到底有没有比人工/传统自动化更有价值」。

/** 单阶段 Span（一次 Agent 执行） */
export interface AgentTraceSpan {
  /** Agent 名（如 requirement / test-design / risk / execution / analysis / rca / defect / healing / flaky） */
  agent: string;
  /** 阶段 */
  stage: string;
  /** 起始时间戳（epoch ms） */
  startAt: number;
  /** 耗时（ms） */
  durationMs: number;
  /** 输入 token */
  inputTokens?: number;
  /** 输出 token */
  outputTokens?: number;
  /** LLM 调用次数 */
  llmCalls: number;
  /** LLM 成本（估算） */
  llmCost?: number;
  /** Tool 调用次数 */
  toolCalls: number;
  /** Tool 总耗时（ms） */
  toolDurationMs: number;
  /** 重试次数 */
  retryCount: number;
  /** 回退次数（LLM→规则） */
  fallbackCount: number;
  /** 错误信息 */
  error?: string;
  /** 是否成功 */
  success: boolean;
  /** 状态：ok / fallback / error */
  status: 'ok' | 'fallback' | 'error';
}

/** Agent Trace（整轮任务的观测汇总） */
export interface AgentTrace {
  taskId: string;
  feature?: string;
  environment?: string;
  spans: AgentTraceSpan[];
  /** 总耗时（ms） */
  totalLatencyMs: number;
  /** 总 token（input + output） */
  totalTokens: number;
  /** 总成本（估算） */
  totalCost?: number;
  /** LLM 调用总次数 */
  llmCallTotal: number;
  /** Tool 调用总次数 */
  toolCallTotal: number;
  /** 回退总次数 */
  fallbackTotal: number;
  /** 错误总次数 */
  errorTotal: number;
  /** 一句话汇总 */
  summary: string;
  createdAt: string;
}

/** 判断数据是否「像 AgentTrace」 */
export function isTraceLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).taskId === 'string'
    && Array.isArray((data as Record<string, unknown>).spans)
  );
}

/** 汇总 Trace 统计 */
export function summarizeTrace(trace: AgentTrace): AgentTrace {
  const totalTokens = trace.spans.reduce((s, x) => s + (x.inputTokens ?? 0) + (x.outputTokens ?? 0), 0);
  const llmCallTotal = trace.spans.reduce((s, x) => s + x.llmCalls, 0);
  const toolCallTotal = trace.spans.reduce((s, x) => s + x.toolCalls, 0);
  const fallbackTotal = trace.spans.reduce((s, x) => s + x.fallbackCount, 0);
  const errorTotal = trace.spans.filter((x) => x.status === 'error').length;
  const totalCost = trace.spans.reduce((s, x) => s + (x.llmCost ?? 0), 0);
  return {
    ...trace,
    totalTokens,
    llmCallTotal,
    toolCallTotal,
    fallbackTotal,
    errorTotal,
    totalCost,
    totalLatencyMs: trace.totalLatencyMs ?? trace.spans.reduce((s, x) => s + x.durationMs, 0),
    summary: `${trace.spans.length} 个 Agent 阶段，LLM ${llmCallTotal} 次，Tool ${toolCallTotal} 次，回退 ${fallbackTotal} 次，错误 ${errorTotal} 次，Token ${totalTokens}，耗时 ${trace.totalLatencyMs}ms`,
    createdAt: trace.createdAt ?? new Date().toISOString(),
  };
}
