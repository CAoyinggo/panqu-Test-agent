// Phase 22 通用：Test Portfolio 单元测试（任务书十七）
// 覆盖：七类确定性分类、分类优先级、组合选择策略（Core/Risk/Change 100%、Historical Top N、
// Exploration 预算 %、Flaky 隔离）、空数据、确定性。

import { describe, it, expect } from 'vitest';
import {
  buildPortfolio,
  categorizeCase,
  portfolioStats,
  selectPortfolio,
  type PortfolioCaseInput,
} from '../../src/portfolio/index.js';

function sampleCases(): PortfolioCaseInput[] {
  return [
    { caseId: 'core-1', priority: 'P0' },
    { caseId: 'risk-1', riskScore: 0.8 },
    { caseId: 'change-1', changeTags: ['model-change'] },
    { caseId: 'hist-1', historicalFailures: 5 },
    { caseId: 'known-1', knownIssue: true },
    { caseId: 'explore-1', coverageGap: true },
    { caseId: 'flaky-1', flaky: true },
    { caseId: 'regress-1' },
  ];
}

describe('Test Portfolio：确定性分类', () => {
  it('七类用例分类正确', () => {
    expect(categorizeCase({ caseId: 'a', priority: 'P0' }).category).toBe('Core');
    expect(categorizeCase({ caseId: 'b', riskScore: 0.8 }).category).toBe('Risk');
    expect(categorizeCase({ caseId: 'c', changeTags: ['x'] }).category).toBe('Change');
    expect(categorizeCase({ caseId: 'd', historicalFailures: 5 }).category).toBe('Historical');
    expect(categorizeCase({ caseId: 'e', knownIssue: true }).category).toBe('Historical');
    expect(categorizeCase({ caseId: 'f', coverageGap: true }).category).toBe('Exploration');
    expect(categorizeCase({ caseId: 'g', flaky: true }).category).toBe('Flaky');
    expect(categorizeCase({ caseId: 'h' }).category).toBe('Regression');
  });

  it('分类优先级：P0(Core) 优先于 Flaky/Historical/Risk', () => {
    expect(categorizeCase({ caseId: 'a', priority: 'P0', flaky: true, knownIssue: true }).category).toBe('Core');
    expect(categorizeCase({ caseId: 'b', flaky: true, riskScore: 0.9 }).category).toBe('Flaky');
    expect(categorizeCase({ caseId: 'c', knownIssue: true, riskScore: 0.9 }).category).toBe('Historical');
  });

  it('批量分类 + 统计', () => {
    const portfolio = buildPortfolio(sampleCases());
    expect(portfolio.length).toBe(8);
    const stats = portfolioStats(portfolio);
    expect(stats.Core).toBe(1);
    expect(stats.Risk).toBe(1);
    expect(stats.Change).toBe(1);
    expect(stats.Historical).toBe(2);
    expect(stats.Exploration).toBe(1);
    expect(stats.Regression).toBe(1);
    expect(stats.Flaky).toBe(1);
  });
});

describe('Test Portfolio：组合选择策略', () => {
  it('Core/Risk/Change/Regression 100%、Flaky 隔离、Historical Top N、Exploration 预算 %', () => {
    const { selected, skipped } = selectPortfolio(sampleCases());
    const ids = selected.map((s) => s.caseId);
    // 100% 选择
    expect(ids).toContain('core-1');
    expect(ids).toContain('risk-1');
    expect(ids).toContain('change-1');
    expect(ids).toContain('regress-1');
    expect(ids).toContain('flaky-1'); // 隔离执行
    // Historical 2 个，Top N=10 → 全选
    expect(ids).toContain('hist-1');
    expect(ids).toContain('known-1');
    // Exploration 1 个，预算 20% → round(1*0.2)=0 → 跳过
    expect(ids).not.toContain('explore-1');
    expect(skipped.some((s) => s.caseId === 'explore-1' && s.reason.includes('探索预算'))).toBe(true);
  });

  it('Historical Top N：超过 N 时只选前 N', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'h1', historicalFailures: 5 },
      { caseId: 'h2', historicalFailures: 4 },
      { caseId: 'h3', knownIssue: true },
    ];
    const { selected, skipped } = selectPortfolio(cases, { historicalTopN: 2 });
    expect(selected.filter((s) => s.category === 'Historical').length).toBe(2);
    expect(skipped.some((s) => s.caseId === 'h3' && s.reason.includes('Top N'))).toBe(true);
  });

  it('Exploration 预算比例：提高比例后纳入探索用例', () => {
    const cases: PortfolioCaseInput[] = [
      { caseId: 'e1', coverageGap: true },
      { caseId: 'e2', coverageGap: true },
      { caseId: 'e3', coverageGap: true },
      { caseId: 'e4', coverageGap: true },
      { caseId: 'e5', coverageGap: true },
    ];
    const { selected } = selectPortfolio(cases, { explorationRatio: 1 });
    expect(selected.filter((s) => s.category === 'Exploration').length).toBe(5);
  });

  it('空数据：返回空', () => {
    const { selected, skipped } = selectPortfolio([]);
    expect(selected).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('确定性：相同输入 → 相同结果', () => {
    const a = selectPortfolio(sampleCases());
    const b = selectPortfolio(sampleCases());
    expect(a).toEqual(b);
  });
});
