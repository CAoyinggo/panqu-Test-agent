// Eval → Feedback Bridge（Phase 49 / 43.2 · 43.21 落地）
// 打通「Benchmark Failure → Feedback → 聚类 → 提案」自动链路，让 Benchmark 越来越接近真实业务：
//   - 从 EvalReport 的 tracked 失败用例自动生成 BENCHMARK_FAILURE 渠道反馈（EVALUATION 来源，INCORRECT）
//   - 幂等去重：同一 caseId + expected + actual 已在库中则跳过（避免重复跑评测时刷屏）
//   - 每个失败自动生成 Benchmark 扩充候选（PENDING_REVIEW）
// 铁律：
//   - 候选必须人工 Review（approve/reject）后才可并入 Benchmark，禁止自动并入（禁止 AI 自批）。
//   - 分数一律来自真实 EvalReport；桥接只搬运失败用例，不虚构。
import { randomBytes } from 'node:crypto';
import type { EvalReport } from '../eval/runner.js';
import type { EvaluationDomain } from '../eval/contract.js';
import type { FeedbackRegistry } from './feedback.js';
import type { AIFeedback, FeedbackSource } from './contract.js';
import { benchmarkCandidateFromFeedback } from './ops.js';

export type BenchmarkCandidateStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

/** Benchmark 扩充候选（43.21）：真实失败用例经 Review 后进入已验证 Ground Truth 池 */
export interface BenchmarkCandidate {
  id: string;
  domain: EvaluationDomain;
  caseId: string;
  expected: unknown;
  actual: unknown;
  errors: string[];
  /** 来源（派生自反馈来源：EVALUATION / PRODUCTION / HUMAN …） */
  source: FeedbackSource;
  feedbackId: string;
  status: BenchmarkCandidateStatus;
  reviewer?: string;
  reviewedAt?: string;
  reason?: string;
  createdAt: string;
}

export interface BenchmarkCandidateStoreOptions {
  now?: () => string;
}

/** Benchmark 扩充候选存储（快照 / 导入复用统一持久化） */
export class BenchmarkCandidateStore {
  private readonly items = new Map<string, BenchmarkCandidate>();

