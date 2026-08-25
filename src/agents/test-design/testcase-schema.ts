// Test DSL Schema：统一的测试用例数据模型 + JSON Schema 校验 + 现有引擎适配
// 目标：Test Design Agent 产出结构化 Test DSL，通过 toTaskDef/toLoadedCase 无缝接入现有 Execution Engine，
// 并复用现有 Assertion Engine（不重新实现第二套断言系统）。

import type { TaskDef, AssertionConfig } from '../../core/types.js';
import type { AssertionRule, AssertionOperator } from '../../core/assertion-operators.js';
import type { LoadedCase } from '../../cases/loader.js';
import { toCanonicalSceneId, type CanonicalSceneId } from '../../core/canonical-scene.js';
import { CodedError, ErrorCode } from '../../core/errors.js';
import type { ContractDependency } from '../../contracts/types.js';

/** 优先级 */
export type TestPriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * 开发验收测试类型与执行模式；旧 DSL 未设置时保持 legacy 行为。
 *
 * `DESCRIPTIVE_ONLY` 是历史名称；新设计链统一产出 `DESIGNED_ONLY`。两者都表示
 * “已完成测试设计，但当前没有可验证的执行契约”，绝不能进入 PASS 路径。
 */
export type TestType =
  | 'FUNCTIONAL'
  | 'API'
  | 'UI'
  | 'PARAMETER'
  | 'AUTH'
  | 'PERMISSION'
  | 'DATA_ISOLATION'
  | 'BUSINESS_RULE'
  | 'STATE'
  | 'ERROR'
  | 'BOUNDARY'
  | 'SECURITY'
  | 'COMPATIBILITY'
  | 'PERFORMANCE'
  | 'SIDE_EFFECT'
  | 'CLEANUP'
  | 'HYBRID';
export type TestExecutionMode = 'EXECUTABLE' | 'DESIGNED_ONLY' | 'DESCRIPTIVE_ONLY';
export type TestCaseSourceType = 'REQUIREMENT' | 'CONTRACT' | 'HEURISTIC';
export type TestProvenance = 'EXPLICIT' | 'CONTRACT' | 'CONFIGURED' | 'INFERRED' | 'UNKNOWN';

export interface TestCaseSource {
  requirementId: string;
  testPointId: string;
  acceptanceCriteriaIds: string[];
  /** Canonical Requirement Fact 与 Test Objective 追溯。 */
  factIds?: string[];
  objectiveIds?: string[];
  scenarioId?: string;
  sourceType?: TestCaseSourceType;
  provenance?: TestProvenance;
  /** Acceptance 编译器确定绑定的 API；Processor 必须用原始 ApiSpec 复核。 */
  apiSpecId?: string;
  apiOperationKey?: string;
  /** Phase 1 canonical API Contract binding。 */
  contractRef?: string;
  contractVersion?: string;
  contractFingerprint?: string;
  documentId?: string;
  section?: string;
  line?: number;
}

export interface TestActor {
  id?: string;
  userId?: string;
  role?: string;
  tenantId?: string;
  tokenRef?: string;
  /** 区分需求明示身份、配置身份与设计阶段占位身份。 */
  provenance?: TestProvenance;
}

export type ApiAssertionType = 'STATUS_CODE' | 'RESPONSE_HEADER' | 'JSON_PATH' | 'JSON_VALUE' | 'CONTAINS' | 'TYPE' | 'DESIGN_EXPECTATION';

/** 单步执行动作 */
export interface TestStep {
  /** 动作：submit / wait / query / assert */
  action?: string;
  /** 协议化步骤；第一阶段支持 HTTP_REQUEST。 */
  type?: 'HTTP_REQUEST';
  /** 场景处理器（如 video），缺省按 feature 推断 */
  scene?: string;
  /** 动作输入（如 { prompt, resolution, duration }） */
  input?: Record<string, unknown>;
  /** wait 的目标状态（如 SUCCESS） */
  until?: string;
  method?: 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url?: string;
  headers?: Record<string, string>;
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  actor?: TestActor;
}

/** 断言定义（复用现有 Assertion Engine 的操作符与 target） */
export interface AssertionDefinition {
  /** HTTP 协议断言；旧 DSL 继续使用 operator。 */
  type?: ApiAssertionType;
  /** 断言目标：submit / response / billing / headers / env / metrics / custom */
  target?: AssertionRule['target'];
  /** JSON Path */
  path?: string;
  /** 操作符（现有 17 个操作符之一） */
  operator?: AssertionOperator;
  /** 期望值 */
  expected?: unknown;
  message?: string;
  /** 设计态的人类可判定期望；DESIGN_EXPECTATION 不得交给 Runner 当作执行证据。 */
  description?: string;
  severity?: 'P0' | 'P1' | 'P2';
  header?: string;
  /** 每条断言都必须能说明它验证哪个 Fact/Objective，以及期望从何而来。 */
  factIds?: string[];
  objectiveId?: string;
  objectiveIds?: string[];
  sourceType?: TestCaseSourceType;
  provenance?: TestProvenance;
}

