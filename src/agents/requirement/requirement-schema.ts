// Requirement Schema：结构化测试需求的数据模型 + JSON Schema 校验
// 目标：禁止下游直接依赖不可控的自然语言，所有 Agent/Engine 只消费结构化 Requirement。
// 支持 LLM 输出校验 + 归一化（兼容 requirements 的数组/对象两种形态）。

/** 单条需求参数（如 resolution: ["720P","1080P"]） */
export interface RequirementItem {
  name: string;
  values: unknown[];
}

/** Requirement Understanding 中单条事实的认知边界。 */
export type RequirementKnowledge = 'EXPLICIT' | 'INFERRED' | 'UNKNOWN';

export type RequirementUnderstandingCategory =
  | 'ACTOR'
  | 'ACTION'
  | 'RESOURCE'
  | 'BUSINESS_RULE'
  | 'EXPECTED_RESULT'
  | 'STATE'
  | 'PERMISSION'
  | 'DATA_RELATION'
  | 'INTERFACE'
  | 'FIELD'
  | 'CONSTRAINT';

/**
 * 需求事实保留“原文明确 / 有依据推导 / 当前未知”的边界。
 * EXPLICIT 必须携带可在原需求中定位的 source 原文，防止把模型补全伪装成产品规则。
 */
export interface RequirementUnderstandingFact {
  id: string;
  category: RequirementUnderstandingCategory;
  statement: string;
  knowledge: RequirementKnowledge;
  source?: string;
  confidence?: number;
}

export interface RequirementAmbiguity {
  id: string;
  question: string;
  impactedFacts: string[];
  owner?: string;
}

export interface RequirementUnderstanding {
  facts: RequirementUnderstandingFact[];
  ambiguities: RequirementAmbiguity[];
  /** 仍缺失且会影响设计、执行或 Oracle 的信息；不得转成已确认业务规则。 */
  unknowns: string[];
}

/** 结构化测试需求 */
export interface Requirement {
  /** 需求明确的功能模块或业务对象；未知时为 unknown。 */
  feature: string;
  /** 原需求支持的一句话业务目标。 */
  goal?: string;
  /** 需求明确的业务能力或风险能力标签。 */
  capabilities: string[];
  /** 需求明确的输入参数名。 */
  inputs: string[];
  /** 参数取值组合需求 */
  requirements: RequirementItem[];
  /** 业务规则（如 任务状态最终成功 / 积分正确扣除） */
  businessRules: string[];
  /** 依赖服务（如 模型服务 / 积分服务） */
  dependencies: string[];
  /** 约束条件（如 禁止真实扣费 / 仅限测试环境） */
  constraints?: string[];
  /** 识别出的风险标签（如 timeout / billing / concurrency） */
  risks?: string[];
  /** 需求版本（解析版本，默认 v1） */
  version?: string;
  /** 原始需求文本（审计用途） */
  source?: string;
  /** 解析置信度 0~1 */
  confidence?: number;
  /** 角色/动作/资源/规则/预期的可追溯理解结果与认知边界。 */
  understanding?: RequirementUnderstanding;
}

/** Requirement JSON Schema（供 ajv 校验 LLM/规则输出） */
export const REQUIREMENT_JSON_SCHEMA = {
  type: 'object',
  required: ['feature'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string', minLength: 1 },
    capabilities: { type: 'array', items: { type: 'string' } },
    inputs: { type: 'array', items: { type: 'string' } },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          values: { type: 'array' },
        },
      },
    },
    businessRules: { type: 'array', items: { type: 'string' } },
    dependencies: { type: 'array', items: { type: 'string' } },
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    version: { type: 'string' },
    confidence: { type: 'number' },
    understanding: {
      type: 'object',
      required: ['facts', 'ambiguities', 'unknowns'],
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'category', 'statement', 'knowledge'],
            properties: {
              id: { type: 'string', minLength: 1 },
              category: { enum: ['ACTOR', 'ACTION', 'RESOURCE', 'BUSINESS_RULE', 'EXPECTED_RESULT', 'STATE', 'PERMISSION', 'DATA_RELATION', 'INTERFACE', 'FIELD', 'CONSTRAINT'] },
              statement: { type: 'string', minLength: 1 },
              knowledge: { enum: ['EXPLICIT', 'INFERRED', 'UNKNOWN'] },
              source: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
        ambiguities: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'question', 'impactedFacts'],
            properties: {
              id: { type: 'string', minLength: 1 },
              question: { type: 'string', minLength: 1 },
              impactedFacts: { type: 'array', items: { type: 'string' } },
              owner: { type: 'string' },
            },
          },
        },
        unknowns: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

