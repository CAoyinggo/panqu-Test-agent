// Test DSL Schema：统一的测试用例数据模型 + JSON Schema 校验 + 现有引擎适配
// 目标：Test Design Agent 产出结构化 Test DSL，通过 toTaskDef/toLoadedCase 无缝接入现有 Execution Engine，
// 并复用现有 Assertion Engine（不重新实现第二套断言系统）。

import type { TaskDef, AssertionConfig } from '../../core/types.js';
import type { AssertionRule, AssertionOperator } from '../../core/assertion-operators.js';
import type { LoadedCase } from '../../cases/loader.js';
import { toCanonicalSceneId, type CanonicalSceneId } from '../../core/canonical-scene.js';
import { CodedError, ErrorCode } from '../../core/errors.js';
import type { ContractDependency } from '../../contracts/types.js';
import type {
  ScenarioAssertionChannel,
  ScenarioHook,
  ScenarioOperationChannel,
  ScenarioPrecondition,
  ScenarioTestData,
} from '../../acceptance/scenario-contract.js';

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

/**
 * Test Type 保留执行器使用的主分类；Test Aspect 描述一条 Case 实际承担的
 * 业务证明义务。多个 Aspect 可以落在同一 Case，避免为了“类型齐全”重复执行。
 */
export type TestAspect =
  | 'UI_INTERACTION'
  | 'CORE_FUNCTION'
  | 'API_CONTRACT'
  | 'PARAMETER_REQUIRED'
  | 'PARAMETER_NULL'
  | 'PARAMETER_TYPE'
  | 'PARAMETER_FORMAT'
  | 'BOUNDARY_VALUE'
  | 'NEGATIVE_PATH'
  | 'AUTHENTICATION'
  | 'ROLE_PERMISSION'
  | 'USER_ISOLATION'
  | 'TENANT_ISOLATION'
  | 'PROJECT_ISOLATION'
  | 'STATE_TRANSITION'
  | 'DATA_CONSISTENCY'
  | 'IDEMPOTENCY'
  | 'DUPLICATE_SUBMISSION'
  | 'CONCURRENCY'
  | 'FRONTEND_BACKEND_CONSISTENCY'
  | 'SIDE_EFFECT'
  | 'CROSS_CASE_SIDE_EFFECT'
  | 'PRE_POST_CONDITION'
  | 'ROLLBACK_RECOVERY';

export type TestRequirementStatus = 'CONFIRMED' | 'UNKNOWN' | 'NEED_CONFIRMATION';

export type TestBusinessScenarioKind =
  | 'CORE_FLOW'
  | 'STATE_TRANSITION'
  | 'PERMISSION'
  | 'DATA_ISOLATION'
  | 'RESOURCE_OWNERSHIP'
  | 'PARAMETER_RULE'
  | 'IDEMPOTENCY'
  | 'CONCURRENCY'
  | 'RECOVERY'
  | 'CONSISTENCY'
  | 'SIDE_EFFECT'
  | 'UNKNOWN';

export interface TestBusinessActorContext {
  id?: string;
  role?: string;
  tenantId?: string;
  projectId?: string;
  relation: 'SUBJECT' | 'OWNER' | 'TARGET' | 'OTHER_USER' | 'OTHER_TENANT';
  provenance: TestProvenance;
}

export interface TestBusinessFlowStep {
  id: string;
  action: string;
  actorRef?: string;
  resourceRef?: string;
  operationRef?: string;
  fromState?: string;
  toState?: string;
  dependsOn: string[];
}

export interface TestBusinessFlow {
  id: string;
  name: string;
  mode: 'SINGLE_OPERATION' | 'SEQUENCE' | 'PARALLEL' | 'CROSS_ACTOR' | 'CROSS_TENANT' | 'RECOVERY';
  steps: TestBusinessFlowStep[];
}

export interface TestBusinessRisk {
  id: string;
  level: TestPriority;
  category: 'BUSINESS_CONTINUITY' | 'SECURITY' | 'DATA_INTEGRITY' | 'FINANCIAL'
    | 'CONCURRENCY' | 'DEPENDENCY' | 'RECOVERY' | 'COMPLIANCE' | 'UNKNOWN';
  description: string;
  source: 'REQUIREMENT' | 'CONTRACT' | 'TEST_STRATEGY';
}

