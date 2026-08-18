// Requirement Schema：结构化测试需求的数据模型 + JSON Schema 校验
// 目标：禁止下游直接依赖不可控的自然语言，所有 Agent/Engine 只消费结构化 Requirement。
// 支持 LLM 输出校验 + 归一化（兼容 requirements 的数组/对象两种形态）。

/** 单条需求参数（如 resolution: ["720P","1080P"]） */
export interface RequirementItem {
  name: string;
  values: unknown[];
}

/** 结构化测试需求 */
export interface Requirement {
  /** 功能模块（如 wan3 / user / order / payment） */
  feature: string;
  /** 测试目标（一句话，如 验证文生视频完整链路） */
  goal?: string;
  /** 能力标签（如 text-to-video / image-to-video） */
  capabilities: string[];
  /** 输入参数名（如 prompt / resolution / duration） */
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
  };
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
  };
}
