// Root Cause Schema：RCA 深度根因分析数据模型 + JSON Schema 校验
// 目标：Phase 13 —— 禁止「断言失败 → LLM 猜原因」。RCA 必须基于证据链，
// 输出分类 / 置信度 / 根因 / 证据 / 排除原因 / 建议动作，并严格区分：
//   确定事实（fact） / AI 推断（inference） / 低置信度猜测（guess）。

// Phase 35（DEBT-11 已解决）：失败分类共享模型上移至 core 层唯一权威来源，
// 此处 re-export 保持对外兼容（agents 域既有 API 不变）。
import { type FailureCategory, FAILURE_CATEGORIES, isFailureCategory } from '../../core/failure-category.js';
export { type FailureCategory, FAILURE_CATEGORIES, isFailureCategory } from '../../core/failure-category.js';

/** 证据确定性等级 */
export type EvidenceCertainty = 'fact' | 'inference' | 'guess';

/** 结构化证据项 */
export interface EvidenceItem {
  /** 证据类型（证据链环节）：assertion / http-response / scene-result / environment / execution-history / metrics / recent-changes / historical-failure */
  type: string;
  /** 证据描述 */
  detail: string;
  /** 确定性：fact（确定事实）/ inference（AI 推断）/ guess（低置信度猜测） */
  certainty: EvidenceCertainty;
  /** 来源（如 tc-01 / 检查点 / 历史记忆） */
  source?: string;
}

/** 根因分析结果 */
export interface RootCauseAnalysis {
  /** 用例 ID */
  caseId: string;
  /** 用例名 */
  name?: string;
  /** 失败分类 */
  category: FailureCategory;
  /** 置信度 0~1 */
  confidence: number;
  /** 根因一句话 */
  rootCause: string;
  /** 证据链（可读字符串，供报告渲染） */
  evidence: string[];
  /** 结构化证据（含确定性标注） */
  evidenceItems: EvidenceItem[];
  /** 确定事实 */
  facts: string[];
  /** AI 推断 */
  inferences: string[];
  /** 低置信度猜测 */
  guesses: string[];
  /** 已排除的原因 */
  excludedCauses: string[];
  /** 建议动作 */
  recommendedAction: string;
  source?: string;
}

/** Root Cause JSON Schema（LLM 输出校验；evidence 允许字符串数组，结构化证据由证据收集器补全） */
export const ROOT_CAUSE_JSON_SCHEMA = {
  type: 'object',
  required: ['caseId', 'category', 'confidence', 'rootCause', 'evidence', 'recommendedAction'],
  additionalProperties: true,
  properties: {
    caseId: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    category: {
      type: 'string',
      enum: [
        'ASSERTION', 'TIMEOUT', 'MODEL_ERROR', 'DATA_ERROR', 'ENVIRONMENT_ERROR',
        'NETWORK_ERROR', 'AUTH_ERROR', 'BILLING_ERROR', 'CONCURRENCY_ERROR',
        'RATE_LIMIT_ERROR', 'DEPENDENCY_ERROR', 'TEST_CODE_ERROR', 'UNKNOWN',
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rootCause: { type: 'string', minLength: 1 },
    evidence: { type: 'array', items: { type: 'string' } },
    excludedCauses: { type: 'array', items: { type: 'string' } },
    recommendedAction: { type: 'string', minLength: 1 },
  },
} as const;

/** 判断数据是否「像 RootCauseAnalysis」 */
export function isRootCauseLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).caseId === 'string'
    && typeof (data as Record<string, unknown>).rootCause === 'string'
  );
}

/** 校验 LLM 输出的根因分析（ajv 动态加载；不通过抛错） */
export async function validateRootCause(data: unknown): Promise<Record<string, unknown>> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean; errors?: unknown })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(ROOT_CAUSE_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`RootCause JSON Schema 校验失败：${JSON.stringify(ajv.errors)}`);
  }
  return data as Record<string, unknown>;
}

/** 同步形态构建（供确定性 RCA / 证据收集器使用） */
export function buildRootCause(partial: Partial<RootCauseAnalysis> & { caseId: string; category: FailureCategory; rootCause: string }): RootCauseAnalysis {
  const items = partial.evidenceItems ?? [];
  const facts = partial.facts ?? items.filter((e) => e.certainty === 'fact').map((e) => e.detail);
  const inferences = partial.inferences ?? items.filter((e) => e.certainty === 'inference').map((e) => e.detail);
  const guesses = partial.guesses ?? items.filter((e) => e.certainty === 'guess').map((e) => e.detail);
  return {
    caseId: partial.caseId,
    name: partial.name,
    category: partial.category,
    confidence: partial.confidence ?? 0.5,
    rootCause: partial.rootCause,
    evidence: partial.evidence ?? items.map((e) => `[${e.type}/${e.certainty}] ${e.detail}`),
    evidenceItems: items,
    facts,
    inferences,
    guesses,
    excludedCauses: partial.excludedCauses ?? [],
    recommendedAction: partial.recommendedAction ?? '',
    source: partial.source,
  };
}

/** 归一化外部/LLM 产出的根因分析：
 * - 合法化 category / confidence
 * - 从 evidenceItems 重新派生 facts/inferences/guesses（保证三者区分恒成立）
 * - 若 LLM 只给 evidence 字符串数组，则全部归入 inferences（AI 推断，非事实）
 */
function toCertainty(v: unknown): EvidenceCertainty {
  return v === 'fact' || v === 'inference' || v === 'guess' ? v : 'inference';
}

export function normalizeRootCause(data: Record<string, unknown>): RootCauseAnalysis {
  const rawItems = Array.isArray(data.evidenceItems) ? data.evidenceItems : [];
  const items: EvidenceItem[] = rawItems
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      type: String(e.type ?? 'evidence'),
      detail: String(e.detail ?? ''),
      certainty: toCertainty(e.certainty),
      source: e.source !== undefined ? String(e.source) : undefined,
    }))
    .filter((e) => e.detail.length > 0);

  const strEvidence = Array.isArray(data.evidence) ? data.evidence.map(String).filter(Boolean) : [];
  // 无结构化证据时，字符串证据按 AI 推断处理
  const effectiveItems: EvidenceItem[] = items.length > 0
    ? items
    : strEvidence.map((d) => ({ type: 'llm', detail: d, certainty: 'inference' }));

  const facts = Array.isArray(data.facts) ? data.facts.map(String).filter(Boolean)
    : effectiveItems.filter((e) => e.certainty === 'fact').map((e) => e.detail);
  const inferences = Array.isArray(data.inferences) ? data.inferences.map(String).filter(Boolean)
    : effectiveItems.filter((e) => e.certainty === 'inference').map((e) => e.detail);
  const guesses = Array.isArray(data.guesses) ? data.guesses.map(String).filter(Boolean)
    : effectiveItems.filter((e) => e.certainty === 'guess').map((e) => e.detail);

  return buildRootCause({
    caseId: String(data.caseId ?? ''),
    name: data.name !== undefined ? String(data.name) : undefined,
    category: isFailureCategory(data.category) ? data.category : 'UNKNOWN',
    confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0.5,
    rootCause: String(data.rootCause ?? ''),
    evidence: strEvidence,
    evidenceItems: effectiveItems,
    facts,
    inferences,
    guesses,
    excludedCauses: Array.isArray(data.excludedCauses) ? data.excludedCauses.map(String).filter(Boolean) : [],
    recommendedAction: String(data.recommendedAction ?? ''),
    source: data.source !== undefined ? String(data.source) : undefined,
  });
}
