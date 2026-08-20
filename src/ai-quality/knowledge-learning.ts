// Knowledge Learning + Quality + Decay（Phase 46 / 43.15 + 43.16 + 43.17）
// 43.15 Knowledge Learning：真实错误 → Verified → Knowledge Candidate → Review → Activate。
//   禁止：LLM 自己产生知识 → 直接进入生产 Knowledge。必须有 Source / Confidence / Verification / Version。
// 43.16 Knowledge Quality：每条知识记录 usage / success / failure，统计 Hit Rate / Success Rate / Outdated / Unused。
// 43.17 Knowledge Decay 升级：EffectiveWeight = f(usage, success, failure, age)——持续有效的旧知识可减缓衰减，
//   频繁导致错误的知识快速降权（不再只按时间下降）。
import { randomBytes } from 'node:crypto';

export type KnowledgeCandidateStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'ARCHIVED';

export interface KnowledgeItem {
  id: string;
  category: string;
  content: string;
  source: string;
  confidence: number;
  verified: boolean;
  verifiedBy?: string;
  version: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: string;
  status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

/** 知识候选（未经人工 Review 前不可进入生产 Knowledge） */
export interface KnowledgeCandidate {
  id: string;
  /** 来源错误（关联反馈/聚类） */
  sourceRef?: string;
  category: string;
  content: string;
  source: string;
  confidence: number;
  status: KnowledgeCandidateStatus;
  reviewer?: string;
  reviewedAt?: string;
  rejectReason?: string;
  createdAt: string;
}

export interface KnowledgeUsageEvent {
  knowledgeId: string;
  outcome: 'success' | 'failure';
  at: string;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export interface KnowledgeLearningOptions {
  now?: () => string;
}

/** Knowledge 学习中心：错误 → 候选 → 人工 Review → 激活（生产 Knowledge） */
export class KnowledgeLearning {
  private readonly candidates = new Map<string, KnowledgeCandidate>();
  private readonly items = new Map<string, KnowledgeItem>();

