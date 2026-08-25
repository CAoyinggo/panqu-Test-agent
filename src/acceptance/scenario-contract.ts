import type { HttpMethod } from './requirement-ir.js';
import type { ContractDependency } from '../contracts/types.js';

/**
 * Scenario 的生命周期状态。PASS / FAIL 不属于设计态，只能出现在
 * ScenarioResultStatus 中。后三种状态由一次执行实例产生，不应由生成器
 * 预先声明为“已完成”。
 */
export type ScenarioExecutionMode =
  | 'EXECUTABLE'
  | 'DESIGNED_ONLY'
  | 'BLOCKED'
  | 'NOT_EXECUTED'
  | 'TIMEOUT'
  | 'CANCELLED';

/** 只有真实执行后的确定性结果才允许使用 PASS / FAIL。 */
export type ScenarioResultStatus =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED'
  | 'NOT_EXECUTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'STALE'
  | 'CONTRACT_DRIFT';

export type BlockedReasonCode =
  | 'REQUIREMENT_CONFLICT'
  | 'MISSING_CONTRACT'
  | 'CONTRACT_CONFLICT'
  | 'CONTRACT_STALE'
  | 'CONTRACT_DRIFT'
  | 'MISSING_ACCEPTANCE_CRITERIA'
  | 'MISSING_API_CONTRACT'
  | 'MISSING_OPERATION_BINDING'
  | 'AMBIGUOUS_OPERATION_BINDING'
  | 'MISSING_METHOD'
  | 'MISSING_PATH'
  | 'MISSING_PROCESSOR'
  | 'MISSING_EXECUTOR'
  | 'UNSUPPORTED_OPERATION'
  | 'MISSING_ACTOR'
  | 'MISSING_AUTHENTICATION'
  | 'MISSING_TENANT'
  | 'MISSING_PROJECT'
  | 'MISSING_RESOURCE_OWNER'
  | 'MISSING_TEST_DATA'
  | 'MISSING_PRECONDITION'
  | 'MISSING_ASSERTION'
  | 'MISSING_RESPONSE_ASSERTION'
  | 'MISSING_STATE_ASSERTION'
  | 'MISSING_SIDE_EFFECT_ASSERTION'
  | 'MISSING_EVIDENCE'
  | 'MISSING_STATE_OBSERVER'
  | 'MISSING_SIDE_EFFECT_OBSERVER'
  | 'MISSING_ENVIRONMENT'
  | 'MISSING_DEPENDENCY'
  | 'MISSING_PREPARE'
  | 'MISSING_CLEANUP'
  | 'AMBIGUOUS_ORACLE'
  | 'POLICY_BLOCKED'
  | 'INVALID_SCENARIO'
  | 'EXECUTION_ABORTED';

export type BlockedReasonStage =
  | 'PARSER'
  | 'REQUIREMENT'
  | 'DESIGN'
  | 'PATTERN_SELECTION'
  | 'BINDING'
  | 'GATE'
  | 'POLICY'
  | 'PREPARE'
  | 'EXECUTION'
  | 'ASSERTION'
  | 'EVIDENCE'
  | 'CLEANUP'
  | 'REPORT';

/** 统一的、可统计且可恢复的阻断原因；禁止再依赖错误字符串前缀。 */
export interface BlockedReason {
  code: BlockedReasonCode;
  stage: BlockedReasonStage;
  message: string;
  details: Record<string, unknown>;
  recoverable: boolean;
  source?: ScenarioSourceReference;
}

export interface ScenarioSourceReference {
  documentId?: string;
  section?: string;
  lineStart?: number;
  lineEnd?: number;
  requirementId?: string;
  factIds?: string[];
  objectiveIds?: string[];
  acceptanceCriteriaIds?: string[];
}

export type ScenarioActorKind =
  | 'USER'
  | 'ADMIN'
  | 'GUEST'
  | 'ANONYMOUS'
  | 'SYSTEM'
  | 'SERVICE'
  | 'PROVIDER'
  | 'UNKNOWN';

export interface ScenarioActor {
  id: string;
  kind: ScenarioActorKind;
  role?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  credentialRef?: string;
  provenance?: 'EXPLICIT' | 'CONTRACT' | 'CONFIGURED' | 'INFERRED' | 'UNKNOWN';
}

