// Phase 22.3 Risk Prediction Engine 单元测试
// 覆盖：任务书场景（30 次失败 11 次 + 最近 5 次失败 3 次 + 变更信号）、时间衰减、
// 趋势、失败聚集、空数据/数据不足、Feature/Model/Environment 维度聚合、确定性。

import { describe, it, expect } from 'vitest';
import {
  predictCaseFailure,
  predictDimensionRisk,
  computeFailureStats,
  type ExecutionSample,
  type ChangeSignal,
} from '../../src/risk-prediction/index.js';

const DAY = 86400000;

/** 构造每天一个样本的执行历史：base 起连续 days 天 */
function dailySamples(base: string, failures: number[], days: number): ExecutionSample[] {
  const start = new Date(base).getTime();
  const out: ExecutionSample[] = [];
  for (let i = 0; i < days; i += 1) {
    out.push({
      caseId: 'wan3-1080p-10s',
      passed: !failures.includes(i),
      at: new Date(start + i * DAY).toISOString(),
    });
  }
  return out;
}

describe('predictCaseFailure 高风险场景', () => {
  it('任务书场景：过去 30 次失败 11 次 + 最近 5 次失败 3 次 + 变更 → HIGH', () => {
    // 最近 3 天连续失败（28,29,30 为索引 27,28,29）；最近 5 天（索引 25-29）中 27/28/29 失败
    const samples = dailySamples('2026-07-01T00:00:00Z', [0, 3, 6, 9, 12, 15, 18, 21, 27, 28, 29], 30);
    const risk = predictCaseFailure(samples, {
      caseId: 'wan3-1080p-10s',
      changeImpact: 0.8,
      changes: [{ type: 'model', target: 'modelA', global: true }],
      now: '2026-07-31T00:00:00Z',
    });
    expect(risk.failureProbability).toBeGreaterThan(0.4);
    expect(risk.riskLevel).not.toBe('LOW');
    expect(risk.confidence).toBeGreaterThanOrEqual(0.5);
    expect(risk.confidence).toBeLessThanOrEqual(0.95);
    // 证据可解释
    expect(risk.evidence.some((e) => e.includes('过去 30 次失败 11 次'))).toBe(true);
    expect(risk.evidence.some((e) => e.includes('最近 5 次失败 3 次'))).toBe(true);
    expect(risk.evidence.some((e) => e.includes('关联变更影响 80%'))).toBe(true);
    expect(risk.evidence.some((e) => e.includes('连续失败 3 次'))).toBe(true);
    // 因子分解
    expect(risk.factors.historical).toBeCloseTo(11 / 30, 3);
    expect(risk.factors.trend).toBeCloseTo(0.28, 3); // 0.6 - 0.32
    expect(risk.factors.clustering).toBe(1);
    expect(risk.factors.change).toBe(0.8);
  });

  it('全部 PASS → 概率 0、LOW；全部失败 → HIGH；空样本 → 0 且置信度低', () => {
    const allPass = dailySamples('2026-07-01T00:00:00Z', [], 30);
    const low = predictCaseFailure(allPass, { caseId: 'c', now: '2026-07-31T00:00:00Z' });
    expect(low.failureProbability).toBe(0);
    expect(low.riskLevel).toBe('LOW');
    // 有历史但零失败：证据明确说明（"0 次"），而非静默
    expect(low.evidence).toEqual(['过去 30 次失败 0 次（0%）']);

    const allFail = dailySamples('2026-07-01T00:00:00Z', Array.from({ length: 30 }, (_, i) => i), 30);
    const high = predictCaseFailure(allFail, { caseId: 'c', now: '2026-07-31T00:00:00Z' });
    expect(high.failureProbability).toBeGreaterThanOrEqual(0.6);
    expect(high.riskLevel).toBe('HIGH');

    const empty = predictCaseFailure([], { caseId: 'new' });
    expect(empty.failureProbability).toBe(0);
    expect(empty.riskLevel).toBe('LOW');
    expect(empty.confidence).toBeLessThan(0.5);
    expect(empty.evidence).toEqual([]);
  });

  it('时间衰减：失败集中在近期 → recencyWeighted 高于 overallRate；集中在远期 → 更低', () => {
    // 近期失败：最后 10 天全失败，前面全 PASS
    const recentFail = dailySamples('2026-07-01T00:00:00Z', Array.from({ length: 10 }, (_, i) => 20 + i), 30);
    const recentStats = computeFailureStats(
      recentFail,
      { recentWindow: 5, decayPerDay: 0.95 },
      new Date('2026-07-31T00:00:00Z').getTime(),
    );
    expect(recentStats.recencyWeighted).toBeGreaterThan(recentStats.overallRate);

    // 远期失败：前 10 天全失败，后面全 PASS
    const oldFail = dailySamples('2026-07-01T00:00:00Z', Array.from({ length: 10 }, (_, i) => i), 30);
    const oldStats = computeFailureStats(
      oldFail,
      { recentWindow: 5, decayPerDay: 0.95 },
      new Date('2026-07-31T00:00:00Z').getTime(),
    );
    expect(oldStats.recencyWeighted).toBeLessThan(oldStats.overallRate);
    // 两者 overallRate 相同但 recencyWeighted 不同 → 时间衰减生效
    expect(recentStats.overallRate).toBeCloseTo(oldStats.overallRate, 6);
  });

  it('趋势：最近窗口恶化 → trend>0；改善 → trend=0', () => {
    const worsen = dailySamples('2026-07-01T00:00:00Z', [25, 26, 27, 28, 29], 30);
    const s1 = computeFailureStats(worsen, { recentWindow: 5, decayPerDay: 0.95 }, new Date('2026-07-31T00:00:00Z').getTime());
    expect(s1.trend).toBeGreaterThan(0);

    const improve = dailySamples('2026-07-01T00:00:00Z', [0, 1, 2, 3, 4], 30);
    const s2 = computeFailureStats(improve, { recentWindow: 5, decayPerDay: 0.95 }, new Date('2026-07-31T00:00:00Z').getTime());
    expect(s2.trend).toBe(0);
  });

  it('确定性：相同输入输出完全一致；乱序样本与有序等价', () => {
    const samples = dailySamples('2026-07-01T00:00:00Z', [1, 5, 9, 27, 28, 29], 30);
    const shuffled = [...samples].reverse();
    const a = predictCaseFailure(samples, { caseId: 'c', now: '2026-07-31T00:00:00Z' });
    const b = predictCaseFailure(samples, { caseId: 'c', now: '2026-07-31T00:00:00Z' });
    const c = predictCaseFailure(shuffled, { caseId: 'c', now: '2026-07-31T00:00:00Z' });
    expect(a).toEqual(b);
    expect(a.failureProbability).toBe(c.failureProbability);
  });
});

