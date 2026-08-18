// Phase 22.6 Autonomous Regression 单元测试
// 覆盖：5 个 Scenario（模型变更/连续失败/充分覆盖/P0 失败/历史问题重现）、
// 自治预算（5 项上限 → AUTONOMOUS STOP）、模式（manual/assisted/autonomous）、
// 任务书二十七决策正确性、确定性。

import { describe, it, expect } from 'vitest';
import {
  runAutonomousRegression,
  runScenario,
  runAllScenarios,
  DEFAULT_AUTONOMOUS_BUDGET,
  type AutonomousCase,
} from '../../src/autonomous/index.js';

const NOW = '2026-08-01T00:00:00Z';

/** 生成全 PASS 历史的用例 */
function passCase(caseId: string, priority: AutonomousCase['priority'] = 'P2', extra: Partial<AutonomousCase> = {}): AutonomousCase {
  return { caseId, priority, historicalSamples: [], ...extra };
}

describe('Scenario 1：模型变更（Change → Risk → Priority → Regression）', () => {
  it('Model A → Model B：模型 B 相关用例（高变更+历史失败）优先执行', () => {
    const r = runScenario('scenario-1-model-change', { now: NOW });
    expect(r.decision).toBe('COMPLETED');
    expect(r.executed.length).toBe(8);
    // 前 4 个执行的是模型 B 用例（高失败概率 → 提前优先执行）
    const first4 = r.executed.slice(0, 4).map((e) => e.caseId);
    expect(first4.every((id) => id.startsWith('mb-'))).toBe(true);
    // 失败预测：模型 B 用例高于模型 A 用例
    const mb = r.predictions.find((p) => p.caseId === 'mb-1')!;
    const ma = r.predictions.find((p) => p.caseId === 'ma-1')!;
    expect(mb.failureProbability).toBeGreaterThan(ma.failureProbability);
    // 可解释：模型 B 用例带变更与历史证据
    expect(mb.evidence.some((e) => e.includes('变更影响 80%'))).toBe(true);
  });
});

describe('Scenario 2：连续失败（Failure Rate ↑ → Risk ↑ → Priority ↑）', () => {
  it('同类用例连续 2 次失败 → 触发重新规划并提升相关用例', () => {
    const r = runScenario('scenario-2-consecutive-failure', { now: NOW });
    expect(r.replans.length).toBe(2);
    // 第一次失败即提升同标签剩余用例
    expect(r.replans[0].failedCase).toBe('q-1');
    expect(r.replans[0].boostedCases).toEqual(['q-2', 'q-3', 'q-4', 'q-5', 'q-6']);
    expect(r.replans[0].cause).toContain('queue');
    expect(r.replans[1].failedCase).toBe('q-2');
    // 决策轨迹可解释
    expect(r.evidence.some((e) => e.includes('重新规划：q-1 失败'))).toBe(true);
    expect(r.decision).toBe('COMPLETED');
  });
});

describe('Scenario 3：测试已充分覆盖（Adaptive Stop）', () => {
  it('Coverage≥90% + P0=100% + 信息增益低 → 自动停止', () => {
    const r = runScenario('scenario-3-sufficient-coverage', { now: NOW });
    expect(r.decision).toBe('STOPPED');
    expect(r.executed.length).toBe(9); // 100 个计划，执行 90% 即停止
    expect(r.remaining).toEqual(['p2-j']);
    expect(r.stopping).not.toBeNull();
    expect(r.stopping!.stop).toBe(true);
    // 必须输出停止原因，不能静默停止
    expect(r.stopping!.reason).toContain('自动停止');
    expect(r.evidence.some((e) => e.startsWith('停止：'))).toBe(true);
  });
});

describe('Scenario 4：发现高风险失败（P0 → BLOCK）', () => {
  it('P0 失败 → 暂停低优先级 → Release BLOCK，需人工审批', () => {
    const r = runScenario('scenario-4-p0-failure', { now: NOW });
    expect(r.decision).toBe('BLOCKED');
    expect(r.releaseBlocked).toBe(true);
    // 低优先级用例未执行
    expect(r.executed.length).toBe(1); // 仅 p0-2 失败用例
    expect(r.remaining.every((id) => id.startsWith('p0-') || id.startsWith('p2-'))).toBe(true);
    // 危险动作需审批
    expect(r.requiresApproval).toContain('release-decision (BLOCK)');
    expect(r.evidence.some((e) => e.includes('Release BLOCK'))).toBe(true);
  });
});

