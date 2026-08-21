// Test DSL Schema：统一的测试用例数据模型 + JSON Schema 校验 + 现有引擎适配
// 目标：Test Design Agent 产出结构化 Test DSL，通过 toTaskDef/toLoadedCase 无缝接入现有 Execution Engine，
// 并复用现有 Assertion Engine（不重新实现第二套断言系统）。

import type { TaskDef, AssertionConfig } from '../../core/types.js';
import type { AssertionRule, AssertionOperator } from '../../core/assertion-operators.js';
import type { LoadedCase } from '../../cases/loader.js';
import { toCanonicalSceneId, type CanonicalSceneId } from '../../core/canonical-scene.js';

/** 优先级 */
export type TestPriority = 'P0' | 'P1' | 'P2' | 'P3';

/** 单步执行动作 */
export interface TestStep {
  /** 动作：submit / wait / query / assert */
  action: string;
  /** 场景处理器（如 video），缺省按 feature 推断 */
  scene?: string;
  /** 动作输入（如 { prompt, resolution, duration }） */
  input?: Record<string, unknown>;
  /** wait 的目标状态（如 SUCCESS） */
  until?: string;
}

/** 断言定义（复用现有 Assertion Engine 的操作符与 target） */
export interface AssertionDefinition {
  /** 断言目标：submit / response / billing / headers / env / metrics / custom */
  target?: AssertionRule['target'];
  /** JSON Path */
  path?: string;
  /** 操作符（现有 17 个操作符之一） */
  operator: AssertionOperator;
  /** 期望值 */
  expected?: unknown;
  message?: string;
  severity?: 'P0' | 'P1' | 'P2';
}

/** 期望结果（汇总） */
export interface ExpectedResult {
  status?: string;
  fields?: Record<string, unknown>;
}

/** 统一 Test DSL 用例 */
export interface TestCase {
  id: string;
  feature: string;
  name: string;
  priority: TestPriority;
  tags: string[];
  preconditions?: string[];
  data?: Record<string, unknown>;
  steps: TestStep[];
  assertions: AssertionDefinition[];
  expected?: ExpectedResult;
  metadata?: Record<string, unknown>;
}

/** 现有 Assertion Engine 支持的全部操作符（供校验） */
export const VALID_OPERATORS: readonly AssertionOperator[] = [
  'equals', 'notEquals', 'contains', 'notContains', 'exists', 'notExists',
  'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'regex', 'type', 'length',
  'deepEquals', 'jsonSchema',
];

/** TestCase JSON Schema（供 ajv 校验 LLM/生成器输出） */
export const TESTCASE_JSON_SCHEMA = {
  type: 'object',
  required: ['id', 'feature', 'name', 'priority', 'steps'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 },
    feature: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    priority: { enum: ['P0', 'P1', 'P2', 'P3'] },
    tags: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', minLength: 1 },
          scene: { type: 'string' },
          input: { type: 'object' },
          until: { type: 'string' },
        },
      },
    },
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['operator'],
        properties: {
          target: { type: 'string' },
          path: { type: 'string' },
          operator: { enum: [...VALID_OPERATORS] },
          severity: { enum: ['P0', 'P1', 'P2'] },
        },
      },
    },
    expected: {
      type: 'object',
      properties: { status: { type: 'string' }, fields: { type: 'object' } },
    },
    metadata: { type: 'object' },
  },
} as const;

/** 校验并归一化单个 TestCase（ajv 动态加载；不通过抛错） */
export async function validateTestCase(data: unknown): Promise<TestCase> {
  const mod = await import('ajv');
  const Ajv = (mod as unknown as { default?: unknown; Ajv?: unknown }).default ?? (mod as unknown as { Ajv?: unknown }).Ajv;
  const ajv = new (Ajv as new (opts?: object) => { validate(schema: object, data: unknown): boolean })(
    { allErrors: true, strict: false },
  );
  const valid = ajv.validate(TESTCASE_JSON_SCHEMA as object, data);
  if (!valid) {
    throw new Error(`TestCase 校验失败：不符合 Test DSL JSON Schema`);
  }
  return normalizeTestCase(data as Record<string, unknown>);
}

/** 归一化 TestCase（补默认字段、过滤非法断言） */
export function normalizeTestCase(data: Record<string, unknown>): TestCase {
  const steps = Array.isArray(data.steps) ? (data.steps as unknown[]).filter(isStep).slice(0, 50) : [];
  const assertions = Array.isArray(data.assertions)
    ? (data.assertions as unknown[]).filter(isAssertion).slice(0, 50)
    : [];
  return {
    id: String(data.id ?? '').trim() || `case-${Date.now().toString(36)}`,
    feature: String(data.feature ?? '').trim(),
    name: String(data.name ?? '').trim(),
    priority: isPriority(data.priority) ? data.priority : 'P2',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    preconditions: Array.isArray(data.preconditions) ? data.preconditions.map(String) : undefined,
    data: isRecord(data.data) ? data.data : undefined,
    steps,
    assertions,
    expected: isRecord(data.expected) ? (data.expected as ExpectedResult) : undefined,
    metadata: isRecord(data.metadata) ? data.metadata : undefined,
  };
}

function isPriority(v: unknown): v is TestPriority {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3';
}
function isStep(v: unknown): v is TestStep {
  return typeof v === 'object' && v !== null && typeof (v as { action?: unknown }).action === 'string';
}
function isAssertion(v: unknown): v is AssertionDefinition {
  return (
    typeof v === 'object' && v !== null
    && typeof (v as { operator?: unknown }).operator === 'string'
    && (VALID_OPERATORS as readonly string[]).includes((v as { operator: string }).operator)
  );
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 按 feature 推断默认场景处理器 */
function inferScene(feature: string): CanonicalSceneId | null {
  const f = feature.toLowerCase();
  if (f === 'wan3' || f.includes('video')) return 'video';
  return null;
}

/** 合并步骤输入为 extra（供 TaskDef 使用） */
function mergeStepInputs(steps: TestStep[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of steps) {
    if (s.input && typeof s.input === 'object') Object.assign(out, s.input);
  }
  return out;
}

/**
 * Test DSL → 现有 TaskDef（Execution Engine 可直接消费）。
 * 断言复用现有 Assertion Engine 的 target/operator/path/expected 结构。
 */
export function toTaskDef(testCase: TestCase): TaskDef {
  const firstSubmit = testCase.steps.find((s) => s.action === 'submit');
  const scene = toCanonicalSceneId(firstSubmit?.scene) ?? inferScene(testCase.feature) ?? firstSubmit?.scene ?? testCase.feature;

  const rules: AssertionRule[] = testCase.assertions.map((a) => ({
    target: a.target ?? 'submit',
    path: a.path,
    operator: a.operator,
    expected: a.expected,
    message: a.message,
    severity: a.severity,
  }));
  const assert: AssertionConfig | undefined = rules.length ? { mode: 'all', rules } : undefined;

  return {
    name: testCase.name,
    scene,
    extra: {
      ...(testCase.data ?? {}),
      ...mergeStepInputs(testCase.steps),
      agentTestCaseId: testCase.id,
    },
    tags: testCase.tags,
    assert,
    // wan3 走业务适配器，其余走 default
    adapter: inferScene(testCase.feature) === 'video' ? 'wan3' : 'default',
  };
}

/** Test DSL → LoadedCase（可与现有 loadCases 结果合并，直接进入执行链路） */
export function toLoadedCase(testCase: TestCase): LoadedCase {
  return {
    name: testCase.name,
    file: `<agent:${testCase.id}>`,
    feature: testCase.feature,
    def: toTaskDef(testCase),
  };
}
