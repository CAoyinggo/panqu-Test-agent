// Knowledge Schema：知识条目模型（Phase 21.5 Knowledge Optimization）
// 每条知识携带 confidence / usageCount / lastUsedAt / source / validUntil，
// 支持 ACTIVE → STALE → EXPIRED 生命周期，避免 Memory 越积越脏。

/** 知识类型 */
export type KnowledgeType =
  | 'known-issue'       // 已知问题
  | 'failure-pattern'   // 失败模式
  | 'risk-insight'      // 风险洞察（历史失败率等）
  | 'test-insight'      // 测试经验（用例设计/数据）
  | 'environment-fact'; // 环境事实

export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = [
  'known-issue', 'failure-pattern', 'risk-insight', 'test-insight', 'environment-fact',
];

/** 知识生命周期状态 */
export type KnowledgeStatus = 'ACTIVE' | 'STALE' | 'EXPIRED';

/** 知识条目 */
export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  feature: string;
  title: string;
  /** 知识内容描述 */
  content: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 被引用次数（检索命中决策时 +1） */
  usageCount: number;
  /** 最近被引用时间 */
  lastUsedAt?: string;
  /** 来源：RCA / execution / healing / manual */
  source: string;
  /** 有效期（ISO，过期进入 EXPIRED） */
  validUntil?: string;
  status: KnowledgeStatus;
  tags: string[];
  /** 决策用统计数据（如 { runs: 30, failures: 11 }） */
  stats?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 创建知识输入 */
export interface CreateKnowledgeInput {
  id?: string;
  type: KnowledgeType;
  feature: string;
  title: string;
  content?: string;
  confidence?: number;
  source?: string;
  validUntil?: string;
  tags?: string[];
  stats?: Record<string, unknown>;
}

let kbSeq = 0;

/** 生成知识 id */
export function generateKnowledgeId(feature: string): string {
  kbSeq += 1;
  const feat = (feature || 'general').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 16);
  return `kb-${feat}-${String(kbSeq).padStart(4, '0')}`;
}

/** 校验并归一化创建输入：非法抛错 */
export function normalizeCreateKnowledgeInput(input: unknown): CreateKnowledgeInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Knowledge 创建失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.type || !KNOWLEDGE_TYPES.includes(raw.type as KnowledgeType)) {
    throw new Error(`Knowledge 创建失败：type 无效（需为 ${KNOWLEDGE_TYPES.join(' / ')}）`);
  }
  if (!raw.feature || typeof raw.feature !== 'string') throw new Error('Knowledge 创建失败：缺少 feature');
  if (!raw.title || typeof raw.title !== 'string') throw new Error('Knowledge 创建失败：缺少 title');
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
  if (confidence < 0 || confidence > 1) throw new Error('Knowledge 创建失败：confidence 需在 0~1');
  const out: CreateKnowledgeInput = {
    type: raw.type as KnowledgeType,
    feature: String(raw.feature).trim(),
    title: String(raw.title).trim(),
    content: typeof raw.content === 'string' ? raw.content : '',
    confidence,
    source: typeof raw.source === 'string' ? raw.source : 'manual',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
  };
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
  if (typeof raw.validUntil === 'string') out.validUntil = raw.validUntil;
  if (typeof raw.stats === 'object' && raw.stats !== null) out.stats = raw.stats as Record<string, unknown>;
  return out;
}