describe('Scenario 5：历史问题重新出现（Known Issue）', () => {
  it('已知问题复现 → 不重复创建缺陷，并提升相关用例优先级', () => {
    const r = runScenario('scenario-5-known-issue-reappear', { now: NOW });
    expect(r.knownIssueReappeared).toEqual(['hist-1']);
    expect(r.evidence.some((e) => e.includes('不重复创建缺陷'))).toBe(true);
    // 相关 legacy 用例被提升
    const boost = r.replans.find((re) => re.failedCase === 'hist-1');
    expect(boost?.boostedCases).toEqual(['legacy-2', 'legacy-3']);
    // 相关用例先于无关用例执行
    const order = r.executed.map((e) => e.caseId);
    expect(order.indexOf('legacy-2')).toBeLessThan(order.indexOf('other-1'));
    expect(r.decision).toBe('COMPLETED');
  });
});

describe('自治预算（任务书二十五）', () => {
  const manyCases = (n: number): AutonomousCase[] =>
    Array.from({ length: n }, (_, i) => passCase(`c${i + 1}`));

  it('maxAutonomousCases 达到上限 → AUTONOMOUS STOP 并输出原因', () => {
    const r = runAutonomousRegression({
      cases: manyCases(6),
      budget: { maxAutonomousCases: 2, maxReplans: 5, maxAutonomousCost: 10, maxAutonomousDuration: 600000, maxLLMCalls: 20 },
      outcomes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`c${i + 1}`, true])),
      now: NOW,
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxAutonomousCases');
    expect(r.executed.length).toBe(2);
    expect(r.reason).toContain('最大自治执行用例数');
    expect(r.evidence.some((e) => e.includes('AUTONOMOUS STOP'))).toBe(true);
  });

  it('maxReplans 达到上限 → AUTONOMOUS STOP', () => {
    const cases = ['q-1', 'q-2', 'q-3', 'q-4'].map((id) => passCase(id, 'P2', { changeTags: ['x'] }));
    const r = runAutonomousRegression({
      cases,
      budget: { maxReplans: 1, maxAutonomousCases: 10, maxAutonomousCost: 10, maxAutonomousDuration: 600000, maxLLMCalls: 20 },
      outcomes: { 'q-1': false, 'q-2': false, 'q-3': true, 'q-4': true },
      now: NOW,
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxReplans');
    expect(r.executed.length).toBe(1);
    expect(r.reason).toContain('最大重新规划次数');
  });

  it('maxAutonomousCost 达到上限 → AUTONOMOUS STOP', () => {
    const r = runAutonomousRegression({
      cases: [passCase('a', 'P1', { estimatedCost: 1 }), passCase('b', 'P1', { estimatedCost: 1 })],
      budget: { maxAutonomousCost: 1, maxAutonomousCases: 10, maxReplans: 5, maxAutonomousDuration: 600000, maxLLMCalls: 20 },
      outcomes: { a: true, b: true },
      now: NOW,
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxAutonomousCost');
    expect(r.budgetUsed.cost).toBe(1);
  });

  it('maxAutonomousDuration 达到上限 → AUTONOMOUS STOP', () => {
    const r = runAutonomousRegression({
      cases: [passCase('a', 'P1', { estimatedDurationMs: 100 }), passCase('b', 'P1', { estimatedDurationMs: 100 })],
      budget: { maxAutonomousDuration: 100, maxAutonomousCases: 10, maxReplans: 5, maxAutonomousCost: 10, maxLLMCalls: 20 },
      outcomes: { a: true, b: true },
      now: NOW,
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxAutonomousDuration');
    expect(r.budgetUsed.durationMs).toBe(100);
  });

  it('maxLLMCalls 达到上限 → AUTONOMOUS STOP', () => {
    const r = runAutonomousRegression({
      cases: manyCases(4),
      budget: { maxLLMCalls: 1, maxAutonomousCases: 10, maxReplans: 5, maxAutonomousCost: 10, maxAutonomousDuration: 600000 },
      llmCallsPerStep: 1,
      outcomes: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`c${i + 1}`, true])),
      now: NOW,
    });
    expect(r.decision).toBe('BUDGET_EXHAUSTED');
    expect(r.exceededLimit).toBe('maxLLMCalls');
    expect(r.budgetUsed.llmCalls).toBe(1);
  });

  it('默认预算与任务书示例一致（Phase 23.4 新增 maxDecisionDepth / maxConsecutiveReplans）', () => {
    expect(DEFAULT_AUTONOMOUS_BUDGET).toEqual({
      maxReplans: 5,
      maxAutonomousCases: 100,
      maxAutonomousCost: 10,
      maxAutonomousDuration: 600000,
      maxLLMCalls: 20,
      maxDecisionDepth: 20,
      maxConsecutiveReplans: 2,
    });
  });
});

describe('自治模式（任务书二十四）', () => {
  it('manual：AI 只分析，不执行 → PLANNED', () => {
    const r = runAutonomousRegression({
      cases: [passCase('a', 'P1', { changeImpact: 0.8, historicalSamples: [{ passed: false, at: '2026-07-01T00:00:00Z' }] }), passCase('b', 'P1')],
      mode: 'manual',
      outcomes: { a: true, b: true },
      now: NOW,
    });
    expect(r.decision).toBe('PLANNED');
    expect(r.executed).toEqual([]);
    expect(r.predictions.length).toBe(2);
    expect(r.remaining.length).toBe(2);
    expect(r.evidence.some((e) => e.includes('manual 模式：仅分析规划'))).toBe(true);
  });

  it('assisted：未获人工确认的用例被跳过', () => {
    const r = runAutonomousRegression({
      cases: [passCase('ok', 'P1'), passCase('skip-me', 'P1'), passCase('ok2', 'P1')],
      mode: 'assisted',
      outcomes: { ok: true, 'skip-me': true, ok2: true },
      approve: (id) => id !== 'skip-me',
      now: NOW,
    });
    expect(r.executed.some((e) => e.caseId === 'skip-me')).toBe(false);
    expect(r.evidence.some((e) => e.includes('跳过 skip-me'))).toBe(true);
  });

  it('autonomous：自动规划/选择/停止（默认模式）', () => {
    const r = runAutonomousRegression({
      cases: [passCase('a', 'P1'), passCase('b', 'P1')],
      outcomes: { a: true, b: true },
      now: NOW,
    });
    expect(r.mode).toBe('autonomous');
    expect(r.executed.length).toBe(2);
    expect(r.decision).toBe('COMPLETED');
  });
});

describe('任务书二十七：自治决策正确性', () => {
  it('Case A（失败率 0.01 无变更）< Case B（失败率 0.35 + 变更 0.8）：B 优先执行', () => {
    const cases: AutonomousCase[] = [
      passCase('case-a', 'P1', { historicalSamples: Array.from({ length: 100 }, (_, i) => ({ passed: i !== 50, at: `2026-07-0${(i % 28) + 1}T00:00:00Z` })), changeImpact: 0 }),
      passCase('case-b', 'P1', { historicalSamples: [0, 3, 6, 9, 12, 15, 18].map((i) => ({ passed: false, at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z` })).concat([1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19].map((i) => ({ passed: true, at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z` }))), changeImpact: 0.8 }),
    ];
    const r = runAutonomousRegression({ cases, outcomes: { 'case-a': true, 'case-b': true }, now: NOW });
    expect(r.executed[0].caseId).toBe('case-b');
    const pa = r.predictions.find((p) => p.caseId === 'case-a')!;
    const pb = r.predictions.find((p) => p.caseId === 'case-b')!;
    expect(pb.failureProbability).toBeGreaterThan(pa.failureProbability);
  });

  it('P0 failure = 1 → Release = BLOCK', () => {
    const r = runAutonomousRegression({
      cases: [passCase('p0-1', 'P0'), passCase('p2-1', 'P2')],
      outcomes: { 'p0-1': false, 'p2-1': true },
      now: NOW,
    });
    expect(r.decision).toBe('BLOCKED');
    expect(r.releaseBlocked).toBe(true);
  });

  it('Coverage=95% + P0=100% + 信息增益 LOW → stop=true', () => {
    const r = runAutonomousRegression({
      cases: Array.from({ length: 20 }, (_, i) => passCase(`c${String(i + 1).padStart(2, '0')}`, i < 5 ? 'P0' : 'P2')),
      outcomes: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${String(i + 1).padStart(2, '0')}`, true])),
      now: NOW,
    });
    // 5 个 P0 + 19 个普通 → 执行到 90%（18 个）即停止
    expect(r.decision).toBe('STOPPED');
    expect(r.executed.length).toBe(18);
    expect(r.stopping?.stop).toBe(true);
  });
});

describe('确定性', () => {
  it('相同输入两次运行结果完全一致', () => {
    const options = {
      cases: [passCase('a', 'P1', { changeImpact: 0.6 }), passCase('b', 'P2')],
      outcomes: { a: true, b: false },
      now: NOW,
    };
    const r1 = runAutonomousRegression(options);
    const r2 = runAutonomousRegression(options);
    expect(r1).toEqual(r2);
  });

  it('runAllScenarios 全部离线可运行', () => {
    const results = runAllScenarios({ now: NOW });
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.runId).toBeTruthy();
    }
  });
});