/** 期望结果（汇总） */
export interface ExpectedResult {
  status?: string;
  fields?: Record<string, unknown>;
  description?: string;
}

export interface TestCaseDesign {
  objectiveIds: string[];
  factIds: string[];
  scenarioId?: string;
  sourceType: TestCaseSourceType;
  expectedOutcome: string;
  /** 人类可读的设计动作；真实执行动作仍由 steps/Execution Plan 承担。 */
  actions: string[];
  executability: 'EXECUTABLE' | 'DESIGNED_ONLY';
  reason?: string;
}

/** 统一 Test DSL 用例 */
export interface TestCase {
  id: string;
  feature: string;
  name: string;
  priority: TestPriority;
  testType?: TestType;
  executionMode?: TestExecutionMode;
  source?: TestCaseSource;
  protocol?: 'HTTP' | 'LEGACY';
  actor?: TestActor;
  tags: string[];
  preconditions?: string[];
  data?: Record<string, unknown>;
  steps: TestStep[];
  assertions: AssertionDefinition[];
  expected?: ExpectedResult;
  metadata?: Record<string, unknown>;
  design?: TestCaseDesign;
  contractDependencies?: ContractDependency[];
  parameterContext?: {
    parameter: string;
    constraint: string;
    testData: unknown;
    expectedResponse?: number;
    expectedOutcome?: string;
    boundaryVector?: string;
  };
  /**
   * One real request may cover several equivalent parameter vectors. Keeping
   * this trace separate prevents the generator from replaying the same write
   * merely to preserve one-vector-per-Case presentation.
   */
  parameterCoverage?: Array<{
    parameter: string;
    constraint: string;
    testData: unknown;
    expectedResponse?: number;
    expectedOutcome?: string;
    boundaryVectors: string[];
  }>;
  /** 明确的负向契约意图；Binding Gate 仅对这些字段允许故意缺失或违反 Schema。 */
  negativeContractIntent?: {
    omittedPathParams?: string[];
    omittedHeaders?: string[];
    omittedQueryParams?: string[];
    omittedBodyFields?: string[];
    invalidPathParams?: string[];
    invalidQueryParams?: string[];
    invalidHeaders?: string[];
    invalidBodyFields?: string[];
  };
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
    testType: { enum: ['FUNCTIONAL', 'API', 'UI', 'PARAMETER', 'AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY', 'COMPATIBILITY', 'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID'] },
    executionMode: { enum: ['EXECUTABLE', 'DESIGNED_ONLY', 'DESCRIPTIVE_ONLY'] },
    protocol: { enum: ['HTTP', 'LEGACY'] },
    source: { type: 'object' },
    actor: { type: 'object' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        anyOf: [{ required: ['action'] }, { required: ['type'] }],
        properties: {
          action: { type: 'string', minLength: 1 },
          scene: { type: 'string' },
          input: { type: 'object' },
          until: { type: 'string' },
          type: { enum: ['HTTP_REQUEST'] },
          method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          url: { type: 'string' },
          headers: { type: 'object' },
          pathParams: { type: 'object' },
          query: { type: 'object' },
          actor: { type: 'object' },
        },
      },
    },
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        anyOf: [{ required: ['operator'] }, { required: ['type'] }],
        properties: {
          type: { enum: ['STATUS_CODE', 'RESPONSE_HEADER', 'JSON_PATH', 'JSON_VALUE', 'CONTAINS', 'TYPE', 'DESIGN_EXPECTATION'] },
          target: { type: 'string' },
          path: { type: 'string' },
          operator: { enum: [...VALID_OPERATORS] },
          severity: { enum: ['P0', 'P1', 'P2'] },
          header: { type: 'string' },
        },
      },
    },
    expected: {
      type: 'object',
      properties: { status: { type: 'string' }, fields: { type: 'object' } },
    },
    metadata: { type: 'object' },
    design: { type: 'object' },
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
    throw new CodedError(ErrorCode.INVALID_TESTCASE, 'TestCase 校验失败：不符合 Test DSL JSON Schema');
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
    testType: isTestType(data.testType) ? data.testType : undefined,
    executionMode: isExecutionMode(data.executionMode) ? data.executionMode : undefined,
    source: isRecord(data.source) ? data.source as unknown as TestCaseSource : undefined,
    protocol: data.protocol === 'HTTP' || data.protocol === 'LEGACY' ? data.protocol : undefined,
    actor: isRecord(data.actor) ? data.actor as TestActor : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    preconditions: Array.isArray(data.preconditions) ? data.preconditions.map(String) : undefined,
    data: isRecord(data.data) ? data.data : undefined,
    steps,
    assertions,
    expected: isRecord(data.expected) ? (data.expected as ExpectedResult) : undefined,
    metadata: isRecord(data.metadata) ? data.metadata : undefined,
    design: isRecord(data.design) ? data.design as unknown as TestCaseDesign : undefined,
    parameterContext: isRecord(data.parameterContext) ? data.parameterContext as TestCase['parameterContext'] : undefined,
    parameterCoverage: Array.isArray(data.parameterCoverage)
      ? data.parameterCoverage.filter(isRecord) as TestCase['parameterCoverage']
      : undefined,
    negativeContractIntent: isRecord(data.negativeContractIntent) ? data.negativeContractIntent as TestCase['negativeContractIntent'] : undefined,
  };
}

