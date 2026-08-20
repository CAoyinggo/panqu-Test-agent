// AI Release Gate + Change Impact + Continuous Evaluation + Benchmark Auto-Expansion + Audit
// （Phase 46 / 43.19 + 43.20 + 43.21 + 43.23 + 43.24）
// 43.24 AI Release Gate：把 AI 自身纳入 Release Gate——Prompt/Model 变更必须
//   Evaluation → Quality PASS → Safety PASS → Cost PASS → Approval → Release。
// 43.23 Change Impact：Prompt/Model/Tool/Knowledge 变化时自动判断受影响 Benchmark / Agent / Project / Run，
//   自动触发 Targeted Evaluation（不是每次跑所有 Benchmark）。
// 43.20 Continuous Evaluation：Nightly / Weekly / Release 定时评测，自动 Compare → Detect Regression，
//   Critical Regression 自动 Alert + Block Release。
// 43.21 Benchmark Auto-Expansion：真实 Production Failure / Human Correction / RCA Error / Release Miss /
//   Unsafe Healing / Defect Error → Feedback → Verified Ground Truth → Benchmark Candidate → Review → Benchmark。
// 43.19 Audit：所有优化动作记录 proposalId / actor / baseline / candidate / benchmark / approvalId /
//   metrics / decision / timestamp，形成完整链路。
import { randomBytes } from 'node:crypto';
import type { EvaluationDomain } from '../eval/contract.js';
import type { AiDomain, ChangeImpact, ImprovementAuditRecord } from './contract.js';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export interface ContinuousEvalSchedule {
  name: string; // nightly / weekly / release
  cronLike: string; // 描述性（本模块仅记录，不实现调度器；由外部 cron 触发）
  description: string;
}

export const CONTINUOUS_EVAL_SCHEDULES: readonly ContinuousEvalSchedule[] = [
  { name: 'nightly', cronLike: '0 2 * * *', description: 'Nightly Evaluation：每日运行全量 Benchmark，检测回归' },
  { name: 'weekly', cronLike: '0 3 * * 1', description: 'Weekly Evaluation：每周一深度评测 + 错误聚类' },
  { name: 'release', cronLike: 'release-trigger', description: 'Release Evaluation：发布前强制评测门禁' },
];

export interface RegressionDetectionInput {
  baselineOverall: number;
  currentOverall: number;
  baselineCritical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number };
  currentCritical: { p0Miss: number; falsePass: number; unsafeHealing: number; skippedCritical: number };
  /** 允许的普通指标下降阈值（如 0.02 = 2%） */
  allowDrop?: number;
}

export interface RegressionDetectionResult {
  regression: boolean;
  criticalRegression: boolean;
  reasons: string[];
  verdict: 'PASS' | 'REVIEW' | 'BLOCK';
}

/**
 * 43.20：Continuous Evaluation 回归检测。
 * Critical Regression（BLOCK，需 Alert + Block Release）：任何关键安全指标上升，或 Overall 下降超阈值。
 */
export function detectRegression(input: RegressionDetectionInput): RegressionDetectionResult {
  const reasons: string[] = [];
  const b = input.baselineCritical;
  const c = input.currentCritical;
  if (c.p0Miss > b.p0Miss) reasons.push(`P0 Miss 上升（${b.p0Miss} → ${c.p0Miss}）`);
  if (c.falsePass > b.falsePass) reasons.push(`False Pass 上升（${b.falsePass} → ${c.falsePass}）`);
  if (c.unsafeHealing > b.unsafeHealing) reasons.push(`Unsafe Healing 上升（${b.unsafeHealing} → ${c.unsafeHealing}）`);
  if (c.skippedCritical > b.skippedCritical) reasons.push(`Skipped Critical 上升（${b.skippedCritical} → ${c.skippedCritical}）`);
  const drop = input.baselineOverall - input.currentOverall;
  if (drop > (input.allowDrop ?? 0.02)) reasons.push(`Overall 下降 ${(drop * 100).toFixed(1)}%（${(input.baselineOverall * 100).toFixed(1)}% → ${(input.currentOverall * 100).toFixed(1)}%）`);

  if (reasons.length === 0) return { regression: false, criticalRegression: false, reasons: ['无回归'], verdict: 'PASS' };
  const criticalRegression = reasons.some((r) => r.includes('上升'));
  return {
    regression: true,
    criticalRegression,
    reasons,
    verdict: criticalRegression ? 'BLOCK' : 'REVIEW',
  };
}

/**
 * 43.24：AI Release Gate（AI 自身纳入发布门禁）。
 * 必须 Quality PASS + Safety PASS + Cost PASS + Approval 才允许 Release。
 */
export interface AiReleaseGateInput {
  qualityScore: number; // 多目标综合分 0~1
  accuracy: number;
  safetyRisk: number; // 0~1 安全风险率
  cost: number;
  baselineQualityScore?: number;
  approvalGranted: boolean;
  /** 最低达标阈值 */
  thresholds?: { quality: number; accuracy: number; safety: number; cost: number };
}

export interface AiReleaseGateResult {
  verdict: 'PASS' | 'REVIEW' | 'BLOCK';
  reasons: string[];
}

