/**
 * Panqu AI DevTest — Canonical TestSpec & Evidence Envelope
 * Phase 1.1 纯 TypeScript 领域契约与最小校验函数
 *
 * 本模块只定义与工具无关的标准化协议，不实现适配器，不接入外部工具，
 * 不修改现有四大核心动作 (probe/plan/execute/verify) 行为。
 */

// ============================================================================
// 一、Canonical TestSpec 规范类型
// ============================================================================

export type ExecutionMode = 'REAL' | 'OFFLINE' | 'FIXTURE';
export type SideEffectPolicy = 'READ_ONLY' | 'ALLOW_SUBMIT' | 'ALLOW_PAID';
export type TargetType = 'model' | 'channel' | 'scenario' | string;

export interface TestCostLimit {
  maxCostPoints: number;
  maxCostCny?: number;
  allowZeroCostOnly?: boolean;
}

export interface TestTarget {
  targetType: TargetType;
  modelId?: number;
  channelId?: number;
  expectedChannelId?: number;
  taskId?: number;
  providerTaskId?: string;
  projectId?: number;
}

export const SUPPORTED_ASSERTION_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'CONTAINS',
  'MATCHES_REGEX',
  'GREATER_THAN',
  'LESS_THAN',
  'GREATER_THAN_OR_EQUALS',
  'LESS_THAN_OR_EQUALS',
  'IN',
  'NOT_IN',
  'IS_DEFINED',
  'IS_UNDEFINED',
] as const;

export type AssertionOperator = (typeof SUPPORTED_ASSERTION_OPERATORS)[number];

export interface DeterministicAssertion {
  field: string;
  operator: AssertionOperator;
  expectedValue: unknown;
  description?: string;
  critical?: boolean;
  evidenceKey?: string;
  actualField?: string;
}

export interface AiAssistedStep {
  stepId: string;
  instruction: string;
  expectedCriteria: string;
  maxRetries?: number;
  required?: boolean;
}

