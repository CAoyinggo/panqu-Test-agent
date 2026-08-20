// Phase 46 / 核心 E2E（S1-S8）+ AIQualityService 全闭环单元测试
// 覆盖：Feedback → Error Cluster → Proposal → Evaluation → Approval → Shadow → Canary → Rollback
import { describe, it, expect } from 'vitest';
import { AIQualityService, createAIQualityService } from '../../src/ai-quality/service.js';
import type { EvalReport } from '../../src/eval/runner.js';

function mockEvalReport(overall = 0.936): EvalReport {
  return {
    version: '4.21.0',
    generatedAt: '2026-08-20T00:00:00.000Z',
    versionInfo: { model: 'rules', modelVersion: '1.0.0', promptVersion: 'n/a', toolVersion: 'eval-tool-v1', agentVersion: 'eval-agent-v1' },
    domains: (['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'SELECTION', 'RCA', 'DEFECT', 'HEALING', 'RELEASE'] as const).map((domain, i) => ({
      domain,
      label: domain,
      benchmark: `${domain}_BENCHMARK_v1`,
      benchmarkVersion: 'v1',
      total: 30, tracked: 30, untracked: 0, passed: 27,
      score: 0.9 + i * 0.005,
      metrics: {},
      failures: [],
      results: [],
      cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, cost: 0 },
    })),
    overall,
    critical: { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 },
    cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, cost: 0 },
  };
}

describe('核心 E2E 闭环（S1-S8）', () => {
  it('S1+S2: Feedback → Error Cluster（Human Correction）', () => {
    const svc = createAIQualityService();
    svc.ingest({
      domain: 'RCA', prediction: { category: 'NETWORK' }, actual: { category: 'MODEL' },
      feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'RCA_VERIFICATION', caseId: 'rca-9',
    });
    const clusters = svc.errorClusters();
    expect(clusters.length).toBe(1);
    expect(clusters[0].domain).toBe('RCA');
    expect(clusters[0].count).toBe(1);
  });

  it('S3: Error Cluster → Proposal（自动生成）', () => {
    const svc = createAIQualityService();
    svc.ingest({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', caseId: 'r-1' });
    svc.ingest({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', caseId: 'r-2' });
    const created = svc.autoProposals();
    expect(created.length).toBe(1);
    expect(created[0].target).toBe('RULE');
    expect(created[0].status).toBe('PROPOSED');
    // 幂等：再次调用不重复生成
    expect(svc.autoProposals().length).toBe(0);
  });

  it('S4: Proposal → Benchmark → Candidate Score（离线评测 + Gate）', () => {
    const svc = createAIQualityService();
    const p = svc.proposals.create({ target: 'RULE', problem: '漏判 P0', hypothesis: '阈值过松', expectedImprovement: '提升', risk: 'MEDIUM' });
    const evaled = svc.proposals.recordEvaluation(p.id, {
      baselineScore: 0.9, candidateScore: 0.95, benchmark: 'RISK_BENCHMARK_v1', benchmarkVersion: 'v1',
      critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 },
    });
    expect(evaled.gateVerdict).toBe('PASS');
    expect(evaled.status).toBe('EVALUATING');
  });

  it('S5: Candidate → Approval → APPROVED（人工）', () => {
    const svc = createAIQualityService();
    const p = svc.proposals.create({ target: 'PROMPT', problem: 'p', hypothesis: 'h', expectedImprovement: 'e', risk: 'LOW' });
    svc.proposals.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.95, benchmark: 'B', benchmarkVersion: 'v1' });
    const approved = svc.proposals.approve(p.id, 'qa-admin');
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('qa-admin');
  });

  it('S6: Candidate → Shadow → Compare（只读）', () => {
    const svc = createAIQualityService();
    const exp = svc.experiments.createShadow({ proposalId: 'imp-1', candidateRef: 'prompt-v2' });
    const r = svc.experiments.recordShadowObservation(exp.id, {
      baseline: { accuracy: 0.9, latencyMs: 500, cost: 0.001, failureRate: 0.02, safety: 0 },
      candidate: { accuracy: 0.94, latencyMs: 520, cost: 0.0012, failureRate: 0.01, safety: 0 },
    });
    expect(r.passed).toBe(true);
  });

  it('S7: Canary 5% → 20% → 50% → 100%', () => {
    const svc = createAIQualityService();
    const exp = svc.experiments.createCanary({ proposalId: 'imp-1', candidateRef: 'prompt-v2' });
    expect(exp.canaryStage).toBe('5%');
    const m = { accuracy: 0.94, latencyMs: 520, cost: 0.0012, failureRate: 0.01, safety: 0 };
    expect(svc.experiments.canaryPromote(exp.id, { metrics: m }).stage).toBe('20%');
    expect(svc.experiments.canaryPromote(exp.id, { metrics: m }).stage).toBe('50%');
    expect(svc.experiments.canaryPromote(exp.id, { metrics: m }).stage).toBe('100%');
    const final = svc.experiments.canaryPromote(exp.id, { metrics: m });
    expect(final.stage).toBe('100%');
    expect(final.passed).toBe(true);
  });

  it('S8: Quality Regression → Auto Rollback → Baseline Restore', () => {
    const svc = createAIQualityService();
    const exp = svc.experiments.createCanary({ proposalId: 'imp-1', candidateRef: 'prompt-v2' });
    // 生产观测出现 Accuracy 骤降（metrics.accuracy 为相对基线的增量，负值=下降）
    const r = svc.experiments.canaryPromote(exp.id, { metrics: { accuracy: -0.24, latencyMs: 520, cost: 0.001, failureRate: 0.3, safety: 0 }, thresholdAccuracyDrop: 0.05 });
    expect(r.passed).toBe(false);
    const rec = svc.experiments.rollback(exp.id, { reason: '生产 Accuracy 下降 24%', metrics: { accuracy: 0.7 } });
    expect(rec.toRef).toBe('baseline');
    expect(rec.reason).toContain('Accuracy');
    expect(svc.experiments.get(exp.id)?.status).toBe('ROLLED_BACK');
  });

  it('S1-S8 完整闭环：从反馈到激活到回滚全程可审计', () => {
    const svc = createAIQualityService();
    // 1. 反馈
    svc.ingest({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'HUMAN_CORRECTION' });
    // 2. 聚类 → 提案
    svc.autoProposals();
    const p = svc.proposals.list()[0];
    expect(p).toBeDefined();
    // 3. 评估
    svc.proposals.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.96, benchmark: 'RISK_BENCHMARK_v1', benchmarkVersion: 'v1' });
    // 4. 审批
    svc.proposals.approve(p.id, 'qa-admin');
    // 5. Shadow
    const shadow = svc.experiments.createShadow({ proposalId: p.id, candidateRef: 'risk-v2' });
    svc.experiments.recordShadowObservation(shadow.id, {
      baseline: { accuracy: 0.9, latencyMs: 500, cost: 0.001, failureRate: 0.02, safety: 0 },
      candidate: { accuracy: 0.96, latencyMs: 480, cost: 0.001, failureRate: 0.01, safety: 0 },
    });
    // 6. Canary
    const canary = svc.experiments.createCanary({ proposalId: p.id, candidateRef: 'risk-v2' });
    const m = { accuracy: 0.96, latencyMs: 480, cost: 0.001, failureRate: 0.01, safety: 0 };
    svc.experiments.canaryPromote(canary.id, { metrics: m });
    svc.experiments.canaryPromote(canary.id, { metrics: m });
    svc.experiments.canaryPromote(canary.id, { metrics: m });
    const promoted = svc.experiments.canaryPromote(canary.id, { metrics: m });
    expect(promoted.passed).toBe(true);
    // 7. 审计完整链路
    const audit = svc.audit.list({ proposalId: p.id });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // 8. AI Quality 报告
    const report = svc.aiQualityReport(mockEvalReport());
    expect((report.feedback as { total: number }).total).toBe(1);
    expect((report.experiments as { canary: number }).canary).toBe(1);
  });
});

