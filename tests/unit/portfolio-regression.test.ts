// Phase 23.2：Portfolio → Regression 接入单元测试
// 覆盖：变更影响筛选（100 用例 + Model B 变更 → 不执行全量）、受影响全选、
// Portfolio 兜底（Core/Risk/Historical/Exploration）、Flaky 隔离、fullRegression、
// 证据可解释、确定性、映射到自治回归用例。

import { describe, it, expect } from 'vitest';
import {
  buildRegressionPlan,
  portfolioToAutonomousCases,
  DEFAULT_PORTFOLIO_POLICY,
  type PortfolioCaseInput,
} from '../../src/portfolio/index.js';
import type { ChangeEvent } from '../../src/regression/regression-schema.js';

const MODEL_CHANGE: ChangeEvent = {
  type: 'model',
  target: 'wan3/text-to-video',
  from: 'Model A',
  to: 'Model B',
};

/** 构造 100 用例：34 个受影响（changeTags 命中），66 个纯回归 */
function build100Cases(): PortfolioCaseInput[] {
  const cases: PortfolioCaseInput[] = [];
  for (let i = 1; i <= 100; i++) {
    const id = `wan3-${String(i).padStart(3, '0')}`;
    if (i <= 34) {
      cases.push({ caseId: id, changeTags: ['wan3/text-to-video', 'model'] });
    } else {
      cases.push({ caseId: id });
    }
  }
  return cases;
}

describe('buildRegressionPlan（任务书五 / 23.2）', () => {
  it('100 用例 + Model B 变更：受影响筛选 → Regression Plan，不执行全量', () => {
    const plan = buildRegressionPlan({ change: MODEL_CHANGE, cases: build100Cases() });
    expect(plan.totalCases).toBe(100);
    expect(plan.affectedCount).toBe(34);
    expect(plan.selectedCaseIds.length).toBe(34);
    expect(plan.executionRate).toBeCloseTo(0.34, 5);
    expect(plan.executionRate).toBeLessThan(1); // 关键：不执行全量
    // 66 个未受影响纯 Regression 全部跳过
    const skippedRegression = plan.skipped.filter((s) => s.reason.includes('避免全量回归'));
    expect(skippedRegression.length).toBe(66);
    // 受影响用例全部进入计划
    for (const id of plan.affectedCaseIds) {
      expect(plan.selectedCaseIds).toContain(id);
    }
  });

  it('受影响用例全选（任何类别都优先进入计划）', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'a', changeTags: ['model'] },
      { caseId: 'b', changeTags: ['model'], priority: 'P3' },
      { caseId: 'c', changeTags: ['model'], riskScore: 0.1 },
      { caseId: 'd' },
    ];
    const plan = buildRegressionPlan({ change: MODEL_CHANGE, cases });
    expect(plan.affectedCount).toBe(3);
    expect(plan.selectedCaseIds).toEqual(['a', 'b', 'c']);
    expect(plan.selectedCaseIds).not.toContain('d');
  });

  it('Portfolio 兜底：未受影响的 P0 / Risk / Historical / Exploration 补充进入', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'hit', changeTags: ['model'] },
      { caseId: 'core', priority: 'P0' },
      { caseId: 'risk', riskScore: 0.8 },
      { caseId: 'hist-1', historicalFailures: 5 },
      { caseId: 'hist-2', historicalFailures: 6 },
      { caseId: 'hist-3', historicalFailures: 7 },
      { caseId: 'explore', coverageGap: true },
      { caseId: 'plain' },
    ];
    const plan = buildRegressionPlan({
      change: MODEL_CHANGE,
      cases,
      policy: { historicalTopN: 2 },
    });
    expect(plan.selectedCaseIds).toContain('hit');
    expect(plan.selectedCaseIds).toContain('core');
    expect(plan.selectedCaseIds).toContain('risk');
    expect(plan.selectedCaseIds).toContain('explore');
    // Historical Top N = 2（字典序前 2：hist-1、hist-2）
    expect(plan.selectedCaseIds).toContain('hist-1');
    expect(plan.selectedCaseIds).toContain('hist-2');
    expect(plan.selectedCaseIds).not.toContain('hist-3');
    // 纯回归未受影响不选
    expect(plan.selectedCaseIds).not.toContain('plain');
  });

  it('Flaky 隔离：excludeQuarantinedFlaky=true 排除，false 纳入', () => {
    const base: PortfolioCaseInput[] = [{ caseId: 'f', flaky: true }];
    const exclude = buildRegressionPlan({ change: MODEL_CHANGE, cases: base, policy: { excludeQuarantinedFlaky: true } });
    expect(exclude.selectedCaseIds).not.toContain('f');
    expect(exclude.skipped.some((s) => s.caseId === 'f' && s.reason.includes('Flaky'))).toBe(true);

    const include = buildRegressionPlan({ change: MODEL_CHANGE, cases: base, policy: { excludeQuarantinedFlaky: false } });
    expect(include.selectedCaseIds).toContain('f');
  });

  it('fullRegression=true：策略显式要求 Full Regression，全部进入计划', () => {
    const plan = buildRegressionPlan({ change: MODEL_CHANGE, cases: build100Cases(), fullRegression: true });
    expect(plan.fullRegression).toBe(true);
    expect(plan.selectedCaseIds.length).toBe(100);
    expect(plan.executionRate).toBe(1);
    expect(plan.skipped.length).toBe(0);
  });

  it('证据可解释：为什么选这些 / 为什么没选其他', () => {
    const plan = buildRegressionPlan({ change: MODEL_CHANGE, cases: build100Cases() });
    expect(plan.evidence.some((e) => e.includes('受影响用例 34/100'))).toBe(true);
    expect(plan.evidence.some((e) => e.includes('全部进入计划'))).toBe(true);
    expect(plan.skipped.every((s) => s.reason.length > 0)).toBe(true);
    expect(plan.categoryStats.Regression).toBe(66);
    expect(plan.categoryStats.Change).toBe(34);
  });

  it('确定性：相同输入产生相同计划', () => {
    const a = buildRegressionPlan({ change: MODEL_CHANGE, cases: build100Cases(), runId: 'run-x' });
    const b = buildRegressionPlan({ change: MODEL_CHANGE, cases: build100Cases(), runId: 'run-x' });
    expect(a.selectedCaseIds).toEqual(b.selectedCaseIds);
    expect(a.skipped).toEqual(b.skipped);
    expect(a.evidence).toEqual(b.evidence);
  });

  it('默认策略与 DEFAULT_PORTFOLIO_POLICY 一致', () => {
    expect(DEFAULT_PORTFOLIO_POLICY).toEqual({
      coreRate: 1,
      riskRate: 1,
      changeRate: 1,
      regressionRate: 1,
      historicalTopN: 10,
      explorationBudgetRate: 0.2,
      excludeQuarantinedFlaky: true,
    });
  });
});

