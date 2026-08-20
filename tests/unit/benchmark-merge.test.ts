// Phase 50 / 43.21：Benchmark 候选并入（Review → Benchmark 落地）单元测试
// 覆盖：仅并入 APPROVED / 找不到真实源用例则跳过（禁止伪造输入）/ 升版（v1→v2…）/
//  并入用例复用源输入与 Ground Truth / 为并入用例登记 HUMAN Ground Truth /
//  候选 markMerged（mergedCaseId / mergedBenchmark）/ 幂等（已并入不可重复）/
//  Service 集成（mergeBenchmarkCandidates 审计 + 持久化往返）
import { describe, it, expect } from 'vitest';
import { BenchmarkRegistry, type BenchmarkDefinition } from '../../src/eval/benchmark/registry.js';
import { GroundTruthRegistry, groundTruthFor } from '../../src/eval/ground-truth.js';
import type { EvaluationCase } from '../../src/eval/contract.js';
import { createBenchmarkCandidateStore, type BenchmarkCandidateStore } from '../../src/ai-quality/eval-bridge.js';
import { mergeApprovedCandidates, candidateMatchesSource } from '../../src/ai-quality/benchmark-merge.js';
import { createImprovementAudit } from '../../src/ai-quality/ops.js';
import { AIQualityService, createAIQualityService } from '../../src/ai-quality/service.js';

/** 构造 RISK 领域 v1 基准（含 risk-src-001 真实源用例） */
function buildRiskBenchmark(): BenchmarkRegistry {
  const registry = new BenchmarkRegistry();
  registry.register({
    name: 'RISK_BENCHMARK_v1',
    version: 'v1',
    domain: 'RISK',
    cases: [
      { id: 'risk-src-001', domain: 'RISK', input: { deps: ['A', 'B', 'C'] }, groundTruth: ['concurrency', 'dependency'], metadata: { source: 'curated' } },
      { id: 'risk-src-002', domain: 'RISK', input: { deps: ['X'] }, groundTruth: ['security'], metadata: { source: 'curated' } },
    ],
  } satisfies BenchmarkDefinition);
  return registry;
}

/** 构造一条 APPROVED 候选（caseId 对应真实源用例） */
function seedApproved(store: BenchmarkCandidateStore, over: Partial<{ caseId: string; domain: string; expected: unknown }> = {}): string {
  const c = store.add({
    domain: 'RISK',
    caseId: over.caseId ?? 'risk-src-001',
    expected: over.expected ?? ['concurrency', 'dependency'],
    actual: ['concurrency'],
    errors: ['遗漏依赖风险 dependency'],
    source: 'EVALUATION',
    feedbackId: 'fb-risk-1',
  });
  return store.approve(c.id, 'qa-lead').id;
}

