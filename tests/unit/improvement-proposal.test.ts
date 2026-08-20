// Phase 46 / 43.5 + 43.6 + 43.11：Improvement Proposal + Gate 单元测试
import { describe, it, expect } from 'vitest';
import { ProposalStore, proposalFromCluster, runImprovementGate, targetForCluster, riskForCluster } from '../../src/ai-quality/improvement.js';
import type { ErrorCluster, ImprovementProposal } from '../../src/ai-quality/contract.js';

function makeCluster(domain: string, category: ErrorCluster['category'], count: number): ErrorCluster {
  return {
    id: 'ec-1', domain: domain as ErrorCluster['domain'], category, count,
    cases: ['c1', 'c2'], evidence: [], createdAt: '2026-08-20T00:00:00.000Z', lastSeenAt: '2026-08-20T00:00:00.000Z',
  };
}

describe('Improvement Proposal（43.5）', () => {
  it('从 ErrorCluster 自动生成提案', () => {
    const cluster = makeCluster('RISK', 'UNDER_PREDICTION', 5);
    const p = proposalFromCluster(cluster);
    expect(p.status).toBe('PROPOSED');
    expect(p.target).toBe('RULE');
    expect(p.risk).toBe('MEDIUM');
    expect(p.problem).toContain('RISK');
    expect(p.evidence).toEqual(cluster.evidence);
  });

  it('UNSAFE 聚类 → RULE + HIGH（安全红线）', () => {
    const cluster = makeCluster('HEALING', 'UNSAFE', 1);
    const p = proposalFromCluster(cluster);
    expect(p.target).toBe('RULE');
    expect(p.risk).toBe('HIGH');
  });

  it('MISSING 聚类 → PROMPT', () => {
    expect(targetForCluster(makeCluster('REQUIREMENT', 'MISSING', 2))).toBe('PROMPT');
  });
});

describe('Improvement Gate（43.6 + 43.11）', () => {
  it('Critical Safety 红线：False Pass 增加 → BLOCK', () => {
    const g = runImprovementGate({ baselineScore: 0.9, candidateScore: 0.95, critical: { falsePass: 1, unsafeHealing: 0, p0Miss: 0 } });
    expect(g.verdict).toBe('BLOCK');
    expect(g.reasons.some((r) => r.includes('False Pass'))).toBe(true);
  });

  it('Unsafe Healing 增加 → BLOCK', () => {
    const g = runImprovementGate({ baselineScore: 0.9, candidateScore: 0.95, critical: { falsePass: 0, unsafeHealing: 2, p0Miss: 0 } });
    expect(g.verdict).toBe('BLOCK');
  });

  it('Critical Accuracy 下降 → BLOCK', () => {
    const g = runImprovementGate({ baselineScore: 0.9, candidateScore: 0.85, critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 } });
    expect(g.verdict).toBe('BLOCK');
  });

  it('持平提升未达阈值 → REVIEW', () => {
    const g = runImprovementGate({ baselineScore: 0.9, candidateScore: 0.905, critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 }, qualityDelta: 0.02 });
    expect(g.verdict).toBe('REVIEW');
  });

  it('达标 → PASS', () => {
    const g = runImprovementGate({ baselineScore: 0.9, candidateScore: 0.95, critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 }, qualityDelta: 0.02 });
    expect(g.verdict).toBe('PASS');
  });
});

describe('Proposal 生命周期（43.6 离线评测 → 43.x 人工审批）', () => {
  it('PROPOSED → EVALUATING（Gate PASS）→ APPROVED → ACTIVATED', () => {
    const store = new ProposalStore({ now: () => '2026-08-20T00:00:00.000Z' });
    const p = store.create({ target: 'PROMPT', problem: '问题', hypothesis: '假设', expectedImprovement: '提升', risk: 'LOW' });
    expect(p.status).toBe('PROPOSED');

    const evaled = store.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.95, benchmark: 'RISK_BENCHMARK_v1', benchmarkVersion: 'v1', critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 } });
    expect(evaled.status).toBe('EVALUATING');
    expect(evaled.gateVerdict).toBe('PASS');
    expect(evaled.candidateScore).toBe(0.95);

    const approved = store.approve(p.id, 'qa-admin');
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('qa-admin');
    expect(approved.approvalId).toBeTruthy();

    const activated = store.activate(p.id, 'qa-admin', 'exp-1');
    expect(activated.status).toBe('ACTIVATED');
    expect(activated.experimentId).toBe('exp-1');
  });

  it('Gate BLOCK 的提案不可审批', () => {
    const store = new ProposalStore();
    const p = store.create({ target: 'RULE', problem: 'p', hypothesis: 'h', expectedImprovement: 'e', risk: 'HIGH' });
    store.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.85, benchmark: 'B', benchmarkVersion: 'v1', critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 } });
    expect(p.status).toBe('REJECTED');
    expect(() => store.approve(p.id, 'qa')).toThrow();
  });

  it('未审批禁止激活；人工 reject', () => {
    const store = new ProposalStore();
    const p = store.create({ target: 'RULE', problem: 'p', hypothesis: 'h', expectedImprovement: 'e', risk: 'LOW' });
    expect(() => store.activate(p.id, 'qa')).toThrow();
    store.reject(p.id, 'qa', '风险过高');
    expect(p.status).toBe('REJECTED');
    expect(p.rejectedReason).toBe('风险过高');
  });

  it('回滚（43.12）', () => {
    const store = new ProposalStore();
    const p = store.create({ target: 'RULE', problem: 'p', hypothesis: 'h', expectedImprovement: 'e', risk: 'LOW' });
    store.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.95, benchmark: 'B', benchmarkVersion: 'v1' });
    store.approve(p.id, 'qa');
    store.activate(p.id, 'qa');
    const rb = store.rollback(p.id, '生产观测精度下降');
    expect(rb.status).toBe('ROLLED_BACK');
  });
});