describe('portfolioToAutonomousCases（接入 Autonomous Regression）', () => {
  it('按类别映射优先级：Core→P0、Risk/Change→P1、Historical/Flaky→P2、Exploration/Regression→P3', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'c1', priority: 'P0' },
      { caseId: 'c2', riskScore: 0.8 },
      { caseId: 'c3', changeTags: ['model'] },
      { caseId: 'c4', historicalFailures: 5 },
      { caseId: 'c5', flaky: true },
      { caseId: 'c6', coverageGap: true },
      { caseId: 'c7' },
    ];
    const plan = buildRegressionPlan({
      change: MODEL_CHANGE,
      cases,
      policy: { excludeQuarantinedFlaky: false },
      fullRegression: true, // 全量进入，覆盖全部类别映射
    });
    const auto = portfolioToAutonomousCases(plan, cases);
    const byId = new Map(auto.map((a) => [a.caseId, a]));
    expect(byId.get('c1')?.priority).toBe('P0');
    expect(byId.get('c2')?.priority).toBe('P1');
    expect(byId.get('c3')?.priority).toBe('P1');
    expect(byId.get('c4')?.priority).toBe('P2');
    expect(byId.get('c5')?.priority).toBe('P2');
    expect(byId.get('c6')?.priority).toBe('P3');
    expect(byId.get('c7')?.priority).toBe('P3');
    expect(auto.length).toBe(plan.selectedCaseIds.length);
  });

  it('model 变更标签 → modelRisk 提升（接入自治回归的风险信号）', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'm1', changeTags: ['model', 'wan3/text-to-video'] },
      { caseId: 'm2', changeTags: ['api'] },
    ];
    const plan = buildRegressionPlan({ change: MODEL_CHANGE, cases });
    const auto = portfolioToAutonomousCases(plan, cases);
    const m1 = auto.find((a) => a.caseId === 'm1');
    const m2 = auto.find((a) => a.caseId === 'm2');
    expect(m1?.modelRisk).toBe(0.6);
    expect(m2?.modelRisk).toBeUndefined();
  });
});
