// Healing Schema：Self-Healing 自愈建议数据模型 + JSON Schema 校验（Phase 15）
// 定位：检测 API 字段变化 / JSON Path 变化 / 接口结构变化 / 参数变化 / 场景变化 /
// 错误码变化 / 测试数据变化 / Selector 变化。
// 铁律：识别 Path 失效 → 分析响应 Schema → 寻找最可能新 Path → 生成修复 Diff →
// 风险评估 → 人工确认 → 才允许修改。LLM 一律不得自动修改核心代码。

/** 自愈类型 */
export type HealingType =
  | 'json-path'      // JSON Path 失效
  | 'api-field'      // API 字段变化
  | 'api-structure'  // 接口结构变化
  | 'parameter'      // 参数变化
  | 'error-code'     // 错误码变化
  | 'selector'       // Selector 变化
  | 'test-data';     // 测试数据变化

/** 自愈建议状态 */
export type HealingStatus = 'SUGGESTED' | 'APPROVED' | 'REJECTED' | 'APPLIED';

/** 单条自愈建议 */
export interface HealingSuggestion {
  id: string;
  caseId: string;
  /** 自愈类型 */
  type: HealingType;
  /** 失效的旧路径/字段 */
  oldPath: string;
  /** 最可能的新路径/字段 */
  newPath?: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 修复理由 */
  reason: string;
  /** 修复 Patch / Diff（文本形式，供人工确认后应用） */
  patch: string;
  /** 风险评估：low / medium / high */
  risk: 'low' | 'medium' | 'high';
  /** 状态：默认 SUGGESTED，需人工审批（Phase 16 Approval） */
  status: HealingStatus;
  /** 证据 */
  evidence: string[];
  createdAt: string;
}

/** 自愈分析汇总 */
export interface HealingAnalysis {
  feature: string;
  /** 检测到的建议数 */
  total: number;
  suggestions: HealingSuggestion[];
  /** 一句话汇总 */
  summary: string;
  source?: string;
}

/** Healing JSON Schema（LLM 输出校验） */
export const HEALING_JSON_SCHEMA = {
  type: 'object',
  required: ['caseId', 'oldPath', 'confidence', 'reason', 'patch', 'risk'],
  additionalProperties: true,
  properties: {
    caseId: { type: 'string', minLength: 1 },
    type: {
      type: 'string',
      enum: ['json-path', 'api-field', 'api-structure', 'parameter', 'error-code', 'selector', 'test-data'],
    },
    oldPath: { type: 'string', minLength: 1 },
    newPath: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1 },
    patch: { type: 'string', minLength: 1 },
    risk: { enum: ['low', 'medium', 'high'] },
    evidence: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** 判断数据是否「像 HealingSuggestion」 */
export function isHealingLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).caseId === 'string'
    && typeof (data as Record<string, unknown>).oldPath === 'string'
    && typeof (data as Record<string, unknown>).patch === 'string'
  );
}

/** 校验 LLM 输出的自愈建议（ajv 动态加载；不通过抛错） */
export async function validateHealing(data: unknown): Promise<Record<string, unknown>> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean; errors?: unknown })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(HEALING_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`Healing JSON Schema 校验失败：${JSON.stringify(ajv.errors)}`);
  }
  return data as Record<string, unknown>;
}

function isHealingType(v: unknown): v is HealingType {
  return ['json-path', 'api-field', 'api-structure', 'parameter', 'error-code', 'selector', 'test-data'].includes(String(v));
}

/** 同步形态构建 */
export function buildHealingSuggestion(partial: Partial<HealingSuggestion> & { caseId: string; oldPath: string; patch: string }): HealingSuggestion {
  return {
    id: partial.id ?? `heal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    caseId: partial.caseId,
    type: partial.type ?? 'json-path',
    oldPath: partial.oldPath,
    newPath: partial.newPath,
    confidence: partial.confidence ?? 0.5,
    reason: partial.reason ?? '',
    patch: partial.patch,
    risk: partial.risk ?? 'medium',
    status: partial.status ?? 'SUGGESTED',
    evidence: partial.evidence ?? [],
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

/** 归一化外部/LLM 产出的自愈建议 */
export function normalizeHealingSuggestion(data: Record<string, unknown>): HealingSuggestion {
  return buildHealingSuggestion({
    id: data.id !== undefined ? String(data.id) : undefined,
    caseId: String(data.caseId ?? ''),
    type: isHealingType(data.type) ? data.type : 'json-path',
    oldPath: String(data.oldPath ?? ''),
    newPath: data.newPath !== undefined ? String(data.newPath) : undefined,
    confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0.5,
    reason: String(data.reason ?? ''),
    patch: String(data.patch ?? ''),
    risk: (data.risk === 'low' || data.risk === 'medium' || data.risk === 'high') ? data.risk : 'medium',
    status: (data.status === 'SUGGESTED' || data.status === 'APPROVED' || data.status === 'REJECTED' || data.status === 'APPLIED') ? data.status : 'SUGGESTED',
    evidence: Array.isArray(data.evidence) ? data.evidence.map(String).filter(Boolean) : [],
    createdAt: String(data.createdAt ?? new Date().toISOString()),
  });
}