describe('AIQualityService 聚合报告（43.22）', () => {
  it('包含 Accuracy / Regression / False Pass / P0 Miss / RCA / Selection / Defect / Healing / Cost / Latency', () => {
    const svc = createAIQualityService();
    const r = svc.aiQualityReport(mockEvalReport(0.936));
    expect(r.accuracy).toBe(0.936);
    expect(r.falsePass).toBe(0);
    expect(r.p0Miss).toBe(0);
    expect(r.rcaAccuracy).toBeGreaterThan(0);
    expect(r.selectionRecall).toBeGreaterThan(0);
    expect(r.defectQuality).toBeGreaterThan(0);
    expect(r.healingSafety).toBeGreaterThan(0);
    expect(typeof r.cost).toBe('number');
    expect(typeof r.latency).toBe('number');
    expect((r.benchmark as { tracked: number }).tracked).toBe(240);
  });

  it('Targeted Evaluation：Prompt 变更定向推荐领域', () => {
    const svc = createAIQualityService();
    const domains = svc.targetedEvaluationDomains('PROMPT');
    expect(domains).toContain('REQUIREMENT');
    expect(domains).toContain('RISK');
    expect(domains.length).toBe(3);
  });
});

describe('AIQualityService 依赖注入（service）', () => {
  it('可通过 deps 注入各 Store', () => {
    const svc = new AIQualityService();
    expect(svc).toBeInstanceOf(AIQualityService);
    expect(svc.feedback.size()).toBe(0);
  });
});

describe('AIQualityService 持久化（43.x：改进闭环跨重启保留）', () => {
  it('persistToFile / loadFromFile：反馈、提案、实验、审计全部保留', () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/aiq-persist-${Date.now()}`;
    const file = `${dir}/state.json`;
    const svc = createAIQualityService();
    svc.ingest({ domain: 'RISK', prediction: 'P2', actual: 'P0', feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'HUMAN_CORRECTION', caseId: 'r-persist' });
    svc.autoProposals();
    const p = svc.proposals.list()[0];
    svc.proposals.recordEvaluation(p.id, { baselineScore: 0.9, candidateScore: 0.95, benchmark: 'B', benchmarkVersion: 'v1' });
    svc.proposals.approve(p.id, 'qa-admin');
    const shadow = svc.experiments.createShadow({ proposalId: p.id, candidateRef: 'risk-v2' });
    svc.persistToFile(file);

    // 模拟重启：新实例从文件恢复
    const restored = AIQualityService.loadFromFile(file);
    expect(restored.feedback.size()).toBe(1);
    expect(restored.feedback.list()[0].caseId).toBe('r-persist');
    expect(restored.proposals.list().length).toBe(1);
    expect(restored.proposals.list()[0].status).toBe('APPROVED');
    expect(restored.experiments.list().length).toBe(1);
    expect(restored.experiments.list()[0].type).toBe('SHADOW');
    expect(restored.audit.list().length).toBeGreaterThanOrEqual(2);

    // 文件不存在 → 空服务（安全降级）
    const empty = AIQualityService.loadFromFile(`${dir}/missing.json`);
    expect(empty.feedback.size()).toBe(0);
  });
});
