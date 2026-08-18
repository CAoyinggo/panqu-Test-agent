// Defect Lifecycle Schema：缺陷生命周期状态机（Phase 21.4）
// 状态流：DRAFT → REVIEW → CREATED → ASSIGNED → FIXING → FIXED → REGRESSION → VERIFIED → CLOSED
// 处置：Known Issue / Duplicate / Won't Fix / Fixed / Regression Failed。

/** 缺陷生命周期状态 */
export type DefectStatus =
  | 'DRAFT'
  | 'REVIEW'
  | 'CREATED'
  | 'ASSIGNED'
  | 'FIXING'
  | 'FIXED'
  | 'REGRESSION'
  | 'VERIFIED'
  | 'CLOSED';

export const DEFECT_STATUSES: readonly DefectStatus[] = [
  'DRAFT', 'REVIEW', 'CREATED', 'ASSIGNED', 'FIXING', 'FIXED', 'REGRESSION', 'VERIFIED', 'CLOSED',
];

/** 缺陷处置结论 */
export type DefectResolution =
  | 'FIXED'               // 已修复
  | 'KNOWN_ISSUE'         // 已知问题（不重复提单）
  | 'DUPLICATE'           // 与已有 Bug 重复
  | 'WONT_FIX'            // 不予修复
  | 'REGRESSION_FAILED';  // 修复后回归失败（重开）

/** 合法状态迁移表 */
export const DEFECT_TRANSITIONS: Record<DefectStatus, readonly DefectStatus[]> = {
  DRAFT: ['REVIEW', 'CLOSED'],
  REVIEW: ['CREATED', 'CLOSED'],
  CREATED: ['ASSIGNED', 'CLOSED'],
  ASSIGNED: ['FIXING', 'CLOSED'],
  FIXING: ['FIXED', 'ASSIGNED'],
  FIXED: ['REGRESSION', 'VERIFIED'],
  REGRESSION: ['VERIFIED', 'FIXING'],   // 回归失败 → 重开回 FIXING
  VERIFIED: ['CLOSED'],
  CLOSED: [],
};

/** 判断状态迁移是否合法 */
export function canTransition(from: DefectStatus, to: DefectStatus): boolean {
  return (DEFECT_TRANSITIONS[from] ?? []).includes(to);
}

/** 状态迁移记录 */
export interface DefectHistoryEntry {
  from: DefectStatus;
  to: DefectStatus;
  at: string;
  note?: string;
}

/** 生命周期缺陷记录 */
export interface DefectRecord {
  id: string;
  feature: string;
  title: string;
  severity: string;
  status: DefectStatus;
  /** 处置结论（CLOSED / FIXED 时必填） */
  resolution?: DefectResolution;
  /** Duplicate 时指向的已有 Bug id */
  duplicateOf?: string;
  /** 关联用例 id */
  relatedCases: string[];
  /** 失败签名（重复判定用，规范化后的错误特征） */
  failureSignature?: string;
  /** 根因类别（RCA category，重复判定用） */
  category?: string;
  history: DefectHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** 从 Defect Draft 摄入生命周期 */
export interface IngestDefectInput {
  id?: string;
  feature: string;
  title: string;
  severity?: string;
  relatedCases?: string[];
  failureSignature?: string;
  category?: string;
}

/** 校验摄入输入 */
export function normalizeIngestInput(input: unknown): IngestDefectInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Defect 摄入失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.feature || typeof raw.feature !== 'string') throw new Error('Defect 摄入失败：缺少 feature');
  if (!raw.title || typeof raw.title !== 'string') throw new Error('Defect 摄入失败：缺少 title');
  const out: IngestDefectInput = {
    feature: String(raw.feature).trim(),
    title: String(raw.title).trim(),
    severity: typeof raw.severity === 'string' ? raw.severity : 'P2',
    relatedCases: Array.isArray(raw.relatedCases)
      ? raw.relatedCases.filter((c): c is string => typeof c === 'string')
      : [],
  };
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
  if (typeof raw.failureSignature === 'string') out.failureSignature = raw.failureSignature;
  if (typeof raw.category === 'string') out.category = raw.category;
  return out;
}
