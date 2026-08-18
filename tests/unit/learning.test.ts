// Phase 22.7 Continuous Learning 单元测试
// 覆盖：Knowledge Weight Decay 锚点（30 天 0.9 / 60 天 0.7 / 90 天 0.4）、
// 连续 PASS → failureRate/confidence/riskWeight/priority 下降、
// 连续失败 → 上升、新证据重新验证（decay 重置）、Selection Update 闭环、空数据。

import { describe, it, expect } from 'vitest';
import {
  weightDecay,
  suggestedPriority,
  createLearningState,
  applyEvidence,
  decayLearningState,
  ContinuousLearner,
  DEFAULT_LEARNING_CONFIG,
  type LearningState,
} from '../../src/learning/index.js';

const DAY = 86400000;
const NOW = new Date('2026-08-01T00:00:00Z').getTime();

/** 构造学习状态 */
function makeState(overrides: Partial<LearningState>): LearningState {
  return {
    ...createLearningState('k'),
    runs: 30,
    failures: 3,
    failureRate: 0.1,
    recentRate: 0,
    confidence: 0.3,
    riskWeight: 0.03,
    decay: 1,
    priority: 'P3',
    consecutivePasses: 0,
    consecutiveFailures: 0,
    lastResult: undefined,
    lastEvidenceAt: new Date(NOW).toISOString(),
    lastUpdatedAt: new Date(NOW).toISOString(),
    evidence: [],
    recent: Array.from({ length: 20 }, () => true),
    ...overrides,
  };
}

describe('Knowledge Weight Decay（任务书十三）', () => {
  it('锚点：30 天 0.9 / 60 天 0.7 / 90 天 0.4，0 天为 1', () => {
    expect(weightDecay(0)).toBe(1);
    expect(weightDecay(29)).toBe(1);
    expect(weightDecay(30)).toBe(0.9);
    expect(weightDecay(45)).toBe(0.9);
    expect(weightDecay(60)).toBe(0.7);
    expect(weightDecay(75)).toBe(0.7);
    expect(weightDecay(90)).toBe(0.4);
    // 90 天后继续衰减但保留最小权重
    expect(weightDecay(120)).toBeLessThan(0.4);
    expect(weightDecay(120)).toBeGreaterThanOrEqual(DEFAULT_LEARNING_CONFIG.minDecay);
  });

  it('无新证据：30/60/90 天权重按锚点下降，优先级可能降级', () => {
    const base = makeState({ riskWeight: 0.5, confidence: 0.8, priority: 'P1' });
    const d30 = decayLearningState(base, NOW + 30 * DAY, DEFAULT_LEARNING_CONFIG);
    expect(d30.decay).toBe(0.9);
    expect(d30.riskWeight).toBeCloseTo(0.45, 3);
    expect(d30.confidence).toBeCloseTo(0.72, 3);

    const d60 = decayLearningState(base, NOW + 60 * DAY, DEFAULT_LEARNING_CONFIG);
    expect(d60.decay).toBe(0.7);
    expect(d60.riskWeight).toBeCloseTo(0.35, 3);

    const d90 = decayLearningState(base, NOW + 90 * DAY, DEFAULT_LEARNING_CONFIG);
    expect(d90.decay).toBe(0.4);
    expect(d90.riskWeight).toBeCloseTo(0.2, 3);
    // 0.2 仍 ≥ 0.15 → P2
    expect(d90.priority).toBe('P2');

    // 更久（200 天）→ 权重继续衰减，可能降级
    const d200 = decayLearningState(base, NOW + 200 * DAY, DEFAULT_LEARNING_CONFIG);
    expect(d200.riskWeight).toBeLessThan(0.2);
  });
});

describe('执行结果自动改变知识权重（任务书十二）', () => {
  it('高风险知识连续 20 次 PASS → failureRate ↓ / confidence ↓ / riskWeight ↓ / priority ↓', () => {
    const risky = makeState({
      key: '1080p-10s',
      runs: 30,
      failures: 11,
      failureRate: 0.367,
      recentRate: 0.75,
      confidence: 0.825,
      riskWeight: 0.303,
      priority: 'P2',
      lastResult: 'FAIL',
      recent: Array.from({ length: 20 }, (_, i) => i < 5), // 15 失败 5 通过
    });
    let s = risky;
    for (let i = 0; i < 20; i += 1) s = applyEvidence(s, true, DEFAULT_LEARNING_CONFIG, NOW + i * DAY);
    expect(s.failureRate).toBeLessThan(risky.failureRate); // 0.22 < 0.367
    expect(s.confidence).toBeLessThan(risky.confidence); // 0.3 < 0.825
    expect(s.riskWeight).toBeLessThan(risky.riskWeight);
    expect(s.priority).toBe('P3'); // 降级
    expect(s.consecutivePasses).toBe(20);
    expect(s.lastResult).toBe('PASS');
  });

  it('连续失败 → failureRate ↑ / confidence ↑ / riskWeight ↑ / priority ↑', () => {
    // 使用 recentWindow=5：连续 5 次失败使 recentRate=1 → confidence=1 → riskWeight=failureRate=0.229 → P2
    const config = { ...DEFAULT_LEARNING_CONFIG, recentWindow: 5 };
    const calm = makeState({});
    let s = calm;
    for (let i = 0; i < 5; i += 1) s = applyEvidence(s, false, config, NOW + i * DAY);
    expect(s.failureRate).toBeGreaterThan(calm.failureRate); // 0.229 > 0.1
    expect(s.confidence).toBeGreaterThan(calm.confidence); // 1.0 > 0.3
    expect(s.riskWeight).toBeGreaterThan(calm.riskWeight);
    expect(s.priority).toBe('P2'); // 0.229 ≥ 0.15 → 升级
    expect(s.consecutiveFailures).toBe(5);
    expect(s.lastResult).toBe('FAIL');
  });

  it('新证据重新验证：decay 重置为 1', () => {
    const base = makeState({ riskWeight: 0.5, confidence: 0.8, priority: 'P1' });
    const decayed = decayLearningState(base, NOW + 90 * DAY, DEFAULT_LEARNING_CONFIG);
    expect(decayed.decay).toBe(0.4);
    // 新证据到达 → 重新计算，decay 回到 1
    const refreshed = applyEvidence(decayed, true, DEFAULT_LEARNING_CONFIG, NOW + 90 * DAY + 1000);
    expect(refreshed.decay).toBe(1);
  });
});

