// Coverage Schema：测试覆盖分析数据模型 + JSON Schema 校验
// 目标：Phase 12 —— 回答「还有什么没测」。AI 不只生成测试，更要知道覆盖缺口。
// 维度：需求覆盖 / 参数覆盖 / 边界覆盖 / 异常覆盖 / 断言覆盖 / 风险覆盖 / 历史缺陷覆盖。

/** 单维度覆盖 */
export interface CoverageDimension {
  /** 维度名：requirement / parameter / boundary / exception / assertion / risk / history */
  name: string;
  /** 已覆盖数量 */
  covered: number;
  /** 应覆盖总数 */
  total: number;
  /** 覆盖率 0~100 */
  rate: number;
}

/** 缺口补测建议 */
export interface CoverageRecommendation {
  description: string;
  priority: 'P1' | 'P2' | 'P3';
  /** 关联维度 */
  dimension: string;
}

/** 覆盖分析结果 */
export interface CoverageAnalysis {
  feature: string;
  dimensions: CoverageDimension[];
  /** 快捷映射：维度名 → 覆盖率 */
  coverage: Record<string, number>;
  /** 覆盖缺口描述（如 1080P + 10秒组合场景缺失） */
  gaps: string[];
  /** 补测建议 */
  recommendedCases: CoverageRecommendation[];
  source?: string;
  confidence?: number;
}

/** Coverage JSON Schema */
export const COVERAGE_JSON_SCHEMA = {
  type: 'object',
  required: ['feature', 'coverage', 'gaps'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string' },
    coverage: { type: 'object', additionalProperties: { type: 'number' } },
    gaps: { type: 'array', items: { type: 'string' } },
    recommendedCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          priority: { type: 'string' },
          dimension: { type: 'string' },
        },
      },
    },
  },
} as const;

/** 判断数据是否「像 CoverageAnalysis」 */
export function isCoverageLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).feature === 'string'
    && typeof (data as Record<string, unknown>).coverage === 'object'
  );
}

/** 校验并归一化 LLM 输出的覆盖分析（ajv 动态加载；不通过抛错） */
export async function validateCoverage(data: unknown): Promise<Record<string, unknown>> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean; errors?: unknown })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(COVERAGE_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`Coverage JSON Schema 校验失败：${JSON.stringify(ajv.errors)}`);
  }
  return data as Record<string, unknown>;
}

/** 同步形态构建（供确定性分析器使用） */
export function buildCoverage(partial: Partial<CoverageAnalysis> & { feature: string }): CoverageAnalysis {
  const dims = partial.dimensions ?? [];
  return {
    feature: partial.feature,
    dimensions: dims,
    coverage: partial.coverage ?? Object.fromEntries(dims.map((d) => [d.name, d.rate])),
    gaps: partial.gaps ?? [],
    recommendedCases: partial.recommendedCases ?? [],
    source: partial.source,
    confidence: partial.confidence,
  };
}