/** Scenario 中的数据与权限范围。resourceOwnerId 用于隔离和 Non-Mutation 证明。 */
export interface ScenarioScope {
  tenantId?: string;
  projectId?: string;
  workspaceId?: string;
  organizationId?: string;
  resourceId?: string;
  resourceOwnerId?: string;
  relation?: 'SELF' | 'OTHER' | 'SAME' | 'CROSS' | 'GLOBAL' | 'UNKNOWN';
}

export type ScenarioAuthenticationType =
  | 'NONE'
  | 'TOKEN'
  | 'SESSION'
  | 'API_KEY'
  | 'BASIC'
  | 'MTLS'
  | 'CUSTOM';

/** 只保存凭据引用，禁止把 Secret 直接写入 Scenario 资产。 */
export interface ScenarioAuthentication {
  type: ScenarioAuthenticationType;
  required: boolean;
  credentialRef?: string;
  scopes?: string[];
  audience?: string;
  metadata?: Record<string, unknown>;
}

export type ScenarioPreconditionKind =
  | 'DATA'
  | 'STATE'
  | 'IDENTITY'
  | 'ENVIRONMENT'
  | 'DEPENDENCY'
  | 'POLICY'
  | 'OTHER';

export interface ScenarioPrecondition {
  id: string;
  kind: ScenarioPreconditionKind;
  description: string;
  required: boolean;
  checkRef?: string;
  evidenceRequirementId?: string;
}

export type ScenarioTestDataSource =
  | 'EXPLICIT'
  | 'FIXTURE'
  | 'PREPARE_HOOK'
  | 'CONFIGURATION'
  | 'CAPTURED'
  | 'GENERATED';

export interface ScenarioTestData {
  id: string;
  source: ScenarioTestDataSource;
  value?: unknown;
  valueRef?: string;
  resourceType?: string;
  resourceOwnerId?: string;
  tenantId?: string;
  projectId?: string;
  mutable?: boolean;
  sensitive?: boolean;
  cleanupHookId?: string;
}

export type ScenarioOperationChannel = 'API' | 'UI' | 'DATA' | 'QUEUE' | 'PROVIDER';

export interface ScenarioCapture {
  name: string;
  from: 'RESPONSE' | 'STATE' | 'EVENT' | 'OUTPUT';
  path?: string;
  required?: boolean;
}

/**
 * 一个 Operation 是 Runner 调用 Processor 的最小原子动作。复杂场景通过
 * dependsOn 与 capture 串联多个 Operation，而不是让单次 HTTP Processor
 * 隐式承担整条业务流程。
 */
export interface ScenarioOperation {
  id: string;
  channel: ScenarioOperationChannel;
  description: string;
  processor?: string;
  /**
   * 可选的 canonical API 契约标识。HTTP Adapter 优先使用它；未声明时只允许
   * 从运行时 ApiSpec 集合中按精确 Method + Path 唯一解析，禁止猜测。
   */
  apiSpecId?: string;
  method?: HttpMethod;
  path?: string;
  input?: unknown;
  headers?: Record<string, string>;
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  capture?: ScenarioCapture[] | Record<string, string>;
  acceptanceCriteriaIds: string[];
  factIds?: string[];
  dependsOn?: string[];
  actorRef?: string;
  timeoutMs?: number;
  retryPolicyRef?: string;
}

export type ScenarioAssertionChannel =
  | ScenarioOperationChannel
  | 'RESPONSE'
  | 'STATE'
  | 'SIDE_EFFECT'
  | 'AUDIT'
  | 'SYSTEM';

export type ScenarioAssertionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'EXISTS'
  | 'NOT_EXISTS'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'MATCHES'
  | 'TYPE_IS'
  | 'COUNT_EQUALS'
  | 'UNCHANGED'
  | 'TRANSITIONED_TO'
  | 'CUSTOM';

export interface ScenarioValueReference {
  operationId?: string;
  evidenceId?: string;
  testDataId?: string;
  path?: string;
}