/** 归一化 requirements 的两种形态 → 数组形态（[{name, values}]） */
function toRequirementItems(req: unknown): RequirementItem[] {
  if (!req) return [];
  if (Array.isArray(req)) {
    return req
      .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
      .map((it) => ({
        name: String(it.name ?? ''),
        values: Array.isArray(it.values) ? it.values : [],
      }))
      .filter((it) => it.name.length > 0);
  }
  // 对象形态：{ resolution: { values: [...] }, duration: { values: [...] } }
  if (typeof req === 'object') {
    return Object.entries(req as Record<string, unknown>)
      .map(([name, val]) => ({
        name,
        values: Array.isArray((val as { values?: unknown[] })?.values) ? (val as { values: unknown[] }).values : [],
      }));
  }
  return [];
}

/** 归一化 LLM/规则输出为完整 Requirement（补默认值、统一 requirements 形态） */
export function normalizeRequirement(data: Record<string, unknown>): Requirement {
  return {
    feature: String(data.feature ?? '').trim(),
    goal: data.goal !== undefined ? String(data.goal).trim() : undefined,
    capabilities: toStringArray(data.capabilities),
    inputs: toStringArray(data.inputs),
    requirements: toRequirementItems(data.requirements),
    businessRules: toStringArray(data.businessRules),
    dependencies: toStringArray(data.dependencies),
    constraints: toStringArray(data.constraints),
    risks: toStringArray(data.risks),
    version: data.version !== undefined ? String(data.version) : undefined,
    source: data.source !== undefined ? String(data.source) : undefined,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
    understanding: normalizeUnderstanding(data.understanding),
  };
}

function normalizeUnderstanding(value: unknown): RequirementUnderstanding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const categories = new Set<RequirementUnderstandingCategory>([
    'ACTOR', 'ACTION', 'RESOURCE', 'BUSINESS_RULE', 'EXPECTED_RESULT', 'STATE', 'PERMISSION',
    'DATA_RELATION', 'INTERFACE', 'FIELD', 'CONSTRAINT',
  ]);
  const knowledge = new Set<RequirementKnowledge>(['EXPLICIT', 'INFERRED', 'UNKNOWN']);
  const facts = (Array.isArray(raw.facts) ? raw.facts : []).flatMap((item): RequirementUnderstandingFact[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const fact = item as Record<string, unknown>;
    const category = String(fact.category ?? '') as RequirementUnderstandingCategory;
    const boundary = String(fact.knowledge ?? '') as RequirementKnowledge;
    const id = String(fact.id ?? '').trim();
    const statement = String(fact.statement ?? '').trim();
    if (!id || !statement || !categories.has(category) || !knowledge.has(boundary)) return [];
    return [{
      id, category, statement, knowledge: boundary,
      source: fact.source === undefined ? undefined : String(fact.source),
      confidence: typeof fact.confidence === 'number' && fact.confidence >= 0 && fact.confidence <= 1
        ? fact.confidence : undefined,
    }];
  });
  const ambiguities = (Array.isArray(raw.ambiguities) ? raw.ambiguities : []).flatMap((item): RequirementAmbiguity[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const ambiguity = item as Record<string, unknown>;
    const id = String(ambiguity.id ?? '').trim();
    const question = String(ambiguity.question ?? '').trim();
    if (!id || !question) return [];
    return [{
      id, question, impactedFacts: toStringArray(ambiguity.impactedFacts),
      owner: ambiguity.owner === undefined ? undefined : String(ambiguity.owner),
    }];
  });
  return { facts, ambiguities, unknowns: toStringArray(raw.unknowns) };
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x.length > 0) : [];
}

/** 判断数据是否「像 Requirement」（至少含 feature） */
export function isRequirementLike(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).feature === 'string';
}

/**
 * 校验并归一化数据为 Requirement。
 * 不满足 Schema（如缺 feature）时抛错，由调用方（Agent）决定回退策略。
 */
export async function validateRequirement(data: unknown): Promise<Requirement> {
  if (!isRequirementLike(data)) {
    throw new Error('Requirement 结构无效：缺少 feature 字段或类型错误');
  }
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean })(
    { allErrors: true, strict: false },
  );
  const validate = ajv.validate(REQUIREMENT_JSON_SCHEMA as object, data);
  if (!validate) {
    throw new Error(`Requirement 校验失败：不符合 JSON Schema（feature 等字段非法）`);
  }
  return normalizeRequirement(data as Record<string, unknown>);
}

/** 同步形态的归一化（供规则解析器使用，不触发 ajv 动态加载） */
export function buildRequirement(partial: Partial<Requirement> & { feature: string }): Requirement {
  return {
    feature: partial.feature,
    goal: partial.goal,
    capabilities: partial.capabilities ?? [],
    inputs: partial.inputs ?? [],
    requirements: partial.requirements ?? [],
    businessRules: partial.businessRules ?? [],
    dependencies: partial.dependencies ?? [],
    constraints: partial.constraints,
    risks: partial.risks,
    version: partial.version,
    source: partial.source,
    confidence: partial.confidence,
    understanding: partial.understanding,
  };
}
