// Ground Truth Registry（Phase 45 / 42.2）
// 核心原则：没有 Ground Truth 就不能声称 Accuracy。
// 每条评测用例必须关联一条 Ground Truth 记录（source / verifiedBy / verifiedAt / confidence）。
// 没有记录 → tracked=false → score=null，禁止虚构准确率（"为了 Dashboard 好看自动给 95%" 绝对禁止）。

/** Ground Truth 来源 */
export type GroundTruthSource = 'HUMAN' | 'REAL_RUN' | 'PRODUCTION' | 'CURATED' | 'GENERATED';

export const GROUND_TRUTH_SOURCES: readonly GroundTruthSource[] = [
  'HUMAN',
  'REAL_RUN',
  'PRODUCTION',
  'CURATED',
  'GENERATED',
];

export interface GroundTruthRecord {
  id: string;
  source: GroundTruthSource;
  verifiedBy?: string;
  verifiedAt?: string;
  /** 0~1，人工核实置信度（HUMAN 通常 1；CURATED/GENERATED 由构建方声明） */
  confidence: number;
}

/** 解析来源是否为合法枚举 */
export function isGroundTruthSource(v: unknown): v is GroundTruthSource {
  return typeof v === 'string' && (GROUND_TRUTH_SOURCES as readonly string[]).includes(v);
}

/**
 * Ground Truth Registry：登记 / 查询每条用例的 Ground Truth 来源。
 * - 用例 ID 未登记 → tracked=false（score 必须为 null）。
 * - 登记但 confidence <= 0 → 视为不可追踪（防"随便标个来源"）。
 */
export class GroundTruthRegistry {
  private records = new Map<string, GroundTruthRecord>();

  constructor(initial?: GroundTruthRecord[]) {
    for (const r of initial ?? []) this.register(r);
  }

  register(record: GroundTruthRecord): this {
    if (!record || !record.id) throw new Error('GroundTruthRecord 缺少 id');
    if (!isGroundTruthSource(record.source)) throw new Error(`GroundTruth 来源非法：${String(record.source)}`);
    if (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1) {
      throw new Error(`GroundTruth confidence 必须在 0~1：${record.id}`);
    }
    this.records.set(record.id, { ...record });
    return this;
  }

  get(id: string): GroundTruthRecord | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    const r = this.records.get(id);
    return !!r && r.confidence > 0;
  }

  isTracked(id: string): boolean {
    return this.has(id);
  }

  /** 登记但 confidence 无效（<=0）的记录，视为未追踪 */
  confidence(id: string): number | null {
    const r = this.records.get(id);
    return r && r.confidence > 0 ? r.confidence : null;
  }

  get size(): number {
    return this.records.size;
  }

  list(): GroundTruthRecord[] {
    return [...this.records.values()];
  }

  /** 快照（持久化用） */
  snapshot(): GroundTruthRecord[] {
    return this.list();
  }

  /** 从快照恢复（持久化用） */
  static import(records: GroundTruthRecord[]): GroundTruthRegistry {
    const r = new GroundTruthRegistry();
    for (const rec of records ?? []) r.records.set(rec.id, { ...rec });
    return r;
  }
}

/** 标准工厂：便捷构造一批用例 ID 到同来源的 Ground Truth 记录 */
export function groundTruthFor(
  ids: string[],
  opts: { source: GroundTruthSource; verifiedBy?: string; verifiedAt?: string; confidence?: number },
): GroundTruthRecord[] {
  const { source, verifiedBy, verifiedAt, confidence = 1 } = opts;
  return ids.map((id) => ({ id, source, verifiedBy, verifiedAt, confidence }));
}
