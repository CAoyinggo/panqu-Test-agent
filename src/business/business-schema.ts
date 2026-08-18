// Business Schema：业务注册中心的数据模型（Phase 21.1 Multi-Business）
// 目标：将 feature/scene 插件机制正式升级为「业务注册中心」。
// 每个业务以声明式 BusinessDefinition 定义（scenes / environments / capabilities / 策略），
// 新增业务只需添加定义 + 可选 Adapter，不修改 Core Engine / Pipeline / Assertion。

/** 业务风险策略：约束该业务下 Agent 的危险动作与审批要求 */
export interface RiskPolicy {
  /** 业务级危险动作黑名单（如 real-billing / delete-data） */
  forbiddenActions?: string[];
  /** 真实提交类操作是否必须人工审批（默认 true） */
  requireApproval?: boolean;
  /** 该业务允许的最大执行并发 */
  maxConcurrency?: number;
  /** 该业务重点关注的风险类别（billing / security / concurrency 等） */
  focusRiskCategories?: string[];
}

/** 业务测试策略：约束该业务的回归与质量门槛 */
export interface TestPolicy {
  /** 默认回归套件（smoke / sanity / regression / full / nightly / release 等） */
  defaultSuite?: string;
  /** P0 用例是否必须 100% 覆盖（默认 true） */
  p0Required?: boolean;
  /** 覆盖率门槛（0~1，默认 0.9） */
  coverageThreshold?: number;
  /** 单次运行用例数上限 */
  maxCasesPerRun?: number;
  /** 该业务允许运行的环境（缺省继承全局 test / preonline） */
  allowedEnvironments?: string[];
}

/** 业务定义：业务注册中心的基本单元 */
export interface BusinessDefinition {
  /** 业务唯一标识（如 wan3 / image-generation / chat） */
  id: string;
  /** 业务展示名 */
  name: string;
  /** 业务定义版本（如 1.0） */
  version: string;
  /** 该业务包含的场景（对应 SceneHandler 可处理的 scene 值） */
  scenes: string[];
  /** 该业务支持的环境（如 test / preonline） */
  environments: string[];
  /** 该业务的能力标签（如 text-to-video / image-to-video） */
  capabilities: string[];
  /** 业务风险策略（可选） */
  riskPolicy?: RiskPolicy;
  /** 业务测试策略（可选） */
  testPolicy?: TestPolicy;
  /** 业务描述（可选，供 Dashboard / 报告展示） */
  description?: string;
}

/** BusinessDefinition JSON Schema（供 ajv 校验外部定义文件） */
export const BUSINESS_JSON_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'scenes', 'capabilities'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    scenes: { type: 'array', items: { type: 'string' } },
    environments: { type: 'array', items: { type: 'string' } },
    capabilities: { type: 'array', items: { type: 'string' } },
    riskPolicy: {
      type: 'object',
      additionalProperties: true,
      properties: {
        forbiddenActions: { type: 'array', items: { type: 'string' } },
        requireApproval: { type: 'boolean' },
        maxConcurrency: { type: 'number', minimum: 1 },
        focusRiskCategories: { type: 'array', items: { type: 'string' } },
      },
    },
    testPolicy: {
      type: 'object',
      additionalProperties: true,
      properties: {
        defaultSuite: { type: 'string' },
        p0Required: { type: 'boolean' },
        coverageThreshold: { type: 'number', minimum: 0, maximum: 1 },
        maxCasesPerRun: { type: 'number', minimum: 1 },
        allowedEnvironments: { type: 'array', items: { type: 'string' } },
      },
    },
    description: { type: 'string' },
  },
} as const;

/** 判断输入是否为对象形态 */
function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

/** 归一化业务定义：补默认值（environments 缺省 test / 策略缺省值） */
export function normalizeBusinessDefinition(data: Record<string, unknown>): BusinessDefinition {
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  const def: BusinessDefinition = {
    id: String(data.id ?? '').trim(),
    name: String(data.name ?? '').trim(),
    version: String(data.version ?? '1.0').trim(),
    scenes: strArr(data.scenes),
    environments: strArr(data.environments),
    capabilities: strArr(data.capabilities),
  };
  if (!def.environments.length) def.environments = ['test'];
  if (isRecord(data.riskPolicy)) def.riskPolicy = { ...(data.riskPolicy as RiskPolicy) };
  if (isRecord(data.testPolicy)) def.testPolicy = { ...(data.testPolicy as TestPolicy) };
  if (typeof data.description === 'string' && data.description) def.description = data.description;
  return def;
}

/** 校验业务定义（ajv）：非法抛错，合法返回归一化结果 */
export async function validateBusinessDefinition(data: unknown): Promise<BusinessDefinition> {
  if (!isRecord(data)) {
    throw new Error('BusinessDefinition 结构无效：必须为对象');
  }
  if (!data.id || typeof data.id !== 'string') {
    throw new Error('BusinessDefinition 校验失败：缺少 id');
  }
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean })(
    { allErrors: true, strict: false },
  );
  const validate = ajv.validate(BUSINESS_JSON_SCHEMA as object, data);
  if (!validate) {
    throw new Error(`BusinessDefinition 校验失败：${data.id} 不符合 JSON Schema`);
  }
  return normalizeBusinessDefinition(data);
}