describe('mergeApprovedCandidates（50.x / 43.21 Review→Benchmark）', () => {
  it('并入 APPROVED 候选：状态 → MERGED，记录 mergedCaseId / mergedBenchmark，Benchmark 升版 v2', () => {
    const candidates = createBenchmarkCandidateStore();
    const approvedId = seedApproved(candidates);
    const registry = buildRiskBenchmark();
    const groundTruth = buildRiskBenchmark().latest('RISK')!.cases.reduce(
      (g, c) => g.register({ id: c.id, source: 'CURATED', verifiedBy: 'p50', confidence: 1 }),
      new GroundTruthRegistry(),
    );
    const audit = createImprovementAudit();

    const result = mergeApprovedCandidates({ candidates, registry, groundTruth, audit }, { by: 'qa-lead' });

    expect(result.merged).toBe(1);
    expect(result.skippedUnresolvable).toBe(0);
    expect(result.skippedNotApproved).toBe(0);
    expect(result.mergedCases.length).toBe(1);
    expect(result.benchmarkVersions).toEqual(['RISK_BENCHMARK_v2']);

    // 候选标记 MERGED + 落地凭据
    const cand = candidates.get(approvedId)!;
    expect(cand.status).toBe('MERGED');
    expect(cand.mergedCaseId).toBe('risk-src-001~m1');
    expect(cand.mergedBenchmark).toBe('RISK_BENCHMARK_v2');

    // Benchmark 升版：v2 = v1 用例 + 新用例（复用源输入与 Ground Truth，绝不伪造）
    const v2 = registry.latest('RISK')!;
    expect(v2.version).toBe('v2');
    expect(v2.cases.length).toBe(3);
    const mergedCase = v2.cases.find((c) => c.id === 'risk-src-001~m1')!;
    expect(mergedCase.input).toEqual({ deps: ['A', 'B', 'C'] });
    expect(mergedCase.groundTruth).toEqual(['concurrency', 'dependency']);
    expect(mergedCase.metadata?.source).toBe('REAL_EVAL_FAILURE');
    expect(mergedCase.metadata?.candidateId).toBe(approvedId);
    expect(mergedCase.metadata?.feedbackId).toBe('fb-risk-1');
    expect(mergedCase.metadata?.reviewer).toBe('qa-lead');

    // 为并入用例登记 Ground Truth（HUMAN 核实）
    expect(groundTruth.has('risk-src-001~m1')).toBe(true);
    expect(groundTruth.get('risk-src-001~m1')!.source).toBe('HUMAN');

    // 完整审计
    expect(audit.list().some((a) => a.candidate === approvedId && a.action === 'APPROVED')).toBe(true);
  });

  it('找不到真实源用例 → 跳过并记录原因（拒绝伪造输入）', () => {
    const candidates = createBenchmarkCandidateStore();
    const id = seedApproved(candidates, { caseId: 'nonexistent-case' });
    const registry = buildRiskBenchmark();
    const groundTruth = new GroundTruthRegistry();
    const audit = createImprovementAudit();

    const result = mergeApprovedCandidates({ candidates, registry, groundTruth, audit }, { by: 'qa-lead' });

    expect(result.merged).toBe(0);
    expect(result.skippedUnresolvable).toBe(1);
    expect(registry.latest('RISK')!.version).toBe('v1'); // 未升版
    expect(candidates.get(id)!.status).toBe('APPROVED'); // 保留 APPROVED
    expect(candidates.get(id)!.reason).toContain('不存在源用例');
  });

  it('非 APPROVED（PENDING_REVIEW / REJECTED / MERGED）一律跳过', () => {
    const candidates = createBenchmarkCandidateStore();
    const pending = candidates.add({ domain: 'RISK', caseId: 'risk-src-001', expected: ['x'], actual: ['y'], errors: [], source: 'EVALUATION', feedbackId: 'f1' });
    const rejected = candidates.add({ domain: 'RISK', caseId: 'risk-src-001', expected: ['x'], actual: ['y'], errors: [], source: 'EVALUATION', feedbackId: 'f2' });
    candidates.reject(rejected.id, 'qa-lead', '重复');
    const registry = buildRiskBenchmark();
    const groundTruth = new GroundTruthRegistry();
    const audit = createImprovementAudit();

    const result = mergeApprovedCandidates({ candidates, registry, groundTruth, audit }, { by: 'qa-lead' });
    // 非 APPROVED 候选在 list({status:'APPROVED'}) 阶段即被过滤，不进入并入流程
    expect(result.merged).toBe(0);
    expect(result.skippedUnresolvable).toBe(0);
    expect(candidates.get(pending.id)!.status).toBe('PENDING_REVIEW');
    expect(candidates.get(rejected.id)!.status).toBe('REJECTED');
  });

  it('幂等：已 MERGED 候选不可重复并入（第二次无新版本）', () => {
    const candidates = createBenchmarkCandidateStore();
    seedApproved(candidates);
    const registry = buildRiskBenchmark();
    const groundTruth = buildRiskBenchmark().latest('RISK')!.cases.reduce(
      (g, c) => g.register({ id: c.id, source: 'CURATED', verifiedBy: 'p50', confidence: 1 }),
      new GroundTruthRegistry(),
    );
    const audit = createImprovementAudit();
    const deps = { candidates, registry, groundTruth, audit };

    const first = mergeApprovedCandidates(deps, { by: 'qa-lead' });
    expect(first.merged).toBe(1);

    // 第二次：候选已 MERGED → 不再出现在 APPROVED 集合 → 0
    const second = mergeApprovedCandidates(deps, { by: 'qa-lead' });
    expect(second.merged).toBe(0);
    expect(second.skippedNotApproved).toBe(0);
    expect(registry.latest('RISK')!.version).toBe('v2'); // 未升 v3
  });

  it('domain / candidateIds 过滤：只并入指定候选', () => {
    const candidates = createBenchmarkCandidateStore();
    const aId = seedApproved(candidates, { caseId: 'risk-src-001' });
    seedApproved(candidates, { caseId: 'risk-src-002' });
    const registry = buildRiskBenchmark();
    const groundTruth = new GroundTruthRegistry();
    const audit = createImprovementAudit();

    const result = mergeApprovedCandidates({ candidates, registry, groundTruth, audit }, { by: 'qa-lead', candidateIds: [aId] });
    expect(result.merged).toBe(1);
    expect(candidates.get(aId)!.status).toBe('MERGED');
  });

  it('同一领域多次并入：连续升版 v2 → v3', () => {
    const candidates = createBenchmarkCandidateStore();
    seedApproved(candidates, { caseId: 'risk-src-001' });
    const registry = buildRiskBenchmark();
    const groundTruth = new GroundTruthRegistry();
    const audit = createImprovementAudit();
    const deps = { candidates, registry, groundTruth, audit };

    mergeApprovedCandidates(deps, { by: 'qa-lead' });
    // 再批准一条并并入 → v3
    const second = seedApproved(candidates, { caseId: 'risk-src-002' });
    const result = mergeApprovedCandidates(deps, { by: 'qa-lead', candidateIds: [second] });
    expect(result.merged).toBe(1);
    expect(result.benchmarkVersions).toEqual(['RISK_BENCHMARK_v3']);
    expect(registry.latest('RISK')!.cases.length).toBe(4);
  });
});

