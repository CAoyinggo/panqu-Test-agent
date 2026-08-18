// Phase 22 通用：Decision Trace 单元测试
// 覆盖：7 类自治决策记录（含 Phase 23.1 replanning）、每次决策必须留下 decision/score/evidence/reason/confidence/timestamp/inputs、
// caseId/outputs 关联、按类型查询、空轨迹、确定性。

import { describe, it, expect } from 'vitest';
import { DecisionRecorder, DECISION_KINDS, type DecisionRecord } from '../../src/decisions/index.js';

describe('DecisionRecorder（任务书二十二）', () => {
  it('记录 7 类自治决策：requirement / risk / selection / priority / stopping / replanning / release', () => {
    const r = new DecisionRecorder('task-1');
    r.record({ kind: 'requirement', decision: 'ACCEPT', reason: '需求完整' });
    r.record({ kind: 'risk', decision: 'HIGH', score: 0.73, evidence: ['历史失败率 37%', '模型发生变更'], reason: '关联模型变更 + 历史失败率高', confidence: 0.88 });
    r.record({ kind: 'selection', decision: 'SELECT', score: 0.6, evidence: ['变更影响'], reason: '变更相关用例优先选择' });
    r.record({ kind: 'priority', decision: 'P0', score: 0.8, evidence: ['P0 风险'], reason: '关联 P0 风险，提升优先级' });
    r.record({ kind: 'stopping', decision: 'STOP', score: 0.95, evidence: ['Coverage 95%', 'P0 100%'], reason: '新增测试价值低于阈值', confidence: 0.9 });
    r.record({ kind: 'replanning', decision: 'REPLAN', score: 0.6, evidence: ['B 与 Model Change 高相关'], reason: '提升 C/D 优先级，暂停 E', caseId: 'case-c' });
    r.record({ kind: 'release', decision: 'BLOCK', score: 0.96, evidence: ['p0: 1 failed', 'critical-defect: 2 open'], reason: 'P0 存在失败', confidence: 0.96 });
    expect(r.size()).toBe(7);
    for (const kind of DECISION_KINDS) expect(r.byKind(kind).length).toBe(1);
  });

  it('记录 caseId 与 outputs 关联（Trace 可还原）', () => {
    const r = new DecisionRecorder('task-5');
    const rec = r.record({
      kind: 'replanning',
      decision: 'REPLAN',
      caseId: 'wan3-1080p-10s',
      inputs: { failure: 'B', tag: 'model-change' },
      outputs: { boosted: ['C', 'D'], paused: ['E'] },
      reason: 'B 失败且与 Model Change 高相关，提升 C/D',
    });
    expect(rec.caseId).toBe('wan3-1080p-10s');
    expect(rec.outputs).toEqual({ boosted: ['C', 'D'], paused: ['E'] });
    expect(rec.inputs.failure).toBe('B');
  });

  it('每条记录包含 decision/score/evidence/reason/confidence/timestamp/inputs', () => {
    const r = new DecisionRecorder('task-2');
    const rec = r.record({
      kind: 'risk',
      decision: 'HIGH',
      score: 0.73,
      evidence: ['历史失败率 37%'],
      reason: '历史失败率高',
      confidence: 0.88,
      timestamp: 1780000000000,
      inputs: { caseId: 'wan3-1080p-10s', failureRate: 0.37 },
    });
    expect(rec.id).toMatch(/^task-2-d\d{3}$/);
    expect(rec.score).toBe(0.73);
    expect(rec.evidence).toEqual(['历史失败率 37%']);
    expect(rec.reason).toBe('历史失败率高');
    expect(rec.confidence).toBe(0.88);
    expect(rec.timestamp).toBe('2026-05-28T20:26:40.000Z');
    expect(rec.inputs.caseId).toBe('wan3-1080p-10s');
  });

  it('toTrace：汇总各类型决策数量', () => {
    const r = new DecisionRecorder('task-3');
    r.record({ kind: 'selection', decision: 'SELECT', reason: 'a' });
    r.record({ kind: 'selection', decision: 'SELECT', reason: 'b' });
    r.record({ kind: 'release', decision: 'PASS', reason: 'c' });
    const trace = r.toTrace();
    expect(trace.taskId).toBe('task-3');
    expect(trace.byKind.selection).toBe(2);
    expect(trace.byKind.release).toBe(1);
    expect(trace.byKind.stopping).toBe(0);
    expect(trace.summary).toContain('3 条自治决策');
    expect(trace.records.length).toBe(3);
  });

  it('空轨迹：entries 为空、byKind 全 0', () => {
    const r = new DecisionRecorder('task-4');
    expect(r.entries()).toEqual([]);
    expect(r.size()).toBe(0);
    const trace = r.toTrace();
    expect(trace.records).toEqual([]);
    expect(Object.values(trace.byKind).every((n) => n === 0)).toBe(true);
  });

  it('确定性：相同输入产生相同记录内容', () => {
    const a = new DecisionRecorder('t');
    const b = new DecisionRecorder('t');
    const ra = a.record({ kind: 'risk', decision: 'HIGH', score: 0.5, reason: 'r', timestamp: 1000 });
    const rb = b.record({ kind: 'risk', decision: 'HIGH', score: 0.5, reason: 'r', timestamp: 1000 });
    expect(ra).toEqual(rb);
  });
});
