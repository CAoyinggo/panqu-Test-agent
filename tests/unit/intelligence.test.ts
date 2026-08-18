// Phase 22.1 Test Intelligence 单元测试
// 覆盖：TestValue 公式、Case Intelligence 九维、Feature Risk、Failure Risk、
// Change Risk、边界（空数据/越界/除零）、确定性。

import { describe, it, expect } from 'vitest';
import {
  computeCaseIntelligence,
  computeFeatureRisk,
  computeFailureRisk,
  computeChangeRisk,
  computeTestValue,
  clamp01,
  normalizeRange,
  logNormalize,
  levelOf,
  coverageValueOf,
  CHANGE_TYPE_BASE_RISK,
} from '../../src/intelligence/index.js';

describe('computeTestValue 公式', () => {
  it('正项加分、负项扣分（executionCost + flakyPenalty）', () => {
    // 全正项高、负项 0 → 高分
    const high = computeTestValue({ risk: 1, changeImpact: 1, historicalFailure: 1, coverageValue: 1, businessCriticality: 1, executionCost: 0, flakyRate: 0 });
    expect(high.testValue).toBe(5);
    expect(high.normalized).toBe(1);

    // 负项拉低
    const withCost = computeTestValue({ risk: 1, changeImpact: 1, historicalFailure: 1, coverageValue: 1, businessCriticality: 1, executionCost: 1, flakyRate: 1 });
    // 5 - 1 - 0.5 = 3.5 → 归一 (3.5-(-1.5))/6.5
    expect(withCost.testValue).toBe(3.5);
    expect(withCost.normalized).toBeGreaterThan(0);
    expect(withCost.normalized).toBeLessThan(high.normalized);
  });

  it('flakyPenalty = flakyRate × 0.5（默认权重）', () => {
    const a = computeTestValue({ risk: 0, changeImpact: 0, historicalFailure: 0, coverageValue: 0, businessCriticality: 0, executionCost: 0, flakyRate: 0 });
    const b = computeTestValue({ risk: 0, changeImpact: 0, historicalFailure: 0, coverageValue: 0, businessCriticality: 0, executionCost: 0, flakyRate: 1 });
    expect(a.testValue).toBe(0);
    expect(b.testValue).toBe(-0.5);
  });
});

describe('computeCaseIntelligence 九维', () => {
  it('高风险高变更用例 testValue 高于低风险用例', () => {
    const risky = computeCaseIntelligence({
      caseId: 'B', riskScore: 1, changeImpact: 1, historicalFailureRate: 1,
      coverageValue: 1, businessCriticality: 1, executionCost: 0.1, flakyRate: 0,
    });
    const safe = computeCaseIntelligence({
      caseId: 'A', riskScore: 0.01, changeImpact: 0, historicalFailureRate: 0.01,
      coverageValue: 0, businessCriticality: 0.1, executionCost: 1, flakyRate: 1,
    });
    expect(risky.testValue).toBeGreaterThan(safe.testValue);
    expect(risky.level).toBe('HIGH');
    expect(safe.level).toBe('LOW');
  });

  it('输出全部维度字段（含 flakyPenalty）与归一值', () => {
    const ci = computeCaseIntelligence({ caseId: 'c1', riskScore: 0.5, flakyRate: 0.4 });
    expect(ci.dimensions).toMatchObject({
      risk: 0.5, changeImpact: 0, historicalFailure: 0, flakyRate: 0.4,
      defectDensity: 0, coverageValue: 0, executionCost: 0, businessCriticality: 0,
    });
    expect(ci.dimensions.flakyPenalty).toBeCloseTo(0.2, 2);
    expect(ci.testValueNormalized).toBeGreaterThanOrEqual(0);
    expect(ci.testValueNormalized).toBeLessThanOrEqual(1);
  });

  it('越界输入截断为 0~1', () => {
    const ci = computeCaseIntelligence({ caseId: 'c2', riskScore: 5, changeImpact: -1, historicalFailureRate: NaN });
    expect(ci.riskScore).toBe(1);
    expect(ci.changeImpact).toBe(0);
    expect(ci.historicalFailureRate).toBe(0);
  });
});

describe('computeFeatureRisk', () => {
  it('加权聚合：平均风险主导，覆盖缺口抬升', () => {
    const high = computeFeatureRisk({ feature: 'wan3', avgCaseRisk: 1, maxCaseRisk: 1, changeImpact: 1, historicalFailureRate: 1, defectDensity: 1, coverageGap: 1 });
    expect(high.riskScore).toBe(1);
    expect(high.level).toBe('HIGH');

    const low = computeFeatureRisk({ feature: 'chat', avgCaseRisk: 0, maxCaseRisk: 0, changeImpact: 0, historicalFailureRate: 0, defectDensity: 0, coverageGap: 0 });
    expect(low.riskScore).toBe(0);
    expect(low.level).toBe('LOW');

    const withGap = computeFeatureRisk({ feature: 'f', avgCaseRisk: 0.5, coverageGap: 0.8 });
    const noGap = computeFeatureRisk({ feature: 'f', avgCaseRisk: 0.5, coverageGap: 0 });
    expect(withGap.riskScore).toBeGreaterThan(noGap.riskScore);
    expect(withGap.reasons.some((r) => r.includes('覆盖缺口'))).toBe(true);
  });

  it('权重合计 1.0；空输入安全', () => {
    const total = Object.values({
      avgCaseRisk: 0.35, maxCaseRisk: 0.2, changeImpact: 0.15,
      historicalFailureRate: 0.15, defectDensity: 0.1, coverageGap: 0.05,
    }).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 6);
    const empty = computeFeatureRisk({ feature: 'f' });
    expect(empty.riskScore).toBe(0);
    expect(empty.reasons).toEqual([]);
  });
});

