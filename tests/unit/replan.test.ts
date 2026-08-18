// Phase 23.5 动态 Re-Planning 单元测试
// 场景：A(P0) PASS → B(P1,model) FAIL → C/D 重新评分 → C(P1,model) FAIL → Risk ↑
//       → 暂停低优先级（D/E）→ RCA → Release BLOCK。
// 验证 Trace 完整记录：Initial Plan / RePlan#1 / RePlan#2 / Final Plan / Stop / Release。
// 全部确定性、离线可复现。

import { describe, it, expect } from 'vitest';
import { runAutonomousPipeline } from '../../src/autonomous/index.js';
import { replanCases } from '../../src/autonomous/pipeline-scenarios.js';
import type { DecisionTrace } from '../../src/decisions/index.js';

const NOW = '2026-08-01T00:00:00Z';

function buildReplanInput() {
  return runAutonomousPipeline({
    change: { type: 'model', target: 'wan3/text-to-video' },
    cases: replanCases(),
    feature: 'wan3/text-to-video',
    environment: 'test',
    outcomes: { A: true, B: false, C: false, D: true, E: true },
    clusterFailureTrigger: 2,
    fullRegression: true,
    now: NOW,
  });
}

describe('动态 Re-Planning（Scenario 4）', () => {
  it('初始计划：A > B > C > D > E（优先级排序）', () => {
    const r = buildReplanInput();
    expect(r.trace.initialPlan).toEqual(['A', 'B', 'C', 'D', 'E']);
    // A（P0）最先执行
    expect(r.regression.executed[0].caseId).toBe('A');
    expect(r.regression.executed[0].passed).toBe(true);
  });

  it('B FAIL → 同标签 C/D 重新评分并提升（RePlan #1）', () => {
    const r = buildReplanInput();
    expect(r.regression.replans.length).toBe(2);
    const first = r.regression.replans[0];
    expect(first.failedCase).toBe('B');
    // B 带 model 标签 → 提升同为 model 的 C、D
    expect(first.boostedCases).toEqual(['C', 'D']);
    // Trace 记录 RePlan #1
    const kinds = r.trace.decisionTrace.records.map((e) => e.kind);
    expect(kinds).toContain('replanning');
  });

  it('C FAIL → Risk ↑ → 暂停低优先级 D/E，仅执行 P0（RePlan #2）', () => {
    const r = buildReplanInput();
    const second = r.regression.replans[1];
    expect(second.failedCase).toBe('C');
    expect(second.boostedCases).toEqual(['D']);
    // 低优先级用例被暂停
    expect(r.trace.pausedCaseIds).toContain('D');
    expect(r.trace.pausedCaseIds).toContain('E');
    expect(r.trace.pausedCaseIds.length).toBeGreaterThanOrEqual(2);
    // D/E 未执行
    const executedIds = r.regression.executed.map((e) => e.caseId);
    expect(executedIds).not.toContain('D');
    expect(executedIds).not.toContain('E');
    // 证据可解释
    expect(r.regression.evidence.some((e) => e.includes('暂停'))).toBe(true);
  });

  it('Trace 完整记录：Initial / RePlan#1 / RePlan#2 / Final / Stop / Release', () => {
    const r = buildReplanInput();
    const trace = r.trace;
    expect(trace.initialPlan).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(trace.replans.length).toBe(2);
    expect(trace.releaseDecision).toBe('BLOCK');
    expect(trace.stopDecision).not.toBeNull();
    expect(trace.stopDecision!.triggered).toBe(true);
    // 决策轨迹包含 Release 决策
    const releaseEvent = trace.decisionTrace.records.find((e) => e.kind === 'release');
    expect(releaseEvent).toBeDefined();
    expect(releaseEvent!.decision).toBe('BLOCK');
  });

  it('Release BLOCK：critical 缺陷 → exit 1（Deterministic，非 LLM 决定）', () => {
    const r = buildReplanInput();
    expect(r.release.decision).toBe('BLOCK');
    expect(r.releaseExitCode).toBe(1);
    expect(r.defects.filter((d) => d.severity === 'critical').length).toBe(2);
    // 决策来自规则引擎：blockReasons 说明阻断因素
    expect(r.release.blockReasons.length).toBeGreaterThan(0);
    // 知识更新：模型变更 + critical → 高风险持久化
    expect(r.knowledgeUpdates.some((k) => k.includes('critical'))).toBe(true);
  });
});

describe('Trace 关联：runId / caseId / decisionKind', () => {
  it('所有决策事件携带 taskId 与统一决策类型（Requirement/Risk/Selection/Priority/Stopping/Release）', () => {
    const r = buildReplanInput();
    const dt: DecisionTrace = r.trace.decisionTrace;
    const kinds = new Set(dt.records.map((e) => e.kind));
    // 端到端闭环必需的关键决策类型
    expect(kinds.has('requirement')).toBe(true);
    expect(kinds.has('selection')).toBe(true);
    expect(kinds.has('risk')).toBe(true);
    expect(kinds.has('priority')).toBe(true);
    expect(kinds.has('replanning')).toBe(true);
    expect(kinds.has('stopping')).toBe(true);
    expect(kinds.has('release')).toBe(true);
    // 事件必须能通过 taskId（含 runId） / caseId 关联
    expect(dt.taskId).toBe(`task-${r.runId}`);
    const replanEvent = dt.records.find((e) => e.kind === 'replanning');
    expect(replanEvent?.caseId).toBeDefined();
  });
});

describe('确定性', () => {
  it('相同输入两次运行结果完全一致', () => {
    const a = runAutonomousPipeline({
      change: { type: 'model', target: 'wan3/text-to-video' },
      cases: replanCases(),
      feature: 'wan3/text-to-video',
      environment: 'test',
      outcomes: { A: true, B: false, C: false, D: true, E: true },
      clusterFailureTrigger: 2,
      fullRegression: true,
      now: NOW,
    });
    const b = runAutonomousPipeline({
      change: { type: 'model', target: 'wan3/text-to-video' },
      cases: replanCases(),
      feature: 'wan3/text-to-video',
      environment: 'test',
      outcomes: { A: true, B: false, C: false, D: true, E: true },
      clusterFailureTrigger: 2,
      fullRegression: true,
      now: NOW,
    });
    expect(a.trace.initialPlan).toEqual(b.trace.initialPlan);
    expect(a.trace.replans).toEqual(b.trace.replans);
    expect(a.release.decision).toBe(b.release.decision);
  });
});