  constructor(private readonly opts: BenchmarkCandidateStoreOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  add(input: Omit<BenchmarkCandidate, 'id' | 'createdAt' | 'status'>): BenchmarkCandidate {
    const cand: BenchmarkCandidate = {
      ...input,
      id: `bmc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      status: 'PENDING_REVIEW',
      createdAt: this.now(),
    };
    this.items.set(cand.id, cand);
    return cand;
  }

  get(id: string): BenchmarkCandidate | undefined {
    return this.items.get(id);
  }

  list(filter: { status?: BenchmarkCandidateStatus; domain?: EvaluationDomain } = {}): BenchmarkCandidate[] {
    return [...this.items.values()]
      .filter((c) => {
        if (filter.status && c.status !== filter.status) return false;
        if (filter.domain && c.domain !== filter.domain) return false;
        return true;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 最新在前
  }

  /**
   * 人工 Review：批准候选进入已验证 Ground Truth 池。
   * 必须人工（禁止 AI 自批）；批准后 status=APPROVED 并记录 reviewer / reviewedAt。
   */
  approve(id: string, reviewer: string): BenchmarkCandidate {
    const c = this.items.get(id);
    if (!c) throw new Error(`Benchmark 候选不存在：${id}`);
    if (c.status !== 'PENDING_REVIEW') throw new Error(`候选 ${id} 状态为 ${c.status}，不可批准`);
    c.status = 'APPROVED';
    c.reviewer = reviewer;
    c.reviewedAt = this.now();
    return c;
  }

  reject(id: string, reviewer: string, reason: string): BenchmarkCandidate {
    const c = this.items.get(id);
    if (!c) throw new Error(`Benchmark 候选不存在：${id}`);
    if (c.status !== 'PENDING_REVIEW') throw new Error(`候选 ${id} 状态为 ${c.status}，不可驳回`);
    c.status = 'REJECTED';
    c.reviewer = reviewer;
    c.reviewedAt = this.now();
    c.reason = reason;
    return c;
  }

  size(): number {
    return this.items.size;
  }

  snapshot(): BenchmarkCandidate[] {
    return [...this.items.values()];
  }

  static import(items: BenchmarkCandidate[]): BenchmarkCandidateStore {
    const s = new BenchmarkCandidateStore();
    for (const c of items) s.items.set(c.id, c);
    return s;
  }
}

export function createBenchmarkCandidateStore(): BenchmarkCandidateStore {
  return new BenchmarkCandidateStore();
}

export interface EvalBridgeResult {
  /** 新入库反馈数 */
  ingested: number;
  /** 幂等去重跳过数 */
  skippedDupes: number;
  feedbackIds: string[];
  /** 新生成的待审候选 */
  candidates: BenchmarkCandidate[];
}

export interface EvalBridgeDeps {
  feedback: FeedbackRegistry;
  candidates: BenchmarkCandidateStore;
}

/** 从 EvalReport 提取 tracked 失败用例（未 tracked 不产生反馈，禁止虚构） */
export function extractEvalFailures(report: EvalReport): Array<{ domain: EvaluationDomain; caseId: string; expected: unknown; actual: unknown; errors: string[] }> {
  const out: Array<{ domain: EvaluationDomain; caseId: string; expected: unknown; actual: unknown; errors: string[] }> = [];
  for (const d of report.domains) {
    for (const r of d.results) {
      if (!r.tracked) continue; // 未追踪用例不产生反馈
      if (r.passed) continue; // 只搬运失败
      out.push({ domain: r.domain, caseId: r.caseId, expected: r.expected, actual: r.actual, errors: r.errors });
    }
  }
  return out;
}

/** 判断是否已存在同一失败反馈（幂等去重键：caseId + expected/actual 深比较） */
function existsFeedback(feedback: FeedbackRegistry, caseId: string, expected: unknown, actual: unknown): boolean {
  const items = feedback.list({ channel: 'BENCHMARK_FAILURE' });
  return items.some((f: AIFeedback) => f.caseId === caseId && JSON.stringify(f.actual) === JSON.stringify(expected) && JSON.stringify(f.prediction) === JSON.stringify(actual));
}

/**
 * 49.x：把一份 EvalReport 的 tracked 失败用例桥接为 BENCHMARK_FAILURE 反馈 + Benchmark 扩充候选。
 * - feedbackType=INCORRECT（AI 预测 ≠ Ground Truth）；prediction=actual（AI 实际输出），actual=expected（真值）。
 * - 幂等：同 caseId+期望/实际已入库则跳过。
 * - 候选一律 PENDING_REVIEW，必须人工 Review 后才可并入（禁止自动并入）。
 */
export function bridgeEvalReport(deps: EvalBridgeDeps, report: EvalReport): EvalBridgeResult {
  const failures = extractEvalFailures(report);
  const result: EvalBridgeResult = { ingested: 0, skippedDupes: 0, feedbackIds: [], candidates: [] };

  for (const f of failures) {
    if (existsFeedback(deps.feedback, f.caseId, f.expected, f.actual)) {
      result.skippedDupes += 1;
      continue;
    }
    const fb = deps.feedback.add(
      {
        caseId: f.caseId,
        domain: f.domain,
        prediction: f.actual, // AI 实际输出
        actual: f.expected, // Ground Truth
        feedbackType: 'INCORRECT',
        source: 'EVALUATION',
        channel: 'BENCHMARK_FAILURE',
        confidence: 0.9,
        note: `Benchmark 失败自动反馈（${f.errors.join('；') || '无错误摘要'}）`,
      },
      false, // 待人工核验
    );
    result.feedbackIds.push(fb.id);

    // 生成待审候选（复用 43.21 benchmarkCandidateFromFeedback，再落为可 Review 实体）
    const raw = benchmarkCandidateFromFeedback({
      feedbackId: fb.id,
      domain: f.domain,
      expected: f.expected,
      actual: f.actual,
      errors: f.errors,
    });
    const cand = deps.candidates.add({
      domain: f.domain,
      caseId: f.caseId,
      expected: f.expected,
      actual: f.actual,
      errors: f.errors,
      source: 'EVALUATION',
      feedbackId: fb.id,
    });
    result.candidates.push(cand);
    result.ingested += 1;
    void raw; // raw 仅用于保持 43.21 契约可见（候选实体在 store 中管理）
  }

  return result;
}
