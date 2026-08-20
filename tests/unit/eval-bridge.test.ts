// Phase 49 / 43.21：Eval → Feedback Bridge 单元测试
// 覆盖：tracked 失败用例提取 / 桥接生成 BENCHMARK_FAILURE 反馈 + 待审候选 /
//  幂等去重（重复桥接同报告不重复入库）/ 未 tracked 失败不产生反馈 /
//  BenchmarkCandidateStore 人工 Review（approve/reject 状态机 + 禁止重复处理）/
//  Service 集成（bridgeEvaluationNow + reviewBenchmarkCandidate + 快照/恢复持久化）
import { describe, it, expect } from 'vitest';
import { FeedbackRegistry } from '../../src/ai-quality/feedback.js';
import { deriveErrorTaxonomy } from '../../src/ai-quality/feedback.js';
import { BenchmarkCandidateStore, bridgeEvalReport, extractEvalFailures, createBenchmarkCandidateStore } from '../../src/ai-quality/eval-bridge.js';
import { AIQualityService, createAIQualityService } from '../../src/ai-quality/service.js';
import type { EvalReport } from '../../src/eval/runner.js';

/** 构造带失败用例的确定性 EvalReport（模拟真实评测输出；生产一律走 runAllEvaluation 不虚构） */
function failingReport(overall = 0.9): EvalReport {
  return {
    version: '4.24.0',
    generatedAt: '2026-08-20T00:00:00.000Z',
    versionInfo: { model: 'rules', modelVersion: '1.0.0', promptVersion: 'n/a', toolVersion: 'eval-tool-v1', agentVersion: 'eval-agent-v1' },
    domains: [
      {
        domain: 'RISK', label: 'Risk',
        benchmark: 'RISK_BENCHMARK_v1', benchmarkVersion: 'v1',
        total: 4, tracked: 3, untracked: 1, passed: 1,
        score: overall,
        metrics: {},
        failures: [{ caseId: 'risk-bridge-001', expected: ['concurrency', 'dependency'], actual: ['concurrency'], errors: ['遗漏依赖风险 dependency'] }],
        results: [
          { caseId: 'risk-bridge-001', domain: 'RISK', score: 0.5, passed: false, tracked: true, expected: ['concurrency', 'dependency'], actual: ['concurrency'], errors: ['遗漏依赖风险 dependency'], evidence: [{ fn: 'r1' }] },
          { caseId: 'risk-bridge-002', domain: 'RISK', score: 1, passed: true, tracked: true, expected: ['security'], actual: ['security'], errors: [] },
          // 未 tracked（无 Ground Truth）：绝不产生反馈
          { caseId: 'risk-bridge-003', domain: 'RISK', score: null, passed: false, tracked: false, expected: null, actual: null, errors: ['无 Ground Truth'] },
          // 未 tracked 且计为 untracked 的用例外另一条
          { caseId: 'risk-bridge-004', domain: 'RISK', score: 0.4, passed: false, tracked: false, expected: null, actual: null, errors: ['无 Ground Truth'] },
        ],
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 10, cost: 0.001 },
      },
      {
        domain: 'RCA', label: 'RCA',
        benchmark: 'RCA_BENCHMARK_v1', benchmarkVersion: 'v1',
        total: 2, tracked: 2, untracked: 0, passed: 0,
        score: 0.5,
        metrics: {},
        failures: [
          { caseId: 'rca-bridge-001', expected: 'MODEL', actual: 'NETWORK', errors: ['根因判定错误'] },
          { caseId: 'rca-bridge-002', expected: 'DEPENDENCY', actual: 'TIMEOUT', errors: ['根因判定错误'] },
        ],
        results: [
          { caseId: 'rca-bridge-001', domain: 'RCA', score: 0, passed: false, tracked: true, expected: 'MODEL', actual: 'NETWORK', errors: ['根因判定错误'], evidence: [{ fn: 'r2' }] },
          { caseId: 'rca-bridge-002', domain: 'RCA', score: 0, passed: false, tracked: true, expected: 'DEPENDENCY', actual: 'TIMEOUT', errors: ['根因判定错误'] },
        ],
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 10, cost: 0.001 },
      },
    ],
    overall,
    critical: { p0Miss: 0, falsePass: 0, unsafeHealing: 0, skippedCritical: 0 },
    cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 20, cost: 0.002 },
  };
}

