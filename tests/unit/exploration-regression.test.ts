// Phase 23.3：Exploration → Regression 接入单元测试
// 覆盖：生命周期状态机（GENERATED→SCREENED→APPROVED→EXECUTED→VALIDATED/REJECTED）、
// 三进门禁（Risk / Budget / Permission）、maxExplorationDuration、
// production 安全（dangerous=DENY、risky=Approval）、接入 Regression Plan、确定性。

import { describe, it, expect } from 'vitest';
import {
  runExplorationPlan,
  screenCandidate,
  classifyPermission,
  advanceExploration,
  DEFAULT_EXPLORATION_CONFIG,
  type ExplorationCandidate,
  type ExplorationLifecycleState,
  type ExplorationGateResult,
} from '../../src/exploration/index.js';

/** 构造一个通过基础门禁的候选 */
function cand(over: Partial<ExplorationCandidate> = {}): ExplorationCandidate {
  return {
    id: 'explore-gap-wan3-4k',
    tags: ['wan3-4k'],
    estimatedCost: 0.3,
    estimatedDurationMs: 20000,
    reason: '覆盖缺口探索（wan3-4k）',
    source: 'coverage-gap',
    riskScore: 0.4,
    approved: true,
    status: 'GENERATED',
    ...over,
  };
}

function passGates(): ExplorationGateResult {
  return { riskGate: 'pass', budgetGate: 'pass', permissionGate: 'pass', canExecute: true, reasons: [] };
}

describe('生命周期状态机（任务书六 / 23.3）', () => {
  it('完整链：GENERATED → SCREENED → APPROVED → EXECUTED → VALIDATED', () => {
    const base: ExplorationLifecycleState = {
      candidateId: 'c1',
      status: 'GENERATED',
      gates: passGates(),
      permission: 'safe',
      timestamp: 't0',
    };
    const s = advanceExploration(base, 'SCREENED');
    expect(s.status).toBe('SCREENED');
    const a = advanceExploration(s, 'APPROVED');
    expect(a.status).toBe('APPROVED');
    const e = advanceExploration(a, 'EXECUTED');
    expect(e.status).toBe('EXECUTED');
    const v = advanceExploration(e, 'VALIDATED');
    expect(v.status).toBe('VALIDATED');
  });

  it('失败链：任意状态 → REJECTED；非法转移抛错', () => {
    const base: ExplorationLifecycleState = {
      candidateId: 'c2',
      status: 'GENERATED',
      gates: passGates(),
      permission: 'safe',
      timestamp: 't0',
    };
    const rejected = advanceExploration(base, 'REJECTED');
    expect(rejected.status).toBe('REJECTED');
    // 非法转移：GENERATED 直接 → EXECUTED 抛错
    expect(() => advanceExploration(base, 'EXECUTED')).toThrow(/非法探索生命周期转移/);
    // REJECTED 不可再推进
    expect(() => advanceExploration(rejected, 'APPROVED')).toThrow(/非法探索生命周期转移/);
  });
});

describe('三进门禁（任务书六 / 23.3）', () => {
  it('Risk Gate：高风险未授权 → block；授权 → pass', () => {
    const high = cand({ riskScore: 0.7, source: 'history' });
    const ctx = { environment: 'test', approveHighRisk: false, approveProduction: false, usedCount: 0, usedCost: 0, usedDuration: 0, config: DEFAULT_EXPLORATION_CONFIG };
    const blocked = screenCandidate(high, ctx);
    expect(blocked.riskGate).toBe('block');
    expect(blocked.canExecute).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('Risk 门禁'))).toBe(true);

    const allowed = screenCandidate(high, { ...ctx, approveHighRisk: true });
    expect(allowed.riskGate).toBe('pass');
    expect(allowed.canExecute).toBe(true);
  });

  it('Budget Gate：maxExplorationCases / maxExplorationCost / maxExplorationDuration 超限 → block', () => {
    const base = cand();
    // count 超限
    const countBlock = screenCandidate(base, {
      environment: 'test', approveHighRisk: true, approveProduction: false,
      usedCount: DEFAULT_EXPLORATION_CONFIG.maxExplorationCases, usedCost: 0, usedDuration: 0,
      config: DEFAULT_EXPLORATION_CONFIG,
    });
    expect(countBlock.budgetGate).toBe('block');
    expect(countBlock.reasons.some((r) => r.includes('maxExplorationCases'))).toBe(true);
    // duration 超限
    const durBlock = screenCandidate(base, {
      environment: 'test', approveHighRisk: true, approveProduction: false,
      usedCount: 0, usedCost: 0, usedDuration: DEFAULT_EXPLORATION_CONFIG.maxExplorationDuration,
      config: DEFAULT_EXPLORATION_CONFIG,
    });
    expect(durBlock.budgetGate).toBe('block');
    expect(durBlock.reasons.some((r) => r.includes('maxExplorationDuration'))).toBe(true);
  });

  it('Permission Gate：production → dangerous=DENY（即使授权也拒绝）', () => {
    const dangerous = cand({ tags: ['run-production'], riskScore: 0.1 });
    const blocked = screenCandidate(dangerous, {
      environment: 'production', approveHighRisk: true, approveProduction: true,
      usedCount: 0, usedCost: 0, usedDuration: 0, config: DEFAULT_EXPLORATION_CONFIG,
    });
    expect(blocked.permissionGate).toBe('block');
    expect(blocked.canExecute).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('DENY'))).toBe(true);
    expect(classifyPermission(dangerous)).toBe('dangerous');
  });

  it('Permission Gate：非生产 dangerous → 需 approveProduction；未授权 → block', () => {
    const dangerous = cand({ tags: ['payment'], riskScore: 0.1 });
    const denied = screenCandidate(dangerous, {
      environment: 'test', approveHighRisk: true, approveProduction: false,
      usedCount: 0, usedCost: 0, usedDuration: 0, config: DEFAULT_EXPLORATION_CONFIG,
    });
    expect(denied.permissionGate).toBe('block');
    expect(denied.reasons.some((r) => r.includes('危险动作'))).toBe(true);

    const allowed = screenCandidate(dangerous, {
      environment: 'test', approveHighRisk: true, approveProduction: true,
      usedCount: 0, usedCost: 0, usedDuration: 0, config: DEFAULT_EXPLORATION_CONFIG,
    });
    expect(allowed.permissionGate).toBe('pass');
    expect(allowed.canExecute).toBe(true);
  });

  it('权限分类：coverage-gap→safe、history/risk≥0.5→risky、危险标签→dangerous', () => {
    expect(classifyPermission(cand({ tags: ['wan3-4k'], riskScore: 0.4 }))).toBe('safe');
    expect(classifyPermission(cand({ source: 'history', riskScore: 0.7 }))).toBe('risky');
    expect(classifyPermission(cand({ tags: ['billing'] }))).toBe('dangerous');
  });
});