export interface TestBusinessScenario {
  /** Requirement 原文对应的业务意图；不得由生成器补充产品规则。 */
  title: string;
  /** Actor 为了什么业务结果执行什么动作。 */
  goal: string;
  actor?: string;
  action?: string;
  resource?: string;
  /** 结构化业务场景类型；用于风险驱动组合生成，而不是报告标签。 */
  kind: TestBusinessScenarioKind;
  /** Subject/Owner/Target 分离，避免把 Actor ID 当成业务 Resource ID。 */
  actors: TestBusinessActorContext[];
  /** Projection 中命中的全部资源，resourceContext 仅保留首资源兼容旧消费方。 */
  resources?: Array<{
    id: string;
    type: string;
    identifiers: Record<string, string>;
    provenance: TestProvenance;
    factIds: string[];
  }>;
  resourceContext: {
    type: string;
    idRef?: string;
    provenance: TestProvenance;
  };
  ownership: {
    relation: 'SELF' | 'OTHER_USER' | 'SAME_TENANT' | 'CROSS_TENANT' | 'SHARED' | 'SYSTEM' | 'UNKNOWN' | 'NOT_APPLICABLE';
    ownerActorId?: string;
    tenantId?: string;
    projectId?: string;
    provenance: TestProvenance;
  };
  /** 多资源、多 Scope 场景的完整归属关系。 */
  ownerships?: Array<{
    resourceId: string;
    ownerActorId?: string;
    subjectActorId?: string;
    tenantId?: string;
    projectId?: string;
    relation: 'SELF' | 'OTHER_USER' | 'SAME_TENANT' | 'CROSS_TENANT' | 'SAME_PROJECT' | 'CROSS_PROJECT' | 'UNKNOWN';
    scopes: Array<{ dimension: string; relation: string; expression: string }>;
    factIds: string[];
  }>;
  scopes?: Array<{ dimension: string; relation: string; expression: string; factIds: string[] }>;
  state: {
    status: 'KNOWN' | 'UNKNOWN' | 'NOT_APPLICABLE';
    before?: string;
    after?: string;
    forbidden?: string[];
    expression?: string;
    provenance: TestProvenance;
  };
  permission: {
    decision: 'ALLOW' | 'DENY' | 'UNKNOWN' | 'NOT_APPLICABLE';
    role?: string;
    action?: string;
    scope?: string;
    provenance: TestProvenance;
  };
  flow: TestBusinessFlow;
  /** 业务依赖只保存来源中已识别的依赖；执行能力依赖见 executionContract。 */
  dependencies: string[];
  risks: TestBusinessRisk[];
  expectedBusinessOutcome: string;
  provenance: TestProvenance;
  factIds: string[];
  acceptanceCriteriaIds: string[];
}

export type TestStepChannel = ScenarioOperationChannel | 'FUNCTIONAL';

export interface TestCaseDependency {
  id: string;
  kind: 'ENVIRONMENT' | 'CONTRACT' | 'IDENTITY' | 'TEST_DATA' | 'OBSERVER' | 'LIFECYCLE' | 'CASE';
  ref: string;
  description: string;
  required: boolean;
  resolution: 'STATIC' | 'RUNTIME_REQUIRED' | 'UNRESOLVED';
}

export interface TestOracleDefinition {
  mode: 'ALL';
  deterministic: true;
  status: 'READY' | 'BLOCKED' | 'NEED_CONFIRMATION';
  assertionIds: string[];
  evidenceRequirementIds: string[];
  reason?: string;
}

export interface TestCaseReadiness {
  status: 'READY' | 'BLOCKED' | 'NEED_CONFIRMATION';
  reasons: string[];
  missingCapabilities: string[];
  /** 首次运行时解析前保存生成态快照。 */
  generated?: {
    status: 'READY' | 'BLOCKED' | 'NEED_CONFIRMATION';
    reasons: string[];
    missingCapabilities: string[];
  };
  runtime?: TestRuntimeReadiness;
  effective?: TestRuntimeReadiness;
}

export interface TestRuntimeCapabilityResolution {
  kind: 'EXECUTOR' | 'PROCESSOR' | 'OBSERVER' | 'HOOK' | 'ENVIRONMENT' | 'TEST_DATA' | 'DEPENDENCY' | 'PREFLIGHT';
  ref: string;
  required: boolean;
  available: boolean;
  reason?: string;
}

export interface TestRuntimeReadiness {
  status: 'EXECUTABLE' | 'BLOCKED' | 'NOT_EXECUTED' | 'DESIGNED_ONLY';
  reasons: string[];
  missingCapabilities: string[];
  capabilities: TestRuntimeCapabilityResolution[];
  resolvedAt: string;
}

export type TestExecutorKind = 'HTTP' | 'BROWSER' | 'DATA' | 'COMPOSITE' | 'FUNCTIONAL' | 'NONE';

/**
 * Case 级执行能力声明。它回答“由谁执行、由谁观察、执行前检查什么”；
 * `AVAILABLE` 只表示实现存在，运行时仍必须通过 Preflight/Policy Gate。
 */
export interface TestExecutionContract {
  executor: {
    kind: TestExecutorKind;
    ref: string;
    status: 'AVAILABLE' | 'RUNTIME_REQUIRED' | 'UNAVAILABLE';
    supports: string[];
  };
  observers: Array<{
    channel: TestEvidenceChannel;
    ref: string;
    phase: TestEvidenceRequirement['phase'];
    required: boolean;
    status: 'AVAILABLE' | 'RUNTIME_REQUIRED' | 'UNAVAILABLE';
  }>;
  preflight: Array<{
    kind: 'ENVIRONMENT' | 'CONTRACT' | 'IDENTITY' | 'RESOURCE' | 'STATE' | 'DEPENDENCY';
    ref: string;
    required: boolean;
  }>;
  lifecycleHooks: Array<{
    phase: 'PREPARE' | 'CLEANUP';
    hookId: string;
    required: boolean;
    evidenceRequired: boolean;
  }>;
}

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
  projectId?: string;
  tokenRef?: string;
  /** 区分需求明示身份、配置身份与设计阶段占位身份。 */
  provenance?: TestProvenance;
}

