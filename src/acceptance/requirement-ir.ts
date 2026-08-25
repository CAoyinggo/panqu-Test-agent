/** 开发验收需求的来源定位。line/lineStart/lineEnd 均为原始文档 1-based 行号。 */
export interface RequirementSource {
  documentId?: string;
  section?: string;
  /** 兼容旧消费者的单行定位；新代码优先使用 lineStart/lineEnd。 */
  line?: number;
  lineStart?: number;
  lineEnd?: number;
  /** 原始来源片段；content 是兼容旧字段，text 是 Fact Ledger 的稳定字段。 */
  content?: string;
  text?: string;
}

/** Fact Ledger 要求来源必须可定位且保留原文。 */
export interface RequirementSourceSpan extends RequirementSource {
  lineStart: number;
  lineEnd: number;
  text: string;
}

export const REQUIREMENT_FACT_CATEGORIES = [
  'FUNCTIONAL',
  'UI',
  'API',
  'VALIDATION',
  'AUTH',
  'PERMISSION',
  'DATA_ISOLATION',
  'BUSINESS_RULE',
  'STATE',
  'ERROR',
  'BOUNDARY',
  'PERFORMANCE',
  'SECURITY',
  'COMPATIBILITY',
  'SIDE_EFFECT',
  'CLEANUP',
  'OTHER',
] as const;

/** 需求事实的业务分类；每个 source statement 必须且只能获得一个主分类。 */
export type RequirementFactCategory = typeof REQUIREMENT_FACT_CATEGORIES[number];

/** 信息的认知属性，与“信息来自哪里”是两个独立维度。 */
export type RequirementEpistemicType = 'FACT' | 'INFERENCE' | 'HYPOTHESIS' | 'OPINION';

/** 测试条件的来源属性。UNKNOWN 只能用于确实无法判定来源的兼容输入。 */
export type RequirementFactProvenance = 'EXPLICIT' | 'CONTRACT' | 'CONFIGURED' | 'INFERRED' | 'UNKNOWN';

export type RequirementNormativity = 'NORMATIVE' | 'NON_NORMATIVE';

/**
 * Parser 只负责建立事实，默认不能宣称已被测试设计消费：
 * - CONSUMED：后续 Test Objective/Case/Assertion 已建立闭环；
 * - UNVERIFIED：事实已理解，但尚未建立消费闭环；
 * - BLOCKED：事实本身存在冲突，不能选择性采用；
 * - NON_NORMATIVE：背景、标题或说明，不计入需求覆盖率。
 */
export type RequirementFactStatus = 'CONSUMED' | 'UNVERIFIED' | 'BLOCKED' | 'NON_NORMATIVE';

export type RequirementFactEntityType =
  | 'FEATURE'
  | 'ACTOR'
  | 'PAGE'
  | 'API'
  | 'PARAMETER'
  | 'RESPONSE'
  | 'ACCEPTANCE_CRITERION'
  | 'PERMISSION'
  | 'ISOLATION_RULE'
  | 'BUSINESS_RULE'
  | 'STATE_RULE';

/** Fact 与现有 Acceptance IR 投影实体之间的稳定引用。 */
export interface RequirementFactEntityRef {
  type: RequirementFactEntityType;
  id: string;
  apiSpecId?: string;
  operationKey?: string;
  field?: string;
}

/**
 * 序列化安全的实体引用集合。items 保留完整类型化引用，派生索引供
 * Test Objective/Generator 无需解析复合 ID 即可确定 API 与参数。
 */
export interface RequirementFactEntityRefs {
  items: RequirementFactEntityRef[];
  apiSpecIds: string[];
  parameterNames: string[];
}

export type CanonicalActorKind = 'USER' | 'ADMIN' | 'GUEST' | 'ANONYMOUS' | 'SYSTEM' | 'SERVICE' | 'UNKNOWN';

export interface CanonicalActor {
  /** 指向 Actors 表中的稳定 ID；只有显式命中时才填充。 */
  id?: string;
  role?: string;
  kind: CanonicalActorKind;
  source: 'EXPLICIT' | 'CONFIGURED' | 'UNKNOWN';
}

export type CanonicalActionKind =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'SUBMIT'
  | 'VALIDATE'
  | 'TRANSITION'
  | 'DISPLAY'
  | 'NOTIFY'
  | 'CHARGE'
  | 'ROLLBACK'
  | 'CLEANUP'
  | 'ACCESS'
  | 'UNKNOWN';

export interface CanonicalAction {
  kind: CanonicalActionKind;
  /** 原文中的动作片段或结构化 Operation。 */
  expression?: string;
  operationKey?: string;
}

export interface CanonicalResource {
  /** 稳定、领域无关的资源类型，例如 ORDER / USER_PROFILE。无法确认时为 UNKNOWN。 */
  kind: string;
  expression?: string;
  /** 仅保存需求显式给出的字段绑定；禁止生成器自行补 ID。 */
  identifiers: Record<string, string>;
}