function isPriority(v: unknown): v is TestPriority {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3';
}
function isTestType(v: unknown): v is TestType {
  return ['FUNCTIONAL', 'API', 'UI', 'PARAMETER', 'AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY', 'COMPATIBILITY', 'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID'].includes(String(v));
}
function isExecutionMode(v: unknown): v is TestExecutionMode {
  return v === 'EXECUTABLE' || v === 'DESIGNED_ONLY' || v === 'DESCRIPTIVE_ONLY';
}

/** 新旧设计态统一判定；调用方不得把设计完成误当成已执行。 */
export function isDesignedOnlyCase(testCase: Pick<TestCase, 'executionMode'>): boolean {
  return testCase.executionMode === 'DESIGNED_ONLY' || testCase.executionMode === 'DESCRIPTIVE_ONLY';
}
function isStep(v: unknown): v is TestStep {
  return typeof v === 'object' && v !== null
    && (typeof (v as { action?: unknown }).action === 'string' || (v as { type?: unknown }).type === 'HTTP_REQUEST');
}
function isAssertion(v: unknown): v is AssertionDefinition {
  return (
    typeof v === 'object' && v !== null
    && ((typeof (v as { operator?: unknown }).operator === 'string'
      && (VALID_OPERATORS as readonly string[]).includes((v as { operator: string }).operator))
      || ['STATUS_CODE', 'RESPONSE_HEADER', 'JSON_PATH', 'JSON_VALUE', 'CONTAINS', 'TYPE', 'DESIGN_EXPECTATION'].includes(String((v as { type?: unknown }).type)))
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

// ── DSL 可执行性检查：生成/LLM 产出的用例必须在 DSL 层面真实可执行 ──

/** 需要 expected 期望值的操作符（缺 expected 即不可执行） */
const OPERATORS_REQUIRING_EXPECTED: readonly AssertionOperator[] = [
  'equals', 'notEquals', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte',
  'in', 'notIn', 'regex', 'type', 'deepEquals',
];

/** DSL 可执行性检查结果 */
export interface DslCheckResult {
  executable: boolean;
  /** 不可执行原因（供日志/过滤） */
  problems: string[];
}

/**
 * 校验单条用例在 DSL 层面真实可执行：
 * - 必须有非空 id/name/feature 与至少一个步骤；
 * - 必须包含 submit 步骤（DSL 的执行锚点），且 submit 带对象类型 input；
 * - wait 步骤必须声明 until；
 * - 断言操作符合法，且需要期望值的操作符必须给出 expected。
 * 不过关的用例不允许进入执行链路（生成器与 LLM 输出统一过此门）。
 */
export function checkDslExecutable(tc: TestCase): DslCheckResult {
  const problems: string[] = [];
  if (!tc.id?.trim()) problems.push('缺少 id');
  if (!tc.name?.trim()) problems.push('缺少 name');
  if (!tc.feature?.trim()) problems.push('缺少 feature');
  if (!Array.isArray(tc.steps) || tc.steps.length === 0) problems.push('缺少步骤');

  if (isDesignedOnlyCase(tc)) {
    return { executable: false, problems: [`用例明确标记为 ${tc.executionMode}`] };
  }

  const apiCase = tc.protocol === 'HTTP' || tc.testType === 'API'
    || (tc.steps ?? []).some((step) => step.type === 'HTTP_REQUEST');
  const submits = (tc.steps ?? []).filter((s) => s.action === 'submit');
  if (apiCase) {
    const requests = (tc.steps ?? []).filter((step) => step.type === 'HTTP_REQUEST');
    if (tc.protocol !== 'HTTP') problems.push('API 用例 protocol 必须为 HTTP');
    if (requests.length === 0) problems.push('API 用例缺少 HTTP_REQUEST 步骤');
    for (const request of requests) {
      if (!request.method) problems.push('HTTP_REQUEST 缺少 method');
      if (!request.url) problems.push('HTTP_REQUEST 缺少 url');
    }
  } else if (submits.length === 0) problems.push('缺少 submit 步骤（DSL 执行锚点）');
  for (const s of submits) {
    if (s.input !== undefined && (typeof s.input !== 'object' || Array.isArray(s.input))) {
      problems.push('submit.input 必须是对象');
    }
  }
  for (const s of (tc.steps ?? [])) {
    if (s.action === 'wait' && !s.until) problems.push('wait 步骤缺少 until');
  }

  if (!Array.isArray(tc.assertions) || tc.assertions.length === 0) {
    problems.push('缺少有效业务断言');
  }

  for (const a of tc.assertions ?? []) {
    if (a.type) {
      if (a.type === 'DESIGN_EXPECTATION') {
        problems.push('DESIGN_EXPECTATION 只能用于 DESIGNED_ONLY Case');
        continue;
      }
      if (a.type !== 'JSON_PATH' && a.expected === undefined) problems.push(`HTTP 断言 ${a.type} 缺少 expected`);
      if (a.type === 'RESPONSE_HEADER' && !a.header) problems.push('RESPONSE_HEADER 断言缺少 header');
      if (['JSON_PATH', 'JSON_VALUE', 'CONTAINS', 'TYPE'].includes(a.type) && !a.path) {
        problems.push(`${a.type} 断言缺少 path`);
      }
      if (a.type === 'STATUS_CODE' && typeof a.expected !== 'number') problems.push('STATUS_CODE expected 必须是数字');
      if (a.type === 'TYPE' && !['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'].includes(String(a.expected))) {
        problems.push('TYPE expected 非法');
      }
    } else {
      if (!a.operator || !(VALID_OPERATORS as readonly string[]).includes(a.operator)) {
        problems.push(`非法操作符：${a.operator}`);
        continue;
      }
      if ((OPERATORS_REQUIRING_EXPECTED as readonly string[]).includes(a.operator) && a.expected === undefined) {
        problems.push(`操作符 ${a.operator} 缺少 expected`);
      }
    }
  }

  return { executable: problems.length === 0, problems };
}

/** 过滤出 DSL 可执行用例（附不可执行原因回调供日志） */
export function filterDslExecutable(cases: TestCase[], onDrop?: (tc: TestCase, problems: string[]) => void): TestCase[] {
  return cases.filter((tc) => {
    const r = checkDslExecutable(tc);
    if (!r.executable) onDrop?.(tc, r.problems);
    return r.executable;
  });
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
  const scene = testCase.protocol === 'HTTP' || testCase.testType === 'API'
    ? 'api'
    : toCanonicalSceneId(firstSubmit?.scene) ?? inferScene(testCase.feature) ?? firstSubmit?.scene ?? testCase.feature;

  const rules: AssertionRule[] = testCase.assertions.filter((a) => a.operator).map((a) => ({
    target: a.target ?? 'submit',
    path: a.path,
    operator: a.operator!,
    expected: a.expected,
    message: a.message,
    severity: a.severity,
  }));
  const assert: AssertionConfig | undefined = rules.length ? { mode: 'all', rules } : undefined;

  const resolvedContract = testCase.metadata?.resolvedContractValue;
  const contractValue = resolvedContract && typeof resolvedContract === 'object' && !Array.isArray(resolvedContract)
    ? resolvedContract as Record<string, unknown> : {};
  const contractExtra = Object.fromEntries(Object.entries(contractValue).filter(([key]) => !['type', 'modelId', 'model_id'].includes(key)));
  return {
    name: testCase.name,
    scene,
    type: typeof contractValue.type === 'number' ? contractValue.type : undefined,
    model_id: (contractValue.modelId ?? contractValue.model_id) as number | string | undefined,
    task_type: contractValue.task_type as number | string | undefined,
    extra: {
      ...(testCase.data ?? {}),
      ...mergeStepInputs(testCase.steps),
      ...contractExtra,
      agentTestCaseId: testCase.id,
      ...(testCase.protocol === 'HTTP' ? { acceptanceCase: testCase } : {}),
    },
    tags: testCase.tags,
    assert,
    // wan3 走业务适配器，其余走 default
    adapter: inferScene(testCase.feature) === 'video' ? 'wan3' : 'default',
    contractDependencies: testCase.contractDependencies,
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
