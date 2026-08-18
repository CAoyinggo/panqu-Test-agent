// Defect Schema：标准缺陷草稿数据模型 + JSON Schema 校验（Phase 14）
// 铁律：缺陷生成与缺陷提交必须分离。第一阶段只能生成 Defect Draft，
// 不能默认直接创建正式缺陷。提交动作必须经过 Approval（Phase 16）。
import { FailureCategory } from '../analysis/root-cause-schema.js';

/** 严重程度（按影响面/用户可见性） */
export type DefectSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** 优先级（按修复紧迫度） */
export type DefectPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** 关联的 RCA 结论 */
export interface DefectRcaRef {
  category: FailureCategory | string;
  rootCause: string;
  confidence: number;
}

/** 标准缺陷草稿 */
export interface DefectDraft {
  /** 草稿 ID（如 defect-001） */
  id: string;
  /** 功能模块 */
  feature: string;
  /** 标题 */
  title: string;
  /** 严重程度 */
  severity: DefectSeverity;
  /** 优先级 */
  priority: DefectPriority;
  /** 问题描述 */
  description: string;
  /** 复现步骤 */
  steps: string[];
  /** 预期结果 */
  expected: string;
  /** 实际结果 */
  actual: string;
  /** 影响范围 */
  impact: string;
  /** 环境 */
  environment: string;
  /** 证据（断言/响应摘要等） */
  evidence: string[];
  /** 日志 */
  logs: string[];
  /** 截图/响应摘要 */
  responseSummary?: string;
  /** 相关测试用例 */
  relatedCases: string[];
  /** 关联 RCA */
  rca?: DefectRcaRef;
  /** 状态：草稿阶段恒为 DRAFT，不允许直接提交 */
  status: 'DRAFT';
  createdAt: string;
  source?: string;
  confidence?: number;
}

/** Defect JSON Schema（LLM 输出校验） */
export const DEFECT_JSON_SCHEMA = {
  type: 'object',
  required: ['title', 'severity', 'priority', 'description', 'steps', 'expected', 'actual', 'environment'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    severity: { enum: ['P0', 'P1', 'P2', 'P3'] },
    priority: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    description: { type: 'string', minLength: 1 },
    steps: { type: 'array', items: { type: 'string' } },
    expected: { type: 'string' },
    actual: { type: 'string' },
    impact: { type: 'string' },
    environment: { type: 'string', minLength: 1 },
    evidence: { type: 'array', items: { type: 'string' } },
    logs: { type: 'array', items: { type: 'string' } },
    relatedCases: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** 判断数据是否「像 DefectDraft」 */
export function isDefectLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).title === 'string'
    && typeof (data as Record<string, unknown>).environment === 'string'
  );
}

/** 校验 LLM 输出的缺陷草稿（ajv 动态加载；不通过抛错） */
export async function validateDefect(data: unknown): Promise<Record<string, unknown>> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean; errors?: unknown })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(DEFECT_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`Defect JSON Schema 校验失败：${JSON.stringify(ajv.errors)}`);
  }
  return data as Record<string, unknown>;
}

function isSeverity(v: unknown): v is DefectSeverity {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3';
}

function isPriority(v: unknown): v is DefectPriority {
  return v === 'CRITICAL' || v === 'HIGH' || v === 'MEDIUM' || v === 'LOW';
}

/** 同步形态构建（供确定性 Defect 生成器使用） */
export function buildDefect(partial: Partial<DefectDraft> & { feature: string; title: string; severity: DefectSeverity; priority: DefectPriority; environment: string }): DefectDraft {
  return {
    id: partial.id ?? `defect-${Date.now().toString(36)}`,
    feature: partial.feature,
    title: partial.title,
    severity: partial.severity,
    priority: partial.priority,
    description: partial.description ?? '',
    steps: partial.steps ?? [],
    expected: partial.expected ?? '',
    actual: partial.actual ?? '',
    impact: partial.impact ?? '',
    environment: partial.environment,
    evidence: partial.evidence ?? [],
    logs: partial.logs ?? [],
    responseSummary: partial.responseSummary,
    relatedCases: partial.relatedCases ?? [],
    rca: partial.rca,
    status: 'DRAFT',
    createdAt: partial.createdAt ?? new Date().toISOString(),
    source: partial.source,
    confidence: partial.confidence,
  };
}

/** 归一化外部/LLM 产出的缺陷草稿（合法化严重度/优先级，强制 DRAFT 状态） */
export function normalizeDefect(data: Record<string, unknown>): DefectDraft {
  return buildDefect({
    id: data.id !== undefined ? String(data.id) : undefined,
    feature: String(data.feature ?? ''),
    title: String(data.title ?? ''),
    severity: isSeverity(data.severity) ? data.severity : 'P2',
    priority: isPriority(data.priority) ? data.priority : 'MEDIUM',
    description: String(data.description ?? ''),
    steps: Array.isArray(data.steps) ? data.steps.map(String).filter(Boolean) : [],
    expected: String(data.expected ?? ''),
    actual: String(data.actual ?? ''),
    impact: String(data.impact ?? ''),
    environment: String(data.environment ?? ''),
    evidence: Array.isArray(data.evidence) ? data.evidence.map(String).filter(Boolean) : [],
    logs: Array.isArray(data.logs) ? data.logs.map(String).filter(Boolean) : [],
    responseSummary: data.responseSummary !== undefined ? String(data.responseSummary) : undefined,
    relatedCases: Array.isArray(data.relatedCases) ? data.relatedCases.map(String).filter(Boolean) : [],
    rca: data.rca as DefectRcaRef | undefined,
    createdAt: String(data.createdAt ?? new Date().toISOString()),
    source: data.source !== undefined ? String(data.source) : undefined,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
  });
}
