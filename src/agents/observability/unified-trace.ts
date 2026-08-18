// Unified Trace：四轨追踪聚合器（Tool / LLM / Execution / Decision）（Phase 23.1）
// 复用现有 AgentTracer（span 聚合）与 DecisionRecorder（决策存储），不建立第二套 Trace 存储。
// 所有事件可通过 runId / taskId / caseId / traceId / spanId 关联，可完整还原整轮自治决策链路。

import type { AgentTraceSpan } from './observability-schema.js';
import type { AgentTracer } from './tracer.js';
import type { DecisionKind } from '../../decisions/decision-schema.js';
import type { DecisionRecorder } from '../../decisions/decision-recorder.js';

/** Tool 事件 */
export interface ToolTraceEvent {
  traceId: string;
  spanId: string;
  agent: string;
  tool: string;
  durationMs: number;
  timestamp: number;
}

/** LLM 事件 */
export interface LLMTraceEvent {
  traceId: string;
  spanId: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  timestamp: number;
}

/** 用例执行事件 */
export interface ExecutionTraceEvent {
  traceId: string;
  runId: string;
  taskId: string;
  caseId: string;
  result: 'PASS' | 'FAIL' | 'FLAKY' | 'ENV' | 'SKIPPED';
  priority?: string;
  durationMs: number;
  timestamp: number;
}

/** 决策事件（与 DecisionRecord 一一对应，含关联字段） */
export interface DecisionTraceEvent {
  traceId: string;
  runId: string;
  taskId: string;
  caseId?: string;
  decisionType: DecisionKind;
  decision: string;
  score?: number;
  evidence: string[];
  reason: string;
  confidence?: number;
  timestamp: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

/** 汇总统计 */
export interface TraceSummary {
  spans: number;
  toolEvents: number;
  llmEvents: number;
  executionEvents: number;
  decisionEvents: number;
  passes: number;
  failures: number;
  skipped: number;
  totalLatencyMs: number;
  replanCount: number;
  stopDecision?: string;
  releaseDecision?: string;
}

/** 统一 Trace（四轨） */
export interface UnifiedTrace {
  runId: string;
  taskId: string;
  feature?: string;
  spans: AgentTraceSpan[];
  toolEvents: ToolTraceEvent[];
  llmEvents: LLMTraceEvent[];
  executionEvents: ExecutionTraceEvent[];
  decisionEvents: DecisionTraceEvent[];
  summary: TraceSummary;
  createdAt: string;
}

/** 决策记录输入（UnifiedTracer 视图） */
export interface RecordUnifiedDecisionInput {
  decisionType: DecisionKind;
  decision: string;
  score?: number;
  evidence?: string[];
  reason: string;
  confidence?: number;
  caseId?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  timestamp?: number;
}

/** 统一追踪器：组合 AgentTracer（span）+ DecisionRecorder（决策）+ 事件级四轨记录 */
export class UnifiedTracer {
  private readonly toolEvents: ToolTraceEvent[] = [];
  private readonly llmEvents: LLMTraceEvent[] = [];
  private readonly executionEvents: ExecutionTraceEvent[] = [];
  private readonly traceId: string;

  constructor(
    private readonly runId: string,
    private readonly taskId: string,
    private readonly feature: string | undefined,
    private readonly tracer: AgentTracer,
    private readonly recorder: DecisionRecorder,
  ) {
    this.traceId = `${runId}:${taskId}`;
  }

  /** 记录 Tool 事件 */
  recordTool(spanId: string, agent: string, tool: string, durationMs: number): ToolTraceEvent {
    const e: ToolTraceEvent = { traceId: this.traceId, spanId, agent, tool, durationMs, timestamp: Date.now() };
    this.toolEvents.push(e);
    return e;
  }

  /** 记录 LLM 事件 */
  recordLLM(spanId: string, agent: string, inputTokens: number, outputTokens: number, latencyMs: number): LLMTraceEvent {
    const e: LLMTraceEvent = { traceId: this.traceId, spanId, agent, inputTokens, outputTokens, latencyMs, timestamp: Date.now() };
    this.llmEvents.push(e);
    return e;
  }

  /** 记录用例执行事件（与执行引擎对接） */
  recordExecution(input: { caseId: string; result: ExecutionTraceEvent['result']; priority?: string; durationMs?: number }): ExecutionTraceEvent {
    const e: ExecutionTraceEvent = {
      traceId: this.traceId,
      runId: this.runId,
      taskId: this.taskId,
      caseId: input.caseId,
      result: input.result,
      priority: input.priority,
      durationMs: input.durationMs ?? 0,
      timestamp: Date.now(),
    };
    this.executionEvents.push(e);
    return e;
  }

  /** 记录自治决策（同时写入 DecisionRecorder 存储，保持单一数据源） */
  recordDecision(input: RecordUnifiedDecisionInput): DecisionTraceEvent {
    const record = this.recorder.record({
      kind: input.decisionType,
      decision: input.decision,
      score: input.score,
      evidence: input.evidence,
      reason: input.reason,
      confidence: input.confidence,
      inputs: input.inputs,
      caseId: input.caseId,
      outputs: input.outputs,
      timestamp: input.timestamp,
    });
    const e: DecisionTraceEvent = {
      traceId: this.traceId,
      runId: this.runId,
      taskId: this.taskId,
      caseId: record.caseId,
      decisionType: record.kind,
      decision: record.decision,
      score: record.score,
      evidence: record.evidence,
      reason: record.reason,
      confidence: record.confidence,
      timestamp: record.timestamp,
      inputs: record.inputs,
      outputs: record.outputs,
    };
    return e;
  }

  /** 生成统一 Trace（spans 来自 AgentTracer，决策来自 DecisionRecorder） */
  toUnifiedTrace(): UnifiedTrace {
    const agentTrace = this.tracer.toTrace();
    const spans = agentTrace.spans;
    const decisionEvents: DecisionTraceEvent[] = this.recorder.toTrace().records.map((r) => ({
      traceId: this.traceId,
      runId: this.runId,
      taskId: this.taskId,
      caseId: r.caseId,
      decisionType: r.kind,
      decision: r.decision,
      score: r.score,
      evidence: r.evidence,
      reason: r.reason,
      confidence: r.confidence,
      timestamp: r.timestamp,
      inputs: r.inputs,
      outputs: r.outputs,
    }));

    const passes = this.executionEvents.filter((e) => e.result === 'PASS').length;
    const failures = this.executionEvents.filter((e) => ['FAIL', 'FLAKY', 'ENV'].includes(e.result)).length;
    const skipped = this.executionEvents.filter((e) => e.result === 'SKIPPED').length;
    const replanCount = decisionEvents.filter((d) => d.decisionType === 'replanning').length;
    const stopDecision = decisionEvents.find((d) => d.decisionType === 'stopping')?.decision;
    const releaseDecision = decisionEvents.find((d) => d.decisionType === 'release')?.decision;

    const summary: TraceSummary = {
      spans: spans.length,
      toolEvents: this.toolEvents.length,
      llmEvents: this.llmEvents.length,
      executionEvents: this.executionEvents.length,
      decisionEvents: decisionEvents.length,
      passes,
      failures,
      skipped,
      totalLatencyMs: agentTrace.totalLatencyMs,
      replanCount,
      stopDecision,
      releaseDecision,
    };

    return {
      runId: this.runId,
      taskId: this.taskId,
      feature: this.feature,
      spans,
      toolEvents: [...this.toolEvents],
      llmEvents: [...this.llmEvents],
      executionEvents: [...this.executionEvents],
      decisionEvents,
      summary,
      createdAt: new Date().toISOString(),
    };
  }
}