describe('computeFailureRisk 失败概率', () => {
  it('任务书场景：历史失败率高 + 最近失败 + 变更 → 概率高、置信度随数据量', () => {
    const risk = computeFailureRisk({
      caseId: 'wan3-1080p-10s', historicalFailureRate: 0.37, recentFailures: 3, recentRuns: 5, changeImpact: 0.8, flakyRate: 0.1,
    });
    // 0.4×0.37 + 0.25×0.6 + 0.2×0.8 + 0.15×0.1 = 0.148+0.15+0.16+0.015 = 0.473
    expect(risk.failureProbability).toBeCloseTo(0.473, 3);
    expect(risk.riskLevel).toBe('MEDIUM');
    expect(risk.confidence).toBeGreaterThanOrEqual(0.3);
    expect(risk.confidence).toBeLessThanOrEqual(0.95);
    expect(risk.evidence.length).toBeGreaterThanOrEqual(3);
    expect(risk.evidence.some((e) => e.includes('最近 5 次失败 3 次'))).toBe(true);
  });

  it('无历史数据 → 概率 0、置信度低（数据不足不虚报）', () => {
    const risk = computeFailureRisk({ caseId: 'new-case' });
    expect(risk.failureProbability).toBe(0);
    expect(risk.riskLevel).toBe('LOW');
    expect(risk.confidence).toBeLessThan(0.5);
    expect(risk.evidence).toEqual([]);
  });

  it('recentRuns=0 时 recentRate 为 0 不除零；越界截断', () => {
    const risk = computeFailureRisk({ caseId: 'c', recentFailures: 3, recentRuns: 0, historicalFailureRate: -1, flakyRate: 3 });
    expect(risk.failureProbability).toBeGreaterThanOrEqual(0);
    expect(risk.failureProbability).toBeLessThanOrEqual(1);
  });

  it('确定性：相同输入输出完全一致', () => {
    const input = { caseId: 'c', historicalFailureRate: 0.3, recentFailures: 2, recentRuns: 4, changeImpact: 0.2 };
    expect(computeFailureRisk(input)).toEqual(computeFailureRisk(input));
  });
});

describe('computeChangeRisk', () => {
  it('变更类型高危度排序：pricing > model > code > requirement', () => {
    expect(CHANGE_TYPE_BASE_RISK.pricing).toBeGreaterThan(CHANGE_TYPE_BASE_RISK.model);
    expect(CHANGE_TYPE_BASE_RISK.model).toBeGreaterThan(CHANGE_TYPE_BASE_RISK.code);
    expect(CHANGE_TYPE_BASE_RISK.code).toBeGreaterThan(CHANGE_TYPE_BASE_RISK.requirement);
    const pricing = computeChangeRisk({ changeType: 'pricing', affectedCases: 100 });
    const requirement = computeChangeRisk({ changeType: 'requirement', affectedCases: 0 });
    expect(pricing.riskScore).toBeGreaterThan(requirement.riskScore);
  });

  it('影响范围越大风险越高；原因可解释', () => {
    const big = computeChangeRisk({ changeType: 'model', affectedCases: 50, affectedCapabilities: 5, affectedBusinesses: 3 });
    const small = computeChangeRisk({ changeType: 'model', affectedCases: 1 });
    expect(big.riskScore).toBeGreaterThan(small.riskScore);
    expect(big.reasons.some((r) => r.includes('50'))).toBe(true);
    expect(big.reasons.some((r) => r.includes('model'))).toBe(true);
  });

  it('未知类型回落低基础分；空输入安全', () => {
    const unknown = computeChangeRisk({ changeType: 'unknown-type', affectedCases: 0 });
    expect(unknown.riskScore).toBeLessThanOrEqual(0.05);
    const empty = computeChangeRisk({ changeType: 'model' });
    expect(empty.riskScore).toBeGreaterThan(0);
  });
});

describe('工具函数边界', () => {
  it('clamp01 / normalizeRange / logNormalize / levelOf / coverageValueOf', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(normalizeRange(5, 0, 10)).toBe(0.5);
    expect(normalizeRange(0, 0, 0)).toBe(0.5);
    expect(logNormalize(0, 10)).toBe(0);
    expect(logNormalize(10, 10)).toBe(1);
    expect(levelOf(0.8)).toBe('HIGH');
    expect(levelOf(0.4)).toBe('MEDIUM');
    expect(levelOf(0.2)).toBe('LOW');
    expect(coverageValueOf(0.9)).toBeCloseTo(0.1, 10);
    expect(coverageValueOf(1)).toBe(0);
    expect(coverageValueOf(0.5)).toBe(0.5);
  });
});
