// Phase 45：Eval Regression（regression.ts）单元测试
// 覆盖：compareVersions——领域下降超 criticalDelta 触发 BLOCK、
// P0 Miss / False Pass / Unsafe Healing 增加触发 BLOCK、小幅下降 REVIEW、无退化 PASS；
// domainTrend 判定（improved / unchanged / regressed）。

import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  domainTrend,
  DEFAULT_GATE_THRESHOLDS,
  type CompareResult,
  type RegressionGateThresholds,
} from '../../src/eval/regression.js';
import { DOMAIN_LABELS, DEFAULT_PASS_THRESHOLD, type EvaluationDomain } from '../../src/eval/contract.js';
import { EMPTY_COST, type DomainReport, type EvalReport } from '../../src/eval/runner.js';
import { DEFAULT_EVAL_VERSION_INFO } from '../../src/eval/versioning.js';

const ZERO_CRITICAL = { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 };

/** 构造一个最小编领域报告（仅需 compareVersions 读取的字段） */
function makeDomain(domain: EvaluationDomain, score: number): DomainReport {
  return {
    domain,
    label: DOMAIN_LABELS[domain],
    benchmark: `${domain}_BENCHMARK_v1`,
    benchmarkVersion: 'v1',
    total: 1,
    tracked: 1,
    untracked: 0,
    passed: score >= DEFAULT_PASS_THRESHOLD ? 1 : 0,
    score,
    metrics: { meanScore: score, passRate: score >= DEFAULT_PASS_THRESHOLD ? 1 : 0 },
    failures: [],
    results: [],
    cost: EMPTY_COST,
  };
}

/** 构造一个最小 EvalReport */
function makeReport(
  version: string,
  overall: number,
  domains: DomainReport[],
  critical: EvalReport['critical'] = ZERO_CRITICAL,
): EvalReport {
  return {
    version,
    generatedAt: '2026-01-01T00:00:00.000Z',
    versionInfo: DEFAULT_EVAL_VERSION_INFO,
    domains,
    overall,
    critical,
    cost: EMPTY_COST,
  };
}

function gate(cmp: CompareResult) {
  return cmp.gate;
}

describe('domainTrend 判定', () => {
  const t = DEFAULT_GATE_THRESHOLDS;

  it('delta > softDelta（0.03）→ improved', () => {
    expect(domainTrend(0.9, 0.95, t)).toBe('improved');
    expect(domainTrend(0.8, 0.85, t)).toBe('improved');
  });

  it('delta 在 [-softDelta, softDelta] → unchanged', () => {
    expect(domainTrend(0.9, 0.91, t)).toBe('unchanged'); // +0.01
    expect(domainTrend(0.9, 0.88, t)).toBe('unchanged'); // -0.02
    expect(domainTrend(0.9, 0.93, t)).toBe('unchanged'); // +0.03 边界
    expect(domainTrend(0.9, 0.87, t)).toBe('unchanged'); // -0.03 边界
  });

  it('delta < -softDelta → regressed', () => {
    expect(domainTrend(0.9, 0.86, t)).toBe('regressed'); // -0.04
    expect(domainTrend(0.95, 0.9, t)).toBe('regressed');
  });

  it('自定义阈值生效', () => {
    const custom: RegressionGateThresholds = { ...DEFAULT_GATE_THRESHOLDS, softDelta: 0.1 };
    expect(domainTrend(0.9, 0.95, custom)).toBe('unchanged'); // +0.05 <= 0.1
    expect(domainTrend(0.9, 0.78, custom)).toBe('regressed'); // -0.12 < -0.1
  });
});

