// Quality Schema：Test Quality Score 九维度模型（Phase 21.7 Quality Optimization）
// 维度：Coverage / Risk Detection / False Positive / False Negative / Flaky Rate /
//       RCA Accuracy / Healing Success / Defect Duplicate Rate / Human Intervention。
// Test Quality Score → Feature Quality Score，全部确定性计算。

/** 质量指标原始输入（0~1） */
export interface QualityMetricsInput {
  /** 覆盖率（越高越好） */
  coverage?: number;
  /** 风险检出率（越高越好） */
  riskDetection?: number;
  /** 误报率（越低越好） */
  falsePositiveRate?: number;
  /** 漏报率（越低越好） */
  falseNegativeRate?: number;
  /** Flaky 占比（越低越好） */
  flakyRate?: number;
  /** RCA 准确率（越高越好） */
  rcaAccuracy?: number;
  /** 自愈成功率（越高越好） */
  healingSuccess?: number;
  /** 缺陷重复率（越低越好） */
  defectDuplicateRate?: number;
  /** 人工干预率（越低越好） */
  humanInterventionRate?: number;
}

/** 九维度权重（合计 1.0） */
export const QUALITY_WEIGHTS: Record<string, number> = {
  coverage: 0.15,
  riskDetection: 0.15,
  rcaAccuracy: 0.15,
  falsePositive: 0.1,
  falseNegative: 0.1,
  flakyRate: 0.1,
  healingSuccess: 0.1,
  humanIntervention: 0.1,
  defectDuplicate: 0.05,
};

/** 质量等级 */
export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 计算 Test Quality Score（0~100）。
 * 「越低越好」的维度先取 (1 - x) 归一为「越好越高」，再加权求和 ×100。
 * 返回总分 + 各维度归一值（dimensions，供趋势/报告）。
 */
export function computeTestQualityScore(metrics: QualityMetricsInput): { score: number; dimensions: Record<string, number> } {
  const dimensions: Record<string, number> = {
    coverage: clamp01(metrics.coverage),
    riskDetection: clamp01(metrics.riskDetection),
    rcaAccuracy: clamp01(metrics.rcaAccuracy),
    falsePositive: 1 - clamp01(metrics.falsePositiveRate),
    falseNegative: 1 - clamp01(metrics.falseNegativeRate),
    flakyRate: 1 - clamp01(metrics.flakyRate),
    healingSuccess: clamp01(metrics.healingSuccess),
    humanIntervention: 1 - clamp01(metrics.humanInterventionRate),
    defectDuplicate: 1 - clamp01(metrics.defectDuplicateRate),
  };
  let score = 0;
  for (const [key, weight] of Object.entries(QUALITY_WEIGHTS)) {
    score += weight * (dimensions[key] ?? 0);
  }
  return { score: Math.round(score * 1000) / 10, dimensions };
}

/** 分数 → 等级 */
export function gradeOf(score: number): QualityGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** 质量记录（Test/Feature 级） */
export interface QualityRecord {
  id: string;
  /** test=单轮测试质量；feature=功能质量（聚合） */
  scope: 'test' | 'feature';
  feature: string;
  score: number;
  grade: QualityGrade;
  dimensions: Record<string, number>;
  metrics: QualityMetricsInput;
  /** 多维趋势归属 */
  version?: string;
  model?: string;
  environment?: string;
  timestamp: string;
}

/** 记录质量输入 */
export interface CreateQualityInput {
  id?: string;
  scope?: 'test' | 'feature';
  feature: string;
  metrics: QualityMetricsInput;
  version?: string;
  model?: string;
  environment?: string;
  timestamp?: string;
}

let qualitySeq = 0;

/** 生成质量记录 id */
export function generateQualityId(): string {
  qualitySeq += 1;
  return `q-${Date.now().toString(36)}-${String(qualitySeq).padStart(4, '0')}`;
}

/** 校验并归一化质量输入：非法抛错 */
export function normalizeCreateQualityInput(input: unknown): CreateQualityInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Quality 记录失败：输入必须为对象');
  }
  const raw = input as Record<string, unknown>;
  if (!raw.feature || typeof raw.feature !== 'string') throw new Error('Quality 记录失败：缺少 feature');
  if (typeof raw.metrics !== 'object' || raw.metrics === null) throw new Error('Quality 记录失败：缺少 metrics');
  const out: CreateQualityInput = {
    feature: String(raw.feature).trim(),
    metrics: raw.metrics as QualityMetricsInput,
    scope: raw.scope === 'feature' ? 'feature' : 'test',
  };
  if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
  for (const key of ['version', 'model', 'environment', 'timestamp'] as const) {
    if (typeof raw[key] === 'string' && (raw[key] as string).trim()) out[key] = (raw[key] as string).trim();
  }
  return out;
}