export type CanonicalConditionKind = 'IF' | 'WHEN' | 'BEFORE' | 'AFTER' | 'OWNERSHIP' | 'STATE' | 'PARAMETER' | 'OTHER';

export interface CanonicalCondition {
  kind: CanonicalConditionKind;
  expression: string;
  explicit: true;
}

export type CanonicalConstraintKind =
  | 'REQUIRED'
  | 'NULLABLE'
  | 'TYPE'
  | 'RANGE'
  | 'LENGTH'
  | 'FORMAT'
  | 'ENUM'
  | 'ROLE_REQUIRED'
  | 'AUTH_NOT_REQUIRED'
  | 'OWNER_ONLY'
  | 'SCOPE_ISOLATION'
  | 'ATOMIC'
  | 'UNIQUE'
  | 'IDEMPOTENT'
  | 'ORDERING'
  | 'STATE_TRANSITION'
  | 'UI_STATE'
  | 'EXPECTED_ERROR'
  | 'OTHER';

export interface CanonicalConstraint {
  kind: CanonicalConstraintKind;
  field?: string;
  expression: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  values?: unknown[];
}

export type CanonicalExpectedKind =
  | 'ALLOW'
  | 'DENY'
  | 'SUCCESS'
  | 'FAILURE'
  | 'NOT_FOUND'
  | 'EMPTY'
  | 'UNCHANGED'
  | 'STATE_CHANGED'
  | 'VISIBLE'
  | 'HIDDEN'
  | 'VALID'
  | 'INVALID'
  | 'STATUS'
  | 'UNKNOWN';

export interface CanonicalExpectedOutcome {
  kind: CanonicalExpectedKind;
  /** 只有需求或结构化契约显式给出时才存在。 */
  status?: number;
  value?: unknown;
  expression?: string;
  explicit: boolean;
}

export interface CanonicalScope {
  dimension: 'USER' | 'TENANT' | 'PROJECT' | 'WORKSPACE' | 'ORGANIZATION' | 'GLOBAL' | 'UNKNOWN';
  relation: 'SELF' | 'OTHER' | 'SAME' | 'CROSS' | 'OWNER_ONLY' | 'UNKNOWN';
  expression: string;
}

export interface CanonicalSideEffect {
  kind: 'DATA_MUTATION' | 'INVENTORY' | 'MESSAGE' | 'BILLING' | 'AUDIT' | 'CACHE' | 'FILE' | 'EXTERNAL' | 'OTHER';
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'INCREASE' | 'DECREASE' | 'SEND' | 'ROLLBACK' | 'UNCHANGED' | 'UNKNOWN';
  expression: string;
  /** 当前需要什么证据通道；它不是“已经可执行”的声明。 */
  observation: 'API' | 'DATA' | 'EVENT' | 'EXTERNAL' | 'UNKNOWN';
}

/**
 * Requirement Understanding 的唯一 canonical 语义载体。
 * 后续 Strategy/Objectives 消费该结构，不应再次从 statement 猜业务语义。
 */
export interface CanonicalRequirementFact {
  actor?: CanonicalActor;
  targetActor?: CanonicalActor;
  resource: CanonicalResource;
  action: CanonicalAction;
  conditions: CanonicalCondition[];
  constraints: CanonicalConstraint[];
  expected: CanonicalExpectedOutcome;
  scopes: CanonicalScope[];
  sideEffects: CanonicalSideEffect[];
  normalizationStatus: 'COMPLETE' | 'PARTIAL' | 'UNRESOLVED';
  unresolved: string[];
}

/** Requirement Fact Ledger 的最小闭环实体。 */
export interface RequirementFact {
  id: string;
  source: RequirementSourceSpan;
  category: RequirementFactCategory;
  statement: string;
  epistemicType: RequirementEpistemicType;
  provenance: RequirementFactProvenance;
  normativity: RequirementNormativity;
  status: RequirementFactStatus;
  confidence?: number;
  entityRefs: RequirementFactEntityRefs;
  /** statement 的一次性标准化结果；Fact → Strategy → Objective 的唯一业务语义输入。 */
  canonical: CanonicalRequirementFact;
  /** 由 Test Design 阶段回填；Parser 初始化为空数组。 */
  linkedObjectiveIds?: string[];
  /** BLOCKED/UNVERIFIED 的机器可读或人类可读原因；后续阶段可补充。 */
  statusReason?: string;
}

export interface FeatureSpec {
  id: string;
  name: string;
  description?: string;
  source?: RequirementSource;
}

export interface ActorSpec {
  id: string;
  name: string;
  userId?: string;
  role: string;
  tenantId?: string;
  /** 仅保存运行时凭据引用，不在需求 IR 中保存真实 Token。 */
  tokenRef?: string;
  source?: RequirementSource;
}

export interface PageSpec {
  id: string;
  path: string;
  description?: string;
  source?: RequirementSource;
}