describe('compareVersions：领域下降', () => {
  it('普通领域下降超过 criticalDelta（0.05）→ BLOCK', () => {
    const baseline = makeReport('v1', 0.925, [makeDomain('REQUIREMENT', 0.95), makeDomain('TEST_DESIGN', 0.9)]);
    const candidate = makeReport('v2', 0.89, [makeDomain('REQUIREMENT', 0.88), makeDomain('TEST_DESIGN', 0.9)]);
    const cmp = compareVersions(baseline, candidate);
    expect(cmp.domains.find((d) => d.domain === 'REQUIREMENT')?.delta).toBe(-0.07);
    expect(gate(cmp).verdict).toBe('BLOCK');
    expect(gate(cmp).reasons.some((r) => r.startsWith('BLOCK') && r.includes('需求理解'))).toBe(true);
  });

  it('关键安全领域（RCA/RISK/RELEASE/HEALING）任何下降即触发 BLOCK', () => {
    for (const domain of ['RCA', 'RISK', 'RELEASE', 'HEALING'] as EvaluationDomain[]) {
      const baseline = makeReport('v1', 0.9, [makeDomain(domain, 0.9)]);
      const candidate = makeReport('v2', 0.89, [makeDomain(domain, 0.89)]); // 仅 -0.01
      const cmp = compareVersions(baseline, candidate);
      expect(gate(cmp).verdict).toBe('BLOCK');
      expect(gate(cmp).reasons.some((r) => r.startsWith('BLOCK') && r.includes('安全敏感领域'))).toBe(true);
    }
  });

  it('普通领域小幅下降（超 softDelta、未超 criticalDelta）→ REVIEW', () => {
    const baseline = makeReport('v1', 0.93, [makeDomain('REQUIREMENT', 0.95), makeDomain('TEST_DESIGN', 0.9)]);
    const candidate = makeReport('v2', 0.905, [makeDomain('REQUIREMENT', 0.91), makeDomain('TEST_DESIGN', 0.9)]);
    const cmp = compareVersions(baseline, candidate);
    expect(cmp.domains.find((d) => d.domain === 'REQUIREMENT')?.delta).toBe(-0.04);
    expect(gate(cmp).verdict).toBe('REVIEW');
    expect(gate(cmp).reasons.some((r) => r.startsWith('REVIEW') && r.includes('小幅下降'))).toBe(true);
  });

  it('无退化（全持平）→ PASS', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('REQUIREMENT', 0.9), makeDomain('TEST_DESIGN', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('REQUIREMENT', 0.9), makeDomain('TEST_DESIGN', 0.9)]);
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('PASS');
    expect(gate(cmp).reasons).toEqual(['全部指标达标或持平，允许发布']);
    expect(cmp.overall.trend).toBe('unchanged');
    expect(cmp.overall.delta).toBe(0);
  });
});

describe('compareVersions：关键安全指标增加 → BLOCK', () => {
  it('P0 Miss 增加（0 → 1）→ BLOCK 且记录退化', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('RISK', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('RISK', 0.9)], { ...ZERO_CRITICAL, p0Miss: 1 });
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('BLOCK');
    expect(gate(cmp).reasons.some((r) => r.includes('P0 Miss = 1'))).toBe(true);
    expect(cmp.critical.regressions).toContain('P0 Miss 0 → 1');
  });

  it('False Pass 增加（0 → 1）→ BLOCK 且记录退化', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('RELEASE', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('RELEASE', 0.9)], { ...ZERO_CRITICAL, falsePass: 1 });
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('BLOCK');
    expect(gate(cmp).reasons.some((r) => r.includes('False Pass = 1'))).toBe(true);
    expect(cmp.critical.regressions).toContain('False Pass 0 → 1');
  });

  it('Unsafe Healing 增加（0 → 1）→ BLOCK 且记录退化', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('HEALING', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('HEALING', 0.9)], { ...ZERO_CRITICAL, unsafeHealing: 1 });
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('BLOCK');
    expect(gate(cmp).reasons.some((r) => r.includes('Unsafe Healing = 1'))).toBe(true);
    expect(cmp.critical.regressions).toContain('Unsafe Healing 0 → 1');
  });

  it('Skipped Critical 增加（0 → 1）→ BLOCK 且记录退化', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('SELECTION', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('SELECTION', 0.9)], { ...ZERO_CRITICAL, skippedCritical: 1 });
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('BLOCK');
    expect(gate(cmp).reasons.some((r) => r.includes('Skipped Critical = 1'))).toBe(true);
    expect(cmp.critical.regressions).toContain('Skipped Critical 0 → 1');
  });

  it('关键安全指标持平（0 → 0）不触发 BLOCK → PASS', () => {
    const baseline = makeReport('v1', 0.9, [makeDomain('RELEASE', 0.9)]);
    const candidate = makeReport('v2', 0.9, [makeDomain('RELEASE', 0.9)]);
    const cmp = compareVersions(baseline, candidate);
    expect(gate(cmp).verdict).toBe('PASS');
    expect(cmp.critical.regressions).toEqual([]);
  });
});

describe('compareVersions：整体趋势汇总', () => {
  it('overall 提升 → overall.trend=improved', () => {
    const baseline = makeReport('v1', 0.8, [makeDomain('REQUIREMENT', 0.8)]);
    const candidate = makeReport('v2', 0.85, [makeDomain('REQUIREMENT', 0.85)]);
    const cmp = compareVersions(baseline, candidate);
    expect(cmp.overall).toMatchObject({ baseline: 0.8, candidate: 0.85, delta: 0.05, trend: 'improved' });
  });

  it('overall 下降 → overall.trend=regressed', () => {
    const baseline = makeReport('v1', 0.85, [makeDomain('REQUIREMENT', 0.85)]);
    const candidate = makeReport('v2', 0.8, [makeDomain('REQUIREMENT', 0.8)]);
    const cmp = compareVersions(baseline, candidate);
    expect(cmp.overall.trend).toBe('regressed');
  });
});
