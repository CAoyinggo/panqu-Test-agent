// 单元测试：Agent Observability + Budget（Phase 17）
// 覆盖：Tracer 记录 LLM/Tool/重试/回退/错误、Trace 汇总、Budget 限额与超限
import { describe, it, expect } from 'vitest';
import {
  AgentTracer,
  AgentBudget,
  summarizeTrace,
  isTraceLike,
} from '../../src/agents/index.js';

describe('tracer - 阶段记录', () => {
  it('startSpan/endSpan 记录耗时与状态', async () => {
    const t = new AgentTracer('t1', { feature: 'wan3', environment: 'test' });
    const id = t.startSpan('requirement', 'REQUIREMENT_PARSED');
    await new Promise((r) => setTimeout(r, 10));
    t.recordLLM('requirement', 100, 50, 5);
    t.endSpan(id, { inputTokens: 100, outputTokens: 50 });
    const trace = t.toTrace();
    expect(trace.spans).toHaveLength(1);
    const s = trace.spans[0];
    expect(s.agent).toBe('requirement');
    expect(s.llmCalls).toBe(1);
    expect(s.durationMs).toBeGreaterThanOrEqual(10);
    expect(s.success).toBe(true);
    expect(s.status).toBe('ok');
    expect(trace.totalTokens).toBe(150);
    expect(trace.llmCallTotal).toBe(1);
  });

  it('回退与错误状态记录', () => {
    const t = new AgentTracer('t1');
    const id1 = t.startSpan('risk', 'RISK_ASSESSED');
    t.recordFallback('risk');
    t.endSpan(id1);
    const id2 = t.startSpan('rca', 'RCA');
    t.recordError('rca', 'LLM 挂了');
    t.endSpan(id2);
    const trace = t.toTrace();
    expect(trace.fallbackTotal).toBe(1);
    expect(trace.errorTotal).toBe(1);
    expect(trace.spans.find((s) => s.agent === 'risk')?.status).toBe('fallback');
    expect(trace.spans.find((s) => s.agent === 'rca')?.status).toBe('error');
    expect(trace.spans.find((s) => s.agent === 'rca')?.error).toContain('LLM');
  });

  it('未结束的 span 不进入汇总', () => {
    const t = new AgentTracer('t1');
    t.startSpan('execution', 'EXECUTING');
    const trace = t.toTrace();
    expect(trace.spans).toHaveLength(0);
    expect(t.activeCount()).toBe(1);
  });

  it('recordTool 统计 Tool 调用与耗时', () => {
    const t = new AgentTracer('t1');
    const id = t.startSpan('data', 'DATA_READY');
    t.recordTool('data', 12);
    t.recordTool('data', 8);
    t.endSpan(id);
    const s = t.toTrace().spans[0];
    expect(s.toolCalls).toBe(2);
    expect(s.toolDurationMs).toBe(20);
  });

  it('isTraceLike 与 summarizeTrace', () => {
    const t = new AgentTracer('t1');
    const id = t.startSpan('analysis', 'ANALYZING');
    t.endSpan(id);
    const trace = t.toTrace();
    expect(isTraceLike(trace)).toBe(true);
    const s = summarizeTrace(trace);
    expect(s.summary).toContain('Token');
    expect(s.createdAt).toBeTruthy();
  });
});

describe('budget - 限额控制', () => {
  it('超限检测（token / LLM 调用 / Agent 调用 / Tool / 时长）', () => {
    const b = new AgentBudget({
      maxTokens: 100,
      maxLLMCalls: 2,
      maxAgentCalls: 3,
      maxToolCalls: 5,
      maxDurationMs: 1000,
    });
    expect(b.check().ok).toBe(true);
    b.addLLMCall(50, 60); // 110 tokens
    b.addLLMCall(0, 0);
    b.addAgentCall();
    b.addToolCall();
    const s = b.status();
    expect(s.exceeded).toContain('maxTokens');
    expect(s.exceeded).toContain('maxLLMCalls');
    expect(s.exceededAny).toBe(true);
    expect(b.check().ok).toBe(false);
    expect(b.remaining().tokens).toBe(0);
    expect(b.remaining().llmCalls).toBe(0);
  });

  it('importTrace 从 Trace 导入用量', () => {
    const t = new AgentTracer('t1');
    const id = t.startSpan('rca', 'RCA');
    t.recordLLM('rca', 100, 50, 3);
    t.endSpan(id, { inputTokens: 100, outputTokens: 50 });
    const b = new AgentBudget({ maxTokens: 200 });
    b.importTrace(t.toTrace());
    const s = b.status();
    expect(s.tokensUsed).toBe(150);
    expect(s.llmCalls).toBe(1);
    expect(b.check().ok).toBe(true);
  });

  it('无上限时不超限', () => {
    const b = new AgentBudget();
    for (let i = 0; i < 100; i++) b.addLLMCall(1000, 1000);
    expect(b.check().ok).toBe(true);
    expect(b.remaining().tokens).toBe('unlimited');
  });
});