describe('candidateMatchesSource（50.x 真值复核）', () => {
  it('候选 expected 与源用例 groundTruth 一致 → true', () => {
    const source: EvaluationCase = { id: 'risk-src-001', domain: 'RISK', input: {}, groundTruth: ['concurrency', 'dependency'] };
    expect(candidateMatchesSource({ expected: ['concurrency', 'dependency'] } as never, source)).toBe(true);
    expect(candidateMatchesSource({ expected: ['concurrency'] } as never, source)).toBe(false);
  });
});

describe('AIQualityService 集成（Phase 50）', () => {
  it('真实闭环：bridge → approve → mergeBenchmarkCandidates 升版 + 审计 + 持久化往返', () => {
    const svc = createAIQualityService();
    const { bridge } = svc.bridgeEvaluationNow();
    expect(bridge.ingested).toBeGreaterThanOrEqual(0);
    if (bridge.candidates.length > 0) {
      const cand = bridge.candidates[0];
      svc.reviewBenchmarkCandidate(cand.id, 'APPROVED', 'qa-lead');
      const before = svc.benchmarkRegistry.latest(cand.domain as never);
      const result = svc.mergeBenchmarkCandidates('qa-lead', { candidateIds: [cand.id] });
      expect(result.merged).toBeGreaterThanOrEqual(1);
      const after = svc.benchmarkRegistry.latest(cand.domain as never)!;
      expect(versionRankOf(after.version)).toBe(versionRankOf(before?.version ?? 'v0') + 1);
      // 审计完整记录（43.19）
      expect(svc.audit.list().some((a) => a.candidate === cand.id && a.action === 'APPROVED' && String(a.metrics?.merged) === '1')).toBe(true);

      // 持久化往返：候选 MERGED + Benchmark 升版保留
      const restored = AIQualityService.restore(svc.snapshot());
      expect(restored.benchmarkCandidates.get(cand.id)!.status).toBe('MERGED');
      expect(restored.benchmarkRegistry.latest(cand.domain as never)!.version).toBe(after.version);

      // 向后兼容 Phase 49 旧快照：缺少 Phase 50 Registry 字段时必须回退默认 v1，不能恢复为空。
      const legacySnapshot = { ...svc.snapshot(), benchmarkDefinitions: undefined, groundTruth: undefined };
      const restoredLegacy = AIQualityService.restore(legacySnapshot);
      expect(restoredLegacy.benchmarkRegistry.latest('RISK')).toBeDefined();
      expect(restoredLegacy.groundTruthRegistry.size).toBeGreaterThan(0);
    } else {
      // 真实评测全绿时无候选：验证空并入不报错
      const result = svc.mergeBenchmarkCandidates('qa-lead');
      expect(result.merged).toBe(0);
    }
  });
});

function versionRankOf(v: string): number {
  const m = /^v(\d+)$/.exec(v);
  return m ? Number(m[1]) : 0;
}
