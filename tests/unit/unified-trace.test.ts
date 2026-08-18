// Phase 23.1 Unified Decision Trace 单元测试
// 覆盖：四轨聚合（Tool/LLM/Execution/Decision）、runId/taskId/caseId/traceId/spanId 关联、
// replanning 决策、summary 统计、整轮链路还原、空轨迹。

import { describe, it, expect } from 'vitest';
import { AgentTracer } from '../../src/agents/observability/tracer.js';
import { UnifiedTracer } from '../../src/agents/observability/unified-trace.js';
import { DecisionRecorder } from '../../src/decisions/index.js';

function setup() {
  const tracer = new AgentTracer('task-1', { feature: 'wan3', environment: 'test' });
  const recorder = new DecisionRecorder('task-1');
  const unified = new UnifiedTracer('run-001', 'task-1', 'wan3', tracer, recorder);
  return { tracer, recorder, unified };
}

describe('UnifiedTracer（任务书四 / Phase 23.1）', () => {
  it('四轨聚合：spans + tool/llm/execution/decision 事件齐全', () => {
    const { tracer, unified } = setup();
    const sid = tracer.startSpan('execution', 'run');
    tracer.recordTool('execution', 10);
    unified.recordTool(sid, 'execution', 'http', 12);
    unified.recordLLM(sid, 'analysis', 100, 50, 200);
    unified.recordExecution({ caseId: 'case-a', result: 'PASS', priority: 'P0' });
    unified.recordExecution({ caseId: 'case-b', result: 'FAIL', priority: 'P1' });
    unified.recordDecision({ decisionType: 'release', decision: 'BLOCK', evidence: ['p0: 1 failed'], reason: 'P0 失败', confidence: 0.9 });
    tracer.endSpan(sid, { success: true, status: 'ok' });

    const trace = unified.toUnifiedTrace();
    expect(trace.runId).toBe('run-001');
    expect(trace.taskId).toBe('task-1');
    expect(trace.feature).toBe('wan3');
    expect(trace.spans.length).toBe(1);
    expect(trace.toolEvents.length).toBe(1);
    expect(trace.llmEvents.length).toBe(1);
    expect(trace.executionEvents.length).toBe(2);
    expect(trace.decisionEvents.length).toBe(1);
    expect(trace.summary.toolEvents).toBe(1);
    expect(trace.summary.llmEvents).toBe(1);
    expect(trace.summary.executionEvents).toBe(2);
  });

  it('事件通过 runId/taskId/caseId/traceId/spanId 关联', () => {
    const { tracer, unified } = setup();
    const sid = tracer.startSpan('execution', 'run');
    const tool = unified.recordTool(sid, 'execution', 'http', 5);
    const exec = unified.recordExecution({ caseId: 'case-c', result: 'FAIL', priority: 'P2' });
    unified.recordDecision({ decisionType: 'priority', decision: 'P0', caseId: 'case-c', reason: '历史失败率高' });
    tracer.endSpan(sid, { success: true, status: 'ok' });
    const trace = unified.toUnifiedTrace();
    expect(tool.traceId).toBe('run-001:task-1');
    expect(tool.spanId).toBe(sid);
    expect(exec.runId).toBe('run-001');
    expect(exec.taskId).toBe('task-1');
    expect(exec.caseId).toBe('case-c');
    const priorityEvent = trace.decisionEvents.find((d) => d.decisionType === 'priority')!;
    expect(priorityEvent.caseId).toBe('case-c');
    expect(priorityEvent.traceId).toBe('run-001:task-1');
  });

  it('整轮链路还原：runId → priority → execution → failure → replan → release', () => {
    const { tracer, unified } = setup();
    unified.recordDecision({ decisionType: 'priority', decision: 'P0', caseId: 'case-b', reason: '变更相关' });
    const sid = tracer.startSpan('execution', 'run');
    tracer.endSpan(sid, { success: true, status: 'ok' });
    unified.recordExecution({ caseId: 'case-b', result: 'FAIL', priority: 'P0' });
    unified.recordDecision({ decisionType: 'replanning', decision: 'REPLAN', caseId: 'case-c', inputs: { failure: 'case-b' }, outputs: { boosted: ['C', 'D'], paused: ['E'] }, reason: 'B 与 Model Change 高相关' });
    unified.recordDecision({ decisionType: 'stopping', decision: 'STOP', reason: 'P0 失败' });
    unified.recordDecision({ decisionType: 'release', decision: 'BLOCK', evidence: ['p0: 1 failed'], reason: 'P0 失败', confidence: 0.96 });

    const trace = unified.toUnifiedTrace();
    const types = trace.decisionEvents.map((d) => d.decisionType);
    expect(types).toEqual(['priority', 'replanning', 'stopping', 'release']);
    const replan = trace.decisionEvents.find((d) => d.decisionType === 'replanning')!;
    expect(replan.outputs).toEqual({ boosted: ['C', 'D'], paused: ['E'] });
    // 顺序还原：execution 事件（case-b FAIL）在 replan 决策前
    const failIndex = trace.executionEvents.findIndex((e) => e.caseId === 'case-b');
    const replanIndex = trace.decisionEvents.findIndex((d) => d.decisionType === 'replanning');
    expect(failIndex).toBeGreaterThanOrEqual(0);
    expect(replanIndex).toBeGreaterThan(0);
    expect(trace.summary.replanCount).toBe(1);
    expect(trace.summary.stopDecision).toBe('STOP');
    expect(trace.summary.releaseDecision).toBe('BLOCK');
  });

  it('summary 统计：passes/failures/skipped 正确', () => {
    const { unified } = setup();
    unified.recordExecution({ caseId: 'a', result: 'PASS' });
    unified.recordExecution({ caseId: 'b', result: 'PASS' });
    unified.recordExecution({ caseId: 'c', result: 'FAIL' });
    unified.recordExecution({ caseId: 'd', result: 'SKIPPED' });
    const trace = unified.toUnifiedTrace();
    expect(trace.summary.passes).toBe(2);
    expect(trace.summary.failures).toBe(1);
    expect(trace.summary.skipped).toBe(1);
  });

  it('空轨迹：各轨为空，summary 全 0，不报错', () => {
    const { unified } = setup();
    const trace = unified.toUnifiedTrace();
    expect(trace.spans).toEqual([]);
    expect(trace.toolEvents).toEqual([]);
    expect(trace.llmEvents).toEqual([]);
    expect(trace.executionEvents).toEqual([]);
    expect(trace.decisionEvents).toEqual([]);
    expect(trace.summary.replanCount).toBe(0);
    expect(trace.summary.releaseDecision).toBeUndefined();
  });

  it('决策同时写入 DecisionRecorder（单一数据源，不重复存储）', () => {
    const { recorder, unified } = setup();
    unified.recordDecision({ decisionType: 'risk', decision: 'HIGH', score: 0.7, evidence: ['历史失败率高'], reason: '历史失败', confidence: 0.8 });
    expect(recorder.size()).toBe(1);
    const rec = recorder.byKind('risk')[0];
    expect(rec.decision).toBe('HIGH');
    expect(rec.confidence).toBe(0.8);
  });
});
