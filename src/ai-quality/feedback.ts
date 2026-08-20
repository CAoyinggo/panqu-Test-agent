// Feedback Registry（Phase 46 / 43.1 + 43.2 + 43.3）
// 统一 AI 反馈注册中心：所有模块（Human Correction / RCA Verification / Defect Review /
// Release Review / Healing Review / Benchmark Failure / Production Incident / Flaky
// Confirmation）共用同一 AIFeedback 结构，禁止各自维护不同的 Feedback 结构。
// Error Taxonomy：从 AIFeedback 自动推导错误类型（WRONG / MISSING / OVER_PREDICTION /
// UNDER_PREDICTION / DUPLICATE / UNSAFE / INCONSISTENT / LOW_VALUE）。
import { randomBytes } from 'node:crypto';
import {
  ERROR_TAXONOMY,
  type AIFeedback,
  type CreateFeedbackInput,
  type ErrorTaxonomy,
  type FeedbackChannel,
  type FeedbackSource,
  type FeedbackType,
} from './contract.js';

function newId(): string {
  return `fb-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** 校验并归一化创建输入（非法抛错） */
export function normalizeCreateFeedbackInput(input: unknown): CreateFeedbackInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Feedback 创建失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  const domain = String(raw.domain ?? '').toUpperCase();
  const validDomains = ['REQUIREMENT', 'TEST_DESIGN', 'RISK', 'SELECTION', 'RCA', 'DEFECT', 'HEALING', 'RELEASE'];
  if (!validDomains.includes(domain)) {
    throw new Error(`Feedback 创建失败：domain 无效（需为 ${validDomains.join(' / ')}）`);
  }
  const feedbackType = String(raw.feedbackType ?? '').toUpperCase();
  if (!['CORRECT', 'INCORRECT', 'PARTIAL', 'UNSAFE', 'MISSING', 'DUPLICATE'].includes(feedbackType)) {
    throw new Error(`Feedback 创建失败：feedbackType 无效（CORRECT / INCORRECT / PARTIAL / UNSAFE / MISSING / DUPLICATE）`);
  }
  const source = String(raw.source ?? '').toUpperCase();
  if (!['HUMAN', 'PRODUCTION', 'EVALUATION', 'SYSTEM'].includes(source)) {
    throw new Error(`Feedback 创建失败：source 无效（HUMAN / PRODUCTION / EVALUATION / SYSTEM）`);
  }
  const out: CreateFeedbackInput = {
    domain: domain as AIFeedback['domain'],
    prediction: raw.prediction,
    actual: raw.actual,
    feedbackType: feedbackType as FeedbackType,
    source: source as FeedbackSource,
  };
  if (typeof raw.runId === 'string' && raw.runId.trim()) out.runId = raw.runId.trim();
  if (typeof raw.caseId === 'string' && raw.caseId.trim()) out.caseId = raw.caseId.trim();
  if (typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1) out.confidence = raw.confidence;
  if (typeof raw.note === 'string') out.note = raw.note;
  const channel = String(raw.channel ?? '').toUpperCase();
  if (['HUMAN_CORRECTION', 'RCA_VERIFICATION', 'DEFECT_REVIEW', 'RELEASE_REVIEW', 'HEALING_REVIEW', 'BENCHMARK_FAILURE', 'PRODUCTION_INCIDENT', 'FLAKY_CONFIRMATION'].includes(channel)) {
    out.channel = channel as FeedbackChannel;
  }
  return out;
}

/**
 * Error Taxonomy 推导（43.3）：
 * 依据 feedbackType + source + 领域上下文确定错误类别。规则确定性、可复现。
 * 例：Risk P2 实际 P0 → UNDER_PREDICTION；RCA NETWORK 实际 MODEL → WRONG。
 */
export function deriveErrorTaxonomy(fb: AIFeedback): ErrorTaxonomy | null {
  if (fb.feedbackType === 'CORRECT') return null;
  switch (fb.feedbackType) {
    case 'UNSAFE':
      return 'UNSAFE';
    case 'DUPLICATE':
      return 'DUPLICATE';
    case 'MISSING':
      return 'MISSING';
    case 'INCORRECT':
      return classifyIncorrect(fb);
    case 'PARTIAL':
      // 部分命中：缺失字段 → MISSING，错误字段 → WRONG，其余 INCONSISTENT
      return 'INCONSISTENT';
    default:
      return 'WRONG';
  }
}

/** INCORRECT 细分：领域相关的确定性判定 */
function classifyIncorrect(fb: AIFeedback): ErrorTaxonomy {
  switch (fb.domain) {
    case 'RISK': {
      // 严重度档位：P0=0（最严重）... P3=3。
      // 真值比预测更严重（a < p，如预测 P2 真值 P0）→ UNDER_PREDICTION（低估漏判）；
      // 预测比真值更严重（p < a，如预测 P0 真值 P2）→ OVER_PREDICTION（虚高风险）。
      const p = sevOf(fb.prediction);
      const a = sevOf(fb.actual);
      if (p !== null && a !== null && a < p) return 'UNDER_PREDICTION';
      if (p !== null && a !== null && a > p) return 'OVER_PREDICTION';
      return 'WRONG';
    }
    case 'RELEASE': {
      // 预测 PASS 真值 BLOCK → 严重漏判（UNDER_PREDICTION）；预测 BLOCK 真值 PASS → OVER
      const pd = decisionOf(fb.prediction);
      const ad = decisionOf(fb.actual);
      if (pd === 'PASS' && ad === 'BLOCK') return 'UNDER_PREDICTION';
      if (pd === 'BLOCK' && ad === 'PASS') return 'OVER_PREDICTION';
      return 'WRONG';
    }
    case 'RCA': {
      // 根因类别不匹配 → WRONG
      return 'WRONG';
    }
    default:
      return 'WRONG';
  }
}

/** 从预测/真值对象或原始值中提取严重度档位（P0=0 ... P3=3；无法识别返回 null） */
function sevOf(v: unknown): number | null {
  const map: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  if (typeof v === 'string' && map[v] !== undefined) return map[v];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = ['severity', 'risk', 'level'];
    for (const k of keys) {
      const s = o[k];
      if (typeof s === 'string' && map[s] !== undefined) return map[s];
    }
  }
  return null;
}

/** 从预测/真值提取发布决策 */
function decisionOf(v: unknown): 'PASS' | 'BLOCK' | null {
  if (typeof v === 'string' && (v === 'PASS' || v === 'BLOCK')) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.decision === 'PASS' || o.decision === 'BLOCK') return o.decision;
  }
  return null;
}

export interface FeedbackRegistryOptions {
  now?: () => string;
}

export class FeedbackRegistry {
  private readonly items = new Map<string, AIFeedback>();

  constructor(private readonly opts: FeedbackRegistryOptions = {}) {}

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  add(input: unknown, verified = false): AIFeedback {
    const norm = normalizeCreateFeedbackInput(input);
    const fb: AIFeedback = {
      id: newId(),
      runId: norm.runId,
      caseId: norm.caseId,
      domain: norm.domain,
      prediction: norm.prediction,
      actual: norm.actual,
      feedbackType: norm.feedbackType,
      source: norm.source,
      channel: norm.channel,
      confidence: norm.confidence,
      verified,
      note: norm.note,
      createdAt: this.now(),
    };
    this.items.set(fb.id, fb);
    return fb;
  }

  get(id: string): AIFeedback | null {
    return this.items.get(id) ?? null;
  }

  list(filter: { domain?: string; source?: string; feedbackType?: string; channel?: string; verified?: boolean } = {}): AIFeedback[] {
    return [...this.items.values()]
      .filter((f) => {
        if (filter.domain && f.domain !== filter.domain) return false;
        if (filter.source && f.source !== filter.source) return false;
        if (filter.feedbackType && f.feedbackType !== filter.feedbackType) return false;
        if (filter.channel && f.channel !== filter.channel) return false;
        if (filter.verified !== undefined && f.verified !== filter.verified) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 人工核验（43.2 的 Human 环节）：标记 verified + 记录核验人 */
  verify(id: string, by: string, note?: string): AIFeedback {
    const fb = this.items.get(id);
    if (!fb) throw new Error(`Feedback 核验失败：${id} 不存在`);
    fb.verified = true;
    fb.verifiedBy = by;
    fb.verifiedAt = this.now();
    if (note) fb.note = `${fb.note ? `${fb.note}\n` : ''}${note}`;
    return fb;
  }

  /** 按错误分类统计（用于 Error Cluster 聚合） */
  classifyAll(): Array<{ fb: AIFeedback; taxonomy: ErrorTaxonomy }> {
    const out: Array<{ fb: AIFeedback; taxonomy: ErrorTaxonomy }> = [];
    for (const f of this.items.values()) {
      const t = deriveErrorTaxonomy(f);
      if (t) out.push({ fb: f, taxonomy: t });
    }
    return out;
  }

  size(): number {
    return this.items.size;
  }

  /** 快照（供持久化/序列化） */
  snapshot(): AIFeedback[] {
    return [...this.items.values()];
  }

  static import(items: AIFeedback[]): FeedbackRegistry {
    const r = new FeedbackRegistry();
    for (const it of items) r.items.set(it.id, it);
    return r;
  }
}

export function createFeedbackRegistry(): FeedbackRegistry {
  return new FeedbackRegistry();
}
