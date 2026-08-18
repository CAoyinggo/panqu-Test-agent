// Phase 23.6 Production Acceptance：Autonomous Dashboard + Report 测试
// 覆盖：Operations Dashboard 自治运行摘要聚合 / HTML 渲染 / Autonomous Run Summary /
//       16 段 HTML Report / Production Safety（dangerous=DENY、risky=Approval）/
//       预算防无限循环（maxDecisionDepth / maxConsecutiveReplans → AUTONOMOUS_STOP）。

import { describe, it, expect } from 'vitest';
import { buildOperationsView, renderOperationsHtml } from '../../src/operations/index.js';
import { renderAutonomousReportHtml, runAutonomousPipeline } from '../../src/autonomous/index.js';
import { runAutonomousRegression } from '../../src/autonomous/index.js';
import { PIPELINE_SCENARIOS, runPipelineScenario } from '../../src/autonomous/pipeline-scenarios.js';

describe('Operations Dashboard：Autonomous 区块（任务书十七）', () => {
  it('自治运行摘要聚合：Run Summary / RePlans / Coverage / Risk / Failures / RCA / Decision', () => {
    const view = buildOperationsView({
      autonomous: {
        runs: [
          {
            runId: 'run-20260818-001',
            feature: 'wan3/video-editor',
            total: 100,
            executed: 34,
            skipped: 66,
            passed: 32,
            failed: 2,
            replans: 2,
            rcaCount: 2,
            coverage: 0.94,
            riskLevel: 'HIGH',
            stopReason: 'P0 失败 → Release BLOCK',
            portfolioRate: 0.86,
            explorationGenerated: 3,
            explorationScreened: 2,
            explorationRejected: 1,
            decision: 'BLOCKED',
            releaseDecision: 'BLOCK',
          },
        ],
      },
    });
    expect(view.autonomous.runCount).toBe(1);
    expect(view.autonomous.latestReleaseDecision).toBe('BLOCK');
    expect(view.autonomous.status).toBe('AUTONOMOUS_BLOCK');
    expect(view.autonomous.totalPlanned).toBe(100);
    expect(view.autonomous.totalExecuted).toBe(34);
    expect(view.autonomous.totalSkipped).toBe(66);
    expect(view.autonomous.totalReplans).toBe(2);
    expect(view.autonomous.totalRca).toBe(2);
    // BLOCK → 关注项
    expect(view.highlights.some((h) => h.includes('BLOCK'))).toBe(true);
    // HTML 渲染包含 Autonomous 区块
    const html = renderOperationsHtml(view);
    expect(html).toContain('Autonomous Status');
    expect(html).toContain('Autonomous Run Summary');
    expect(html).toContain('Decision Trace / RePlan / Stop / Release');
    expect(html).toContain('run-20260818-001');
    expect(html).toContain('94.0%');
  });

  it('无自治运行 → AUTONOMOUS_NONE，Dashboard 安全渲染', () => {
    const view = buildOperationsView({});
    expect(view.autonomous.status).toBe('AUTONOMOUS_NONE');
    expect(view.autonomous.runCount).toBe(0);
    expect(view.autonomous.totalPlanned).toBe(0);
    const html = renderOperationsHtml(view);
    expect(html).toContain('AUTONOMOUS NONE');
  });
});