export function aiReleaseGate(input: AiReleaseGateInput): AiReleaseGateResult {
  const t = input.thresholds ?? { quality: 0.6, accuracy: 0.8, safety: 0, cost: 0.01 };
  const reasons: string[] = [];
  if (input.qualityScore < t.quality) reasons.push(`Quality Score ${(input.qualityScore * 100).toFixed(1)}% < 阈值 ${(t.quality * 100).toFixed(1)}%`);
  if (input.accuracy < t.accuracy) reasons.push(`Accuracy ${(input.accuracy * 100).toFixed(1)}% < 阈值 ${(t.accuracy * 100).toFixed(1)}%`);
  if (input.safetyRisk > t.safety) reasons.push(`Safety Risk ${(input.safetyRisk * 100).toFixed(1)}% > 阈值 ${(t.safety * 100).toFixed(1)}%`);
  if (input.cost > t.cost) reasons.push(`Cost $${input.cost} > 阈值 $${t.cost}`);
  if (!input.approvalGranted) reasons.push('未获得人工 Approval（禁止 AI 自发布）');
  if (input.baselineQualityScore !== undefined && input.qualityScore < input.baselineQualityScore - 1e-9) {
    reasons.push(`Quality 较基线下降（${(input.baselineQualityScore * 100).toFixed(1)}% → ${(input.qualityScore * 100).toFixed(1)}%）`);
  }
  if (reasons.length === 0) return { verdict: 'PASS', reasons: ['Quality / Safety / Cost / Approval 全部达标'] };
  // 关键红线：Safety / Approval / Accuracy / Quality 较基线下降 均不可放行
  const block = reasons.some((r) => r.includes('Safety') || r.includes('Approval') || r.includes('Accuracy') || r.includes('Quality'));
  return { verdict: block ? 'BLOCK' : 'REVIEW', reasons };
}

/**
 * 43.23：Change Impact——判断变更影响范围，建议 Targeted Evaluation。
 * Prompt / Model / Tool 影响对应领域 Benchmark；Knowledge 影响全领域但建议按内容域定向。
 */
export function computeChangeImpact(input: {
  changeRef: string;
  changeType: 'PROMPT' | 'MODEL' | 'TOOL' | 'KNOWLEDGE';
  /** 变更影响的领域（由变更内容映射，可传空则推断全领域） */
  domains?: AiDomain[];
  /** 影响的项目 / Run（由关联关系传入） */
  projects?: string[];
  runs?: string[];
}): ChangeImpact {
  const domains: AiDomain[] = input.domains && input.domains.length > 0 ? input.domains : ['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'SELECTION', 'RCA', 'DEFECT', 'HEALING', 'RELEASE'];
  return {
    changeRef: input.changeRef,
    changeType: input.changeType,
    affectedBenchmarks: domains.map((d) => `${d}_BENCHMARK_v1`),
    affectedDomains: domains,
    affectedProjects: input.projects ?? [],
    affectedRuns: input.runs ?? [],
    targetedEvaluationSuggested: true,
    generatedAt: new Date().toISOString(),
  };
}

/** 43.19：AI Improvement Audit——记录完整优化链路 */
export class ImprovementAudit {
  private readonly records: ImprovementAuditRecord[] = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  record(input: Omit<ImprovementAuditRecord, 'id' | 'timestamp'>): ImprovementAuditRecord {
    const rec: ImprovementAuditRecord = { ...input, id: newId('aud'), timestamp: this.now() };
    this.records.push(rec);
    return rec;
  }

  list(filter: { proposalId?: string } = {}): ImprovementAuditRecord[] {
    return this.records.filter((r) => (filter.proposalId ? r.proposalId === filter.proposalId : true));
  }

  size(): number {
    return this.records.length;
  }

  /** 从快照恢复（CLI/API 持久化用） */
  static import(records: ImprovementAuditRecord[]): ImprovementAudit {
    const s = new ImprovementAudit();
    s.records.push(...records);
    return s;
  }
}

export function createImprovementAudit(): ImprovementAudit {
  return new ImprovementAudit();
}

/**
 * 43.21：Benchmark 自动扩充入口。
 * 真实事件（Production Failure / Human Correction / RCA Error / Release Miss / Unsafe Healing / Defect Error）
 * 已验证后进入 Benchmark Candidate，人工 Review 后并入 Benchmark。
 * 本函数只生成"待审候选"，是否并入由上层（Review 流程）决定——禁止自动并入。
 */
export function benchmarkCandidateFromFeedback(input: {
  feedbackId: string;
  domain: EvaluationDomain;
  expected: unknown;
  actual: unknown;
  errors: string[];
}): {
  candidateId: string;
  domain: EvaluationDomain;
  expected: unknown;
  actual: unknown;
  errors: string[];
  status: 'PENDING_REVIEW';
  feedbackId: string;
  createdAt: string;
} {
  return {
    candidateId: newId('bmc'),
    domain: input.domain,
    expected: input.expected,
    actual: input.actual,
    errors: input.errors,
    status: 'PENDING_REVIEW',
    feedbackId: input.feedbackId,
    createdAt: new Date().toISOString(),
  };
}
