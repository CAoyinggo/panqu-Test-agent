// Phase 22 通用：Exploration Testing 单元测试（任务书十八）
// 覆盖：参数空间组合生成、覆盖缺口、历史失败（高风险）、Budget 上限（maxExplorationCases /
// maxExplorationCost）、Risk 授权门禁、Permission 生产危险门禁、空数据、防组合爆炸、确定性。

import { describe, it, expect } from 'vitest';
import { generateExplorations, explorationBySource } from '../../src/exploration/index.js';

describe('Exploration Testing：生成与门禁', () => {
  it('参数空间组合生成（确定性、排除已有用例）', () => {
    const r = generateExplorations({
      existingCaseIds: [],
      parameterSpace: { resolution: ['1080p', '720p'], duration: ['10s', '30s'] },
      config: { maxExplorationCases: 5 },
    });
    expect(r.selected.length).toBeGreaterThan(0);
    expect(r.selected.every((c) => c.tags.length === 2)).toBe(true);
    expect(explorationBySource(r.selected).parameter).toBe(r.selected.length);
  });

  it('覆盖缺口生成', () => {
    const r = generateExplorations({ existingCaseIds: [], coverageGaps: ['wan3-4k', 'wan4-1080p'] });
    const gaps = r.selected.filter((c) => c.source === 'coverage-gap');
    expect(gaps.length).toBe(2);
    expect(gaps[0].reason).toContain('覆盖缺口');
  });

  it('Budget 上限：maxExplorationCases 达到上限 → 拒绝多余候选并输出原因', () => {
    const r = generateExplorations({
      existingCaseIds: [],
      coverageGaps: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'],
      config: { maxExplorationCases: 3 },
    });
    expect(r.selected.length).toBeLessThanOrEqual(3);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejected.every((c) => c.blockedReason?.includes('预算不足'))).toBe(true);
    expect(r.reason).toContain('maxExplorationCases=3');
  });

  it('Budget 上限：maxExplorationCost 达到上限 → 停止生成', () => {
    const r = generateExplorations({
      existingCaseIds: [],
      coverageGaps: ['g1', 'g2', 'g3', 'g4'],
      config: { maxExplorationCost: 0.7 },
    });
    expect(r.usedCost).toBeLessThanOrEqual(0.7);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejected.some((c) => c.blockedReason?.includes('maxExplorationCost'))).toBe(true);
  });

  it('Risk 门禁：历史失败（高风险）未授权 → 拒绝；授权后通过', () => {
    const input = { existingCaseIds: [], historicalFailures: ['wan3-1080p-10s'] };
    const denied = generateExplorations(input);
    const hist = denied.candidates.find((c) => c.source === 'history')!;
    expect(hist.riskScore).toBeGreaterThanOrEqual(0.5);
    expect(denied.rejected.some((c) => c.source === 'history')).toBe(true);
    expect(denied.rejected[0].blockedReason).toContain('高风险探索需人工授权');

    const approved = generateExplorations({ ...input, approveHighRisk: true });
    expect(approved.selected.some((c) => c.source === 'history')).toBe(true);
  });

  it('Permission 门禁：生产危险动作需授权', () => {
    const r = generateExplorations({
      existingCaseIds: [],
      parameterSpace: { env: ['production'], feature: ['pay'] },
    });
    expect(r.selected.every((c) => !c.tags.some((t) => t.toLowerCase().includes('production')))).toBe(true);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejected.some((c) => c.blockedReason?.includes('生产环境危险动作'))).toBe(true);
  });

  it('空数据：无参数空间/缺口/历史 → 不生成，也不报错', () => {
    const r = generateExplorations({ existingCaseIds: ['x'] });
    expect(r.selected).toEqual([]);
    expect(r.usedCount).toBe(0);
    expect(r.reason).toContain('未生成探索用例');
  });

  it('防组合爆炸：大参数空间被截断到预算内', () => {
    const big: Record<string, string[]> = {};
    for (let i = 0; i < 8; i += 1) big[`p${i}`] = ['a', 'b', 'c'];
    const r = generateExplorations({ existingCaseIds: [], parameterSpace: big, config: { maxExplorationCases: 4 } });
    expect(r.selected.length).toBeLessThanOrEqual(4); // 不超预算
    expect(r.candidates.length).toBeLessThanOrEqual(8); // 生成+拒绝总量有界
  });

  it('确定性：相同输入 → 相同候选', () => {
    const input = { existingCaseIds: [], coverageGaps: ['g1', 'g2'], historicalFailures: ['h1'] };
    expect(generateExplorations(input)).toEqual(generateExplorations(input));
  });
});
