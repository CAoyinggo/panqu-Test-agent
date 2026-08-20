// Unified Evaluation Contract（Phase 45 / 42.1）
// 全平台 AI 评测的统一数据契约：所有模块（Requirement / Test Design / Risk / Selection /
// RCA / Defect / Healing / Release）必须使用同一套 EvaluationCase / EvaluationResult，
// 禁止各模块自定义完全不同的 Score Contract。
//
// 约定：
//   - score 为 0~1 归一化（1 为满分）；聚合层按需转百分比。
//   - passed 由阈值判定（连续型默认 >= 0.9，分类型要求精确匹配）。
//   - 没有 Ground Truth 的用例 tracked=false，score=null，绝不虚构数值。

/** 评测领域 */
export type EvaluationDomain =
  | 'REQUIREMENT'
  | 'TEST_DESIGN'
  | 'RISK'
  | 'SELECTION'
  | 'RCA'
  | 'DEFECT'
  | 'HEALING'
  | 'RELEASE';

/** 领域中文标签（Web/报告展示） */
export const DOMAIN_LABELS: Record<EvaluationDomain, string> = {
  REQUIREMENT: '需求理解',
  TEST_DESIGN: '测试设计',
  RISK: '风险评估',
  SELECTION: '用例选择',
  RCA: '根因分析',
  DEFECT: '缺陷质量',
  HEALING: '自愈安全',
  RELEASE: '发布决策',
};

/** 全部领域（顺序即展示顺序） */
export const ALL_DOMAINS: readonly EvaluationDomain[] = [
  'REQUIREMENT',
  'TEST_DESIGN',
  'RISK',
  'SELECTION',
  'RCA',
  'DEFECT',
  'HEALING',
  'RELEASE',
];

/** 用例元数据 */
export interface EvaluationCaseMeta {
  project?: string;
  feature?: string;
  environment?: string;
  /** normal / boundary / abnormal / ambiguous / missing-field / contradictory ... */
  difficulty?: string;
  /** 基准来源标签 */
  source?: string;
  [key: string]: unknown;
}

/** 统一评测用例 */
export interface EvaluationCase<Input = unknown, GroundTruth = unknown> {
  id: string;
  domain: EvaluationDomain;
  input: Input;
  groundTruth: GroundTruth;
  metadata?: EvaluationCaseMeta;
}

/** 单条评测结果 */
export interface EvaluationResult {
  caseId: string;
  domain: EvaluationDomain;
  /** 0~1；无 Ground Truth（未追踪）时为 null */
  score: number | null;
  passed: boolean;
  tracked: boolean;
  expected: unknown;
  actual: unknown;
  errors: string[];
  evidence?: unknown[];
  /** 评测耗时（ms） */
  latencyMs?: number;
  /** 估算成本（美元；确定性评测为 0） */
  cost?: number;
}

/** 连续型得分通过阈值（默认 0.9） */
export const DEFAULT_PASS_THRESHOLD = 0.9;

/** 由 0~1 得分判定 passed */
export function isPassed(score: number | null, threshold = DEFAULT_PASS_THRESHOLD): boolean {
  return score !== null && score >= threshold;
}
