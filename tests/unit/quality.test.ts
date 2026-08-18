// Phase 21.7 Quality Optimization 单元测试
// 覆盖：Test Quality Score 九维度计算、等级、Feature Quality Score、多维趋势、
// Flaky Lifecycle 状态机（STABLE→SUSPECTED→FLAKY→QUARANTINED→FIXED→STABLE）、
// 与既有 classifyStatus 的集成、持久化。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeTestQualityScore,
  gradeOf,
  QUALITY_WEIGHTS,
  QualityTracker,
  createQualityTracker,
  FlakyLifecycle,
  createFlakyLifecycle,
  FLAKY_LIFECYCLE_STATUSES,
} from '../../src/quality/index.js';

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `quality-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

describe('computeTestQualityScore 九维度', () => {
  it('权重合计为 1；全优 → 100 分，全劣 → 0 分', () => {
    const total = Object.values(QUALITY_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 6);

    const perfect = computeTestQualityScore({
      coverage: 1, riskDetection: 1, rcaAccuracy: 1, healingSuccess: 1,
      falsePositiveRate: 0, falseNegativeRate: 0, flakyRate: 0,
      defectDuplicateRate: 0, humanInterventionRate: 0,
    });
    expect(perfect.score).toBe(100);

    const worst = computeTestQualityScore({
      coverage: 0, riskDetection: 0, rcaAccuracy: 0, healingSuccess: 0,
      falsePositiveRate: 1, falseNegativeRate: 1, flakyRate: 1,
      defectDuplicateRate: 1, humanInterventionRate: 1,
    });
    expect(worst.score).toBe(0);
  });

  it('混合指标加权正确，「越低越好」维度取反', () => {
    const { score, dimensions } = computeTestQualityScore({
      coverage: 0.9, riskDetection: 1, rcaAccuracy: 0.8,
      falsePositiveRate: 0.05, falseNegativeRate: 0.1, flakyRate: 0.02,
      healingSuccess: 0.75, defectDuplicateRate: 0.04, humanInterventionRate: 0.15,
    });
    expect(dimensions.falsePositive).toBeCloseTo(0.95, 6);
    expect(dimensions.humanIntervention).toBeCloseTo(0.85, 6);
    // 0.135+0.15+0.12+0.095+0.09+0.098+0.075+0.085+0.048 = 0.896 → 89.6
    expect(score).toBeCloseTo(89.6, 1);
    expect(gradeOf(score)).toBe('B');
  });

  it('越界值截断到 0~1；缺失维度按 0 计', () => {
    const { score } = computeTestQualityScore({ coverage: 5, riskDetection: -1 });
    // coverage 截断为 1 → 0.15；riskDetection 截断为 0；其余缺失 → 归一值 0（率类缺失按 0 → 归一 1）
    expect(score).toBeGreaterThan(0);
    expect(gradeOf(95)).toBe('A');
    expect(gradeOf(85)).toBe('B');
    expect(gradeOf(75)).toBe('C');
    expect(gradeOf(65)).toBe('D');
    expect(gradeOf(50)).toBe('F');
  });
});

describe('QualityTracker：Feature Quality Score 与多维趋势', () => {
  it('record 自动计算得分/等级；featureScore 返回最新记录', () => {
    const tracker = createQualityTracker();
    tracker.record({
      feature: 'wan3', version: 'v1.0', timestamp: '2026-08-10T10:00:00Z',
      metrics: { coverage: 0.5, riskDetection: 0.5, rcaAccuracy: 0.5, healingSuccess: 0.5 },
    });
    const latest = tracker.record({
      feature: 'wan3', version: 'v2.0', timestamp: '2026-08-15T10:00:00Z',
      metrics: { coverage: 1, riskDetection: 1, rcaAccuracy: 1, healingSuccess: 1 },
    });
    expect(latest.score).toBe(100);
    expect(latest.grade).toBe('A');
    expect(tracker.featureScore('wan3')?.version).toBe('v2.0');
    expect(tracker.featureScore('none')).toBeNull();
    expect(() => tracker.record({ metrics: {} })).toThrow('feature');
  });

  it('趋势：按 day / version / model / environment 分组取平均分', () => {
    const tracker = createQualityTracker();
    const good = { coverage: 1, riskDetection: 1, rcaAccuracy: 1, healingSuccess: 1 };
    const mid = { coverage: 0.5, riskDetection: 0.5, rcaAccuracy: 0.5, healingSuccess: 0.5 };
    tracker.record({ feature: 'wan3', version: 'v1.0', model: 'modelA', environment: 'staging', timestamp: '2026-08-10T10:00:00Z', metrics: good });
    tracker.record({ feature: 'wan3', version: 'v1.0', model: 'modelA', environment: 'staging', timestamp: '2026-08-11T10:00:00Z', metrics: mid });
    tracker.record({ feature: 'chat', version: 'v2.0', model: 'modelB', environment: 'prod', timestamp: '2026-08-11T12:00:00Z', metrics: good });

    const byDay = tracker.trend('day');
    expect(byDay.map((p) => p.key)).toEqual(['2026-08-10', '2026-08-11']);
    expect(byDay[1].count).toBe(2);

    const byVersion = tracker.trend('version');
    expect(byVersion.find((p) => p.key === 'v1.0')?.count).toBe(2);
    expect(byVersion.find((p) => p.key === 'v2.0')?.avgScore).toBe(100);

    expect(tracker.trend('model').map((p) => p.key)).toEqual(['modelA', 'modelB']);
    expect(tracker.trend('environment', { feature: 'wan3' }).map((p) => p.key)).toEqual(['staging']);
    expect(tracker.trend('feature').map((p) => p.key)).toEqual(['chat', 'wan3']);
    // 周趋势键形如 2026-W33
    expect(tracker.trend('week')[0].key).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('save/load 往返一致；损坏文件降级为空', () => {
    const file = tmpFile('quality.json');
    const tracker = createQualityTracker();
    tracker.record({ feature: 'wan3', metrics: { coverage: 1 } });
    tracker.save(file);
    expect(QualityTracker.load(file).list()).toHaveLength(1);

    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, '{invalid', 'utf-8');
    expect(QualityTracker.load(bad).list()).toHaveLength(0);
  });
});

describe('FlakyLifecycle 状态机', () => {
  it('完整循环：STABLE→SUSPECTED→FLAKY→QUARANTINED→FIXED→STABLE', () => {
    const lc = createFlakyLifecycle();
    expect(lc.status('c1')).toBe('STABLE');

    let events = lc.recordRun('c1', false);
    expect(events[0]).toMatchObject({ from: 'STABLE', to: 'SUSPECTED' });

    events = lc.recordRun('c1', false);
    expect(events[0]).toMatchObject({ from: 'SUSPECTED', to: 'FLAKY' });

    events = lc.recordRun('c1', false);
    expect(events[0]).toMatchObject({ from: 'FLAKY', to: 'QUARANTINED' });

    // 隔离期连续通过 3 次 → FIXED（中途失败重置计数）
    lc.recordRun('c1', true);
    lc.recordRun('c1', true);
    expect(lc.status('c1')).toBe('QUARANTINED');
    lc.recordRun('c1', false); // 重置
    lc.recordRun('c1', true);
    lc.recordRun('c1', true);
    expect(lc.status('c1')).toBe('QUARANTINED');
    events = lc.recordRun('c1', true);
    expect(events[0]).toMatchObject({ from: 'QUARANTINED', to: 'FIXED' });

    // 修复后持续稳定一次 → STABLE
    events = lc.recordRun('c1', true);
    expect(events[0]).toMatchObject({ from: 'FIXED', to: 'STABLE' });
    expect(lc.history('c1')).toHaveLength(5);
  });

  it('SUSPECTED 恢复通过 → STABLE；FIXED 复发 → FLAKY', () => {
    const lc = createFlakyLifecycle();
    lc.recordRun('c2', false);
    expect(lc.status('c2')).toBe('SUSPECTED');
    const events = lc.recordRun('c2', true);
    expect(events[0]).toMatchObject({ from: 'SUSPECTED', to: 'STABLE' });

    // 构造 FIXED 后复发
    lc.recordRun('c3', false);
    lc.recordRun('c3', false);
    lc.recordRun('c3', false); // QUARANTINED
    lc.recordRun('c3', true);
    lc.recordRun('c3', true);
    lc.recordRun('c3', true); // FIXED
    const relapse = lc.recordRun('c3', false);
    expect(relapse[0]).toMatchObject({ from: 'FIXED', to: 'FLAKY' });
  });

  it('自定义恢复阈值；手动隔离/标记修复', () => {
    const lc = new FlakyLifecycle({ recoveryThreshold: 2 });
    lc.quarantine('c4');
    expect(lc.status('c4')).toBe('QUARANTINED');
    expect(lc.quarantine('c4')).toBeNull(); // 已隔离

    lc.recordRun('c4', true);
    const events = lc.recordRun('c4', true);
    expect(events[0]).toMatchObject({ from: 'QUARANTINED', to: 'FIXED' });

    expect(lc.markFixed('c-not-exist')).toBeNull(); // STABLE 不能标记修复
    expect(FLAKY_LIFECYCLE_STATUSES).toEqual(['STABLE', 'SUSPECTED', 'FLAKY', 'QUARANTINED', 'FIXED']);
  });

  it('syncFromPassRate：复用 classifyStatus 分类信号', () => {
    const lc = createFlakyLifecycle();
    // 通过率 50% → classifyStatus FLAKY → 进入 FLAKY
    const events = lc.syncFromPassRate('c5', 0.5, 10);
    expect(events[0]).toMatchObject({ from: 'STABLE', to: 'FLAKY' });
    expect(events[0].reason).toContain('FLAKY');

    // SUSPECTED + STABLE 分类 → 恢复
    lc.recordRun('c6', false);
    expect(lc.status('c6')).toBe('SUSPECTED');
    lc.syncFromPassRate('c6', 0.99, 20);
    expect(lc.status('c6')).toBe('STABLE');

    // BROKEN（通过率 0）不属于 Flaky，不改变状态
    lc.syncFromPassRate('c7', 0, 10);
    expect(lc.status('c7')).toBe('STABLE');
  });

  it('summary 汇总状态计数与隔离名单；持久化', () => {
    const lc = createFlakyLifecycle();
    lc.recordRun('a', false);
    lc.recordRun('a', false);
    lc.recordRun('a', false); // a → QUARANTINED
    lc.recordRun('b', false); // b → SUSPECTED

    const summary = lc.summary();
    expect(summary.byStatus.QUARANTINED).toBe(1);
    expect(summary.byStatus.SUSPECTED).toBe(1);
    expect(summary.quarantineIds).toEqual(['a']);
    expect(summary.tracked).toBe(2);

    const file = tmpFile('flaky.json');
    lc.save(file);
    const loaded = FlakyLifecycle.load(file);
    expect(loaded.status('a')).toBe('QUARANTINED');
    expect(loaded.summary().tracked).toBe(2);

    const bad = tmpFile('bad.json');
    fs.writeFileSync(bad, '{invalid', 'utf-8');
    expect(FlakyLifecycle.load(bad).summary().tracked).toBe(0);
  });
});