export interface ScenarioAssertion {
  id: string;
  channel: ScenarioAssertionChannel;
  target: string;
  operator: ScenarioAssertionOperator;
  expected?: unknown;
  expectedFrom?: string | ScenarioValueReference;
  acceptanceCriteriaIds: string[];
  factIds?: string[];
  operationId?: string;
  evidenceRequirementIds: string[];
  severity?: 'P0' | 'P1' | 'P2';
  description?: string;
}

export type ScenarioEvidenceKind =
  | 'REQUEST'
  | 'RESPONSE'
  | 'STATE_BEFORE'
  | 'STATE_AFTER'
  | 'DATABASE'
  | 'RESOURCE'
  | 'EVENT'
  | 'QUEUE_MESSAGE'
  | 'PROVIDER_CALL'
  | 'BILLING_RECORD'
  | 'AUDIT_RECORD'
  | 'CACHE_ENTRY'
  | 'FILE'
  | 'LOG'
  | 'TRACE'
  | 'METRIC'
  | 'SCREENSHOT'
  | 'OTHER';

export interface EvidenceRequirement {
  id: string;
  kind: ScenarioEvidenceKind;
  channel: ScenarioAssertionChannel;
  description: string;
  requiredForPass: boolean;
  sourceRef?: string;
  operationId?: string;
  assertionIds: string[];
  retention?: 'RUN' | 'REGRESSION' | 'AUDIT';
}

export type ScenarioHookPhase = 'PREPARE' | 'CLEANUP';

/** Hook 只能引用运行时 allowlist 中的 handler，不允许 Markdown 携带任意代码。 */
export interface ScenarioHook {
  id: string;
  phase: ScenarioHookPhase;
  handler: string;
  input?: Record<string, unknown>;
  required: boolean;
  produces?: string[];
  dependsOn?: string[];
  timeoutMs?: number;
}

export interface ScenarioRisk {
  id: string;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category: string;
  description: string;
}

/** Requirement → Pattern → Execution 的 canonical Scenario 资产。 */
export interface Scenario {
  schemaVersion: string;
  id: string;
  title: string;
  domain?: string;
  requirement: string;
  sources: ScenarioSourceReference[];
  acceptanceCriteriaIds: string[];
  patternIds: string[];
  actor?: ScenarioActor;
  role?: string;
  scope: ScenarioScope;
  authentication?: ScenarioAuthentication;
  preconditions: ScenarioPrecondition[];
  testData: ScenarioTestData[];
  operations: ScenarioOperation[];
  assertions: ScenarioAssertion[];
  evidenceRequirements: EvidenceRequirement[];
  prepare: ScenarioHook[];
  cleanup: ScenarioHook[];
  executionMode: ScenarioExecutionMode;
  blockedReasons: BlockedReason[];
  risks: ScenarioRisk[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  dependencies: string[];
  /** 执行时必须解析到相同版本/指纹；字面参数不能替代 Contract 来源。 */
  contractDependencies?: ContractDependency[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** 兼容调用方偏好的显式名称，不建立第二套结构。 */
export type AcceptanceScenario = Scenario;

export interface EvidenceEnvelope {
  id: string;
  scenarioId: string;
  operationId?: string;
  assertionId?: string;
  requirementId?: string;
  acceptanceCriteriaIds: string[];
  kind: ScenarioEvidenceKind;
  channel: ScenarioAssertionChannel;
  source: string;
  observedAt: string;
  data: unknown;
  verified: boolean;
  redacted?: boolean;
  digest?: string;
}

export interface ScenarioOperationResult {
  operationId: string;
  status: ScenarioResultStatus;
  executed: boolean;
  processor?: string;
  processorInvoked: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  evidence: EvidenceEnvelope[];
  blockedReasons: BlockedReason[];
  error?: string;
}

/**
 * Result 将执行事实、断言计数和证据作为独立字段；下游不得仅凭 status
 * 推断是否执行或是否存在 Processor/Evidence。
 */
export interface ScenarioResult {
  scenarioId: string;
  runId?: string;
  status: ScenarioResultStatus;
  executionMode: ScenarioExecutionMode;
  executed: boolean;
  processorInvoked: boolean;
  processors: string[];
  assertions: number;
  passedAssertions: number;
  failedAssertions: number;
  evidence: EvidenceEnvelope[];
  blockedReasons: BlockedReason[];
  operationResults: ScenarioOperationResult[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
}
