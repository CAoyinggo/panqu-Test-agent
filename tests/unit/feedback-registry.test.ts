// Phase 46 / 43.1+43.2+43.3：Feedback Registry + Error Taxonomy 单元测试
import { describe, it, expect } from 'vitest';
import { FeedbackRegistry, deriveErrorTaxonomy, normalizeCreateFeedbackInput } from '../../src/ai-quality/feedback.js';

describe('Feedback Registry（43.1）', () => {
  it('登记统一 AIFeedback，禁止各模块自定义结构', () => {
    const reg = new FeedbackRegistry({ now: () => '2026-08-20T00:00:00.000Z' });
    const fb = reg.add({
      domain: 'RCA',
      prediction: { category: 'NETWORK' },
      actual: { category: 'MODEL' },
      feedbackType: 'INCORRECT',
      source: 'HUMAN',
      channel: 'RCA_VERIFICATION',
      note: 'AI 判 NETWORK，人工确认为 MODEL',
    });
    expect(fb.id).toMatch(/^fb-/);
    expect(fb.domain).toBe('RCA');
    expect(fb.feedbackType).toBe('INCORRECT');
    expect(fb.source).toBe('HUMAN');
    expect(fb.channel).toBe('RCA_VERIFICATION');
    expect(fb.verified).toBe(false);
  });

  it('RCA 验证：AI NETWORK vs Human MODEL → INCORRECT（43.2 示例）', () => {
    const reg = new FeedbackRegistry();
    const fb = reg.add({
      domain: 'RCA', prediction: { category: 'NETWORK' }, actual: { category: 'MODEL' },
      feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'RCA_VERIFICATION',
    });
    expect(deriveErrorTaxonomy(fb)).toBe('WRONG');
  });

  it('人工核验标记 verified + verifiedBy', () => {
    const reg = new FeedbackRegistry({ now: () => '2026-08-20T00:00:00.000Z' });
    const fb = reg.add({
      domain: 'REQUIREMENT', prediction: 'x', actual: 'y', feedbackType: 'PARTIAL', source: 'HUMAN',
    });
    const v = reg.verify(fb.id, 'qa-user', '确认 PARTIAL');
    expect(v.verified).toBe(true);
    expect(v.verifiedBy).toBe('qa-user');
    expect(v.verifiedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('非法输入拒绝（domain / feedbackType / source 校验）', () => {
    const reg = new FeedbackRegistry();
    expect(() => reg.add({ domain: 'NOPE', prediction: 1, actual: 2, feedbackType: 'INCORRECT', source: 'HUMAN' })).toThrow();
    expect(() => reg.add({ domain: 'RCA', prediction: 1, actual: 2, feedbackType: 'FOO', source: 'HUMAN' })).toThrow();
    expect(() => reg.add({ domain: 'RCA', prediction: 1, actual: 2, feedbackType: 'INCORRECT', source: 'LLM' })).toThrow();
  });

  it('过滤与快照', () => {
    const reg = new FeedbackRegistry();
    reg.add({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN' });
    reg.add({ domain: 'RCA', prediction: 1, actual: 2, feedbackType: 'INCORRECT', source: 'EVALUATION' });
    expect(reg.list({ domain: 'RISK' }).length).toBe(1);
    expect(reg.list({ source: 'EVALUATION' }).length).toBe(1);
    expect(reg.snapshot().length).toBe(2);
  });
});

describe('Error Taxonomy（43.3）', () => {
  it('Risk P2 vs P0 → UNDER_PREDICTION', () => {
    const fb = { id: 'fb-t1', domain: 'RISK' as const, prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT' as const, source: 'HUMAN' as const, verified: false, createdAt: '' };
    expect(deriveErrorTaxonomy(fb)).toBe('UNDER_PREDICTION');
  });
  it('Risk P0 vs P2 → OVER_PREDICTION（虚高风险）', () => {
    const fb = { id: 'fb-t2', domain: 'RISK' as const, prediction: 'P0', actual: 'P2', feedbackType: 'INCORRECT' as const, source: 'HUMAN' as const, verified: false, createdAt: '' };
    expect(deriveErrorTaxonomy(fb)).toBe('OVER_PREDICTION');
  });
  it('Release PASS vs BLOCK → UNDER_PREDICTION（漏判发布）', () => {
    const fb = { id: 'fb-t3', domain: 'RELEASE' as const, prediction: 'PASS', actual: 'BLOCK', feedbackType: 'INCORRECT' as const, source: 'HUMAN' as const, verified: false, createdAt: '' };
    expect(deriveErrorTaxonomy(fb)).toBe('UNDER_PREDICTION');
  });
  it('Release BLOCK vs PASS → OVER_PREDICTION', () => {
    const fb = { id: 'fb-t4', domain: 'RELEASE' as const, prediction: 'BLOCK', actual: 'PASS', feedbackType: 'INCORRECT' as const, source: 'HUMAN' as const, verified: false, createdAt: '' };
    expect(deriveErrorTaxonomy(fb)).toBe('OVER_PREDICTION');
  });
  it('UNSAFE / DUPLICATE / MISSING / CORRECT 直接映射', () => {
    const base = { id: 'fb-t5', domain: 'HEALING' as const, prediction: 1, actual: 2, source: 'HUMAN' as const, verified: false, createdAt: '' };
    expect(deriveErrorTaxonomy({ ...base, feedbackType: 'UNSAFE' as const })).toBe('UNSAFE');
    expect(deriveErrorTaxonomy({ ...base, feedbackType: 'DUPLICATE' as const })).toBe('DUPLICATE');
    expect(deriveErrorTaxonomy({ ...base, feedbackType: 'MISSING' as const })).toBe('MISSING');
    expect(deriveErrorTaxonomy({ ...base, feedbackType: 'CORRECT' as const })).toBeNull();
  });
});
