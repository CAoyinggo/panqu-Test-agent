// 单元测试：Agent Evaluation（Phase 18）
// 覆盖：评测工具函数（集合评分/匹配/均值/百分比）、质量报告权重汇总、完整 Benchmark 评测（Quality Score）
import { describe, it, expect } from 'vitest';
import { setScore, exactMatch, mean, pct, buildQualityReport, finalizeReport } from './eval-utils.js';
import { runAgentEval } from './run-evals.js';
import { REQUIREMENT_BENCHMARK } from './benchmark/requirements.js';
import { FAILURE_BENCHMARK } from './benchmark/failures.js';
import { HEALING_BENCHMARK } from './benchmark/healing.js';

describe('eval-utils - 集合评分', () => {
  it('setScore 计算 precision/recall/F1', () => {
    const s = setScore(['a', 'b', 'c'], ['a', 'b']);
    expect(s.precision).toBeCloseTo(2 / 3, 5);
    expect(s.recall).toBe(1);
    expect(s.f1).toBeCloseTo((2 * (2 / 3) * 1) / (2 / 3 + 1), 5);
  });

  it('空期望集合：实际为空得满分，非空得 0 分', () => {
    expect(setScore([], []).f1).toBe(1);
    expect(setScore(['x'], []).f1).toBe(0);
  });

  it('exactMatch 大小写不敏感 0/1', () => {
    expect(exactMatch('Wan3', 'wan3')).toBe(1);
    expect(exactMatch('wan3', 'user')).toBe(0);
  });

  it('mean / pct', () => {
    expect(mean([0.5, 0.5, 1])).toBeCloseTo(0.6667, 3);
    expect(pct(0.5)).toBe(50);
    expect(pct(0.8765)).toBe(87.7);
  });
});

describe('eval-utils - 质量报告汇总', () => {
  it('overall 为维度加权和（权重已归一化，不再除维度数）', () => {
    const dims = [
      { key: 'requirements', label: 'R', score: 80, passed: 8, total: 10 },
      { key: 'rca', label: 'X', score: 100, passed: 10, total: 10 },
    ];
    const report = buildQualityReport(dims, { requirements: 0.5, rca: 0.5 });
    expect(report.overall).toBe(90);
  });

  it('finalizeReport 合并成本/回退指标', () => {
    const report = buildQualityReport([], {}, {});
    const final = finalizeReport(report, { fallbackRate: 0.5, tokenCost: 0.01, latencyMs: 100 });
    expect(final.fallbackRate).toBe(0.5);
    expect(final.tokenCost).toBe(0.01);
    expect(final.latencyMs).toBe(100);
  });
});

describe('Agent 评测 Benchmark', () => {
  it('基准数据规模：30 需求 + 30 失败 + 5 自愈', () => {
    expect(REQUIREMENT_BENCHMARK).toHaveLength(30);
    expect(FAILURE_BENCHMARK).toHaveLength(30);
    expect(HEALING_BENCHMARK).toHaveLength(5);
  });

  it('完整评测产生质量分且各维度达到稳定阈值', async () => {
    const report = await runAgentEval();
    const dim = (k: string): number => report.dimensions.find((d) => d.key === k)?.score ?? -1;
    expect(dim('requirements')).toBeGreaterThanOrEqual(80);
    expect(dim('rca')).toBeGreaterThanOrEqual(95);
    expect(dim('healing')).toBeGreaterThanOrEqual(80);
    expect(dim('defect')).toBeGreaterThanOrEqual(95);
    expect(dim('risk')).toBeGreaterThanOrEqual(95);
    expect(report.overall).toBeGreaterThanOrEqual(90);
    expect(report.fallbackRate).toBeGreaterThan(0);
    expect(report.hallucinationRate).toBeLessThanOrEqual(0.05);
    expect(report.tokenCost).toBeGreaterThanOrEqual(0);
  });
});