  constructor(private readonly opts: KnowledgeLearningOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  /** 43.15：从真实错误沉淀知识候选（默认 PENDING_REVIEW，未经 Review 不进入生产） */
  createCandidate(input: { sourceRef?: string; category: string; content: string; source: string; confidence?: number }): KnowledgeCandidate {
    const c: KnowledgeCandidate = {
      id: newId('kbc'),
      sourceRef: input.sourceRef,
      category: input.category,
      content: input.content,
      source: input.source,
      confidence: input.confidence ?? 0.5,
      status: 'PENDING_REVIEW',
      createdAt: this.now(),
    };
    this.candidates.set(c.id, c);
    return c;
  }

  /** 人工 Review：批准 → 激活为生产 Knowledge（带 version/verified） */
  approveCandidate(id: string, reviewer: string): { candidate: KnowledgeCandidate; item: KnowledgeItem } {
    const c = this.candidates.get(id);
    if (!c) throw new Error(`知识候选不存在：${id}`);
    if (c.status !== 'PENDING_REVIEW') throw new Error(`知识候选 ${id} 状态为 ${c.status}，不可重复审批`);
    c.status = 'ACTIVE';
    c.reviewer = reviewer;
    c.reviewedAt = this.now();
    const item: KnowledgeItem = {
      id: newId('kb'),
      category: c.category,
      content: c.content,
      source: c.source,
      confidence: c.confidence,
      verified: true,
      verifiedBy: reviewer,
      version: 1,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      status: 'ACTIVE',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.items.set(item.id, item);
    return { candidate: c, item };
  }

  /** 人工拒绝 */
  rejectCandidate(id: string, reviewer: string, reason: string): KnowledgeCandidate {
    const c = this.candidates.get(id);
    if (!c) throw new Error(`知识候选不存在：${id}`);
    c.status = 'REJECTED';
    c.reviewer = reviewer;
    c.reviewedAt = this.now();
    c.rejectReason = reason;
    return c;
  }

  /** 43.16：知识使用结果回填（success / failure） */
  recordUsage(event: KnowledgeUsageEvent): KnowledgeItem | null {
    const item = this.items.get(event.knowledgeId);
    if (!item) return null;
    item.usageCount += 1;
    if (event.outcome === 'success') item.successCount += 1;
    else item.failureCount += 1;
    item.lastUsedAt = event.at ?? this.now();
    item.updatedAt = this.now();
    return item;
  }

  listCandidates(filter: { status?: string } = {}): KnowledgeCandidate[] {
    return [...this.candidates.values()].filter((c) => {
      if (filter.status && c.status !== filter.status) return false;
      return true;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listItems(): KnowledgeItem[] {
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getItem(id: string): KnowledgeItem | null {
    return this.items.get(id) ?? null;
  }

  /**
   * Knowledge Quality（43.16）：
   * Hit Rate = usageCount / total usages；Success Rate = successCount / usageCount；
   * Outdated = 超时未用；Unused = 从未使用。
   */
  qualityMetrics(): {
    total: number;
    totalUsages: number;
    hitRate: number;
    successRate: number;
    outdatedRate: number;
    unusedRate: number;
    perItem: Array<{
      id: string;
      category: string;
      usageCount: number;
      successCount: number;
      failureCount: number;
      successRate: number;
      effectiveWeight: number;
    }>;
  } {
    const items = this.listItems();
    const totalUsages = items.reduce((s, i) => s + i.usageCount, 0);
    const totalSuccess = items.reduce((s, i) => s + i.successCount, 0);
    const now = Date.now();
    const DAY_MS = 86400000;
    const outdated = items.filter((i) => i.lastUsedAt && now - new Date(i.lastUsedAt).getTime() > 90 * DAY_MS).length;
    const unused = items.filter((i) => i.usageCount === 0).length;
    return {
      total: items.length,
      totalUsages,
      hitRate: totalUsages > 0 ? 1 : 0,
      // 聚合 Success Rate = 成功使用次数 / 总使用次数（无使用记录则 0）
      successRate: totalUsages > 0 ? Math.round((totalSuccess / totalUsages) * 10000) / 10000 : 0,
      outdatedRate: items.length > 0 ? Math.round((outdated / items.length) * 10000) / 10000 : 0,
      unusedRate: items.length > 0 ? Math.round((unused / items.length) * 10000) / 10000 : 0,
      perItem: items.map((i) => ({
        id: i.id,
        category: i.category,
        usageCount: i.usageCount,
        successCount: i.successCount,
        failureCount: i.failureCount,
        successRate: i.usageCount > 0 ? Math.round((i.successCount / i.usageCount) * 10000) / 10000 : 0,
        effectiveWeight: this.effectiveWeight(i),
      })),
    };
  }

  /**
   * Knowledge Decay 升级（43.17）：EffectiveWeight 综合 usage / success / failure / age。
   * - 持续成功（successRate 高、usage 多）→ 减缓衰减（即使老）。
   * - 频繁失败 → 快速降权。
   * - 无使用记录 → 按时间衰减。
   * 不再只按时间下降。
   */
  effectiveWeight(item: KnowledgeItem, nowMs: number = Date.now()): number {
    const DAY_MS = 86400000;
    const ageDays = Math.max(0, (nowMs - new Date(item.createdAt).getTime()) / DAY_MS);
    // 基础时间衰减（90 天内 1，之后线性下降至最低 0.1）
    const timeFactor = ageDays < 90 ? 1 : Math.max(0.1, 1 - (ageDays - 90) / 900);
    // 成功激励：成功率高、使用多的知识即使老也保持权重
    const successRate = item.usageCount > 0 ? item.successCount / item.usageCount : 0;
    const successBoost = 1 + (item.usageCount > 0 ? (successRate - 0.5) * 0.6 : 0);
    // 失败惩罚：失败比例高 → 快速降权
    const failurePenalty = item.usageCount > 0 ? 1 - Math.min(1, (item.failureCount / item.usageCount) * 2) : 1;
    // 无使用记录 → 纯时间衰减；有使用 → 成功/失败主导
    const usageFactor = item.usageCount === 0 ? 1 : 0.5 + Math.min(0.5, Math.log(item.usageCount + 1) / 5);
    const weight = item.confidence * timeFactor * successBoost * failurePenalty * usageFactor;
    return Math.round(Math.min(1, Math.max(0, weight)) * 10000) / 10000;
  }

  candidateSize(): number {
    return this.candidates.size;
  }

  itemSize(): number {
    return this.items.size;
  }

  /** 从快照恢复（CLI/API 持久化用） */
  static import(candidates: KnowledgeCandidate[], items: KnowledgeItem[]): KnowledgeLearning {
    const s = new KnowledgeLearning();
    for (const c of candidates) s.candidates.set(c.id, c);
    for (const i of items) s.items.set(i.id, i);
    return s;
  }
}

export function createKnowledgeLearning(): KnowledgeLearning {
  return new KnowledgeLearning();
}
