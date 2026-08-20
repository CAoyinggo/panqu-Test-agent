// Improvement Proposal（Phase 46 / 43.5 + 43.6 + 43.11 + 43.19 部分）
// 根据 Error Cluster 自动生成 Improvement Proposal；必须离线评测（Sandbox → Benchmark →
// Compare Baseline → Regression → Approval → Activate）后才允许上线，禁止：
//   发现问题 → 直接修改生产 Prompt。
// Improvement Gate（43.11）：Candidate 必须满足 Critical Safety / Critical Accuracy 不下降、
// False Pass / Unsafe Healing 不增加，且普通指标达到阈值才允许进入 Approval。
import { randomBytes } from 'node:crypto';
import type { ErrorCluster, ImprovementProposal, ImprovementTarget, ProposalRisk } from './contract.js';
import { ERROR_TAXONOMY_LABELS } from './contract.js';

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export interface CreateProposalInput {
  clusterId?: string;
  domain?: string;
  category?: string;
  target: ImprovementTarget;
  problem: string;
  hypothesis: string;
  expectedImprovement: string;
  risk: ProposalRisk;
  evidence?: unknown[];
}

/** 从 ErrorCluster 自动生成提案（43.5）：确定性映射 cluster → 提案骨架 */
export function proposalFromCluster(cluster: ErrorCluster, now: string = new Date().toISOString()): ImprovementProposal {
  const target = targetForCluster(cluster);
  const problem = `[${cluster.domain}] ${ERROR_TAXONOMY_LABELS[cluster.category]} 出现 ${cluster.count} 次（用例 ${cluster.cases.slice(0, 5).join(', ')}${cluster.cases.length > 5 ? ' 等' : ''}）`;
  const hypothesis = cluster.suspectedCause ?? '需进一步离线评测验证';
  return {
    id: newId('imp'),
    clusterId: cluster.id,
    target,
    problem,
    hypothesis,
    expectedImprovement: `降低 ${cluster.domain} 领域 ${ERROR_TAXONOMY_LABELS[cluster.category]} 发生率`,
    risk: riskForCluster(cluster),
    evidence: cluster.evidence.slice(0, 20),
    status: 'PROPOSED',
    createdAt: now,
    updatedAt: now,
  };
}

/** 目标映射：不同错误分类优先改进不同组件（确定性） */
export function targetForCluster(cluster: ErrorCluster): ImprovementTarget {
  switch (cluster.category) {
    case 'UNSAFE':
      return 'RULE';      // 自愈安全 → 规则层
    case 'DUPLICATE':
      return 'RULE';      // 去重 → 规则
    case 'UNDER_PREDICTION':
      return 'RULE';      // 漏判 → 规则阈值
    case 'OVER_PREDICTION':
      return 'RULE';
    case 'MISSING':
      return 'PROMPT';    // 覆盖不全 → Prompt
    case 'WRONG':
      return 'PROMPT';
    case 'INCONSISTENT':
      return 'PROMPT';
    default:
      return 'PROMPT';
  }
}

/** 风险等级：安全类错误聚类 → HIGH，其余 MEDIUM/LOW（确定性） */
export function riskForCluster(cluster: ErrorCluster): ProposalRisk {
  if (cluster.category === 'UNSAFE') return 'HIGH';
  if (cluster.category === 'UNDER_PREDICTION' && cluster.domain === 'RELEASE') return 'HIGH';
  if (cluster.count >= 5) return 'MEDIUM';
  return 'LOW';
}

export interface ImprovementGateInput {
  baselineScore: number;
  candidateScore: number;
  /** 关键安全指标（必须不下降 / 不增加） */
  critical?: {
    falsePass: number;
    unsafeHealing: number;
    p0Miss: number;
  };
  /** 普通指标变化（可选阈值） */
  qualityDelta?: number;
}

export interface ImprovementGateResult {
  verdict: 'PASS' | 'REVIEW' | 'BLOCK';
  reasons: string[];
}

/**
 * Improvement Gate（43.11）：
 * BLOCK（任一触发）：
 *   - Critical Safety 上升（falsePass / unsafeHealing / p0Miss 任一 > 0）
 *   - Critical Accuracy 下降（candidate < baseline）
 * REVIEW：小幅下降 / 提升不足阈值
 * PASS：candidate ≥ baseline 且 critical 安全
 */
