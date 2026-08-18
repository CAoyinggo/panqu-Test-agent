// Phase 22.4 Adaptive Test Stopping 单元测试
// 覆盖：任务书场景（Coverage95%+P0 100%+信息增益低 → stop）、P0 失败 → BLOCK 停止、
// 防过早停止、预算上限、环境异常、条件未命中继续、可解释理由与置信度。

import { describe, it, expect } from 'vitest';
import { evaluateStopping } from '../../src/stopping/index.js';

describe('evaluateStopping 停止判定', () => {
  it('任务书场景：Coverage 95% + P0 100% + 新增信息增益 LOW → stop=true', () => {
    const d = evaluateStopping({
      coverage: 0.95,
      riskCoverage: 1,
      p0Coverage: 1,
      infoGain: 0.05,
      remainingCases: ['c-7', 'c-8', 'c-9'],
      executedCases: 23,
    });
    expect(d.stop).toBe(true);
    expect(d.remainingCases).toEqual(['c-7', 'c-8', 'c-9']);
    expect(d.reason).toContain('自动停止');
    expect(d.reason).toContain('覆盖 95%');
    expect(d.reason).toContain('信息增益 5%');
    expect(d.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('P0 失败 → Release BLOCK → 停止（暂停低优先级测试转 RCA）', () => {
    const d = evaluateStopping({
      coverage: 0.6,
      riskCoverage: 0.8,
      p0Coverage: 0.8,
      p0Failed: true,
      executedCases: 10,
    });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('P0 用例失败');
    expect(d.conditions.find((c) => c.name === 'release-block')?.satisfied).toBe(true);
  });

  it('Coverage 达标但 P0 未全覆盖 → 不停止（不能牺牲 P0）', () => {
    const d = evaluateStopping({
      coverage: 0.95,
      riskCoverage: 1,
      p0Coverage: 0.7,
      executedCases: 10,
    });
    expect(d.stop).toBe(false);
    expect(d.reason).toContain('继续执行');
    expect(d.conditions.find((c) => c.name === 'p0-covered')?.satisfied).toBe(false);
  });

  it('防过早停止：已执行数 < 最少执行数 → 即使覆盖达标也继续', () => {
    const d = evaluateStopping({
      coverage: 1,
      riskCoverage: 1,
      p0Coverage: 1,
      executedCases: 1,
    });
    expect(d.stop).toBe(false);
    expect(d.blocks[0]).toContain('防过早停止');
  });

  it('预算接近上限 → 停止', () => {
    const d = evaluateStopping({
      coverage: 0.7,
      riskCoverage: 0.9,
      p0Coverage: 1,
      budgetUsedRatio: 0.95,
      executedCases: 20,
    });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('预算已用 95%');
  });

  it('环境异常 → 停止（不能继续污染结果）', () => {
    const d = evaluateStopping({
      coverage: 0.4,
      riskCoverage: 0.5,
      p0Coverage: 0.5,
      environmentAbnormal: true,
      executedCases: 8,
    });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('环境异常');
  });

  it('条件全部未命中 → 继续执行且给出当前状态', () => {
    const d = evaluateStopping({
      coverage: 0.5,
      riskCoverage: 0.6,
      p0Coverage: 1, // P0 已覆盖，避免走 P0 门禁分支
      infoGain: 0.8,
      budgetUsedRatio: 0.3,
      executedCases: 15,
    });
    expect(d.stop).toBe(false);
    expect(d.reason).toContain('所有停止条件均未满足');
    expect(d.reason).toContain('覆盖 50%');
  });

  it('可解释：输出全部条件评估（含未命中）与 blocks；置信度随命中数增长', () => {
    const partial = evaluateStopping({ coverage: 0.9, riskCoverage: 1, p0Coverage: 1, executedCases: 10 });
    expect(partial.conditions).toHaveLength(7);
    expect(partial.conditions.filter((c) => c.satisfied).length).toBeGreaterThanOrEqual(1);
    const full = evaluateStopping({ coverage: 1, riskCoverage: 1, p0Coverage: 1, infoGain: 0.05, budgetUsedRatio: 0.95, executedCases: 10 });
    expect(full.confidence).toBeGreaterThan(partial.confidence);
    expect(full.confidence).toBeLessThanOrEqual(0.98);
  });

  it('空剩余用例 + 覆盖达标 → 停止；确定性', () => {
    const a = evaluateStopping({ coverage: 0.95, riskCoverage: 1, p0Coverage: 1, executedCases: 10, remainingCases: [] });
    const b = evaluateStopping({ coverage: 0.95, riskCoverage: 1, p0Coverage: 1, executedCases: 10, remainingCases: [] });
    expect(a.stop).toBe(true);
    expect(a).toEqual(b);
  });
});