describe('extractEvalFailures（49.x）', () => {
  it('只提取 tracked 失败用例（跳过 passed 与未 tracked）', () => {
    const failures = extractEvalFailures(failingReport());
    expect(failures.length).toBe(3);
    expect(failures.map((f) => f.caseId).sort()).toEqual(['rca-bridge-001', 'rca-bridge-002', 'risk-bridge-001']);
    const rca = failures.find((f) => f.caseId === 'rca-bridge-001')!;
    expect(rca.expected).toBe('MODEL');
    expect(rca.actual).toBe('NETWORK');
    expect(rca.errors).toEqual(['根因判定错误']);
  });

  it('无失败（全部通过）→ 空数组', () => {
    const report = failingReport();
    for (const d of report.domains) {
      d.results = d.results.map((r) => ({ ...r, passed: true, score: 1 }));
      d.passed = d.total;
      d.failures = [];
    }
    expect(extractEvalFailures(report).length).toBe(0);
  });
});

describe('bridgeEvalReport（49.x / 43.21）', () => {
  it('失败用例桥接为 BENCHMARK_FAILURE 反馈（INCORRECT，prediction=actual，actual=expected）+ 待审候选', () => {
    const feedback = new FeedbackRegistry();
    const candidates = new BenchmarkCandidateStore();
    const res = bridgeEvalReport({ feedback, candidates }, failingReport());
    expect(res.ingested).toBe(3);
    expect(res.skippedDupes).toBe(0);
    expect(res.feedbackIds.length).toBe(3);
    expect(res.candidates.length).toBe(3);

    const fb = feedback.list()[0];
    expect(fb.channel).toBe('BENCHMARK_FAILURE');
    expect(fb.source).toBe('EVALUATION');
    expect(fb.feedbackType).toBe('INCORRECT');
    expect(fb.verified).toBe(false); // 待人工核验
    expect(fb.caseId).toBe('risk-bridge-001');
    expect(fb.prediction).toEqual(['concurrency']); // AI 实际输出
    expect(fb.actual).toEqual(['concurrency', 'dependency']); // Ground Truth

    // 候选全部 PENDING_REVIEW（禁止自动并入）
    expect(candidates.list().every((c) => c.status === 'PENDING_REVIEW')).toBe(true);
    expect(candidates.list().every((c) => c.feedbackId)).toBe(true);
  });

  it('幂等：重复桥接同一报告不重复入库（仅去重跳过）', () => {
    const feedback = new FeedbackRegistry();
    const candidates = new BenchmarkCandidateStore();
    const deps = { feedback, candidates };
    const first = bridgeEvalReport(deps, failingReport());
    const second = bridgeEvalReport(deps, failingReport());
    expect(first.ingested).toBe(3);
    expect(second.ingested).toBe(0);
    expect(second.skippedDupes).toBe(3);
    expect(feedback.size()).toBe(3);
    expect(candidates.size()).toBe(3);
    expect(second.feedbackIds.length).toBe(0);
    expect(second.candidates.length).toBe(0);
  });

  it('已人工核验过的桥接反馈：feedbackType 推导错误分类（RCA 判定错误 → WRONG）', () => {
    const feedback = new FeedbackRegistry();
    const candidates = new BenchmarkCandidateStore();
    bridgeEvalReport({ feedback, candidates }, failingReport());
    const rcaFb = feedback.list().find((f) => f.caseId === 'rca-bridge-001')!;
    expect(deriveErrorTaxonomy(rcaFb)).toBe('WRONG');
  });
});