export type ApiAssertionType = 'STATUS_CODE' | 'RESPONSE_HEADER' | 'JSON_PATH' | 'JSON_VALUE' | 'CONTAINS' | 'TYPE' | 'DESIGN_EXPECTATION';

/** 单步执行动作 */
export interface TestStep {
  /** 稳定的 Case 内步骤标识，供依赖、Evidence 与报告引用。 */
  id?: string;
  channel?: TestStepChannel;
  description?: string;
  execution?: 'EXECUTABLE' | 'PLANNED';
  dependsOn?: string[];
  acceptanceCriteriaIds?: string[];
  factIds?: string[];
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
  /** 同一非空 group 的 Step 需要并发调度；当前不支持时必须保持 PLANNED。 */
  concurrencyGroup?: string;
  /** 运行时从该 Step 输出捕获值，供后续 {{capture.name}} 绑定。 */
  capture?: Record<string, string>;
}

/** 断言定义（复用现有 Assertion Engine 的操作符与 target） */
export interface AssertionDefinition {
  /** Case 内 Oracle 标识与 Evidence 反向引用。 */
  id?: string;
  channel?: ScenarioAssertionChannel;
  acceptanceCriteriaIds?: string[];
  evidenceRequirementIds?: string[];
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
  /** 多步骤 Scenario 可引用前序捕获值，不建立新的 Oracle 协议。 */
  expectedFrom?: string | { operationId?: string; evidenceId?: string; testDataId?: string; path?: string };
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
  response?: {
    status?: number | string;
    fields?: Record<string, unknown>;
    description?: string;
  };
  state?: {
    expectation: 'PRESENT' | 'UNCHANGED' | 'CHANGED' | 'CONSISTENT' | 'UNKNOWN';
    description: string;
  };
  sideEffects?: Array<{
    kind: string;
    action: string;
    description: string;
    expectation: 'REQUIRED' | 'FORBIDDEN' | 'UNCHANGED' | 'UNKNOWN';
  }>;
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

/**
 * Case 在执行前声明的证据采集契约。它只描述“必须观察什么”，不声称证据已经存在；
 * Runner/Oracle 会逐项核对 collected/missing，避免根据 testType 事后猜测证据要求。
 */
export type TestEvidenceChannel =
  | 'API_REQUEST'
  | 'API_RESPONSE'
  | 'UI_STATE'
  | 'UI_SCREENSHOT'
  | 'DATABASE_STATE'
  | 'LOG'
  | 'STATE_CHANGE'
  | 'DATA_DIFF'
  | 'LIFECYCLE_HOOK'
  | 'RESOURCE_STATE'
  | 'EVENT'
  | 'QUEUE_MESSAGE'
  | 'PROVIDER_CALL'
  | 'BILLING_RECORD'
  | 'AUDIT_RECORD';

export interface TestEvidenceRequirement {
  id?: string;
  channel: TestEvidenceChannel;
  phase: 'BEFORE' | 'DURING' | 'AFTER';
  required: boolean;
  /** Oracle 对该证据的确定性语义；缺省只证明证据存在。 */
  expectation?: 'PRESENT' | 'UNCHANGED' | 'CHANGED' | 'CONSISTENT';
  description: string;
  factIds: string[];
  sourceStepId?: string;
  assertionIds?: string[];
}

/** 统一 Test DSL 用例 */
export interface TestCase {
  /** 新生成 Case 使用 V2；未设置表示兼容历史 Test DSL。 */
  schemaVersion?: 'TEST_CASE_V2';
  id: string;
  feature: string;
  name: string;
  priority: TestPriority;
  testType?: TestType;
  testAspects?: TestAspect[];
  executionMode?: TestExecutionMode;
  requirementStatus?: TestRequirementStatus;
  businessScenario?: TestBusinessScenario;
  source?: TestCaseSource;
  protocol?: 'HTTP' | 'LEGACY';
  actor?: TestActor;
  tags: string[];
  preconditions?: string[];
  /** 复用 canonical Scenario primitive，供 Preflight/Runner 逐项检查。 */
  preconditionPlan?: ScenarioPrecondition[];
  data?: Record<string, unknown>;
  /** 结构化测试数据与归属/敏感/清理信息；data 保留为 Runner 兼容输入。 */
  testData?: ScenarioTestData[];
  steps: TestStep[];
  assertions: AssertionDefinition[];
  expected?: ExpectedResult;
  /** 可执行与设计态 Case 都必须显式列出验证所需证据；设计态仅表示当前尚无采集能力。 */
  evidenceRequirements?: TestEvidenceRequirement[];
  oracle?: TestOracleDefinition;
  prepare?: ScenarioHook[];
  cleanup?: ScenarioHook[];
  dependencies?: TestCaseDependency[];
  readiness?: TestCaseReadiness;
  executionContract?: TestExecutionContract;
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
  allOf: [{
    if: { properties: { schemaVersion: { const: 'TEST_CASE_V2' } }, required: ['schemaVersion'] },
    then: {
      required: [
        'source', 'testType', 'testAspects', 'executionMode', 'requirementStatus',
        'businessScenario', 'tags', 'preconditions', 'preconditionPlan', 'data',
        'testData', 'assertions', 'expected', 'evidenceRequirements', 'oracle',
        'prepare', 'cleanup', 'dependencies', 'readiness', 'executionContract',
      ],
      properties: {
        source: {
          type: 'object',
          required: ['requirementId', 'testPointId', 'acceptanceCriteriaIds', 'factIds', 'objectiveIds', 'sourceType', 'provenance'],
          properties: {
            requirementId: { type: 'string', minLength: 1 },
            testPointId: { type: 'string', minLength: 1 },
            acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
            factIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
            objectiveIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
            sourceType: { enum: ['REQUIREMENT', 'CONTRACT', 'HEURISTIC'] },
            provenance: { enum: ['EXPLICIT', 'CONTRACT', 'CONFIGURED', 'INFERRED', 'UNKNOWN'] },
          },
        },
        preconditions: { type: 'array', items: { type: 'string' } },
        preconditionPlan: {
          type: 'array',
          items: {
            type: 'object', required: ['id', 'kind', 'description', 'required'],
            properties: {
              id: { type: 'string', minLength: 1 },
              kind: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              required: { type: 'boolean' },
            },
          },
        },
        data: { type: 'object' },
        testData: {
          type: 'array',
          items: {
            type: 'object', required: ['id', 'source'],
            properties: {
              id: { type: 'string', minLength: 1 },
              source: { enum: ['EXPLICIT', 'FIXTURE', 'PREPARE_HOOK', 'CONFIGURATION', 'CAPTURED', 'GENERATED'] },
            },
          },
        },
        steps: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'channel', 'description', 'execution', 'dependsOn', 'acceptanceCriteriaIds', 'factIds'],
            properties: {
              id: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              execution: { enum: ['EXECUTABLE', 'PLANNED'] },
              dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string' } },
              acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
              factIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
            },
          },
        },
        assertions: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'channel', 'acceptanceCriteriaIds', 'factIds', 'evidenceRequirementIds'],
            properties: {
              id: { type: 'string', minLength: 1 },
              acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
              factIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
              evidenceRequirementIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
            },
          },
        },
        evidenceRequirements: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'channel', 'phase', 'required', 'description', 'factIds', 'sourceStepId', 'assertionIds'],
            properties: {
              id: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              factIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
              sourceStepId: { type: 'string', minLength: 1 },
              assertionIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
            },
          },
        },
        oracle: {
          type: 'object',
          required: ['mode', 'deterministic', 'status', 'assertionIds', 'evidenceRequirementIds'],
          properties: {
            mode: { const: 'ALL' }, deterministic: { const: true },
            status: { enum: ['READY', 'BLOCKED', 'NEED_CONFIRMATION'] },
            assertionIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
            evidenceRequirementIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
          },
          allOf: [{
            if: { properties: { status: { const: 'READY' } }, required: ['status'] },
            then: { properties: { assertionIds: { minItems: 1 }, evidenceRequirementIds: { minItems: 1 } } },
          }],
        },
        prepare: { type: 'array', items: { $ref: '#/$defs/scenarioHook' } },
        cleanup: { type: 'array', items: { $ref: '#/$defs/scenarioHook' } },
        dependencies: {
          type: 'array',
          items: {
            type: 'object', required: ['id', 'kind', 'ref', 'description', 'required', 'resolution'],
            properties: {
              id: { type: 'string', minLength: 1 },
              kind: { enum: ['ENVIRONMENT', 'CONTRACT', 'IDENTITY', 'TEST_DATA', 'OBSERVER', 'LIFECYCLE', 'CASE'] },
              ref: { type: 'string', minLength: 1 },
              description: { type: 'string', minLength: 1 },
              required: { type: 'boolean' },
              resolution: { enum: ['STATIC', 'RUNTIME_REQUIRED', 'UNRESOLVED'] },
            },
          },
        },
        readiness: {
          type: 'object', required: ['status', 'reasons', 'missingCapabilities'],
          properties: {
            status: { enum: ['READY', 'BLOCKED', 'NEED_CONFIRMATION'] },
            reasons: { type: 'array', items: { type: 'string' } },
            missingCapabilities: { type: 'array', items: { type: 'string' } },
          },
        },
        executionContract: {
          type: 'object', required: ['executor', 'observers', 'preflight', 'lifecycleHooks'],
          properties: {
            executor: {
              type: 'object', required: ['kind', 'ref', 'status', 'supports'],
              properties: {
                kind: { enum: ['HTTP', 'BROWSER', 'DATA', 'COMPOSITE', 'FUNCTIONAL', 'NONE'] },
                ref: { type: 'string', minLength: 1 },
                status: { enum: ['AVAILABLE', 'RUNTIME_REQUIRED', 'UNAVAILABLE'] },
                supports: { type: 'array', items: { type: 'string' } },
              },
            },
            observers: { type: 'array', items: { type: 'object', required: ['channel', 'ref', 'phase', 'required', 'status'] } },
            preflight: { type: 'array', items: { type: 'object', required: ['kind', 'ref', 'required'] } },
            lifecycleHooks: { type: 'array', items: { type: 'object', required: ['phase', 'hookId', 'required', 'evidenceRequired'] } },
          },
        },
      },
    },
  }],
  $defs: {
    scenarioHook: {
      type: 'object', required: ['id', 'phase', 'handler', 'required'],
      properties: {
        id: { type: 'string', minLength: 1 },
        phase: { enum: ['PREPARE', 'CLEANUP'] },
        handler: { type: 'string', minLength: 1 },
        required: { type: 'boolean' },
      },
    },
  },
  properties: {
    schemaVersion: { enum: ['TEST_CASE_V2'] },
    id: { type: 'string', minLength: 1 },
    feature: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    priority: { enum: ['P0', 'P1', 'P2', 'P3'] },
    tags: { type: 'array', items: { type: 'string' } },
    testType: { enum: ['FUNCTIONAL', 'API', 'UI', 'PARAMETER', 'AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY', 'COMPATIBILITY', 'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID'] },
    testAspects: {
      type: 'array', minItems: 1, uniqueItems: true,
      items: { enum: [
        'UI_INTERACTION', 'CORE_FUNCTION', 'API_CONTRACT', 'PARAMETER_REQUIRED',
        'PARAMETER_NULL', 'PARAMETER_TYPE', 'PARAMETER_FORMAT', 'BOUNDARY_VALUE',
        'NEGATIVE_PATH', 'AUTHENTICATION', 'ROLE_PERMISSION', 'USER_ISOLATION',
        'TENANT_ISOLATION', 'PROJECT_ISOLATION', 'STATE_TRANSITION',
        'DATA_CONSISTENCY', 'IDEMPOTENCY', 'DUPLICATE_SUBMISSION', 'CONCURRENCY',
        'FRONTEND_BACKEND_CONSISTENCY', 'SIDE_EFFECT', 'CROSS_CASE_SIDE_EFFECT',
        'PRE_POST_CONDITION', 'ROLLBACK_RECOVERY',
      ] },
    },
    executionMode: { enum: ['EXECUTABLE', 'DESIGNED_ONLY', 'DESCRIPTIVE_ONLY'] },
    requirementStatus: { enum: ['CONFIRMED', 'UNKNOWN', 'NEED_CONFIRMATION'] },
    businessScenario: {
      type: 'object',
      required: [
        'title', 'goal', 'kind', 'actors', 'resourceContext', 'ownership', 'state',
        'permission', 'flow', 'dependencies', 'risks', 'expectedBusinessOutcome',
        'provenance', 'factIds', 'acceptanceCriteriaIds',
      ],
      properties: {
        title: { type: 'string', minLength: 1 },
        goal: { type: 'string', minLength: 1 },
        kind: { enum: [
          'CORE_FLOW', 'STATE_TRANSITION', 'PERMISSION', 'DATA_ISOLATION', 'RESOURCE_OWNERSHIP',
          'PARAMETER_RULE', 'IDEMPOTENCY', 'CONCURRENCY', 'RECOVERY', 'CONSISTENCY',
          'SIDE_EFFECT', 'UNKNOWN',
        ] },
        actors: { type: 'array', items: { type: 'object', required: ['relation', 'provenance'] } },
        resourceContext: { type: 'object', required: ['type', 'provenance'] },
        ownership: { type: 'object', required: ['relation', 'provenance'] },
        state: { type: 'object', required: ['status', 'provenance'] },
        permission: { type: 'object', required: ['decision', 'provenance'] },
        flow: {
          type: 'object', required: ['id', 'name', 'mode', 'steps'],
          properties: {
            id: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            mode: { enum: ['SINGLE_OPERATION', 'SEQUENCE', 'PARALLEL', 'CROSS_ACTOR', 'CROSS_TENANT', 'RECOVERY'] },
            steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'action', 'dependsOn'] } },
          },
        },
        dependencies: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'object', required: ['id', 'level', 'category', 'description', 'source'] } },
        expectedBusinessOutcome: { type: 'string', minLength: 1 },
        provenance: { enum: ['EXPLICIT', 'CONTRACT', 'CONFIGURED', 'INFERRED', 'UNKNOWN'] },
        factIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
      },
    },
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
          id: { type: 'string' },
          channel: { enum: ['API', 'UI', 'DATA', 'QUEUE', 'PROVIDER', 'FUNCTIONAL'] },
          description: { type: 'string' },
          execution: { enum: ['EXECUTABLE', 'PLANNED'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
          acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
          factIds: { type: 'array', items: { type: 'string' } },
          action: { type: 'string', minLength: 1 },
          scene: { type: 'string' },
          input: { type: 'object' },
          until: { type: 'string' },
          type: { enum: ['HTTP_REQUEST'] },
          method: { enum: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] },
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
          id: { type: 'string' },
          channel: { type: 'string' },
          acceptanceCriteriaIds: { type: 'array', items: { type: 'string' } },
          evidenceRequirementIds: { type: 'array', items: { type: 'string' } },
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
      properties: {
        status: { type: 'string' }, fields: { type: 'object' }, description: { type: 'string' },
        response: { type: 'object' }, state: { type: 'object' }, sideEffects: { type: 'array' },
      },
    },
    evidenceRequirements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['channel', 'phase', 'required', 'description', 'factIds'],
        properties: {
          id: { type: 'string' },
          channel: { enum: ['API_REQUEST', 'API_RESPONSE', 'UI_STATE', 'UI_SCREENSHOT', 'DATABASE_STATE', 'LOG', 'STATE_CHANGE', 'DATA_DIFF', 'LIFECYCLE_HOOK', 'RESOURCE_STATE', 'EVENT', 'QUEUE_MESSAGE', 'PROVIDER_CALL', 'BILLING_RECORD', 'AUDIT_RECORD'] },
          phase: { enum: ['BEFORE', 'DURING', 'AFTER'] },
          required: { type: 'boolean' },
          expectation: { enum: ['PRESENT', 'UNCHANGED', 'CHANGED', 'CONSISTENT'] },
          description: { type: 'string' },
          factIds: { type: 'array', items: { type: 'string' } },
          sourceStepId: { type: 'string' },
          assertionIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    preconditionPlan: { type: 'array', items: { type: 'object' } },
    testData: { type: 'array', items: { type: 'object' } },
    oracle: { type: 'object' },
    prepare: { type: 'array', items: { type: 'object' } },
    cleanup: { type: 'array', items: { type: 'object' } },
    dependencies: { type: 'array', items: { type: 'object' } },
    readiness: { type: 'object' },
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
    schemaVersion: data.schemaVersion === 'TEST_CASE_V2' ? 'TEST_CASE_V2' : undefined,
    id: String(data.id ?? '').trim() || `case-${Date.now().toString(36)}`,
    feature: String(data.feature ?? '').trim(),
    name: String(data.name ?? '').trim(),
    priority: isPriority(data.priority) ? data.priority : 'P2',
    testType: isTestType(data.testType) ? data.testType : undefined,
    testAspects: Array.isArray(data.testAspects)
      ? data.testAspects.filter(isTestAspect)
      : undefined,
    executionMode: isExecutionMode(data.executionMode) ? data.executionMode : undefined,
    requirementStatus: data.requirementStatus === 'CONFIRMED'
      || data.requirementStatus === 'UNKNOWN'
      || data.requirementStatus === 'NEED_CONFIRMATION'
      ? data.requirementStatus : undefined,
    businessScenario: isRecord(data.businessScenario)
      ? data.businessScenario as unknown as TestBusinessScenario : undefined,
    source: isRecord(data.source) ? data.source as unknown as TestCaseSource : undefined,
    protocol: data.protocol === 'HTTP' || data.protocol === 'LEGACY' ? data.protocol : undefined,
    actor: isRecord(data.actor) ? data.actor as TestActor : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    preconditions: Array.isArray(data.preconditions) ? data.preconditions.map(String) : undefined,
    preconditionPlan: Array.isArray(data.preconditionPlan)
      ? data.preconditionPlan.filter(isRecord) as unknown as ScenarioPrecondition[] : undefined,
    data: isRecord(data.data) ? data.data : undefined,
    testData: Array.isArray(data.testData)
      ? data.testData.filter(isRecord) as unknown as ScenarioTestData[] : undefined,
    steps,
    assertions,
    expected: isRecord(data.expected) ? (data.expected as ExpectedResult) : undefined,
    evidenceRequirements: Array.isArray(data.evidenceRequirements)
      ? data.evidenceRequirements.filter(isRecord) as unknown as TestEvidenceRequirement[]
      : undefined,
    oracle: isRecord(data.oracle) ? data.oracle as unknown as TestOracleDefinition : undefined,
    prepare: Array.isArray(data.prepare)
      ? data.prepare.filter(isRecord) as unknown as ScenarioHook[] : undefined,
    cleanup: Array.isArray(data.cleanup)
      ? data.cleanup.filter(isRecord) as unknown as ScenarioHook[] : undefined,
    dependencies: Array.isArray(data.dependencies)
      ? data.dependencies.filter(isRecord) as unknown as TestCaseDependency[] : undefined,
    readiness: isRecord(data.readiness) ? data.readiness as unknown as TestCaseReadiness : undefined,
    executionContract: isRecord(data.executionContract)
      ? data.executionContract as unknown as TestExecutionContract : undefined,
    metadata: isRecord(data.metadata) ? data.metadata : undefined,
    design: isRecord(data.design) ? data.design as unknown as TestCaseDesign : undefined,
    parameterContext: isRecord(data.parameterContext) ? data.parameterContext as TestCase['parameterContext'] : undefined,
    parameterCoverage: Array.isArray(data.parameterCoverage)
      ? data.parameterCoverage.filter(isRecord) as TestCase['parameterCoverage']
      : undefined,
    negativeContractIntent: isRecord(data.negativeContractIntent) ? data.negativeContractIntent as TestCase['negativeContractIntent'] : undefined,
    contractDependencies: Array.isArray(data.contractDependencies)
      ? data.contractDependencies.filter(isRecord) as unknown as ContractDependency[] : undefined,
  };
}

