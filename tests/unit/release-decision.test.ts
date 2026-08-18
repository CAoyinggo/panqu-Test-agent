// Phase 22.8 Autonomous Release Decision 单元测试
// 覆盖：三态决策正确性（PASS/BLOCK/REVIEW）、权威 BLOCK 信号、REVIEW 软信号、
// 结构化证据、空数据/历史不足、冲突信号（硬信号优先）、置信度确定性。

import { describe, it, expect } from 'vitest';
import { decideRelease, type ReleaseDecisionInput } from '../../src/release-decision/index.js';

/** 全达标基线输入 */
function baseInput(overrides: Partial<ReleaseDecisionInput> = {}): ReleaseDecisionInput {
  return {
    p0: { total: 4, passed: 4 },
    p1: { total: 10, passed: 10 },
    coverage: 0.95,
    criticalDefects: 0,
    riskLevel: 'LOW',
    failurePrediction: 0.1,
    historicalFailureRate: 0.05,
    modelChange: false,
    environmentAbnormal: false,
    flakyCount: 0,
    knownIssues: 0,
    ...overrides,
  };
}

describe('Autonomous Release Decision：三态决策正确性', () => {
  it('全达标 → PASS（P0 全过 / P1 / Coverage / 无缺陷 / 无风险信号）', () => {
    const r = decideRelease(baseInput());
    expect(r.decision).toBe('PASS');
    expect(r.blockingFactors).toEqual([]);
    expect(r.reasons).toContain('所有发布门禁与风险信号均达标');
    expect(r.recommendedActions).toContain('允许发布');
  });

  it('P0 failure = 1 → BLOCK（任务书二十七）', () => {
    const r = decideRelease(baseInput({ p0: { total: 5, passed: 4 } }));
    expect(r.decision).toBe('BLOCK');
    expect(r.blockingFactors.some((b) => b.includes('P0 全部通过'))).toBe(true);
    expect(r.recommendedActions).toContain('修复 P0 失败用例并重新回归');
  });

  it('Critical Defect > 0 → BLOCK', () => {
    const r = decideRelease(baseInput({ criticalDefects: 2 }));
    expect(r.decision).toBe('BLOCK');
    expect(r.blockingFactors.some((b) => b.includes('Critical Defect'))).toBe(true);
  });

  it('环境异常 → BLOCK', () => {
    const r = decideRelease(baseInput({ environmentAbnormal: true }));
    expect(r.decision).toBe('BLOCK');
    expect(r.blockingFactors.some((b) => b.includes('环境正常'))).toBe(true);
    expect(r.recommendedActions).toContain('修复测试环境后重新验证');
  });

  it('冲突信号：P0 失败 + Coverage 低 → 硬信号优先 BLOCK', () => {
    const r = decideRelease(baseInput({ p0: { total: 4, passed: 3 }, coverage: 0.6 }));
    expect(r.decision).toBe('BLOCK'); // 软信号（Coverage）不降级硬信号
    expect(r.blockingFactors.length).toBe(1); // 仅权威信号进入阻断因素
  });

  it('任务书十四示例：P1 99% / Coverage 94% / Known Issue 1 / Flaky 2 / Risk Moderate → REVIEW', () => {
    const r = decideRelease(baseInput({ p1: { total: 100, passed: 99 }, coverage: 0.94, knownIssues: 1, flakyCount: 2, riskLevel: 'MEDIUM' }));
    expect(r.decision).toBe('REVIEW'); // 不是直接 PASS
    expect(r.blockingFactors).toEqual([]);
    expect(r.reasons.some((x) => x.includes('不稳定用例'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('已知问题'))).toBe(true);
    expect(r.recommendedActions).toContain('隔离不稳定用例并复核');
    expect(r.recommendedActions).toContain('评估已知问题影响面并确认豁免');
  });

  it('Coverage < 90% → REVIEW（软信号，不直接 BLOCK）', () => {
    const r = decideRelease(baseInput({ coverage: 0.85 }));
    expect(r.decision).toBe('REVIEW');
    expect(r.recommendedActions).toContain('补充测试覆盖，提升覆盖率');
  });

  it('P1 通过率不足 → REVIEW', () => {
    const r = decideRelease(baseInput({ p1: { total: 10, passed: 9 } }));
    expect(r.decision).toBe('REVIEW');
    expect(r.recommendedActions).toContain('补充 P1 回归，提升通过率');
  });

  it('模型变更 + 历史失败率高 → REVIEW（变更信号）', () => {
    const r = decideRelease(baseInput({ modelChange: true, historicalFailureRate: 0.4 }));
    expect(r.decision).toBe('REVIEW');
    expect(r.recommendedActions).toContain('对模型变更范围补充回归验证');
    expect(r.recommendedActions).toContain('评估高风险区域并追加针对性测试');
  });
});

describe('Release Decision 必须有证据（任务书十五）', () => {
  it('BLOCK 输出结构化证据数组，禁止无证据决策', () => {
    const r = decideRelease(baseInput({ p0: { total: 5, passed: 4 }, criticalDefects: 2, coverage: 0.91 }));
    expect(r.decision).toBe('BLOCK');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    const byType = (type: string) => r.evidence.find((e) => e.type === type)!;
    expect(byType('p0').value).toBe('4/5 passed');
    expect(byType('critical-defect').value).toBe('2 open');
    expect(byType('coverage').value).toBe('91.0%');
    expect(r.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('PASS 也输出全部信号证据', () => {
    const r = decideRelease(baseInput());
    expect(r.evidence.some((e) => e.type === 'p0' && e.value === '4/4 passed')).toBe(true);
    expect(r.evidence.some((e) => e.type === 'critical-defect' && e.value === '0 open')).toBe(true);
  });
});

describe('边界 / 空数据 / 历史不足', () => {
  it('空数据：无 P0 / 无 P1 运行 → 视为通过 → PASS', () => {
    const r = decideRelease({ p0: { total: 0, passed: 0 }, p1: { total: 0, passed: 0 }, coverage: 1, criticalDefects: 0 });
    expect(r.decision).toBe('PASS');
  });

  it('历史数据不足：无历史失败率/失败预测 → 视为 0 → 不误报', () => {
    const r = decideRelease({ p0: { total: 2, passed: 2 }, p1: { total: 2, passed: 2 }, coverage: 0.95, criticalDefects: 0 });
    expect(r.decision).toBe('PASS');
  });

  it('历史失败率高于阈值 → REVIEW（历史数据参与决策）', () => {
    const r = decideRelease(baseInput({ historicalFailureRate: 0.5 }));
    expect(r.decision).toBe('REVIEW');
  });

  it('边界：Coverage 恰为 90% → PASS（≥ 阈值）', () => {
    const r = decideRelease(baseInput({ coverage: 0.9 }));
    expect(r.decision).toBe('PASS');
  });

  it('边界：P1 通过率恰为 98% → PASS', () => {
    const r = decideRelease(baseInput({ p1: { total: 100, passed: 98 } }));
    expect(r.decision).toBe('PASS');
  });
});

describe('确定性', () => {
  it('相同输入 → 相同决策/置信度/证据（可复现）', () => {
    const input = baseInput({ p0: { total: 3, passed: 2 }, knownIssues: 1 });
    const a = decideRelease(input);
    const b = decideRelease(input);
    expect(a).toEqual(b);
  });

  it('置信度在 0~1 且 BLOCK ≥ REVIEW ≥ PASS 下限合理', () => {
    const blocked = decideRelease(baseInput({ p0: { total: 2, passed: 1 } }));
    const review = decideRelease(baseInput({ knownIssues: 1 }));
    const passed = decideRelease(baseInput());
    expect(blocked.confidence).toBeGreaterThanOrEqual(0.6);
    expect(review.confidence).toBeGreaterThanOrEqual(0.5);
    expect(passed.confidence).toBe(0.85);
    expect(blocked.confidence).toBeLessThanOrEqual(0.98);
  });
});