describe('BenchmarkCandidateStore（43.21 Review 状态机）', () => {
  function seedOne(): { store: BenchmarkCandidateStore; id: string } {
    const store = createBenchmarkCandidateStore();
    const c = store.add({
      domain: 'RISK', caseId: 'risk-x',
      expected: ['concurrency', 'dependency'], actual: ['concurrency'],
      errors: ['遗漏依赖'], source: 'EVALUATION', feedbackId: 'fb-1',
    });
    return { store, id: c.id };
  }

  it('approve：PENDING_REVIEW → APPROVED，记录 reviewer（人工门禁）', () => {
    const { store, id } = seedOne();
    const c = store.approve(id, 'qa-lead');
    expect(c.status).toBe('APPROVED');
    expect(c.reviewer).toBe('qa-lead');
    expect(c.reviewedAt).toBeTruthy();
  });

  it('reject：PENDING_REVIEW → REJECTED，记录原因', () => {
    const { store, id } = seedOne();
    const c = store.reject(id, 'qa-lead', 'Ground Truth 有误');
    expect(c.status).toBe('REJECTED');
    expect(c.reviewer).toBe('qa-lead');
    expect(c.reason).toBe('Ground Truth 有误');
  });

  it('禁止重复处理：已 APPROVED / REJECTED 不可再 approve / reject', () => {
    const { store, id } = seedOne();
    store.approve(id, 'qa-lead');
    expect(() => store.approve(id, 'qa-lead')).toThrow(/不可批准/);
    expect(() => store.reject(id, 'qa-lead', 'x')).toThrow(/不可驳回/);
  });

  it('list 过滤（status / domain）与快照/导入往返', () => {
    const store = createBenchmarkCandidateStore();
    store.add({ domain: 'RISK', caseId: 'a', expected: 1, actual: 2, errors: [], source: 'EVALUATION', feedbackId: 'f1' });
    const b = store.add({ domain: 'RCA', caseId: 'b', expected: 1, actual: 2, errors: [], source: 'EVALUATION', feedbackId: 'f2' });
    store.approve(b.id, 'qa-lead');

    expect(store.list({ status: 'APPROVED' }).length).toBe(1);
    expect(store.list({ domain: 'RISK' }).length).toBe(1);

    const restored = BenchmarkCandidateStore.import(store.snapshot());
    expect(restored.size()).toBe(2);
    expect(restored.get(b.id)!.status).toBe('APPROVED');
    expect(restored.get(b.id)!.reviewer).toBe('qa-lead');
  });
});

describe('AIQualityService 集成（Phase 49）', () => {
  it('bridgeEvaluation：失败 → 反馈 + 候选，且可经人工 reviewBenchmarkCandidate 批准', () => {
    const svc = createAIQualityService();
    const res = svc.bridgeEvaluation(failingReport());
    expect(res.ingested).toBe(3);
    expect(svc.benchmarkCandidates.size()).toBe(3);

    const cand = res.candidates[0];
    const approved = svc.reviewBenchmarkCandidate(cand.id, 'APPROVED', 'qa-lead');
    expect(approved.status).toBe('APPROVED');
    // 审计完整记录（43.19）
    expect(svc.audit.list().some((a) => a.candidate === cand.id && a.action === 'APPROVED')).toBe(true);
  });

  it('reviewBenchmarkCandidate：reject 记录原因并写入审计', () => {
    const svc = createAIQualityService();
    const res = svc.bridgeEvaluation(failingReport());
    const cand = res.candidates[0];
    const rejected = svc.reviewBenchmarkCandidate(cand.id, 'REJECTED', 'qa-lead', '重复用例');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reason).toBe('重复用例');
    expect(svc.audit.list().some((a) => a.candidate === cand.id && a.action === 'REJECTED')).toBe(true);
  });

  it('快照/恢复：benchmarkCandidates 持久化保留', () => {
    const svc = createAIQualityService();
    const res = svc.bridgeEvaluation(failingReport());
    svc.reviewBenchmarkCandidate(res.candidates[0].id, 'APPROVED', 'qa-lead');

    const restored = AIQualityService.restore(svc.snapshot());
    expect(restored.benchmarkCandidates.size()).toBe(3);
    expect(restored.benchmarkCandidates.list({ status: 'APPROVED' }).length).toBe(1);
  });

  it('bridgeEvaluationNow：跑真实评测（确定性、零 token）并把失败桥接为反馈 + 候选', () => {
    const svc = createAIQualityService();
    const { report, bridge } = svc.bridgeEvaluationNow();
    expect(report.overall).toBeGreaterThan(0);
    expect(bridge.ingested).toBeGreaterThanOrEqual(0);
    expect(bridge.feedbackIds.length).toBe(bridge.ingested);
    expect(bridge.candidates.length).toBe(bridge.ingested);
    expect(svc.feedback.size()).toBe(bridge.ingested);
  });

  it('runContinuousEval：真实评测 + 失败自动桥接（反馈与候选随运行产生，幂等）', () => {
    const svc = createAIQualityService();
    const run1 = svc.runContinuousEval({ schedule: 'NIGHTLY', createdBy: 'tester' });
    expect(run1.regression.verdict).toBe('PASS');
    const firstIngest = svc.feedback.size();
    // 第二次运行：同一份真实评测结果 → 幂等去重，不再新增反馈
    svc.runContinuousEval({ schedule: 'NIGHTLY', createdBy: 'tester' });
    expect(svc.feedback.size()).toBe(firstIngest);
    expect(svc.audit.list().some((a) => a.metrics?.bridged !== undefined)).toBe(true);
  });
});