describe('ContinuousLearner（Execution → Knowledge → Risk → Selection 闭环）', () => {
  it('批量学习 + 状态查询', () => {
    const learner = new ContinuousLearner(DEFAULT_LEARNING_CONFIG);
    const updates = learner.learn(
      [
        { key: 'case-a', passed: false },
        { key: 'case-b', passed: true },
      ],
      NOW,
    );
    expect(updates.length).toBe(2);
    const a = learner.state('case-a')!;
    expect(a.runs).toBe(1);
    expect(a.failures).toBe(1);
    expect(a.failureRate).toBe(1);
    expect(a.riskWeight).toBe(1);
    expect(a.priority).toBe('P0');
    const b = learner.state('case-b')!;
    expect(b.failureRate).toBe(0);
    expect(updates[0].deltas.some((d) => d.includes('failureRate'))).toBe(true);
  });

  it('Selection Update：学习结果提升用例优先级；P0 不降级；无状态用例不受影响', () => {
    const learner = new ContinuousLearner(DEFAULT_LEARNING_CONFIG);
    // case-a 失败 → 高风险；case-p0 通过 → 低风险但原 P0 不降级
    learner.learn(
      [
        { key: 'case-a', passed: false },
        { key: 'case-p0', passed: true },
      ],
      NOW,
    );
    const applied = learner.applyToCases([
      { caseId: 'case-a', priority: 'P2', riskScore: 0 },
      { caseId: 'case-p0', priority: 'P0', riskScore: 0.2 },
      { caseId: 'case-untracked', priority: 'P1', riskScore: 0 },
    ]);
    expect(applied.length).toBe(2);
    const a = applied.find((x) => x.caseId === 'case-a')!;
    expect(a.priority).toBe('P0'); // P2 → P0 提升
    expect(a.riskScore).toBeGreaterThan(0);
    const p0 = applied.find((x) => x.caseId === 'case-p0')!;
    expect(p0.priority).toBe('P0'); // P0 不降级
    expect(applied.some((x) => x.caseId === 'case-untracked')).toBe(false);
  });

  it('decayAll：全部状态按时间衰减；空学习器返回空数组', () => {
    const learner = new ContinuousLearner(DEFAULT_LEARNING_CONFIG);
    expect(learner.decayAll(NOW)).toEqual([]);
    expect(learner.applyToCases([{ caseId: 'x', priority: 'P1' }])).toEqual([]);
    expect(learner.entries()).toEqual([]);

    learner.learn([{ key: 'case-a', passed: false }], NOW);
    const decays = learner.decayAll(NOW + 30 * DAY);
    expect(decays.length).toBe(1);
    expect(decays[0].kind).toBe('decay');
    expect(decays[0].after.riskWeight).toBeLessThan(decays[0].before.riskWeight);
  });

  it('toKnowledgeInputs：产出 risk-insight 知识条目（供 KnowledgeStore 沉淀）', () => {
    const learner = new ContinuousLearner(DEFAULT_LEARNING_CONFIG);
    learner.learn([{ key: '1080p-10s', passed: false }], NOW);
    const inputs = learner.toKnowledgeInputs('wan3');
    expect(inputs.length).toBe(1);
    expect(inputs[0].type).toBe('risk-insight');
    expect(inputs[0].stats).toEqual({ runs: 1, failures: 1 });
    expect(inputs[0].tags).toContain('1080p-10s');
  });
});

describe('建议优先级阈值（确定性）', () => {
  it('riskWeight 阈值 → P0/P1/P2/P3', () => {
    expect(suggestedPriority(0.7)).toBe('P0');
    expect(suggestedPriority(0.5)).toBe('P1');
    expect(suggestedPriority(0.2)).toBe('P2');
    expect(suggestedPriority(0.1)).toBe('P3');
  });
});
