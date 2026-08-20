// Benchmark Merge（Phase 50 / 43.21 落地：Review → Benchmark）
// 把「人工批准（APPROVED）」的 Benchmark 扩充候选真正并入 Benchmark Registry，
// 以「新增版本」（<DOMAIN>_BENCHMARK_v2 / v3 …）方式落地——Benchmark 越来越接近真实业务。
//
// 铁律：
//   - 只并入 APPROVED 候选（必须人工 Review，禁止 AI 自批/自动并库）。
//   - 只复用真实源用例的 input / groundTruth（按 domain + caseId 从当前 Benchmark 最新版查找）；
//     找不到源用例（无真实输入）→ 跳过并记录 reason，绝不凭空构造输入（禁止伪造）。
//   - 并入的新用例 id 唯一（<caseId>~m<N>），metadata 完整记录 candidateId / feedbackId / reviewer。
//   - 为并入用例登记 Ground Truth（source=REAL_RUN？ 使用 HUMAN 核实语义更准确——来源取候选 source）。
//   - 幂等：已 MERGED 的候选不可重复并入；重复的用例 id 自动去重。
//   - 完整写入 ImprovementAudit（proposalId / actor / metrics / decision）。
import type { EvaluationCase, EvaluationDomain } from '../eval/contract.js';
import { GroundTruthRegistry } from '../eval/ground-truth.js';
import { BenchmarkRegistry } from '../eval/benchmark/registry.js';
import { ImprovementAudit } from './ops.js';
import { BenchmarkCandidateStore, type BenchmarkCandidate } from './eval-bridge.js';

export interface BenchmarkMergeResult {
  /** 成功并入候选数 */
  merged: number;
  /** 找不到真实源用例而跳过数（不伪造输入） */
  skippedUnresolvable: number;
  /** 已处理（非 APPROVED）跳过数 */
  skippedNotApproved: number;
  /** 并入后生成的新用例（每候选一条） */
  mergedCases: Array<{ candidateId: string; caseId: string; domain: EvaluationDomain }>;
  /** 升版后的 Benchmark 名（按领域去重） */
  benchmarkVersions: string[];
}

export interface BenchmarkMergeDeps {
  candidates: BenchmarkCandidateStore;
  registry: BenchmarkRegistry;
  groundTruth: GroundTruthRegistry;
  audit: ImprovementAudit;
}

export interface BenchmarkMergeOptions {
  /** 人工执行者（必须人工触发；禁止 AI 自批） */
  by: string;
  /** 只并入这些候选 id（缺省并入全部 APPROVED） */
  candidateIds?: string[];
  /** 只并入这些领域（缺省全领域） */
  domains?: EvaluationDomain[];
}

/** 深比较（用于确认候选期望真值 == 源用例 groundTruth） */
function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/**
 * Phase 50：并入人工批准的 Benchmark 候选。
 * 返回合并结果；候选状态 APPROVED → MERGED（mergedCaseId / mergedBenchmark 记录落地凭据）。
 */
export function mergeApprovedCandidates(deps: BenchmarkMergeDeps, opts: BenchmarkMergeOptions): BenchmarkMergeResult {
  const { candidates, registry, groundTruth, audit } = deps;
  const result: BenchmarkMergeResult = { merged: 0, skippedUnresolvable: 0, skippedNotApproved: 0, mergedCases: [], benchmarkVersions: [] };
  const wantDomains = new Set(opts.domains ?? []);
  const wantIds = opts.candidateIds ? new Set(opts.candidateIds) : undefined;

  const approved = candidates.list({ status: 'APPROVED' }).filter((c) => {
    if (wantIds && !wantIds.has(c.id)) return false;
    if (wantDomains.size > 0 && !wantDomains.has(c.domain)) return false;
    return true;
  });

  for (const cand of approved) {
    const merged = mergeOne(deps, cand, opts.by, result);
    if (merged) {
      audit.record({
        proposalId: 'n/a',
        actor: opts.by,
        action: 'APPROVED',
        candidate: cand.id,
        decision: `Benchmark 候选 ${cand.id}（${cand.domain}/${cand.caseId}）已并入 ${merged.benchmark}（用例 ${merged.caseId}）`,
        metrics: { merged: 1 },
      });
    }
  }
  return result;
}

function mergeOne(
  deps: BenchmarkMergeDeps,
  cand: BenchmarkCandidate,
  by: string,
  result: BenchmarkMergeResult,
): { caseId: string; benchmark: string } | null {
  const { candidates, registry, groundTruth } = deps;
  // 幂等/状态守卫：仅 APPROVED 可并入（已 MERGED / REJECTED 跳过）
  if (cand.status !== 'APPROVED') {
    result.skippedNotApproved += 1;
    return null;
  }
  // 查找真实源用例：按领域最新版中 caseId 匹配（复用其 input / groundTruth，绝不虚构）
  const def = registry.latest(cand.domain);
  const source = def?.cases.find((c) => c.id === cand.caseId);
  if (!source) {
    result.skippedUnresolvable += 1;
    // 保留 APPROVED，记录无法并入原因（无真实输入 → 禁止伪造）
    cand.reason = `无法并入：基准中不存在源用例 ${cand.caseId}（无真实输入，拒绝伪造构造）`;
    return null;
  }
  // 新用例唯一 id：<caseId>~m<N>（同一候选重复并入由 markMerged 状态机防呆；同名去重由 registry.extendWithCases 保证）
  // def 已有 source（source 来自 def.cases），此处可安全断言非空
  const seq = 1 + (def?.cases ?? []).filter((c) => c.id.startsWith(`${cand.caseId}~m`)).length;
  const caseId = `${cand.caseId}~m${seq}`;
  const mergedCase: EvaluationCase = {
    id: caseId,
    domain: cand.domain,
    input: source.input,
    // 真值：以源用例 groundTruth 为准（人工批准即视为对该真值的复核确认；cand.expected 应一致）
    groundTruth: source.groundTruth,
    metadata: {
      ...source.metadata,
      source: 'REAL_EVAL_FAILURE',
      benchmarkOrigin: source.id,
      candidateId: cand.id,
      feedbackId: cand.feedbackId,
      reviewer: by,
      reviewedAt: cand.reviewedAt ?? new Date().toISOString(),
      difficulty: 'real-failure',
    },
  };
  // 为并入用例登记 Ground Truth（HUMAN 核实：人工批准即确认真值）
  groundTruth.register({
    id: caseId,
    source: 'HUMAN',
    verifiedBy: by,
    verifiedAt: cand.reviewedAt ?? new Date().toISOString(),
    confidence: 1,
  });
  // 并入该领域 Benchmark（升版：v1 → v2 …）
  const extended = registry.extendWithCases(cand.domain, [mergedCase]);
  const merged = candidates.markMerged(cand.id, caseId, extended.name);
  result.merged += 1;
  result.mergedCases.push({ candidateId: merged.id, caseId, domain: merged.domain });
  if (!result.benchmarkVersions.includes(extended.name)) result.benchmarkVersions.push(extended.name);
  return { caseId, benchmark: extended.name };
}

/** 校验候选的期望真值与源用例 groundTruth 是否一致（供测试/审计复核；不一致仅记录不阻断，以源真值为准） */
export function candidateMatchesSource(cand: BenchmarkCandidate, source: EvaluationCase): boolean {
  return deepEqual(cand.expected, source.groundTruth);
}
