// Data Schema：测试数据准备计划的数据模型 + JSON Schema 校验
// 目标：Data Agent 产出结构化 DataPlan，指导执行引擎在 --auto-setup 模式下准备/清理测试数据。
// 与现有 DataFactory / DataContext 对齐：plan.dataContext 为 setup 后的快照（初始为空）。

import type { DataContext } from '../../core/types.js';

/** 数据需求类型 */
export type DataNeedType = 'account' | 'balance' | 'assets' | 'tasks' | 'cleanup';

/** 单条数据准备动作 */
export interface DataAction {
  type: DataNeedType;
  desc: string;
  targetCases?: string[];
}

/** 单条用例的数据工厂分配 */
export interface CaseDataAssignment {
  caseId: string;
  factoryName: string;
  needsSetup: boolean;
}

/** 结构化数据准备计划 */
export interface DataPlan {
  feature: string;
  /** 是否需要数据准备（对应 --auto-setup） */
  needsSetup: boolean;
  /** 推荐数据工厂名称（如 wan3 / default，须已注册） */
  factoryName: string;
  /** 执行前准备动作 */
  setupActions: DataAction[];
  /** 执行后清理动作 */
  teardownActions: DataAction[];
  /** 用例 → 数据工厂分配 */
  caseAssignments: CaseDataAssignment[];
  /** 参数化生成参数（供 DataFactory.generate()） */
  generateParams: Record<string, unknown>;
  /** 数据上下文快照（setup 后产出；计划阶段为空对象） */
  dataContext: DataContext;
  source?: string;
  confidence?: number;
}

/** DataPlan JSON Schema（供 ajv 校验 LLM/规则输出） */
export const DATA_PLAN_JSON_SCHEMA = {
  type: 'object',
  required: ['feature', 'needsSetup', 'factoryName'],
  additionalProperties: true,
  properties: {
    feature: { type: 'string', minLength: 1 },
    needsSetup: { type: 'boolean' },
    factoryName: { type: 'string', minLength: 1 },
    setupActions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'desc'],
        properties: {
          type: { enum: ['account', 'balance', 'assets', 'tasks', 'cleanup'] },
          desc: { type: 'string', minLength: 1 },
          targetCases: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    teardownActions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'desc'],
        properties: {
          type: { enum: ['account', 'balance', 'assets', 'tasks', 'cleanup'] },
          desc: { type: 'string', minLength: 1 },
          targetCases: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    caseAssignments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['caseId', 'factoryName', 'needsSetup'],
        properties: {
          caseId: { type: 'string', minLength: 1 },
          factoryName: { type: 'string', minLength: 1 },
          needsSetup: { type: 'boolean' },
        },
      },
    },
    generateParams: { type: 'object' },
    confidence: { type: 'number' },
  },
} as const;

const DATA_NEED_TYPES: readonly DataNeedType[] = ['account', 'balance', 'assets', 'tasks', 'cleanup'];

function isDataNeedType(v: unknown): v is DataNeedType {
  return typeof v === 'string' && (DATA_NEED_TYPES as readonly string[]).includes(v);
}

function isDataAction(v: unknown): v is DataAction {
  return (
    typeof v === 'object' && v !== null
    && isDataNeedType((v as { type?: unknown }).type)
    && typeof (v as { desc?: unknown }).desc === 'string'
  );
}

function isCaseAssignment(v: unknown): v is CaseDataAssignment {
  return (
    typeof v === 'object' && v !== null
    && typeof (v as { caseId?: unknown }).caseId === 'string'
    && typeof (v as { factoryName?: unknown }).factoryName === 'string'
    && typeof (v as { needsSetup?: unknown }).needsSetup === 'boolean'
  );
}

/** 归一化 DataPlan（过滤非法动作/分配、补默认、重算 needsSetup） */
export function normalizeDataPlan(data: Record<string, unknown>): DataPlan {
  const setupActions = (Array.isArray(data.setupActions) ? data.setupActions : []).filter(isDataAction);
  const teardownActions = (Array.isArray(data.teardownActions) ? data.teardownActions : []).filter(isDataAction);
  const caseAssignments = (Array.isArray(data.caseAssignments) ? data.caseAssignments : []).filter(isCaseAssignment);

  const needsSetup = data.needsSetup === true || setupActions.length > 0;

  return {
    feature: String(data.feature ?? '').trim(),
    needsSetup,
    factoryName: String(data.factoryName ?? '').trim() || 'default',
    setupActions,
    teardownActions,
    caseAssignments,
    generateParams: isRecord(data.generateParams) ? data.generateParams : {},
    dataContext: isRecord(data.dataContext) ? (data.dataContext as DataContext) : {},
    source: data.source !== undefined ? String(data.source) : undefined,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 判断数据是否「像 DataPlan」 */
export function isDataPlanLike(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).feature === 'string';
}

/** 校验并归一化数据为 DataPlan（ajv 动态加载，不通过抛错） */
export async function validateDataPlan(data: unknown): Promise<DataPlan> {
  if (!isDataPlanLike(data)) {
    throw new Error('DataPlan 结构无效：缺少 feature 字段');
  }
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(DATA_PLAN_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error('DataPlan 校验失败：不符合 Data Plan JSON Schema');
  }
  return normalizeDataPlan(data as Record<string, unknown>);
}
