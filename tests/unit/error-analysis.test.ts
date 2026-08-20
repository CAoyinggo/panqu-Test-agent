// Phase 46 / 43.4：Error Analysis（自动错误聚类）单元测试
import { describe, it, expect } from 'vitest';
import { analyzeErrors, classifyEvalResult } from '../../src/ai-quality/error-analysis.js';
import { FeedbackRegistry } from '../../src/ai-quality/feedback.js';
import type { EvaluationResult } from '../../src/eval/contract.js';

describe('Error Analysis（43.4）', () => {
  it('从 Feedback 自动聚类（domain + taxonomy）', () => {
    const reg = new FeedbackRegistry({ now: () => '2026-08-20T00:00:00.000Z' });
    reg.add({ domain: 'RCA', prediction: { category: 'NETWORK' }, actual: { category: 'MODEL' }, feedbackType: 'INCORRECT', source: 'HUMAN', caseId: 'rca-1' });
    reg.add({ domain: 'RCA', prediction: { category: 'TIMEOUT' }, actual: { category: 'DATA' }, feedbackType: 'INCORRECT', source: 'HUMAN', caseId: 'rca-2' });
    reg.add({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', caseId: 'risk-3' });

    const clusters = analyzeErrors({ feedback: reg.list() });
    expect(clusters.length).toBe(2);
    const rca = clusters.find((c) => c.domain === 'RCA');
    expect(rca?.category).toBe('WRONG');
    expect(rca?.count).toBe(2);
    expect(rca?.cases).toEqual(['rca-1', 'rca-2']);
    expect(rca?.suspectedCause).toBeTruthy();
    const risk = clusters.find((c) => c.domain === 'RISK');
    expect(risk?.category).toBe('UNDER_PREDICTION');
    expect(risk?.count).toBe(1);
  });

  it('聚类按 count 降序', () => {
    const reg = new FeedbackRegistry();
    for (let i = 0; i < 5; i++) {
      reg.add({ domain: 'RCA', prediction: 'x', actual: 'y', feedbackType: 'INCORRECT', source: 'HUMAN' });
    }
    reg.add({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN' });
    const clusters = analyzeErrors({ feedback: reg.list() });
    expect(clusters[0].count).toBe(5);
    expect(clusters[0].domain).toBe('RCA');
  });

  it('忽略 CORRECT 反馈（无错误不聚类）', () => {
    const reg = new FeedbackRegistry();
    reg.add({ domain: 'RCA', prediction: 'x', actual: 'x', feedbackType: 'CORRECT', source: 'HUMAN' });
    expect(analyzeErrors({ feedback: reg.list() }).length).toBe(0);
  });

  it('从评测失败结果聚类', () => {
    const fail: EvaluationResult = {
      caseId: 'c1', domain: 'RISK', score: 0, passed: false, tracked: true,
      expected: 'P0', actual: 'P2', errors: ['Critical Miss: 漏判 P0 风险'],
    };
    const clusters = analyzeErrors({ evalFailures: [{ result: fail, benchmark: 'RISK_BENCHMARK_v1' }] });
    expect(clusters.length).toBe(1);
    expect(clusters[0].category).toBe('UNDER_PREDICTION');
    expect(clusters[0].evidence.some((e) => (e as { kind?: string }).kind === 'eval')).toBe(true);
  });

  it('classifyEvalResult 安全类判定', () => {
    const r: EvaluationResult = { caseId: 'h1', domain: 'HEALING', score: 0, passed: false, tracked: true, expected: 'x', actual: 'y', errors: ['DANGEROUS: 掩盖真实 Bug'] };
    expect(classifyEvalResult(r)).toBe('UNSAFE');
  });
});