export type ParameterType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
export type ParameterLocation = 'header' | 'query' | 'path' | 'body';

export interface ParameterSpec {
  name: string;
  type: ParameterType;
  required: boolean;
  nullable: boolean;
  location: ParameterLocation;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  source?: RequirementSource;
}

export interface ResponseSpec {
  status: number;
  description?: string;
  headers?: Record<string, string>;
  body?: unknown;
  source?: RequirementSource;
}

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiAuthPolicy = 'AUTH_REQUIRED' | 'AUTH_NOT_REQUIRED' | 'AUTH_UNKNOWN';

export interface ApiSpec {
  id: string;
  /** 当前 Markdown 入口的稳定 Operation Identity：精确 Method + Path Template。 */
  operationKey: string;
  /** 认证必须由契约显式声明；没有声明时不得把 anonymous 等同于 public。 */
  authPolicy: ApiAuthPolicy;
  method: HttpMethod;
  path: string;
  headers: ParameterSpec[];
  query: ParameterSpec[];
  pathParams: ParameterSpec[];
  body: ParameterSpec[];
  responses: ResponseSpec[];
  source?: RequirementSource;
}

export type ApiBindingStrategy = 'SINGLE_API' | 'EXACT_METHOD_PATH';

/** AC/Test Point 与一个确定 API Operation 的编译期绑定。 */
export interface ApiOperationBinding {
  apiSpecId: string;
  operationKey: string;
  method: HttpMethod;
  path: string;
  sourceAcId?: string;
  sourceTestPointId: string;
  strategy: ApiBindingStrategy;
  confidence: 'HIGH';
}

export type ApiBindingIssueCode = 'API_NOT_FOUND' | 'BINDING_AMBIGUOUS' | 'BINDING_MISMATCH' | 'BINDING_INCOMPLETE';

export interface ApiBindingIssue {
  code: ApiBindingIssueCode;
  stage: 'BINDING';
  blocking: true;
  message: string;
  source?: RequirementSource;
  sourceAcId?: string;
  sourceTestPointId: string;
  candidateApiSpecIds: string[];
}

export interface DataModelSpec {
  id: string;
  name: string;
  fields: ParameterSpec[];
  source?: RequirementSource;
}

export interface PermissionSpec {
  id: string;
  actorRole: string;
  action: string;
  resource: string;
  effect: 'ALLOW' | 'DENY';
  source?: RequirementSource;
}

export interface IsolationRule {
  id: string;
  subject: string;
  resource: string;
  dimension: 'USER' | 'PROJECT' | 'TENANT';
  expected: 'ALLOW' | 'DENY' | 'NOT_FOUND' | 'EMPTY';
  source?: RequirementSource;
}

export interface StateRule {
  id: string;
  from?: string;
  action: string;
  to?: string;
  source?: RequirementSource;
}

export interface AcceptanceCriterion {
  criterionId: string;
  objective: string;
  source: RequirementSource;
}

export interface BusinessRule {
  id: string;
  description: string;
  source?: RequirementSource;
}

export interface RequirementParseWarning {
  code: 'NO_API' | 'NO_RESPONSE' | 'NO_ACCEPTANCE_CRITERIA' | 'NO_ACTOR' | 'AUTH_UNKNOWN' | 'AUTH_REQUIRED_NO_ACTOR' | 'AMBIGUOUS_CRITERION' | 'DUPLICATE_AC' | 'DUPLICATE_PARAMETER' | 'DUPLICATE_API_OPERATION' | 'PARAMETER_WITHOUT_API_CONTEXT' | 'INVALID_API_PATH' | 'UNPARSED_CONTRACT_HINT' | 'AUTH_CONTRACT_UNRESOLVED' | 'UNPARSED_RESPONSE_CONTRACT' | 'UNMAPPED_REQUIREMENT_RULE' | 'UNVERIFIED_REQUIREMENT_FACT' | 'REQUIREMENT_CONFLICT';
  message: string;
  source?: RequirementSource;
  stage?: 'PARSER';
  /** 关键约束未被理解时阻断 Data Prepare 和 Execution。 */
  blocking?: boolean;
}

/** 通用开发验收的内部需求模型；与历史 Requirement 并存，不改变 WAN3 输入契约。 */
export interface AcceptanceRequirement {
  id: string;
  title: string;
  source: RequirementSource;
  features: FeatureSpec[];
  actors: ActorSpec[];
  pages: PageSpec[];
  apis: ApiSpec[];
  dataModels: DataModelSpec[];
  permissions: PermissionSpec[];
  isolationRules: IsolationRule[];
  stateRules: StateRule[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessRules: BusinessRule[];
  /** 原文语句与结构化实体的统一事实账本；是后续 Test Design 的 canonical 输入。 */
  factLedger: RequirementFact[];
  /** 无法可靠结构化的内容必须显式暴露，禁止静默丢失。 */
  warnings: RequirementParseWarning[];
}
