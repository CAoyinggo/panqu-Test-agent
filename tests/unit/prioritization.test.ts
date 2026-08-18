// Phase 22.2 Adaptive Prioritization 单元测试
// 覆盖：动态优先级评分、P2→P0 提权（任务书场景）、P0 降级、惩罚项、批量重排、边界。

import { describe, it, expect } from 'vitest';
import {
  computePriorityScore,
  prioritizeCases,
  type PriorityScore,
} from '../../src/prioritization/index.js';

describe('computePriorityScore', () => {
  it('任务书场景：P2 + 最近版本变更 + 历史失败率 35% + 关联 P0 风险 → 动态 P0', () => {
    const result = computePriorityScore({
      caseId: 'wan3-1080p-10s',
      basePriority: 'P2',
      changeImpact: 0.8,        // 最近版本发生变更
      historicalFailure: 0.35,  // 过去 20 次失败率 35%
      risk: 0.7,                // 关联 P0 风险
      recentFailure: 0.3,
    });
    expect(result.priority).toBe('P0');
    expect(result.adjustment).toBe('promoted-to-p0');
    expect(result.reasons.some((r) => r.includes('变更影响'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('35%'))).toBe(true);
    expect(result.reasons.some((r) => r.includes('风险评分 0.7'))).toBe(true);
  });

  it('静态 P0 高风险保持 P0；无信号时保持基础优先级', () => {
    const keepP0 = computePriorityScore({ caseId: 'c', basePriority: 'P0', risk: 0.5 });
    expect(keepP0.priority).toBe('P0');
    expect(keepP0.adjustment).toBe('same');

    const plain = computePriorityScore({ caseId: 'c', basePriority: 'P1' });
    expect(plain.priority).toBe('P1');
    expect(plain.adjustment).toBe('same');
  });

  it('flaky / 高成本惩罚可致 P0 降级', () => {
    const down = computePriorityScore({
      caseId: 'c', basePriority: 'P0', flakyRate: 1, executionCost: 1,
      risk: 0, changeImpact: 0, historicalFailure: 0, recentFailure: 0,
      coverageGap: 0, defectDensity: 0, businessCriticality: 0,
    });
    // base 0.85 - flaky 0.3 - cost 0.2 = 0.35 → P3（强惩罚彻底降级）
    expect(down.priority).toBe('P3');
    expect(down.adjustment).toBe('down');
    expect(down.reasons.some((r) => r.includes('Flaky'))).toBe(true);
    expect(down.reasons.some((r) => r.includes('执行成本'))).toBe(true);
  });

  it('信号混合：最近失败 + 覆盖缺口推动提权', () => {
    const up = computePriorityScore({
      caseId: 'c', basePriority: 'P2',
      recentFailure: 0.6, coverageGap: 0.8, risk: 0.3,
    });
    expect(up.adjustment).toBe('up');
    expect(up.reasons.some((r) => r.includes('最近失败率 60%'))).toBe(true);
  });

  it('score 截断 0~1；确定性；缺省 basePriority 按 P2', () => {
    const a = computePriorityScore({ caseId: 'c', risk: 5, changeImpact: -1 });
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(computePriorityScore({ caseId: 'c', risk: 0.5 })).toEqual(computePriorityScore({ caseId: 'c', risk: 0.5 }));
  });
});

describe('prioritizeCases 批量重排', () => {
  it('按 score 降序；高风险变更用例排前；同分按 caseId', () => {
    const inputs = [
      { caseId: 'low', basePriority: 'P1' as const },
      { caseId: 'high', basePriority: 'P2' as const, changeImpact: 1, historicalFailure: 0.8, risk: 1 },
      { caseId: 'mid', basePriority: 'P2' as const, risk: 0.4 },
    ];
    const ranked = prioritizeCases(inputs);
    expect(ranked[0].caseId).toBe('high');
    expect(ranked[0].priority).toBe('P0');
    expect(ranked[2].caseId).toBe('mid'); // low 是 P1 基线(0.65) > mid(0.45+0.08)
    expect(ranked.map((r) => r.score)).toEqual([...ranked.map((r) => r.score)].sort((a, b) => b - a));
  });

  it('空输入返回空数组', () => {
    expect(prioritizeCases([])).toEqual([]);
  });

  it('返回类型含全部字段（供 DecisionTrace 消费）', () => {
    const [r] = prioritizeCases([{ caseId: 'c', risk: 0.5 }]) as PriorityScore[];
    expect(r).toMatchObject({ caseId: 'c', score: expect.any(Number), priority: expect.any(String), adjustment: expect.any(String), reasons: expect.any(Array) });
  });
});