function isPriority(v: unknown): v is TestPriority {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3';
}
function isTestType(v: unknown): v is TestType {
  return ['FUNCTIONAL', 'API', 'UI', 'PARAMETER', 'AUTH', 'PERMISSION', 'DATA_ISOLATION', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY', 'COMPATIBILITY', 'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID'].includes(String(v));
}
function isTestAspect(v: unknown): v is TestAspect {
  return [
    'UI_INTERACTION', 'CORE_FUNCTION', 'API_CONTRACT', 'PARAMETER_REQUIRED',
    'PARAMETER_NULL', 'PARAMETER_TYPE', 'PARAMETER_FORMAT', 'BOUNDARY_VALUE',
    'NEGATIVE_PATH', 'AUTHENTICATION', 'ROLE_PERMISSION', 'USER_ISOLATION',
    'TENANT_ISOLATION', 'PROJECT_ISOLATION', 'STATE_TRANSITION', 'DATA_CONSISTENCY',
    'IDEMPOTENCY', 'DUPLICATE_SUBMISSION', 'CONCURRENCY', 'FRONTEND_BACKEND_CONSISTENCY',
    'SIDE_EFFECT', 'CROSS_CASE_SIDE_EFFECT', 'PRE_POST_CONDITION', 'ROLLBACK_RECOVERY',
  ].includes(String(v));
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

/** Processor 不能从产品或功能名称推断；由显式 scene/runtime binding 决定。 */
function inferScene(_feature: string): CanonicalSceneId | null {
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

  if (tc.schemaVersion === 'TEST_CASE_V2') {
    if (tc.executionMode !== 'EXECUTABLE') problems.push('TEST_CASE_V2 executionMode 必须为 EXECUTABLE');
    if (tc.requirementStatus !== 'CONFIRMED') problems.push('Requirement 未确认，禁止执行');
    if (tc.readiness?.status !== 'READY') problems.push('Readiness 未就绪，禁止执行');
    if (!tc.executionContract || tc.executionContract.executor.status !== 'AVAILABLE') {
      problems.push('Executor 能力未就绪，禁止执行');
    }
    if (tc.executionContract?.observers.some((observer) => observer.required && observer.status !== 'AVAILABLE')) {
      problems.push('Observer 能力未就绪，禁止执行');
    }
    if (tc.oracle?.status !== 'READY' || tc.oracle.deterministic !== true
      || !tc.oracle.assertionIds.length || !tc.oracle.evidenceRequirementIds.length) {
      problems.push('确定性 Oracle 未就绪');
    }
    if (tc.steps.some((step) => step.execution !== 'EXECUTABLE')) problems.push('存在 PLANNED/未声明执行步骤');
    if (tc.steps.some((step) => !step.id || !step.channel || !step.description || !step.factIds?.length)) {
      problems.push('Step 缺少 id/channel/description/factIds');
    }
    if ((tc.dependencies ?? []).some((dependency) => dependency.required && dependency.resolution === 'UNRESOLVED')) {
      problems.push('存在未解析的 required Dependency');
    }
    if ((tc.preconditionPlan ?? []).some((precondition) => precondition.required && !precondition.checkRef)) {
      problems.push('存在无法检查的 required Precondition');
    }
    const assertionIds = new Set(tc.assertions.map((assertion) => assertion.id).filter(Boolean));
    const evidenceIds = new Set((tc.evidenceRequirements ?? []).map((evidence) => evidence.id).filter(Boolean));
    if (assertionIds.size !== tc.assertions.length) problems.push('Assertion ID 缺失或重复');
    if (evidenceIds.size !== (tc.evidenceRequirements ?? []).length) problems.push('Evidence Requirement ID 缺失或重复');
    if (tc.assertions.some((assertion) => assertion.type !== 'DESIGN_EXPECTATION'
      && (!assertion.factIds?.length || !assertion.evidenceRequirementIds?.length
        || assertion.evidenceRequirementIds.some((id) => !evidenceIds.has(id))))) {
      problems.push('Assertion 的 Fact/Evidence trace 不完整');
    }
    if ((tc.evidenceRequirements ?? []).some((evidence) => !evidence.factIds.length
      || !evidence.sourceStepId || !tc.steps.some((step) => step.id === evidence.sourceStepId)
      || evidence.assertionIds?.some((id) => !assertionIds.has(id)))) {
      problems.push('Evidence Requirement 的 Step/Assertion/Fact trace 不完整');
    }
    if (tc.oracle && (tc.oracle.assertionIds.some((id) => !assertionIds.has(id))
      || tc.oracle.evidenceRequirementIds.some((id) => !evidenceIds.has(id)))) {
      problems.push('Oracle 引用了未定义的 Assertion/Evidence');
    }
    const runtimeAssertionIds = tc.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')
      .map((assertion) => assertion.id!).filter(Boolean);
    const requiredEvidenceIds = (tc.evidenceRequirements ?? []).filter((evidence) => evidence.required)
      .map((evidence) => evidence.id!).filter(Boolean);
    const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
      && new Set(left).size === left.length && left.every((id) => right.includes(id));
    if (tc.oracle && (!sameIds(tc.oracle.assertionIds, runtimeAssertionIds)
      || !sameIds(tc.oracle.evidenceRequirementIds, requiredEvidenceIds))) {
      problems.push('Oracle mode=ALL 必须覆盖全部 Runtime Assertion 与 required Evidence');
    }
  }

  const apiCase = tc.protocol === 'HTTP' || tc.testType === 'API'
    || (tc.steps ?? []).some((step) => step.type === 'HTTP_REQUEST');
  const submits = (tc.steps ?? []).filter((s) => s.action === 'submit');
  if (apiCase) {
    const requests = (tc.steps ?? []).filter((step) => step.type === 'HTTP_REQUEST');
    if (tc.protocol !== 'HTTP') problems.push('API 用例 protocol 必须为 HTTP');
    if (requests.length === 0) problems.push('API 用例缺少 HTTP_REQUEST 步骤');
    if (tc.schemaVersion === 'TEST_CASE_V2' && (requests.length !== 1 || tc.steps.length !== 1
      || tc.steps.some((step) => step.type !== 'HTTP_REQUEST' || step.channel !== 'API'))) {
      problems.push('当前 HTTP Processor 要求 V2 API Case 仅包含一个 channel=API 的 HTTP_REQUEST');
    }
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
    if (tc.schemaVersion === 'TEST_CASE_V2' && apiCase && !a.type) {
      problems.push('当前 HTTP Processor 不支持 operator-only V2 Assertion');
      continue;
    }
    if (a.type) {
      if (a.type === 'DESIGN_EXPECTATION') {
        problems.push('DESIGN_EXPECTATION 只能用于 DESIGNED_ONLY Case');
        continue;
      }
      const effectiveOperator = a.operator ?? (a.type === 'JSON_PATH' ? 'exists'
        : a.type === 'CONTAINS' ? 'contains' : a.type === 'TYPE' ? 'type' : 'equals');
      if (!(VALID_OPERATORS as readonly string[]).includes(effectiveOperator)) {
        problems.push(`非法操作符：${effectiveOperator}`);
      }
      if ((OPERATORS_REQUIRING_EXPECTED as readonly string[]).includes(effectiveOperator)
        && a.expected === undefined) problems.push(`HTTP 断言 ${a.type}/${effectiveOperator} 缺少 expected`);
      if (a.type === 'RESPONSE_HEADER' && !a.header) problems.push('RESPONSE_HEADER 断言缺少 header');
      if (['JSON_PATH', 'JSON_VALUE', 'CONTAINS', 'TYPE'].includes(a.type) && !a.path) {
        problems.push(`${a.type} 断言缺少 path`);
      }
      if (a.type === 'STATUS_CODE' && effectiveOperator === 'equals' && typeof a.expected !== 'number') {
        problems.push('STATUS_CODE equals expected 必须是数字');
      }
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
  if (testCase.schemaVersion === 'TEST_CASE_V2') {
    const executable = checkDslExecutable(testCase);
    if (!executable.executable) {
      throw new CodedError(ErrorCode.INVALID_TESTCASE, `TEST_CASE_V2 不可执行：${executable.problems.join('；')}`);
    }
  }
  const firstSubmit = testCase.steps.find((s) => s.action === 'submit');
  const scene = testCase.protocol === 'HTTP' || testCase.testType === 'API'
    ? 'api'
    : toCanonicalSceneId(firstSubmit?.scene) ?? inferScene(testCase.feature) ?? firstSubmit?.scene ?? testCase.feature;

  const rules: AssertionRule[] = testCase.assertions.flatMap((assertion): AssertionRule[] => {
    if (!assertion.type) return assertion.operator ? [{
      target: assertion.target ?? 'submit', path: assertion.path, operator: assertion.operator,
      expected: assertion.expected, message: assertion.message, severity: assertion.severity,
    }] : [];
    if (assertion.type === 'DESIGN_EXPECTATION') return [];
    const target = assertion.type === 'RESPONSE_HEADER' ? 'headers' : 'response';
    const path = assertion.type === 'STATUS_CODE' ? 'status'
      : assertion.type === 'RESPONSE_HEADER' ? assertion.header?.toLowerCase()
        : assertion.path ? `json.${assertion.path}` : 'json';
    const operator = assertion.operator ?? (assertion.type === 'JSON_PATH' ? 'exists'
      : assertion.type === 'CONTAINS' ? 'contains' : assertion.type === 'TYPE' ? 'type' : 'equals');
    return [{ target, path, operator, expected: assertion.expected,
      message: assertion.message ?? assertion.description, severity: assertion.severity }];
  });
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
    adapter: 'default',
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
