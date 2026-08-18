// Test Selection Schema：测试选择结果数据模型 + JSON Schema 校验
// 目标：Phase 11 —— 回答「到底哪些测试应该执行 / 为什么」。
// 输入：Requirement + TestCase[] + RiskAssessment + 历史失败 + 执行预算
// 输出：选中的用例 / 跳过的用例 / 建议执行顺序 / 每个决定的理由（审计关键）。

/** 选择统计 */
export interface SelectionStatistics {
  total: number;
  selected: number;
  skipped: number;
  /** 命中风险维度（高风险/受影响用例）的选中数 */
  riskAffected: number;
  /** 因历史失败被提升优先级的用例数 */
  historyBoosted: number;
  /** 被标记为 flaky 的用例数 */
  flakyMarked: number;
  /** 因预算被裁剪的用例数 */
  budgetTrimmed: number;
}

/** 测试选择结果 */
export interface TestSelection {
  feature: string;
  /** 选中的用例 ID（按执行顺序） */
  selectedCases: string[];
  /** 跳过的用例 ID */
  skippedCases: string[];
  /** 建议执行顺序（优先级排序，含历史提优） */
  priorityOrder: string[];
  /** 每个用例的决定理由（为什么选 / 为什么跳 / 为什么提优） */
  reasons: Record<string, string>;
  statistics: SelectionStatistics;
  /** 本次执行的预算约束 */
  budget?: { maxCases?: number; maxConcurrency?: number };
  source?: string;
  confidence?: number;
}

/** Test Selection JSON Schema（供 ajv 校验 LLM 输出） */
export const SELECTION_JSON_SCHEMA = {
  type: 'object',
  required: ['feature', 'selectedCases', 'skippedCases'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string', minLength: 1 },
    selectedCases: { type: 'array', items: { type: 'string' } },
    skippedCases: { type: 'array', items: { type: 'string' } },
    priorityOrder: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'object', additionalProperties: { type: 'string' } },
    statistics: { type: 'object' },
    budget: { type: 'object' },
  },
} as const;

/** 判断数据是否「像 TestSelection」 */
export function isSelectionLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).feature === 'string'
    && Array.isArray((data as Record<string, unknown>).selectedCases)
  );
}

/** 校验并归一化 LLM 输出的选择结果（ajv 动态加载；不通过抛错） */
export async function validateSelection(data: unknown): Promise<Record<string, unknown>> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean; errors?: unknown })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(SELECTION_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`TestSelection JSON Schema 校验失败：${JSON.stringify(ajv.errors)}`);
  }
  return data as Record<string, unknown>;
}

/** 同步形态的归一化（供确定性选择器使用，不触发 ajv） */
export function buildSelection(partial: Partial<TestSelection> & { feature: string }): TestSelection {
  return {
    feature: partial.feature,
    selectedCases: partial.selectedCases ?? [],
    skippedCases: partial.skippedCases ?? [],
    priorityOrder: partial.priorityOrder ?? [...(partial.selectedCases ?? [])],
    reasons: partial.reasons ?? {},
    statistics: partial.statistics ?? {
      total: 0, selected: 0, skipped: 0, riskAffected: 0, historyBoosted: 0, flakyMarked: 0, budgetTrimmed: 0,
    },
    budget: partial.budget,
    source: partial.source,
    confidence: partial.confidence,
  };
}
