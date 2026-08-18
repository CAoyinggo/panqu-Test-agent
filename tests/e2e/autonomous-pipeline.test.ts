// Phase 23.5 End-to-End Autonomous Pipeline 验收测试
// 覆盖 6 个最终验收场景（任务书十五）：
//   Scenario 1 普通变更 → PASS / 0
//   Scenario 2 高风险变更（模型）→ REVIEW / 2
//   Scenario 3 探索发现问题 → REVIEW / 2（含 RCA）
//   Scenario 4 动态重规划 → BLOCK / 1（含 RePlan）
//   Scenario 5 Release REVIEW → REVIEW / 2
//   Scenario 6 Release BLOCK → BLOCK / 1
// 断言：Release Decision + CI Exit Code + 完整 Trace（Initial/RePlan/Final/Stop/Release）。
// 全部确定性、离线可复现。

import { describe, it, expect } from 'vitest';
import {
  PIPELINE_SCENARIOS,
  runPipelineScenario,
  type PipelineScenario,
} from '../../src/autonomous/pipeline-scenarios.js';
import { runAutonomousPipeline } from '../../src/autonomous/index.js';
import { releaseExitCode } from '../../src/release-ci/index.js';

describe('Autonomous Pipeline 6 大验收场景', () => {
  it('场景数量为 6（任务书十五）', () => {
    expect(PIPELINE_SCENARIOS.length).toBe(6);
    expect(PIPELINE_SCENARIOS.map((s) => s.id)).toEqual([
      'code-change-pass',
      'model-change-risk',
      'exploration-failure',
      'replan-block',
      'release-review',
      'release-block',
    ]);
  });

  for (const scenario of PIPELINE_SCENARIOS) {
    describe(scenario.name, () => {
      const r = runPipelineScenario(scenario);
      const expectSpec = scenario.expect;

      it('Release Decision 与 CI Exit Code 一致', () => {
        expect(r.release.decision).toBe(expectSpec.releaseDecision);
        // 退出码必须与决策一致（REVIEW 绝不返回 0）
        expect(r.releaseExitCode).toBe(expectSpec.exitCode);
        expect(releaseExitCode(r.release.decision)).toBe(expectSpec.exitCode);
        // 统一契约字段完整
        expect(r.release.runId).toBeTruthy();
        expect(r.release.traceId).toBeTruthy();
        expect(r.release.createdAt).toBeTruthy();
        expect(Array.isArray(r.release.checks)).toBe(true);
        expect(Array.isArray(r.release.evidence)).toBe(true);
        expect(Array.isArray(r.release.blockReasons)).toBe(true);
        expect(Array.isArray(r.release.recommendations)).toBe(true);
      });

      it('Trace 完整：Initial Plan / RePlan / Final Plan / Stop / Release 全部记录', () => {
        expect(r.trace.initialPlan.length).toBeGreaterThan(0);
        expect(r.trace.finalPlan).toBeDefined();
        expect(r.trace.releaseDecision).toBe(expectSpec.releaseDecision);
        // Decision Trace：端到端关键决策类型齐全
        const kinds = new Set(r.trace.decisionTrace.records.map((e) => e.kind));
        expect(kinds.has('requirement')).toBe(true);
        expect(kinds.has('selection')).toBe(true);
        expect(kinds.has('priority')).toBe(true);
        expect(kinds.has('release')).toBe(true);
      });

      const minimumRca = expectSpec.minimumRca;
      if (minimumRca !== undefined) {
        it(`RCA ≥ ${minimumRca}`, () => {
          expect(r.rca.length).toBeGreaterThanOrEqual(minimumRca);
          // 失败必有根因，根因必有缺陷与知识更新
          expect(r.defects.length).toBeGreaterThanOrEqual(minimumRca);
          expect(r.knowledgeUpdates.length).toBeGreaterThanOrEqual(minimumRca);
        });
      }

      const minimumReplans = expectSpec.minimumReplans;
      if (minimumReplans !== undefined) {
        it(`RePlan ≥ ${minimumReplans}`, () => {
          expect(r.regression.replans.length).toBeGreaterThanOrEqual(minimumReplans);
          // 每次 RePlan 都在 Decision Trace 中记录
          const replanCount = r.trace.decisionTrace.records.filter((e) => e.kind === 'replanning').length;
          expect(replanCount).toBeGreaterThanOrEqual(minimumReplans);
        });
      }

      if (expectSpec.affectedCount !== undefined) {
        it(`受影响用例 ${expectSpec.affectedCount}`, () => {
          expect(r.portfolio.affectedCount).toBe(expectSpec.affectedCount);
        });
      }

      it('Run Summary 可被 CI Gate 消费（run-summary.json 契约）', () => {
        const s = r.runSummary;
        expect(s.runId).toBeTruthy();
        expect(s.feature).toBeTruthy();
        expect(typeof s.total).toBe('number');
        expect(s.executed + s.skipped).toBe(s.total);
        expect(s.passed + s.failed).toBe(s.executed);
        expect(s.releaseDecision).toBe(expectSpec.releaseDecision);
      });
    });
  }
});

describe('Deterministic First：Release 决策由规则引擎推导（非 LLM）', () => {
  it('相同输入两次运行结果完全一致（确定性、可复现）', () => {
    const scenario = PIPELINE_SCENARIOS.find((s) => s.id === 'replan-block')!;
    // 固定 now，保证 runId / replan 时间戳一致（确定性）
    const mk = () => runAutonomousPipeline({ ...scenario.build(), now: '2026-08-01T00:00:00Z' });
    const a = mk();
    const b = mk();
    expect(a.release.decision).toBe(b.release.decision);
    expect(a.releaseExitCode).toBe(b.releaseExitCode);
    expect(a.trace.initialPlan).toEqual(b.trace.initialPlan);
    expect(a.trace.replans).toEqual(b.trace.replans);
  });
});

describe('Production Safety：自治模式不改变安全策略', () => {
  it('production 环境探索危险动作被 DENY，不进入回归计划', () => {
    const scenario: PipelineScenario = {
      id: 'safety-production',
      name: 'Production Safety：危险探索 DENY',
      build: () => ({
        change: { type: 'code', target: 'wan3/billing' },
        cases: [{ caseId: 'b-1', priority: 'P0', riskScore: 0.1 }],
        feature: 'wan3/billing',
        environment: 'production',
        outcomes: {},
        exploration: { coverageGaps: ['billing'], approveHighRisk: true, approveProduction: false },
      }),
      expect: { releaseDecision: 'PASS', exitCode: 0 },
    };
    const r = runPipelineScenario(scenario);
    // 危险探索候选被拒绝，不进入自治用例
    const allIds = r.autonomousCases.map((c) => c.caseId);
    expect(allIds).not.toContain('explore-gap-billing');
    // 探索证据说明生产环境危险动作被拒绝
    expect(r.exploration.evidence.some((e) => e.includes('DENY'))).toBe(true);
    // 决策 Trace 记录风险门禁拒绝
    const riskEvent = r.trace.decisionTrace.records.find((e) => e.kind === 'risk');
    expect(riskEvent).toBeDefined();
  });
});