export function runImprovementGate(input: ImprovementGateInput): ImprovementGateResult {
  const reasons: string[] = [];
  const critical = input.critical ?? { falsePass: 0, unsafeHealing: 0, p0Miss: 0 };

  if (critical.falsePass > 0) reasons.push(`False Pass 增加（${critical.falsePass}），违反关键安全红线`);
  if (critical.unsafeHealing > 0) reasons.push(`Unsafe Healing 增加（${critical.unsafeHealing}），违反关键安全红线`);
  if (critical.p0Miss > 0) reasons.push(`P0 Miss 增加（${critical.p0Miss}），违反关键安全红线`);

  if (input.candidateScore < input.baselineScore - 1e-9) {
    reasons.push(`候选精度下降（${fmtPct(input.baselineScore)} → ${fmtPct(input.candidateScore)}），Critical Accuracy 不得下降`);
  }

  if (reasons.some((r) => r.includes('红线'))) return { verdict: 'BLOCK', reasons };

  if (input.candidateScore < input.baselineScore - 1e-9) {
    return { verdict: 'BLOCK', reasons };
  }

  // 有提升或持平 → PASS；提升不足阈值且无显著提升 → REVIEW（提示阈值由调用方控制）
  const delta = input.candidateScore - input.baselineScore;
  if (input.qualityDelta !== undefined && delta < input.qualityDelta) {
    reasons.push(`精度提升 ${fmtPct(delta)} 未达预设阈值 ${fmtPct(input.qualityDelta)}`);
    return { verdict: 'REVIEW', reasons };
  }
  reasons.push(`候选精度 ${fmtPct(input.candidateScore)} ≥ 基线 ${fmtPct(input.baselineScore)}（Δ${fmtPct(delta)}），且关键安全指标达标`);
  return { verdict: 'PASS', reasons };
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export interface ProposalStoreOptions {
  now?: () => string;
}

/** 提案生命周期管理（含审批状态机；审批必须人工，AI 不能自批） */
export class ProposalStore {
  private readonly items = new Map<string, ImprovementProposal>();

  constructor(private readonly opts: ProposalStoreOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  create(input: CreateProposalInput | ImprovementProposal): ImprovementProposal {
    const now = this.now();
    const p: ImprovementProposal =
      'id' in input && typeof input.id === 'string'
        ? { ...input, updatedAt: now }
        : {
            id: newId('imp'),
            clusterId: input.clusterId,
            target: input.target,
            problem: input.problem,
            hypothesis: input.hypothesis,
            expectedImprovement: input.expectedImprovement,
            risk: input.risk,
            evidence: input.evidence ?? [],
            status: 'PROPOSED',
            createdAt: now,
            updatedAt: now,
          };
    this.items.set(p.id, p);
    return p;
  }

  get(id: string): ImprovementProposal | null {
    return this.items.get(id) ?? null;
  }

  list(filter: { status?: string; target?: string; domain?: string } = {}): ImprovementProposal[] {
    return [...this.items.values()].filter((p) => {
      if (filter.status && p.status !== filter.status) return false;
      if (filter.target && p.target !== filter.target) return false;
      if (filter.domain && p.clusterId) {
        const cl = this.clusterDomain.get(p.clusterId);
        if (cl && cl !== filter.domain) return false;
      }
      return true;
    });
  }

  /** 附注：cluster → domain 映射（供筛选） */
  clusterDomain = new Map<string, string>();

  /** 从快照恢复（CLI/API 持久化用） */
  static import(items: ImprovementProposal[], clusterDomain?: Record<string, string>): ProposalStore {
    const s = new ProposalStore();
    for (const p of items) s.items.set(p.id, p);
    if (clusterDomain) for (const [k, v] of Object.entries(clusterDomain)) s.clusterDomain.set(k, v);
    return s;
  }

  /** 评估结果登记（43.6 离线评测后） */
  recordEvaluation(
    id: string,
    input: {
      baselineScore: number;
      candidateScore: number;
      benchmark: string;
      benchmarkVersion: string;
      critical?: ImprovementGateInput['critical'];
      qualityDelta?: number;
      qualityScore?: number;
    },
  ): ImprovementProposal {
    const p = this.items.get(id);
    if (!p) throw new Error(`提案不存在：${id}`);
    const gate = runImprovementGate({
      baselineScore: input.baselineScore,
      candidateScore: input.candidateScore,
      critical: input.critical,
      qualityDelta: input.qualityDelta,
    });
    p.baselineScore = input.baselineScore;
    p.candidateScore = input.candidateScore;
    p.benchmark = input.benchmark;
    p.benchmarkVersion = input.benchmarkVersion;
    p.qualityScore = input.qualityScore;
    p.gateVerdict = gate.verdict;
    p.status = gate.verdict === 'BLOCK' ? 'REJECTED' : 'EVALUATING';
    p.updatedAt = this.now();
    return p;
  }

  /** 人工审批（43.x Human Approval）：approve / reject；禁止 AI 自批 */
  approve(id: string, by: string): ImprovementProposal {
    const p = this.items.get(id);
    if (!p) throw new Error(`提案不存在：${id}`);
    if (p.status !== 'EVALUATING' || p.gateVerdict !== 'PASS') {
      throw new Error(`提案 ${id} 不可审批：需先 EVALUATING 且 Gate=PASS（当前 ${p.status}/${p.gateVerdict}）`);
    }
    p.status = 'APPROVED';
    p.approvedBy = by;
    p.approvedAt = this.now();
    p.approvalId = newId('apv');
    p.updatedAt = this.now();
    return p;
  }

  reject(id: string, by: string, reason: string): ImprovementProposal {
    const p = this.items.get(id);
    if (!p) throw new Error(`提案不存在：${id}`);
    p.status = 'REJECTED';
    p.rejectedReason = reason;
    p.updatedAt = this.now();
    return p;
  }

  /** 激活（approve 之后由人工确认/实验通过后调用） */
  activate(id: string, by: string, experimentId?: string): ImprovementProposal {
    const p = this.items.get(id);
    if (!p) throw new Error(`提案不存在：${id}`);
    if (p.status !== 'APPROVED') throw new Error(`提案 ${id} 未审批，禁止激活`);
    p.status = 'ACTIVATED';
    p.experimentId = experimentId;
    p.updatedAt = this.now();
    return p;
  }

  /** 回滚（43.12）：质量回归时自动回滚，恢复基线 */
  rollback(id: string, reason: string): ImprovementProposal {
    const p = this.items.get(id);
    if (!p) throw new Error(`提案不存在：${id}`);
    p.status = 'ROLLED_BACK';
    p.updatedAt = this.now();
    return p;
  }

  size(): number {
    return this.items.size;
  }
}

export function createProposalStore(): ProposalStore {
  return new ProposalStore();
}
