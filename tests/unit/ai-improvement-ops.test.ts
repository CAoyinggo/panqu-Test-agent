// Phase 46 / 43.19 + 43.20 + 43.21 + 43.23 + 43.24：AI Release Gate + Change Impact +
// Continuous Evaluation + Benchmark Auto-Expansion + Audit 单元测试
import { describe, it, expect } from 'vitest';
import {
  aiReleaseGate,
  detectRegression,
  computeChangeImpact,
  benchmarkCandidateFromFeedback,
  ImprovementAudit,
  CONTINUOUS_EVAL_SCHEDULES,
} from '../../src/ai-quality/ops.js';

describe('AI Release Gate（43.24）', () => {
  it('Quality + Safety + Cost + Approval 全达标 → PASS', () => {
    const r = aiReleaseGate({ qualityScore: 0.85, accuracy: 0.94, safetyRisk: 0, cost: 0.001, approvalGranted: true });
    expect(r.verdict).toBe('PASS');
  });

  it('未获人工 Approval → BLOCK（禁止 AI 自发布）', () => {
    const r = aiReleaseGate({ qualityScore: 0.85, accuracy: 0.94, safetyRisk: 0, cost: 0.001, approvalGranted: false });
    expect(r.verdict).toBe('BLOCK');
    expect(r.reasons.some((x) => x.includes('Approval'))).toBe(true);
  });

  it('Safety Risk 升高 → BLOCK', () => {
    const r = aiReleaseGate({ qualityScore: 0.7, accuracy: 0.9, safetyRisk: 0.05, cost: 0.001, approvalGranted: true });
    expect(r.verdict).toBe('BLOCK');
  });

  it('Quality 较基线下降 → BLOCK', () => {
    const r = aiReleaseGate({ qualityScore: 0.7, accuracy: 0.9, safetyRisk: 0, cost: 0.001, approvalGranted: true, baselineQualityScore: 0.75 });
    expect(r.verdict).toBe('BLOCK');
  });
});

describe('Continuous Evaluation（43.20）', () => {
  const critical = { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 };

  it('无回归 → PASS', () => {
    const r = detectRegression({ baselineOverall: 0.936, currentOverall: 0.94, baselineCritical: critical, currentCritical: critical });
    expect(r.regression).toBe(false);
    expect(r.verdict).toBe('PASS');
  });

  it('Critical 安全指标上升 → Critical Regression（BLOCK）', () => {
    const r = detectRegression({ baselineOverall: 0.936, currentOverall: 0.94, baselineCritical: critical, currentCritical: { ...critical, falsePass: 1 } });
    expect(r.criticalRegression).toBe(true);
    expect(r.verdict).toBe('BLOCK');
  });

  it('Overall 下降超阈值 → REVIEW', () => {
    const r = detectRegression({ baselineOverall: 0.936, currentOverall: 0.90, baselineCritical: critical, currentCritical: critical, allowDrop: 0.02 });
    expect(r.regression).toBe(true);
    expect(r.verdict).toBe('REVIEW');
  });

  it('Nightly/Weekly/Release 三档定时评测定义存在', () => {
    expect(CONTINUOUS_EVAL_SCHEDULES.map((s) => s.name)).toEqual(['nightly', 'weekly', 'release']);
  });
});

describe('Change Impact（43.23）', () => {
  it('Prompt 变更影响对应领域，建议定向评测', () => {
    const impact = computeChangeImpact({ changeRef: 'prompt-risk-v2', changeType: 'PROMPT', domains: ['RISK', 'RCA'] });
    expect(impact.affectedBenchmarks).toEqual(['RISK_BENCHMARK_v1', 'RCA_BENCHMARK_v1']);
    expect(impact.affectedDomains).toEqual(['RISK', 'RCA']);
    expect(impact.targetedEvaluationSuggested).toBe(true);
  });

  it('未指定领域 → 变更类型推断默认领域', () => {
    const impact = computeChangeImpact({ changeRef: 'tool-x', changeType: 'TOOL' });
    expect(impact.affectedDomains.length).toBeGreaterThan(0);
  });
});

describe('Benchmark Auto-Expansion（43.21）', () => {
  it('真实事件 → PENDING_REVIEW 基准候选（禁止自动并入）', () => {
    const cand = benchmarkCandidateFromFeedback({
      feedbackId: 'fb-1', domain: 'RCA', expected: 'MODEL', actual: 'NETWORK', errors: ['分类不符'],
    });
    expect(cand.status).toBe('PENDING_REVIEW');
    expect(cand.feedbackId).toBe('fb-1');
    expect(cand.domain).toBe('RCA');
  });
});

describe('AI Improvement Audit（43.19）', () => {
  it('完整链路记录：Problem → Proposal → Evaluation → Approval → Activation → Observation → Rollback/Success', () => {
    const audit = new ImprovementAudit(() => '2026-08-20T00:00:00.000Z');
    audit.record({ proposalId: 'imp-1', actor: 'SYSTEM', action: 'CREATED', baseline: '0.9', decision: '生成提案' });
    audit.record({ proposalId: 'imp-1', actor: 'SYSTEM', action: 'EVALUATED', baseline: '0.9', candidate: '0.95', benchmark: 'RISK_BENCHMARK_v1', decision: 'Gate PASS' });
    audit.record({ proposalId: 'imp-1', actor: 'qa-admin', action: 'APPROVED', approvalId: 'apv-1', decision: '人工批准' });
    audit.record({ proposalId: 'imp-1', actor: 'qa-admin', action: 'ACTIVATED', candidate: 'risk-v2', decision: '激活' });
    const recs = audit.list({ proposalId: 'imp-1' });
    expect(recs.length).toBe(4);
    expect(recs.map((r) => r.action)).toEqual(['CREATED', 'EVALUATED', 'APPROVED', 'ACTIVATED']);
    expect(recs[0].id).toMatch(/^aud-/);
    expect(recs[0].timestamp).toBe('2026-08-20T00:00:00.000Z');
  });
});