describe('Autonomous Pipeline HTML Report：16 段（任务书十八）', () => {
  const sections = [
    '01 Requirement', '02 Change Impact', '03 Portfolio', '04 Exploration', '05 Priority',
    '06 Regression Plan', '07 Execution', '08 RePlanning', '09 Adaptive Stop', '10 RCA',
    '11 Defect', '12 Healing', '13 Knowledge Update', '14 Release Decision', '15 Unified Trace', '16 Cost',
  ];
  const scenario = PIPELINE_SCENARIOS.find((s) => s.id === 'replan-block')!;
  const result = runPipelineScenario(scenario);
  const html = renderAutonomousReportHtml(result);

  for (const s of sections) {
    it(`包含 ${s} 段落`, () => {
      expect(html).toContain(`>${s}<`);
    });
  }

  it('能回答关键"为什么"问题（证据可解释）', () => {
    expect(html).toContain('为什么选这些 Case？');
    expect(html).toContain('为什么没执行其他 Case？');
    expect(html).toContain('为什么重新规划？');
    expect(html).toContain('为什么停止？');
    expect(html).toContain('AI 到底做了什么？');
    // BLOCK 场景回答"为什么 BLOCK？"，REVIEW 场景回答"为什么 REVIEW？"
    expect(html).toContain('为什么 BLOCK？');
    expect(result.release.blockReasons.length).toBeGreaterThan(0);
    const reviewHtml = renderAutonomousReportHtml(
      runPipelineScenario(PIPELINE_SCENARIOS.find((s) => s.id === 'release-review')!),
    );
    expect(reviewHtml).toContain('为什么 REVIEW？');
  });

  it('统一 Trace 段落完整列出 AI 决策（requirement→…→release）', () => {
    expect(html).toContain('15 Unified Trace');
    const kinds = new Set(result.trace.decisionTrace.records.map((e) => e.kind));
    expect(kinds.has('requirement')).toBe(true);
    expect(kinds.has('selection')).toBe(true);
    expect(kinds.has('priority')).toBe(true);
    expect(kinds.has('replanning')).toBe(true);
    expect(kinds.has('stopping')).toBe(true);
    expect(kinds.has('release')).toBe(true);
  });
});

describe('Production Safety（任务书十九）', () => {
  it('production 环境危险探索 DENY，不进入回归（自治模式不改变安全策略）', () => {
    const r = runPipelineScenario({
      id: 'safety-prod',
      name: '生产安全：危险探索 DENY',
      build: () => ({
        change: { type: 'code', target: 'wan3/billing' },
        cases: [{ caseId: 'b-1', priority: 'P0', riskScore: 0.1 }],
        feature: 'wan3/billing',
        environment: 'production',
        outcomes: {},
        exploration: { coverageGaps: ['billing'], approveHighRisk: true, approveProduction: false },
      }),
      expect: { releaseDecision: 'PASS', exitCode: 0 },
    });
    expect(r.autonomousCases.map((c) => c.caseId)).not.toContain('explore-gap-billing');
    expect(r.exploration.evidence.some((e) => e.includes('DENY'))).toBe(true);
  });

  it('test 环境 production 危险动作仍需审批（risky → Approval），不能自动执行', () => {
    const r = runAutonomousPipeline({
      change: { type: 'code', target: 'wan3/billing' },
      cases: [
        { caseId: 'c-1', priority: 'P0', riskScore: 0.1 },
        { caseId: 'c-2', priority: 'P0', riskScore: 0.1 },
      ],
      feature: 'wan3/billing',
      environment: 'test',
      outcomes: { 'c-1': true, 'c-2': true },
      exploration: { coverageGaps: ['database-mutation'], approveHighRisk: false },
    });
    // 危险探索候选被拒绝（未审批 → 不执行）
    expect(r.autonomousCases.map((c) => c.caseId)).not.toContain('explore-gap-database-mutation');
  });
});

describe('预算防无限循环（任务书二十）', () => {
  it('maxDecisionDepth 超限 → AUTONOMOUS_STOP，输出 reason/budget/trace', () => {
    const r = runAutonomousRegression({
      cases: Array.from({ length: 30 }, (_, i) => ({ caseId: `tc-${i}`, priority: 'P0' as const })),
      outcomes: {},
      budget: { maxDecisionDepth: 5 },
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxDecisionDepth');
    expect(r.reason).toContain('最大决策深度');
    // budget 使用与 evidence（trace 可解释）都输出
    expect((r.budgetUsed as { decisionDepth?: number }).decisionDepth).toBeGreaterThanOrEqual(6);
    expect(r.evidence.some((e) => e.includes('AUTONOMOUS STOP'))).toBe(true);
  });

  it('maxConsecutiveReplans 超限 → AUTONOMOUS_STOP', () => {
    const r = runAutonomousRegression({
      // 无相关性标签 + 高集群阈值：避免集群暂停清空队列，让连续失败持续触发重规划直到超限
      cases: Array.from({ length: 8 }, (_, i) => ({ caseId: `tc-${i}`, priority: 'P2' as const })),
      outcomes: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tc-${i}`, false])),
      budget: { maxConsecutiveReplans: 1 },
      clusterFailureTrigger: 99,
    });
    // 连续失败第 2 次后（consecutiveReplans=2 > 1）触发超限
    expect(r.exceededLimit).toBe('maxConsecutiveReplans');
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
  });
});