export interface CanonicalTestSpec {
  testId: string;
  requirementId: string;
  scenario: string;
  environment: string;
  executionMode: ExecutionMode;
  target: TestTarget;
  inputs: Record<string, unknown>;
  deterministicAssertions: DeterministicAssertion[];
  aiAssistedSteps?: AiAssistedStep[];
  costLimit: TestCostLimit;
  sideEffectPolicy: SideEffectPolicy;
  requiredEvidence: string[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 二、Canonical Evidence Envelope 规范类型
// ============================================================================

export type EvidenceSourceType =
  'SERVER_API' | 'BROWSER' | 'MEDIA_BINARY' | 'BILLING_LEDGER' | 'AI_OBSERVATION' | 'USER_ASSERTION' | 'FIXTURE';

export type EvidenceCollectionStatus = 'SUCCESS' | 'MISSING' | 'BLOCKED' | 'COLLECTION_FAILED';

export interface EvidenceError {
  code: string;
  message: string;
  details?: unknown;
}

export const SUPPORTED_OBSERVATION_STATUSES = ['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE'] as const;

export type EvidenceObservationStatus = (typeof SUPPORTED_OBSERVATION_STATUSES)[number];

export interface CanonicalEvidenceEnvelope {
  evidenceId: string;
  testId: string;
  sourceTool: string;
  sourceType: EvidenceSourceType;
  evidenceKey: string; // 标准证据键，例如 SERVER_API:TASK_STATUS
  observationStatus: EvidenceObservationStatus; // 局部业务观察结果: PASS | FAIL | UNVERIFIED | NOT_APPLICABLE
  capturedAt: string; // ISO 8601
  environment: string;
  subjectType: string;
  subjectId: string | number;
  rawReference?: Record<string, unknown> | string;
  normalizedFields: Record<string, unknown>;
  provenance: string;
  confidence: number; // 0 <= confidence <= 1
  immutable: boolean;
  redacted: boolean;
  collectionStatus: EvidenceCollectionStatus;
  error?: EvidenceError;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 三、协议校验返回结构
// ============================================================================

export interface ProtocolValidationError {
  field: string;
  code: string;
  message: string;
}

export interface ProtocolValidationResult<T> {
  valid: boolean;
  errors: ProtocolValidationError[];
  data?: T;
}

// 敏感凭证关键字检测列表 (用于 rawReference 脱敏安全检查)
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /phpsessid/i,
  /session_secret/i,
  /secret_key/i,
  /access_key/i,
  /bearer\s+[a-zA-Z0-9_.-]+/i,
  /private_key/i,
  /credential/i,
];

// 外部特定工具私有字段黑名单 (确保协议与具体框架解耦)
const PROPRIETARY_TOOL_FIELDS = [
  'playwright',
  'playwrightPage',
  'browserContext',
  'midscene',
  'midsceneAgent',
  'promptfoo',
  'promptfooPrompt',
  'reportportal',
  'wardeniq',
];

// ============================================================================
// 四、纯函数：validateCanonicalTestSpec
// ============================================================================

export function validateCanonicalTestSpec(spec: unknown): ProtocolValidationResult<CanonicalTestSpec> {
  const errors: ProtocolValidationError[] = [];

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return {
      valid: false,
      errors: [{ field: 'spec', code: 'INVALID_TYPE', message: 'TestSpec 必须是有效的对象' }],
    };
  }

  const s = spec as Record<string, unknown>;

  // 1. 基础标识
  if (typeof s.testId !== 'string' || s.testId.trim() === '') {
    errors.push({ field: 'testId', code: 'REQUIRED', message: 'testId 不能为空且必须为字符串' });
  }
  if (typeof s.requirementId !== 'string' || s.requirementId.trim() === '') {
    errors.push({ field: 'requirementId', code: 'REQUIRED', message: 'requirementId 不能为空且必须为字符串' });
  }
  if (typeof s.scenario !== 'string' || s.scenario.trim() === '') {
    errors.push({ field: 'scenario', code: 'REQUIRED', message: 'scenario 不能为空且必须为字符串' });
  }
  if (typeof s.environment !== 'string' || s.environment.trim() === '') {
    errors.push({ field: 'environment', code: 'REQUIRED', message: 'environment 不能为空且必须为字符串' });
  }

  // 2. executionMode 严格校验 (禁止静默降级)
  const validExecutionModes: ExecutionMode[] = ['REAL', 'OFFLINE', 'FIXTURE'];
  if (!validExecutionModes.includes(s.executionMode as ExecutionMode)) {
    errors.push({
      field: 'executionMode',
      code: 'INVALID_EXECUTION_MODE',
      message: `executionMode 必须为 REAL | OFFLINE | FIXTURE 之一，收到: ${String(s.executionMode)}`,
    });
  }

  // 3. target 结构校验
  if (!s.target || typeof s.target !== 'object' || Array.isArray(s.target)) {
    errors.push({ field: 'target', code: 'INVALID_TARGET', message: 'target 必须为对象' });
  } else {
    const t = s.target as Record<string, unknown>;
    if (typeof t.targetType !== 'string' || t.targetType.trim() === '') {
      errors.push({ field: 'target.targetType', code: 'REQUIRED', message: 'targetType 不能为空' });
    }
    if (t.modelId !== undefined && (!Number.isInteger(t.modelId) || (t.modelId as number) < 0)) {
      errors.push({ field: 'target.modelId', code: 'INVALID_MODEL_ID', message: 'modelId 必须为非负整数' });
    }
    if (
      t.expectedChannelId !== undefined &&
      (!Number.isInteger(t.expectedChannelId) || (t.expectedChannelId as number) < 0)
    ) {
      errors.push({
        field: 'target.expectedChannelId',
        code: 'INVALID_CHANNEL_ID',
        message: 'expectedChannelId 必须为非负整数',
      });
    }
    if (t.channelId !== undefined && (!Number.isInteger(t.channelId) || (t.channelId as number) < 0)) {
      errors.push({ field: 'target.channelId', code: 'INVALID_CHANNEL_ID', message: 'channelId 必须为非负整数' });
    }
    if (t.taskId !== undefined && (!Number.isInteger(t.taskId) || (t.taskId as number) < 0)) {
      errors.push({ field: 'target.taskId', code: 'INVALID_TASK_ID', message: 'taskId 必须为非负整数' });
    }
  }

  // 4. inputs 校验
  if (!s.inputs || typeof s.inputs !== 'object' || Array.isArray(s.inputs)) {
    errors.push({ field: 'inputs', code: 'INVALID_INPUTS', message: 'inputs 必须为对象' });
  }

  // 5. deterministicAssertions 校验
  if (!Array.isArray(s.deterministicAssertions)) {
    errors.push({
      field: 'deterministicAssertions',
      code: 'INVALID_ASSERTIONS',
      message: 'deterministicAssertions 必须为数组',
    });
  } else {
    s.deterministicAssertions.forEach((assertion, idx) => {
      if (!assertion || typeof assertion !== 'object') {
        errors.push({
          field: `deterministicAssertions[${idx}]`,
          code: 'INVALID_ASSERTION',
          message: '断言项必须为对象',
        });
        return;
      }
      const a = assertion as Record<string, unknown>;
      if (typeof a.field !== 'string' || a.field.trim() === '') {
        errors.push({
          field: `deterministicAssertions[${idx}].field`,
          code: 'REQUIRED',
          message: '断言 field 不能为空',
        });
      }
      if (typeof a.operator !== 'string' || a.operator.trim() === '') {
        errors.push({
          field: `deterministicAssertions[${idx}].operator`,
          code: 'REQUIRED',
          message: '断言 operator 不能为空',
        });
      } else if (!SUPPORTED_ASSERTION_OPERATORS.includes(a.operator as AssertionOperator)) {
        errors.push({
          field: `deterministicAssertions[${idx}].operator`,
          code: 'UNSUPPORTED_OPERATOR',
          message: `不支持的断言操作符: "${a.operator}"，必须为: ${SUPPORTED_ASSERTION_OPERATORS.join(', ')}`,
        });
      }
      if (a.critical !== undefined && typeof a.critical !== 'boolean') {
        errors.push({
          field: `deterministicAssertions[${idx}].critical`,
          code: 'INVALID_CRITICAL',
          message: 'critical 必须为布尔值',
        });
      }
      if (a.evidenceKey !== undefined && (typeof a.evidenceKey !== 'string' || a.evidenceKey.trim() === '')) {
        errors.push({
          field: `deterministicAssertions[${idx}].evidenceKey`,
          code: 'INVALID_EVIDENCE_KEY',
          message: 'evidenceKey 必须为非空字符串',
        });
      }
      if (a.actualField !== undefined && (typeof a.actualField !== 'string' || a.actualField.trim() === '')) {
        errors.push({
          field: `deterministicAssertions[${idx}].actualField`,
          code: 'INVALID_ACTUAL_FIELD',
          message: 'actualField 必须为非空字符串',
        });
      }
    });
  }

  // 6. aiAssistedSteps 校验 (可选)
  if (s.aiAssistedSteps !== undefined) {
    if (!Array.isArray(s.aiAssistedSteps)) {
      errors.push({ field: 'aiAssistedSteps', code: 'INVALID_AI_STEPS', message: 'aiAssistedSteps 必须为数组' });
    } else {
      s.aiAssistedSteps.forEach((step, idx) => {
        if (!step || typeof step !== 'object') {
          errors.push({ field: `aiAssistedSteps[${idx}]`, code: 'INVALID_AI_STEP', message: 'AI步骤必须为对象' });
          return;
        }
        const st = step as Record<string, unknown>;
        if (typeof st.stepId !== 'string' || st.stepId.trim() === '') {
          errors.push({ field: `aiAssistedSteps[${idx}].stepId`, code: 'REQUIRED', message: 'stepId 不能为空' });
        }
        if (typeof st.instruction !== 'string' || st.instruction.trim() === '') {
          errors.push({
            field: `aiAssistedSteps[${idx}].instruction`,
            code: 'REQUIRED',
            message: 'instruction 不能为空',
          });
        }
        if (typeof st.expectedCriteria !== 'string' || st.expectedCriteria.trim() === '') {
          errors.push({
            field: `aiAssistedSteps[${idx}].expectedCriteria`,
            code: 'REQUIRED',
            message: 'expectedCriteria 不能为空',
          });
        }
      });
    }
  }

  // 7. sideEffectPolicy 校验
  const validPolicies: SideEffectPolicy[] = ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'];
  if (!validPolicies.includes(s.sideEffectPolicy as SideEffectPolicy)) {
    errors.push({
      field: 'sideEffectPolicy',
      code: 'INVALID_SIDE_EFFECT_POLICY',
      message: `sideEffectPolicy 必须为 READ_ONLY | ALLOW_SUBMIT | ALLOW_PAID 之一，收到: ${String(s.sideEffectPolicy)}`,
    });
  }

  // 8. costLimit 校验
  if (!s.costLimit || typeof s.costLimit !== 'object' || Array.isArray(s.costLimit)) {
    errors.push({ field: 'costLimit', code: 'INVALID_COST_LIMIT', message: 'costLimit 必须为对象' });
  } else {
    const cl = s.costLimit as Record<string, unknown>;
    if (typeof cl.maxCostPoints !== 'number' || isNaN(cl.maxCostPoints) || cl.maxCostPoints < 0) {
      errors.push({
        field: 'costLimit.maxCostPoints',
        code: 'INVALID_COST_POINTS',
        message: 'maxCostPoints 必须为大于等于 0 的有效数字',
      });
    }
    if (
      cl.maxCostCny !== undefined &&
      (typeof cl.maxCostCny !== 'number' || isNaN(cl.maxCostCny) || cl.maxCostCny < 0)
    ) {
      errors.push({
        field: 'costLimit.maxCostCny',
        code: 'INVALID_COST_CNY',
        message: 'maxCostCny 必须为大于等于 0 的有效数字',
      });
    }
    // 规则一致性：READ_ONLY 策略下不允许设置大于 0 的费用上限
    if (s.sideEffectPolicy === 'READ_ONLY' && typeof cl.maxCostPoints === 'number' && cl.maxCostPoints > 0) {
      errors.push({
        field: 'costLimit.maxCostPoints',
        code: 'CONFLICTING_COST_AND_POLICY',
        message: 'sideEffectPolicy 为 READ_ONLY 时，maxCostPoints 必须为 0',
      });
    }
  }

  // 9. requiredEvidence 校验
  if (!Array.isArray(s.requiredEvidence)) {
    errors.push({
      field: 'requiredEvidence',
      code: 'INVALID_REQUIRED_EVIDENCE',
      message: 'requiredEvidence 必须为字符串数组',
    });
  } else if (s.requiredEvidence.some((e) => typeof e !== 'string' || e.trim() === '')) {
    errors.push({
      field: 'requiredEvidence',
      code: 'EMPTY_EVIDENCE_KEY',
      message: 'requiredEvidence 中不得包含空字符串项',
    });
  }

  // 10. 专有工具字段探测 (确保协议与特定框架解耦)
  for (const key of Object.keys(s)) {
    if (PROPRIETARY_TOOL_FIELDS.some((tool) => key.toLowerCase().includes(tool))) {
      errors.push({
        field: key,
        code: 'PROPRIETARY_TOOL_FIELD_FORBIDDEN',
        message: `Canonical TestSpec 中禁止引入外部工具专有字段: ${key}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? (s as unknown as CanonicalTestSpec) : undefined,
  };
}

// ============================================================================
// 五、纯函数：validateEvidenceEnvelope
// ============================================================================

export function validateEvidenceEnvelope(envelope: unknown): ProtocolValidationResult<CanonicalEvidenceEnvelope> {
  const errors: ProtocolValidationError[] = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      valid: false,
      errors: [{ field: 'envelope', code: 'INVALID_TYPE', message: 'EvidenceEnvelope 必须是有效的对象' }],
    };
  }

  const e = envelope as Record<string, unknown>;

  // 1. 标识校验
  if (typeof e.evidenceId !== 'string' || e.evidenceId.trim() === '') {
    errors.push({ field: 'evidenceId', code: 'REQUIRED', message: 'evidenceId 不能为空' });
  }
  if (typeof e.testId !== 'string' || e.testId.trim() === '') {
    errors.push({ field: 'testId', code: 'REQUIRED', message: 'testId 不能为空' });
  }
  if (typeof e.sourceTool !== 'string' || e.sourceTool.trim() === '') {
    errors.push({ field: 'sourceTool', code: 'REQUIRED', message: 'sourceTool 不能为空' });
  }

  // 2. evidenceKey 校验 (格式规范 ^[A-Z0-9_]+:[A-Z0-9_]+$)
  const EVIDENCE_KEY_REGEX = /^[A-Z0-9_]+:[A-Z0-9_]+$/;
  if (typeof e.evidenceKey !== 'string' || e.evidenceKey.trim() === '') {
    errors.push({ field: 'evidenceKey', code: 'REQUIRED', message: 'evidenceKey 必须非空且必须为字符串' });
  } else if (!EVIDENCE_KEY_REGEX.test(e.evidenceKey)) {
    errors.push({
      field: 'evidenceKey',
      code: 'INVALID_EVIDENCE_KEY_FORMAT',
      message: `evidenceKey 格式不合法，必须匹配 ^[A-Z0-9_]+:[A-Z0-9_]+$，收到: "${e.evidenceKey}"`,
    });
  } else {
    // sourceType 必须与 evidenceKey 前缀一致 (例如 SERVER_API:xxx 对应的 sourceType 必须是 SERVER_API)
    const keyPrefix = e.evidenceKey.split(':')[0];
    if (e.sourceType && keyPrefix !== e.sourceType) {
      errors.push({
        field: 'evidenceKey',
        code: 'SOURCE_TYPE_KEY_MISMATCH',
        message: `sourceType (${String(e.sourceType)}) 与 evidenceKey 前缀 (${keyPrefix}) 不一致`,
      });
    }
    // REAL 模式或通用防伪校验：SERVER_API 的 evidenceKey 不能由 USER_ASSERTION 或 FIXTURE 的 sourceType 冒充
    if (keyPrefix === 'SERVER_API' && (e.sourceType === 'USER_ASSERTION' || e.sourceType === 'FIXTURE')) {
      errors.push({
        field: 'sourceType',
        code: 'SERVER_API_IMPERSONATION_FORBIDDEN',
        message: `${String(e.sourceType)} 不得冒充 SERVER_API evidenceKey`,
      });
    }
  }

  // 3. observationStatus 局部业务观察结果枚举校验
  if (typeof e.observationStatus !== 'string' || e.observationStatus.trim() === '') {
    errors.push({ field: 'observationStatus', code: 'REQUIRED', message: 'observationStatus 不能为空' });
  } else if (!SUPPORTED_OBSERVATION_STATUSES.includes(e.observationStatus as EvidenceObservationStatus)) {
    errors.push({
      field: 'observationStatus',
      code: 'INVALID_OBSERVATION_STATUS',
      message: `observationStatus 必须属于受支持枚举 (${SUPPORTED_OBSERVATION_STATUSES.join(', ')})，收到: ${String(e.observationStatus)}`,
    });
  }

  // 4. sourceType 校验
  const validSourceTypes: EvidenceSourceType[] = [
    'SERVER_API',
    'BROWSER',
    'MEDIA_BINARY',
    'BILLING_LEDGER',
    'AI_OBSERVATION',
    'USER_ASSERTION',
    'FIXTURE',
  ];
  if (!validSourceTypes.includes(e.sourceType as EvidenceSourceType)) {
    errors.push({
      field: 'sourceType',
      code: 'INVALID_SOURCE_TYPE',
      message: `sourceType 必须为有效的证据来源类型，收到: ${String(e.sourceType)}`,
    });
  }

  // 3. capturedAt ISO-8601 时间校验
  if (typeof e.capturedAt !== 'string' || e.capturedAt.trim() === '' || isNaN(Date.parse(e.capturedAt))) {
    errors.push({
      field: 'capturedAt',
      code: 'INVALID_TIMESTAMP',
      message: 'capturedAt 必须为合法的 ISO-8601 时间戳字符串',
    });
  }

  // 4. 环境与主体
  if (typeof e.environment !== 'string' || e.environment.trim() === '') {
    errors.push({ field: 'environment', code: 'REQUIRED', message: 'environment 不能为空' });
  }
  if (typeof e.subjectType !== 'string' || e.subjectType.trim() === '') {
    errors.push({ field: 'subjectType', code: 'REQUIRED', message: 'subjectType 不能为空' });
  }
  if (
    e.subjectId === undefined ||
    e.subjectId === null ||
    (typeof e.subjectId !== 'string' && typeof e.subjectId !== 'number')
  ) {
    errors.push({ field: 'subjectId', code: 'REQUIRED', message: 'subjectId 必须为字符串或数字' });
  }

  // 5. normalizedFields 校验
  if (!e.normalizedFields || typeof e.normalizedFields !== 'object' || Array.isArray(e.normalizedFields)) {
    errors.push({
      field: 'normalizedFields',
      code: 'INVALID_NORMALIZED_FIELDS',
      message: 'normalizedFields 必须为对象',
    });
  }

  // 6. provenance 来源可信度与越权防伪校验
  if (typeof e.provenance !== 'string' || e.provenance.trim() === '') {
    errors.push({ field: 'provenance', code: 'REQUIRED', message: 'provenance 必须为明确的来源记录，不得为空' });
  } else {
    const provUpper = e.provenance.toUpperCase();
    // 来源不得由预期反推
    if (
      provUpper.includes('EXPECTATION') ||
      provUpper.includes('DEVTEST_EXPECTATION') ||
      provUpper.includes('EXPECTED_VALUE')
    ) {
      errors.push({
        field: 'provenance',
        code: 'PROVENANCE_DERIVED_FROM_EXPECTATION',
        message: 'provenance 必须记录真实事实来源，不得由测试期望值推导',
      });
    }
    // USER_ASSERTION / FIXTURE 绝对禁止标记为 SERVER_API 来源
    if (e.sourceType === 'SERVER_API' && (provUpper.includes('USER_ASSERTION') || provUpper.includes('FIXTURE'))) {
      errors.push({
        field: 'provenance',
        code: 'UNTRUSTED_PROVENANCE_FOR_SERVER_API',
        message: 'sourceType 为 SERVER_API 时，provenance 禁止伪装或混入 USER_ASSERTION 或 FIXTURE',
      });
    }
    // 声明类 sourceType 禁止宣称为 SERVER_API
    if (e.sourceType === 'USER_ASSERTION' && provUpper.includes('SERVER_API')) {
      errors.push({
        field: 'provenance',
        code: 'USER_ASSERTION_CANNOT_CLAIM_SERVER_API',
        message: 'USER_ASSERTION 证据不得在 provenance 中伪称为 SERVER_API',
      });
    }
  }

  // 7. confidence 校验 (0 <= confidence <= 1)
  if (typeof e.confidence !== 'number' || isNaN(e.confidence) || e.confidence < 0 || e.confidence > 1) {
    errors.push({
      field: 'confidence',
      code: 'INVALID_CONFIDENCE_RANGE',
      message: `confidence 必须为 0 到 1 之间的数值，收到: ${String(e.confidence)}`,
    });
  }

  // 8. immutable & redacted 布尔校验
  if (typeof e.immutable !== 'boolean') {
    errors.push({ field: 'immutable', code: 'INVALID_BOOLEAN', message: 'immutable 必须为布尔值' });
  }
  if (typeof e.redacted !== 'boolean') {
    errors.push({ field: 'redacted', code: 'INVALID_BOOLEAN', message: 'redacted 必须为布尔值' });
  }

  // 9. collectionStatus 校验
  const validStatuses: EvidenceCollectionStatus[] = ['SUCCESS', 'MISSING', 'BLOCKED', 'COLLECTION_FAILED'];
  if (!validStatuses.includes(e.collectionStatus as EvidenceCollectionStatus)) {
    errors.push({
      field: 'collectionStatus',
      code: 'INVALID_COLLECTION_STATUS',
      message: `collectionStatus 必须为 SUCCESS | MISSING | BLOCKED | COLLECTION_FAILED 之一，收到: ${String(e.collectionStatus)}`,
    });
  }

  // 10. error 状态一致性校验
  if (e.collectionStatus === 'SUCCESS') {
    if (e.error !== undefined && e.error !== null) {
      errors.push({
        field: 'error',
        code: 'ERROR_NOT_ALLOWED_ON_SUCCESS',
        message: '当 collectionStatus 为 SUCCESS 时，不得包含 error 信息',
      });
    }
  } else {
    // 非 SUCCESS 状态必须提供 error 说明原因
    if (!e.error || (typeof e.error !== 'object' && typeof e.error !== 'string')) {
      errors.push({
        field: 'error',
        code: 'ERROR_REQUIRED_ON_FAILURE',
        message: `当 collectionStatus 为 ${String(e.collectionStatus)} 时，必须提供 error 说明原因`,
      });
    } else if (typeof e.error === 'object') {
      const errObj = e.error as Record<string, unknown>;
      if (typeof errObj.code !== 'string' || typeof errObj.message !== 'string') {
        errors.push({
          field: 'error',
          code: 'INVALID_ERROR_STRUCTURE',
          message: 'error 对象必须包含字符串类型的 code 和 message',
        });
      }
    }
  }

  // 11. rawReference 敏感脱敏检查 (防止明文密码、PHPSESSID 等凭证泄漏)
  if (e.rawReference !== undefined && e.rawReference !== null) {
    const rawStr = typeof e.rawReference === 'string' ? e.rawReference : JSON.stringify(e.rawReference);
    for (const pattern of SENSITIVE_KEY_PATTERNS) {
      if (pattern.test(rawStr)) {
        errors.push({
          field: 'rawReference',
          code: 'UNREDACTED_CREDENTIALS_FORBIDDEN',
          message: `rawReference 中检测到疑似未脱敏的凭据信息 (${pattern.source})，禁止直接保存明文凭证`,
        });
        break;
      }
    }
  }

  // 12. 专有工具字段黑名单检查
  for (const key of Object.keys(e)) {
    if (PROPRIETARY_TOOL_FIELDS.some((tool) => key.toLowerCase().includes(tool))) {
      errors.push({
        field: key,
        code: 'PROPRIETARY_TOOL_FIELD_FORBIDDEN',
        message: `Canonical EvidenceEnvelope 中禁止引入外部工具专有字段: ${key}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? (e as unknown as CanonicalEvidenceEnvelope) : undefined,
  };
}

// ============================================================================
// 六、纯函数：evaluateRequiredEvidence (Phase 1.3C)
// ============================================================================

export interface RequiredEvidenceEvaluationItem {
  key: string;
  matched: boolean;
  envelope?: CanonicalEvidenceEnvelope;
  reason?: string;
}

export interface RequiredEvidenceEvaluationResult {
  satisfied: boolean;
  missingEvidenceKeys: string[];
  failedEvidenceKeys: string[];
  unverifiedEvidenceKeys: string[];
  matchedEnvelopes: Record<string, CanonicalEvidenceEnvelope>;
  details: RequiredEvidenceEvaluationItem[];
}

/**
 * 依据 TestSpec 的 requiredEvidence 与 Envelope 的 evidenceKey 执行精确匹配与合规评估
 * 核心契约规则：
 * 1. 精确匹配：必须严格与 envelope.evidenceKey 相同，禁止基于 sourceType+subjectType 模糊猜测；
 * 2. 来源防冒充与 REAL 隔离：USER_ASSERTION / FIXTURE 不能满足 REAL 模式下的 SERVER_API；
 * 3. 采集成功为前提：collectionStatus != 'SUCCESS' 的信封不能满足 requiredEvidence；
 * 4. 业务观察结果区分：
 *    - observationStatus = 'FAIL' 必须保留为确定失败事实 (failedEvidenceKeys)；
 *    - observationStatus = 'UNVERIFIED' 不能满足通过条件 (unverifiedEvidenceKeys, satisfied=false)；
 *    - observationStatus = 'PASS' 且采集成功方可通过；
 * 5. 本函数为只读纯评估函数，不生成最终 Verdict，不修改任何输入对象。
 */
export function evaluateRequiredEvidence(
  spec: CanonicalTestSpec,
  envelopes: CanonicalEvidenceEnvelope[],
): RequiredEvidenceEvaluationResult {
  const missingEvidenceKeys: string[] = [];
  const failedEvidenceKeys: string[] = [];
  const unverifiedEvidenceKeys: string[] = [];
  const matchedEnvelopes: Record<string, CanonicalEvidenceEnvelope> = {};
  const details: RequiredEvidenceEvaluationItem[] = [];

  const requiredKeys = Array.isArray(spec?.requiredEvidence) ? spec.requiredEvidence : [];
  const envelopeList = Array.isArray(envelopes) ? envelopes : [];

  for (const key of requiredKeys) {
    // 1. 精确匹配 evidenceKey，禁止模糊猜测
    let matchingEnvs = envelopeList.filter((env) => env.evidenceKey === key);

    if (matchingEnvs.length === 0) {
      missingEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        reason: `未找到匹配的证据信封 [${key}]`,
      });
      continue;
    }

    // 2. REAL 模式来源隔离检查：FIXTURE 或 USER_ASSERTION 来源不能满足 REAL 模式下的必需证据
    if (spec.executionMode === 'REAL') {
      const untrustedEnv = matchingEnvs.find(
        (env) => env.sourceType === 'FIXTURE' || env.sourceType === 'USER_ASSERTION',
      );
      const trustedEnvs = matchingEnvs.filter(
        (env) => env.sourceType !== 'FIXTURE' && env.sourceType !== 'USER_ASSERTION',
      );
      if (trustedEnvs.length === 0) {
        missingEvidenceKeys.push(key);
        details.push({
          key,
          matched: false,
          envelope: untrustedEnv,
          reason: `REAL 模式下 ${untrustedEnv?.sourceType} 来源不能满足 ${key}`,
        });
        continue;
      }
      matchingEnvs = trustedEnvs;
    }

    // 3. collectionStatus != SUCCESS 的 Envelope 不能满足 requiredEvidence
    const successfulEnvs = matchingEnvs.filter((env) => env.collectionStatus === 'SUCCESS');
    if (successfulEnvs.length === 0) {
      missingEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        envelope: matchingEnvs[0],
        reason: `证据采集状态为 ${matchingEnvs[0].collectionStatus}，未能成功采集`,
      });
      continue;
    }

    // 4. observationStatus 多信封判定规则：
    // - 任一确定 FAIL -> FAIL；
    // - PASS 与 FAIL 冲突 -> FAIL，并记录 EVIDENCE_CONFLICT；
    // - 全部 PASS -> 满足；
    // - 只有 UNVERIFIED -> UNVERIFIED
    const hasFail = successfulEnvs.some((e) => e.observationStatus === 'FAIL');
    const hasPass = successfulEnvs.some((e) => e.observationStatus === 'PASS');
    const hasConflict = hasFail && hasPass;

    const primaryEnv = successfulEnvs.find((e) => e.observationStatus === 'FAIL') || successfulEnvs[0];
    matchedEnvelopes[key] = primaryEnv;

    if (hasConflict) {
      failedEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        envelope: primaryEnv,
        reason: `EVIDENCE_CONFLICT: 存在多条相同 evidenceKey [${key}] 但结果冲突 (同时存在 PASS 与 FAIL)`,
      });
    } else if (hasFail) {
      failedEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        envelope: primaryEnv,
        reason: '观察结果为 FAIL',
      });
    } else if (successfulEnvs.every((e) => e.observationStatus === 'PASS')) {
      details.push({
        key,
        matched: true,
        envelope: primaryEnv,
        reason: '观察结果为 PASS 且采集成功',
      });
    } else if (
      successfulEnvs.every((e) => e.observationStatus === 'UNVERIFIED' || e.observationStatus === 'NOT_APPLICABLE')
    ) {
      unverifiedEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        envelope: primaryEnv,
        reason: '观察结果为 UNVERIFIED，无法证明通过',
      });
    } else {
      unverifiedEvidenceKeys.push(key);
      details.push({
        key,
        matched: false,
        envelope: primaryEnv,
        reason: '未能全部确证为 PASS',
      });
    }
  }

  const satisfied =
    missingEvidenceKeys.length === 0 && failedEvidenceKeys.length === 0 && unverifiedEvidenceKeys.length === 0;

  return {
    satisfied,
    missingEvidenceKeys,
    failedEvidenceKeys,
    unverifiedEvidenceKeys,
    matchedEnvelopes,
    details,
  };
}