describe('runExplorationPlan（接入 Regression Plan）', () => {
  it('覆盖缺口触发探索 → 通过门禁的候选可加入 Regression Plan', () => {
    const plan = runExplorationPlan({
      existingCaseIds: [],
      coverageGaps: ['wan3-4k', 'wan4-1080p'],
      environment: 'test',
      approveHighRisk: true,
    });
    expect(plan.canAddToRegression).toBe(true);
    expect(plan.screened.length).toBeGreaterThan(0);
    expect(plan.screened[0].status).toBe('SCREENED');
    expect(plan.screened[0].approved).toBe(true);
    expect(plan.lifecycle.every((l) => ['SCREENED', 'REJECTED'].includes(l.status))).toBe(true);
    expect(plan.budget.usedCount).toBe(plan.screened.length);
    expect(plan.evidence.some((e) => e.includes('可加入 Regression Plan'))).toBe(true);
  });

  it('历史失败未授权 → Risk 门禁拒绝，不加入 Regression', () => {
    const plan = runExplorationPlan({
      existingCaseIds: [],
      historicalFailures: ['wan3-1080p-10s'],
      environment: 'test',
      approveHighRisk: false,
    });
    expect(plan.canAddToRegression).toBe(false);
    expect(plan.screened.length).toBe(0);
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.rejected[0].status).toBe('REJECTED');
    expect(plan.rejected[0].blockedReason).toContain('高风险');
  });

  it('Budget 门禁：maxExplorationDuration 超限 → 拒绝并记录原因', () => {
    const plan = runExplorationPlan({
      existingCaseIds: [],
      coverageGaps: ['g1', 'g2'],
      environment: 'test',
      approveHighRisk: true,
      config: { maxExplorationDuration: 1000 }, // 每个候选 20000ms → 全部超限
    });
    expect(plan.canAddToRegression).toBe(false);
    expect(plan.screened.length).toBe(0);
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.rejected[0].blockedReason).toContain('maxExplorationDuration');
  });

  it('production 安全：自治模式不改变安全策略（dangerous 候选 DENY）', () => {
    const plan = runExplorationPlan({
      existingCaseIds: [],
      parameterSpace: { env: ['production'], feature: ['pay'] },
      environment: 'production',
      approveHighRisk: true,
      approveProduction: true, // 即使授权，production dangerous 仍 DENY
    });
    expect(plan.screened.length).toBe(0);
    expect(plan.rejected.length).toBeGreaterThan(0);
    expect(plan.evidence.some((e) => e.includes('未改变安全策略'))).toBe(true);
  });

  it('确定性：相同输入产生相同计划', () => {
    const input = {
      existingCaseIds: [],
      coverageGaps: ['wan3-4k'],
      historicalFailures: ['h1'],
      environment: 'test',
      approveHighRisk: true,
    };
    const a = runExplorationPlan(input);
    const b = runExplorationPlan(input);
    expect(a.screened.map((c) => c.id)).toEqual(b.screened.map((c) => c.id));
    expect(a.rejected.map((c) => c.id)).toEqual(b.rejected.map((c) => c.id));
  });
});