describe('predictDimensionRisk 维度聚合', () => {
  it('Feature/Model/Environment 风险按置信度加权平均', () => {
    const cases = [
      { caseId: 'a', failureProbability: 0.9, confidence: 0.8 },
      { caseId: 'b', failureProbability: 0.1, confidence: 0.2 },
    ];
    const feature = predictDimensionRisk('wan3', cases);
    expect(feature.riskScore).toBeGreaterThan(0.5); // 高置信高风险主导
    expect(feature.riskLevel).toBe('HIGH');
    expect(feature.caseCount).toBe(2);
    expect(feature.evidence[0]).toBe('覆盖 2 个用例');
    expect(feature.evidence.some((e) => e.includes('1 个用例为高风险'))).toBe(true);
  });

  it('空用例 → LOW 且无数据；全部低风险 → LOW', () => {
    const empty = predictDimensionRisk('env-prod', []);
    expect(empty.riskScore).toBe(0);
    expect(empty.riskLevel).toBe('LOW');
    expect(empty.evidence).toEqual(['无历史数据']);

    const low = predictDimensionRisk('env-staging', [
      { caseId: 'a', failureProbability: 0.1, confidence: 0.9 },
      { caseId: 'b', failureProbability: 0.2, confidence: 0.9 },
    ]);
    expect(low.riskLevel).toBe('LOW');
  });
});

describe('computeFailureStats 边界', () => {
  it('空样本全部因子为 0；recentWindow 大于样本数时不除零', () => {
    const empty = computeFailureStats([], { recentWindow: 5, decayPerDay: 0.95 }, Date.now());
    expect(empty).toEqual({
      total: 0, failures: 0, overallRate: 0, recentRate: 0, olderRate: 0,
      consecutiveFailures: 0, rate: 0, recencyWeighted: 0, recentWindow: 5, trend: 0,
    });

    const few = dailySamples('2026-07-01T00:00:00Z', [0], 2);
    const s = computeFailureStats(few, { recentWindow: 5, decayPerDay: 0.95 }, new Date('2026-07-31T00:00:00Z').getTime());
    expect(s.total).toBe(2);
    expect(s.olderRate).toBe(0);
  });

  it('变更信号不参与数值计算（仅 changeImpact 因子），但可作为证据来源', () => {
    const changes: ChangeSignal[] = [{ type: 'model', target: 'modelB', global: true, at: '2026-07-29T00:00:00Z' }];
    const risk = predictCaseFailure(dailySamples('2026-07-01T00:00:00Z', [0], 30), {
      caseId: 'c',
      changes,
      now: '2026-07-31T00:00:00Z',
    });
    // changeImpact 未提供时 change 因子为 0
    expect(risk.factors.change).toBe(0);
  });
});
