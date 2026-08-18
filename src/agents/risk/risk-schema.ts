// Risk Schema：风险评估数据模型 + JSON Schema 校验 + 现有 IssueItem 适配
// 目标：Risk Agent 产出结构化风险评估，可直接映射到现有 ReportData.issues（IssueItem）供报告复用。
// 风险维度：依赖 / 数据 / 边界 / 并发 / 计费 / 安全 / 环境 / 兼容 / 超时 / 重试。

import type { IssueItem } from '../../core/types.js';

/** 风险级别 */
export type RiskLevel = 'high' | 'medium' | 'low';

/** 风险维度 */
export type RiskCategory =
  | 'dependency' | 'data' | 'boundary' | 'concurrency' | 'billing'
  | 'security' | 'environment' | 'compatibility' | 'timeout' | 'retry';

/** 单条风险 */
export interface RiskItem {
  /** 唯一标识（如 risk-01） */
  id: string;
  /** 风险维度 */
  category: RiskCategory;
  /** 风险级别 */
  level: RiskLevel;
  /** 风险标题 */
  title: string;
  /** 风险描述 */
  desc: string;
  /** 受影响用例 ID 列表 */
  affectedCases?: string[];
  /** 缓解措施 */
  mitigation: string;
  /** 置信度 0~1 */
  confidence?: number;
}

/** 风险汇总 */
export interface RiskSummary {
  high: number;
  medium: number;
  low: number;
  /** 整体风险等级 */
  overall: RiskLevel;
  /** 是否建议跳过阻塞性执行（高优先阻塞风险时） */
  recommendedSkip: boolean;
}

/** 结构化风险评估 */
export interface RiskAssessment {
  feature: string;
  risks: RiskItem[];
  summary: RiskSummary;
  /** 映射到现有 IssueItem（供报告直接渲染） */
  issues: IssueItem[];
  source?: string;
  confidence?: number;
}

/** Risk JSON Schema（供 ajv 校验 LLM/规则输出） */
export const RISK_JSON_SCHEMA = {
  type: 'object',
  required: ['feature', 'risks'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string', minLength: 1 },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'level', 'title', 'desc', 'mitigation'],
        properties: {
          id: { type: 'string' },
          category: {
            enum: ['dependency', 'data', 'boundary', 'concurrency', 'billing', 'security', 'environment', 'compatibility', 'timeout', 'retry'],
          },
          level: { enum: ['high', 'medium', 'low'] },
          title: { type: 'string', minLength: 1 },
          desc: { type: 'string', minLength: 1 },
          affectedCases: { type: 'array', items: { type: 'string' } },
          mitigation: { type: 'string', minLength: 1 },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

const RISK_CATEGORIES: readonly RiskCategory[] = [
  'dependency', 'data', 'boundary', 'concurrency', 'billing',
  'security', 'environment', 'compatibility', 'timeout', 'retry',
];

/** 风险级别 → 现有 IssueItem.level */
function toIssueLevel(level: RiskLevel): IssueItem['level'] {
  if (level === 'high') return '阻塞';
  if (level === 'medium') return '数据异常';
  return '待人工';
}

/** 单条 RiskItem → IssueItem（报告可直接消费） */
export function toIssueItem(risk: RiskItem): IssueItem {
  return {
    level: toIssueLevel(risk.level),
    title: risk.title,
    desc: risk.desc,
  };
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return v === 'high' || v === 'medium' || v === 'low';
}

function isRiskCategory(v: unknown): v is RiskCategory {
  return typeof v === 'string' && (RISK_CATEGORIES as readonly string[]).includes(v);
}

function isRiskItem(v: unknown): v is RiskItem {
  return (
    typeof v === 'object' && v !== null
    && isRiskCategory((v as { category?: unknown }).category)
    && isRiskLevel((v as { level?: unknown }).level)
    && typeof (v as { title?: unknown }).title === 'string'
    && typeof (v as { desc?: unknown }).desc === 'string'
    && typeof (v as { mitigation?: unknown }).mitigation === 'string'
  );
}

/** 归一化 RiskAssessment（过滤非法风险项、补默认、重算汇总） */
export function normalizeRiskAssessment(data: Record<string, unknown>): RiskAssessment {
  const risks = (Array.isArray(data.risks) ? data.risks : [])
    .filter(isRiskItem)
    .map((r, i) => ({ ...r, id: r.id || `risk-${String(i + 1).padStart(2, '0')}` }));

  const summary = computeRiskSummary(risks);
  return {
    feature: String(data.feature ?? '').trim(),
    risks,
    summary,
    issues: risks.map(toIssueItem),
    source: data.source !== undefined ? String(data.source) : undefined,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
  };
}

/** 由风险列表计算汇总（high/medium/low 计数 + 整体等级 + 是否建议跳过） */
export function computeRiskSummary(risks: RiskItem[]): RiskSummary {
  const high = risks.filter((r) => r.level === 'high').length;
  const medium = risks.filter((r) => r.level === 'medium').length;
  const low = risks.filter((r) => r.level === 'low').length;
  const overall: RiskLevel = high > 0 ? 'high' : medium > 0 ? 'medium' : 'low';
  // 高风险达到 2 条以上，或存在计费/安全/并发高风险 → 建议跳过
  const criticalHigh = risks.some(
    (r) => r.level === 'high' && (r.category === 'billing' || r.category === 'security' || r.category === 'concurrency'),
  );
  return { high, medium, low, overall, recommendedSkip: high >= 2 || criticalHigh };
}

/** 判断数据是否「像 RiskAssessment」 */
export function isRiskAssessmentLike(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).feature === 'string';
}

/** 校验并归一化数据为 RiskAssessment（ajv 动态加载，不通过抛错） */
export async function validateRiskAssessment(data: unknown): Promise<RiskAssessment> {
  if (!isRiskAssessmentLike(data)) {
    throw new Error('RiskAssessment 结构无效：缺少 feature 字段');
  }
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(RISK_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error('RiskAssessment 校验失败：不符合 Risk JSON Schema');
  }
  return normalizeRiskAssessment(data as Record<string, unknown>);
}
