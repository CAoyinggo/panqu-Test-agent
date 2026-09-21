/**
 * Panqu AI DevTest — Legacy Protocol Mappers
 * Phase 1.3 建立旧调用链到 Canonical Protocol 的单向兼容映射
 *
 * 核心架构边界 (遵守 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 本模块为只读单向映射函数，严禁在现有四大核心动作 (probe/plan/execute/verify) 中自动调用；
 * 2. plan 只映射为 CanonicalTestSpec，绝对不产生 EvidenceEnvelope；
 * 3. execute SUBMITTED 绝对不得映射为 COMPLETED；
 * 4. verify 的 verdict、acceptance、passed 属于终态裁决，严禁作为原始证据打包进入 Envelope；
 * 5. CLI/MCP 手填声明与静态渠道绝对不得升级标记为 SERVER_API；
 * 6. 无法识别来源时严禁猜测，必须返回明确 mapping issue；
 * 7. rawResponse、cookie、session、token 等敏感凭据必须强制脱敏 (redacted: true)；
 * 8. 输入的旧对象在映射过程中严禁被修改。
 */

import type {
  CanonicalTestSpec,
  CanonicalEvidenceEnvelope,
  ExecutionMode,
  SideEffectPolicy,
  EvidenceSourceType,
  EvidenceCollectionStatus,
  EvidenceObservationStatus,
  TestCostLimit,
  DeterministicAssertion,
} from './canonical-protocol.js';
import type { ExecutionResult } from './execution-ports.js';
import type {
  PlanKernelResult,
  ProbeKernelResult,
  ExecuteKernelResult,
  VerifyKernelResult,
} from './core-kernel.js';
import type { CanonicalVerdictResult, CanonicalBlocker } from './canonical-verdict-engine.js';
export type { CanonicalBlocker };
import type { EvidenceCompleteness } from './types.js';

// ============================================================================
// 一、结构化映射结果契约
// ============================================================================

export interface MappingIssue {
  field?: string;
  code: string;
  message: string;
  severity: 'WARNING' | 'ERROR';
  details?: unknown;
}

export interface MappingResult<T> {
  success: boolean;
  value?: T;
  issues: MappingIssue[];
  unmappedFields: string[];
  warnings: string[];
}

// ============================================================================
// 二、敏感信息脱敏工具函数 (纯函数，零写副作用)
// ============================================================================

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('password') ||
    lower.includes('phpsessid') ||
    lower.includes('cookie') ||
    lower.includes('authorization') ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('credential')
  );
}

export function redactSensitiveData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }
  if (typeof data === 'string') {
    return data
      .replace(/PHPSESSID=[a-zA-Z0-9_\-]+/gi, 'PHPSESSID=[REDACTED]')
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/password=[^&;\s]+/gi, 'password=[REDACTED]')
      .replace(/token=[a-zA-Z0-9_\-\.]+/gi, 'token=[REDACTED]')
      .replace(/cookie:[^\r\n]+/gi, 'cookie: [REDACTED]');
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item));
  }
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactSensitiveData(v);
      }
    }
    return result;
  }
  return data;
}

// ============================================================================
// 三、Mapper 1: plan → CanonicalTestSpec
// ============================================================================

export interface MapPlanOptions {
  testId: string; // 必须由调用者显式提供 (Requirement 3)
  requirementId?: string;
  environment?: string;
  executionMode?: ExecutionMode;
  sideEffectPolicy?: SideEffectPolicy;
  costLimit?: TestCostLimit;
}

/**
 * 将旧版 PlanKernelResult 单向映射为 CanonicalTestSpec
 * 永久约束：
 * 1. plan 是执行计划与预期，绝不能映射为 EvidenceEnvelope；
 * 2. 禁止映射器自动授权副作用：plan.expectedPoints 只能作为预期值，不得自动设置 ALLOW_SUBMIT 或 ALLOW_PAID；
 * 3. 未显式提供时默认 READ_ONLY + maxCostPoints=0；
 * 4. REAL 计划需要付费但没有显式授权时，返回结构化 mapping issue；
 * 5. testId 必须由调用者提供，禁止隐式 Date.now()；
 * 6. 定价为 UNVERIFIED 时，不得生成确定的 billing.expectedPoints 关键断言；
 * 7. 根据场景精准生成 requiredEvidence (指定 expectedChannelId 时包含路由证据)。
 */
export function mapPlanToCanonicalTestSpec(
  planResult: PlanKernelResult,
  options: MapPlanOptions
): MappingResult<CanonicalTestSpec> {
  const issues: MappingIssue[] = [];
  const warnings: string[] = [];
  const unmappedFields: string[] = [];

  if (!planResult || typeof planResult !== 'object') {
    return {
      success: false,
      issues: [{ code: 'INVALID_INPUT', message: 'planResult 必须为有效对象', severity: 'ERROR' }],
      unmappedFields: [],
      warnings: [],
    };
  }

  // 1. 必要 ID 校验 (禁止隐式 Date.now())
  if (!options || typeof options.testId !== 'string' || options.testId.trim() === '') {
    issues.push({
      field: 'testId',
      code: 'MISSING_TEST_ID',
      message: 'testId 必须由调用者显式提供，禁止隐式生成',
      severity: 'ERROR',
    });
  }

  // 必需字段校验
  if (typeof planResult.modelId !== 'number') {
    issues.push({
      field: 'modelId',
      code: 'REQUIRED_FIELD_MISSING',
      message: 'planResult.modelId 必需且必须为数字',
      severity: 'ERROR',
    });
  }
  if (typeof planResult.expectedPoints !== 'number') {
    issues.push({
      field: 'expectedPoints',
      code: 'REQUIRED_FIELD_MISSING',
      message: 'planResult.expectedPoints 必需且必须为数字',
      severity: 'ERROR',
    });
  }

  const testId = options?.testId || '';
  const requirementId = options?.requirementId || `REQ-${planResult.scenario || 'UNKNOWN'}-${planResult.modelId ?? 0}`;
  const environment = options?.environment || 'test';
  const executionMode: ExecutionMode = options?.executionMode || 'FIXTURE';

  // 2. 副作用与预算策略严格遵循调用者显式授权，未提供时默认 READ_ONLY + 0 预算
  const sideEffectPolicy: SideEffectPolicy = options?.sideEffectPolicy || 'READ_ONLY';
  const costLimit: TestCostLimit = options?.costLimit || {
    maxCostPoints: 0,
    allowZeroCostOnly: true,
  };

  // REAL 计划需要付费但没有显式授权时，返回结构化 mapping issue
  if (executionMode === 'REAL' && (planResult.expectedPoints || 0) > 0) {
    if (sideEffectPolicy !== 'ALLOW_PAID') {
      issues.push({
        field: 'sideEffectPolicy',
        code: 'UNAUTHORIZED_PAID_EXECUTION',
        message: `REAL 模式计划预期消耗 ${planResult.expectedPoints} 积分，但 sideEffectPolicy 未显式授权为 ALLOW_PAID (当前为: ${sideEffectPolicy})`,
        severity: 'ERROR',
      });
    }
    if (costLimit.maxCostPoints < planResult.expectedPoints) {
      issues.push({
        field: 'costLimit',
        code: 'INSUFFICIENT_COST_LIMIT',
        message: `REAL 模式计划预期消耗 ${planResult.expectedPoints} 积分，但授权预算上限不足 (当前上限: ${costLimit.maxCostPoints})`,
        severity: 'ERROR',
      });
    }
  }

  // 3. 目标推导
  const target = {
    targetType: planResult.disambiguation?.targetKind || 'model',
    modelId: planResult.modelId,
    expectedChannelId: planResult.disambiguation?.channelId,
    channelId: planResult.disambiguation?.channelId,
    projectId: planResult.disambiguation?.projectId,
  };

  // 4. 确定性断言推导 (仅生成能够明确绑定 evidenceKey 与 actualField 的断言)
  const deterministicAssertions: DeterministicAssertion[] = [];

  // 定价为 UNVERIFIED 时，不得生成确定的 billing.actualCharge 关键断言！
  if (planResult.pricingStatus === 'UNVERIFIED') {
    warnings.push('pricingStatus 为 UNVERIFIED，未生成确定的 billing.actualCharge 关键断言');
  } else if (typeof planResult.expectedPoints === 'number') {
    deterministicAssertions.push({
      field: 'billing.actualCharge',
      operator: 'EQUALS',
      expectedValue: planResult.expectedPoints,
      description: '预期刊例积分扣减值与实际计费一致',
      critical: true,
      evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
      actualField: 'actualCharge',
    });
  }

  // 指定 expectedChannelId 时生成确定承接渠道断言
  if (typeof target.expectedChannelId === 'number' && target.expectedChannelId > 0) {
    deterministicAssertions.push({
      field: 'routing.expectedChannelId',
      operator: 'EQUALS',
      expectedValue: target.expectedChannelId,
      description: '预期承接网关渠道 ID',
      critical: true,
      evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
      actualField: 'actualValue',
    });
  }

  // 无对应真实证据的 plan 期望 (如 willDivert, routeLine) 仅作为元数据提示，不得生成无证据绑定的关键断言
  if (typeof planResult.willDivert === 'boolean' || typeof planResult.routeLine === 'number') {
    warnings.push('planResult 中的 willDivert/routeLine 属于离线预估，无真实服务端证据信封支持，未生成关键断言');
  }

  // 5. 根据场景生成 requiredEvidence
  const requiredEvidence: string[] = [];

  // 任务终态：TASK_STATUS
  requiredEvidence.push('SERVER_API:TASK_STATUS');

  // 媒体验收：MEDIA_BINARY
  if (planResult.mediaType === 'video' || planResult.mediaType === 'image') {
    requiredEvidence.push('MEDIA_BINARY:CONTAINER_CHECK');
  } else if (planResult.mediaType) {
    issues.push({
      field: 'mediaType',
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: `无法安全推导媒体类型 (${planResult.mediaType}) 的验收证据，禁止猜测`,
      severity: 'ERROR',
    });
  }

  // 账单属于测试范围时：BILLING_LEDGER (UNVERIFIED 时不作为确定的账单验证范围)
  const isBillingInScope =
    planResult.pricingStatus === 'DETERMINED' ||
    (planResult.expectedPoints > 0 && executionMode === 'REAL' && sideEffectPolicy === 'ALLOW_PAID');
  if (isBillingInScope) {
    requiredEvidence.push('BILLING_LEDGER:TASK_RECORDS');
  }

  // 指定 expectedChannelId 时：SERVER_API 路由证据
  if (typeof target.expectedChannelId === 'number' && target.expectedChannelId > 0) {
    requiredEvidence.push('SERVER_API:ROUTING_CHANNEL');
  }

  // 6. 记录不可直接作为证据的计划字段到 unmappedFields
  unmappedFields.push(
    'candidateChannels',
    'acceptanceForecast',
    'pricingStatus',
    'blocked',
    'testerActionSummary',
    'domainPlan',
    'contract',
    'changeContract',
    'testPlan'
  );
  warnings.push(
    'plan 中的 candidateChannels、expectedPoints 仅表达测试预期或网关候选，绝不能作为实际执行或真实扣费证据'
  );

  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  if (hasErrors) {
    return {
      success: false,
      issues,
      unmappedFields,
      warnings,
    };
  }

  const spec: CanonicalTestSpec = {
    testId,
    requirementId,
    scenario: planResult.scenario || 'UNKNOWN_SCENARIO',
    environment,
    executionMode,
    target,
    inputs: {
      mediaType: planResult.mediaType,
      flowType: planResult.flowType,
      decision: planResult.decision,
      reason: planResult.reason,
      changeType: planResult.changeType,
    },
    deterministicAssertions,
    costLimit,
    sideEffectPolicy,
    requiredEvidence,
    metadata: {
      mappedFrom: 'PlanKernelResult',
      scenarioName: planResult.scenarioName,
    },
  };

  return {
    success: true,
    value: spec,
    issues,
    unmappedFields,
    warnings,
  };
}

// ============================================================================
// 四、Mapper 2: probe → CanonicalEvidenceEnvelope[]
// ============================================================================

export interface MapProbeOptions {
  testId: string; // 必须显式提供 (Requirement 3)
  capturedAt?: string; // 可选，若未提供则使用 probeResult.probedAt
}

/**
 * 将旧版 ProbeKernelResult 单向映射为 CanonicalEvidenceEnvelope 集合
 * 规则：
 * 1. 只映射实际探测观察到的事实，静态推断与候选渠道不得升级为实时证据；
 * 2. 分离采集状态与业务观察结果：成功采集到事实 (不论 PASS/FAIL) collectionStatus 均为 SUCCESS；
 * 3. 业务观察结果写入 normalizedFields (observedStatus, assertionMatched 等)；
 * 4. 证据 ID 由 testId、subjectType 与稳定序号生成，禁止 Date.now()。
 */
export function mapProbeToCanonicalEvidence(
  probeResult: ProbeKernelResult,
  options: MapProbeOptions
): MappingResult<CanonicalEvidenceEnvelope[]> {
  const issues: MappingIssue[] = [];
  const warnings: string[] = [];
  const unmappedFields: string[] = [];
  const envelopes: CanonicalEvidenceEnvelope[] = [];

  if (!probeResult || typeof probeResult !== 'object') {
    return {
      success: false,
      issues: [{ code: 'INVALID_INPUT', message: 'probeResult 必须为有效对象', severity: 'ERROR' }],
      unmappedFields: [],
      warnings: [],
    };
  }

  // 1. 必要 ID 与时间校验 (禁止隐式 Date.now())
  if (!options || typeof options.testId !== 'string' || options.testId.trim() === '') {
    issues.push({
      field: 'testId',
      code: 'MISSING_TEST_ID',
      message: 'testId 必须由调用者显式提供，禁止隐式生成',
      severity: 'ERROR',
    });
  }

  const capturedAt = options?.capturedAt || probeResult.probedAt;
  if (!capturedAt || typeof capturedAt !== 'string' || isNaN(Date.parse(capturedAt))) {
    issues.push({
      field: 'capturedAt',
      code: 'MISSING_CAPTURED_AT',
      message: 'capturedAt 必须显式提供合法的 ISO-8601 时间戳，禁止使用当前时间隐式生成',
      severity: 'ERROR',
    });
  }

  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  if (hasErrors) {
    return {
      success: false,
      issues,
      unmappedFields,
      warnings,
    };
  }

  const testId = options.testId;
  const environment = probeResult.env || 'test';

  // 1. 鉴权探活事实证据
  if (probeResult.auth) {
    const authStatus = probeResult.auth.status;
    const isAuthSuccess = authStatus === 'VALID';

    // 分离采集状态：成功发起并收到鉴权判定均为 SUCCESS；缺失为 MISSING；阻断为 BLOCKED
    let authCollectionStatus: EvidenceCollectionStatus = 'SUCCESS';
    let observationStatus: EvidenceObservationStatus = 'PASS';
    const rawAuthStatus = String(authStatus);

    if (rawAuthStatus === 'VALID') {
      authCollectionStatus = 'SUCCESS';
      observationStatus = 'PASS';
    } else if (rawAuthStatus === 'MISSING') {
      authCollectionStatus = 'MISSING';
      observationStatus = 'UNVERIFIED';
    } else if (rawAuthStatus === 'BLOCKED') {
      authCollectionStatus = 'BLOCKED';
      observationStatus = 'UNVERIFIED';
    } else {
      authCollectionStatus = 'SUCCESS';
      observationStatus = 'FAIL';
    }

    envelopes.push({
      evidenceId: `${testId}-auth-1`,
      testId,
      sourceTool: 'env-probe',
      sourceType: 'SERVER_API',
      evidenceKey: 'SERVER_API:AUTH_STATUS',
      observationStatus,
      capturedAt: capturedAt!,
      environment,
      subjectType: 'auth',
      subjectId: 'session_auth',
      rawReference: {
        authDetails: redactSensitiveData(probeResult.auth.details),
        hasSession: probeResult.auth.hasSession,
      },
      normalizedFields: {
        observedStatus: observationStatus,
        rawStatus: authStatus,
        hasSession: probeResult.auth.hasSession,
        assertionMatched: isAuthSuccess,
      },
      provenance: `PROBE_HTTP (/auth/probe:env=${environment})`,
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: authCollectionStatus,
      error: undefined,
    });
  }

  // 2. 端点连通性事实证据
  if (Array.isArray(probeResult.endpoints)) {
    probeResult.endpoints.forEach((ep, idx) => {
      const isReachable = Boolean(ep.reachable);
      // 只有在未拿到 HTTP 响应/网络不可达且无状态码时才是 COLLECTION_FAILED
      const isCollectionSuccess = ep.statusCode !== undefined;
      const collectionStatus: EvidenceCollectionStatus = isCollectionSuccess ? 'SUCCESS' : 'COLLECTION_FAILED';
      const observationStatus: EvidenceObservationStatus = isCollectionSuccess
        ? (isReachable ? 'PASS' : 'FAIL')
        : 'UNVERIFIED';

      envelopes.push({
        evidenceId: `${testId}-endpoint-${idx + 1}`,
        testId,
        sourceTool: 'env-probe',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:ENDPOINT_STATUS',
        observationStatus,
        capturedAt: capturedAt!,
        environment,
        subjectType: 'endpoint',
        subjectId: ep.name || ep.url,
        rawReference: {
          url: redactSensitiveData(ep.url),
          statusCode: ep.statusCode,
          latencyMs: ep.latencyMs,
        },
        normalizedFields: {
          name: ep.name,
          reachable: isReachable,
          observedStatus: observationStatus,
          actualValue: ep.statusCode,
          expectedValue: 200,
          assertionMatched: isReachable,
          statusCode: ep.statusCode,
          latencyMs: ep.latencyMs,
        },
        provenance: `PROBE_HTTP (${ep.url})`,
        confidence: isCollectionSuccess ? 1.0 : 0.0,
        immutable: true,
        redacted: true,
        collectionStatus,
        error: isCollectionSuccess
          ? undefined
          : { code: 'ENDPOINT_UNREACHABLE', message: ep.message || `端点不可达 (status: ${ep.statusCode})` },
      });
    });
  }

  // 3. 记录未映射字段
  unmappedFields.push('candidateChannelCount', 'recommendations', 'domainAnalysis');
  warnings.push(
    'probeResult 中的 candidateChannelCount、recommendations 属于离线预估或建议，未被映射为实时证据信封'
  );

  return {
    success: true,
    value: envelopes,
    issues,
    unmappedFields,
    warnings,
  };
}

// ============================================================================
// 五、Mapper 3: execute → ExecutionResult + EvidenceEnvelope[]
// ============================================================================

export interface MapExecuteOptions {
  testId: string; // 必须显式提供 (Requirement 3)
  capturedAt: string; // 必须显式提供 (Requirement 3)
  environment?: string;
  executionId?: string;
}

/**
 * 将旧版 ExecuteKernelResult 单向映射为 ExecutionResult 及 EvidenceEnvelope
 * 规则：
 * 1. REAL 提交成功最多证明任务已成功排队，SUBMITTED 绝对不得映射为 COMPLETED；
 * 2. mock 执行只能产生 sourceType=FIXTURE 证据；
 * 3. rawResponse 必须全量脱敏，严禁明文密码或会话进入 rawReference；
 * 4. 分离采集状态与业务观察结果：只要提交请求获得响应，collectionStatus 为 SUCCESS，业务观察放入 normalizedFields；
 * 5. 去除 Date.now()，由 options.testId, options.capturedAt 和稳定序号生成。
 */
export function mapExecuteToExecutionResult(
  executeResult: ExecuteKernelResult,
  options: MapExecuteOptions
): MappingResult<{ execution: ExecutionResult; evidence: CanonicalEvidenceEnvelope[] }> {
  const issues: MappingIssue[] = [];
  const warnings: string[] = [];
  const unmappedFields: string[] = [];

  if (!executeResult || typeof executeResult !== 'object') {
    return {
      success: false,
      issues: [{ code: 'INVALID_INPUT', message: 'executeResult 必须为有效对象', severity: 'ERROR' }],
      unmappedFields: [],
      warnings: [],
    };
  }

  // 1. 必要 ID 与时间校验
  if (!options || typeof options.testId !== 'string' || options.testId.trim() === '') {
    issues.push({
      field: 'testId',
      code: 'MISSING_TEST_ID',
      message: 'testId 必须由调用者显式提供，禁止隐式生成',
      severity: 'ERROR',
    });
  }
  if (!options || typeof options.capturedAt !== 'string' || isNaN(Date.parse(options.capturedAt))) {
    issues.push({
      field: 'capturedAt',
      code: 'MISSING_CAPTURED_AT',
      message: 'capturedAt 必须显式提供合法的 ISO-8601 时间戳，禁止使用当前时间隐式生成',
      severity: 'ERROR',
    });
  }

  // 必需字段校验
  if (!executeResult.mode) {
    issues.push({
      field: 'mode',
      code: 'REQUIRED_FIELD_MISSING',
      message: 'executeResult.mode 必需 (real | mock)',
      severity: 'ERROR',
    });
  }

  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  if (hasErrors) {
    return {
      success: false,
      issues,
      unmappedFields,
      warnings,
    };
  }

  const testId = options.testId;
  const capturedAt = options.capturedAt;
  const environment = options.environment || 'test';

  // 2. 状态严格对齐：SUBMITTED 保持 SUBMITTED，绝对不能升级为 COMPLETED！
  let executionStatus: ExecutionResult['status'];
  if (executeResult.status === 'SUBMITTED') {
    executionStatus = 'SUBMITTED';
  } else if (executeResult.status === 'BLOCKED') {
    executionStatus = 'BLOCKED';
  } else if (executeResult.status === 'FAILED' || executeResult.status === 'ERROR' || !executeResult.ok) {
    executionStatus = 'FAILED';
  } else if (executeResult.status === 'SUCCESS') {
    executionStatus = 'COMPLETED';
  } else {
    executionStatus = 'FAILED';
  }

  // 3. 证据源类型：mock 或 isSimulated 强制为 FIXTURE
  const isFixtureMode = executeResult.mode === 'mock' || Boolean(executeResult.isSimulated);
  const sourceType: EvidenceSourceType = isFixtureMode ? 'FIXTURE' : 'SERVER_API';
  const provenance = isFixtureMode
    ? 'FIXTURE (execute_mock_kernel)'
    : 'SERVER_API (POST /aivideo/videonew/add:task_submitted)';

  const evidence: CanonicalEvidenceEnvelope[] = [];

  // 分离采集状态与业务观察
  let collectionStatus: EvidenceCollectionStatus = 'SUCCESS';
  if (executeResult.status === 'BLOCKED') {
    collectionStatus = 'BLOCKED';
  } else if (executeResult.status === 'ERROR' && !executeResult.rawResponse) {
    collectionStatus = 'COLLECTION_FAILED';
  } else {
    collectionStatus = 'SUCCESS';
  }

  const evidenceKey = isFixtureMode ? 'FIXTURE:TASK_SUBMISSION' : 'SERVER_API:TASK_SUBMISSION';
  const observationStatus: EvidenceObservationStatus = collectionStatus === 'SUCCESS'
    ? (executeResult.ok ? 'PASS' : 'FAIL')
    : 'UNVERIFIED';

  evidence.push({
    evidenceId: `${testId}-task-1`,
    testId,
    sourceTool: 'core-kernel.execute',
    sourceType,
    evidenceKey,
    observationStatus,
    capturedAt,
    environment,
    subjectType: 'task',
    subjectId: executeResult.taskId || executeResult.simulationId || 'unassigned_task',
    rawReference: redactSensitiveData(executeResult.rawResponse) as Record<string, unknown> | undefined,
    normalizedFields: {
      observedStatus: executeResult.ok ? 'PASS' : 'FAIL',
      actualValue: executeResult.status,
      expectedValue: 'SUBMITTED',
      assertionMatched: executeResult.ok,
      taskId: executeResult.taskId,
      simulationId: executeResult.simulationId,
      isSimulated: executeResult.isSimulated,
      mode: executeResult.mode,
      modelId: executeResult.modelId,
      mediaType: executeResult.mediaType,
      legacyStatus: executeResult.status,
    },
    provenance,
    confidence: collectionStatus === 'SUCCESS' ? 1.0 : 0.0,
    immutable: true,
    redacted: true,
    collectionStatus,
    error: collectionStatus === 'COLLECTION_FAILED'
      ? { code: executeResult.blockerCode || 'TASK_SUBMIT_FAILED', message: executeResult.message || '任务提交采集未成功' }
      : undefined,
  });

  // 4. 组装 ExecutionResult (禁止包含任何最终 Verdict 字段)
  const execution: ExecutionResult = {
    executionId: options.executionId || `${testId}-exec-1`,
    testId,
    status: executionStatus,
    evidence,
    startedAt: capturedAt,
    completedAt: capturedAt,
    error: executionStatus === 'FAILED' || executionStatus === 'BLOCKED'
      ? { code: executeResult.blockerCode || 'EXECUTION_UNSUCCESSFUL', message: executeResult.message }
      : undefined,
    metadata: {
      mode: executeResult.mode,
      taskId: executeResult.taskId,
    },
  };

  // 5. 记录未映射字段
  unmappedFields.push('points', 'disambiguation', 'credentialsMasked');
  warnings.push(
    'executeResult.points 仅表达提交时预期预扣积分，真实扣费必须由 verify 账单流水证实'
  );

  return {
    success: true,
    value: { execution, evidence },
    issues,
    unmappedFields,
    warnings,
  };
}

// ============================================================================
// 六、Mapper 4: verify 中的原始证据 → CanonicalEvidenceEnvelope[]
// ============================================================================

export interface MapVerifyOptions {
  testId: string; // 必须显式提供 (Requirement 3)
  capturedAt: string; // 必须显式提供 (Requirement 3)
  environment?: string;
}

/**
 * 将旧版 VerifyKernelResult 中的原始事实证据单向映射为 CanonicalEvidenceEnvelope 集合
 * 核心原则：
 * 1. 绝不复制旧的最终结论 (verdict, acceptance, passed, status 严禁进入 Evidence)；
 * 2. 分离采集状态与业务观察结果：成功采集到 PASS 或 FAIL 事实，collectionStatus 均为 SUCCESS；
 * 3. 业务观察结果写入 normalizedFields (observedStatus, actualValue, expectedValue, assertionMatched)；
 * 4. 媒体二进制检查映射为 MEDIA_BINARY；
 * 5. 账单流水映射为 BILLING_LEDGER；
 * 6. 调用者入参声明映射为 USER_ASSERTION，服务端事实映射为 SERVER_API，二者必须区分；
 * 7. 静态渠道绝对不能映射为 SERVER_API；
 * 8. 无法识别来源时严禁猜测或标记为 SERVER_API，必须返回明确 issue 并判定映射失败；
 * 9. 去除 Date.now()，信封由 testId 和稳定序号命名，相同输入产生完全相同输出。
 */
// ============================================================================
// 六、纯前置事实契约 (CanonicalVerifyFacts) 与事实生成器
// ============================================================================

export interface CanonicalVerifyFacts {
  testId: string;
  capturedAt: string;
  environment?: string;
  executionMode: 'real' | 'offline' | 'fixture';
  taskId: number;
  modelId?: number;
  mediaType?: 'video' | 'image';
  progress?: number;

  // 任务事实 (严格禁止包含旧 verdict/acceptance/passed/finalStatus)
  task?: {
    status: 'PASS' | 'FAIL' | 'PROCESSING' | 'UNVERIFIED';
    source?: string;
    error?: string;
    terminalStatus?: string;
    progress?: number;
  };

  // 产物二进制事实
  artifact?: {
    decodable?: boolean;
    fileAccessible?: boolean;
    dimensions?: { width?: number; height?: number };
    durationSeconds?: number;
    format?: string;
    hasMdat?: boolean;
    reasons?: string[];
    ownership?: 'VERIFIED' | 'UNVERIFIED';
    status?: 'PASS' | 'FAIL' | 'UNVERIFIED';
  };
  artifactOwnership?: 'VERIFIED' | 'UNVERIFIED';

  // 账务事实
  billing?: {
    status?: 'PASS' | 'FAIL' | 'UNVERIFIED';
    passed?: boolean;
    settledPoints?: number;
    netDeductedPoints?: number;
    preDeductedPoints?: number;
    expectedPoints?: number;
    hasViolations?: boolean;
  };
  billingAudit?: 'AUDITED' | 'SKIPPED_NO_LOGS';
  expectedChargeSource?: 'REAL_BILLING_FACT' | 'DEVTEST_EXPECTATION';
  pricingAllowPass?: boolean;

  // 不变量事实
  invariants?: {
    antiDoubleBilling?: boolean;
    netChargeZero?: boolean;
    refundIdempotency?: boolean;
  };

  // 路由通道与网关事实
  channelDetail?: {
    status?: 'PASS' | 'FAIL' | 'UNVERIFIED';
    channelMatched?: boolean;
    fallbackAvoided?: boolean;
    targetChannelId?: number;
    targetChannelName?: string;
    actualChannelId?: number;
    actualChannelName?: string;
    fallbackChannel?: string;
    retryProvider?: string;
    reason?: string;
  };

  // 来源元数据
  provenance?: {
    actualChannelId?: string;
    fallbackChannel?: string;
    retryProvider?: string;
    extra?: string;
    gatewayChannel?: string;
  };
  isActualChannelAssertedOnly?: boolean;

  // 冲突与采集异常
  hasEvidenceConflict?: boolean;
  conflictReasons?: string[];

  // 回归比对事实 (可选)
  regressionDiff?: {
    isRegression: boolean;
    regressionStatus?: 'CLEAN' | 'REGRESSION' | 'UNKNOWN';
    unexpectedChanges?: Array<{ field: string; reason: string }>;
  };

  // 契约配置冲突 (可选)
  contractConflicts?: Array<{ field?: string; message: string; severity?: string }>;

  // 领域业务校验事实 (可选)
  businessValidationStatus?: 'PASS' | 'FAIL' | 'UNVERIFIED';

  // 网关渠道快照事实 (可选)
  gatewayChannelFact?: {
    verified?: boolean;
    required?: boolean;
    failureReason?: string;
  };

  // DB Extra 落库事实 (可选)
  isDbExtraVerified?: boolean;
}

/**
 * 从原始前置事实生成 Canonical Evidence Envelopes
 * 纯函数，零写副作用，绝不反向读取旧 Verdict，绝不生成最终 Verdict。
 */
export function buildCanonicalEvidenceFromVerifyFacts(
  facts: CanonicalVerifyFacts
): MappingResult<CanonicalEvidenceEnvelope[]> {
  const issues: MappingIssue[] = [];
  const warnings: string[] = [];
  const unmappedFields: string[] = [];
  const envelopes: CanonicalEvidenceEnvelope[] = [];

  if (!facts || typeof facts !== 'object') {
    return {
      success: false,
      issues: [{ code: 'INVALID_INPUT', message: 'facts 必须为有效对象', severity: 'ERROR' }],
      unmappedFields: [],
      warnings: [],
    };
  }

  // 1. 必要 ID 与时间校验
  if (!facts.testId || typeof facts.testId !== 'string' || facts.testId.trim() === '') {
    issues.push({
      field: 'testId',
      code: 'MISSING_TEST_ID',
      message: 'testId 必须由调用者显式提供，禁止隐式生成',
      severity: 'ERROR',
    });
  }
  if (!facts.capturedAt || typeof facts.capturedAt !== 'string' || isNaN(Date.parse(facts.capturedAt))) {
    issues.push({
      field: 'capturedAt',
      code: 'MISSING_CAPTURED_AT',
      message: 'capturedAt 必须显式提供合法的 ISO-8601 时间戳，禁止使用当前时间隐式生成',
      severity: 'ERROR',
    });
  }

  // 必需字段校验
  if (typeof facts.taskId !== 'number') {
    issues.push({
      field: 'taskId',
      code: 'REQUIRED_FIELD_MISSING',
      message: 'facts.taskId 必需且必须为数字',
      severity: 'ERROR',
    });
  }
  if (!facts.executionMode) {
    issues.push({
      field: 'executionMode',
      code: 'REQUIRED_FIELD_MISSING',
      message: 'facts.executionMode 必需 (real | offline | fixture)',
      severity: 'ERROR',
    });
  }

  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  if (hasErrors) {
    return {
      success: false,
      issues,
      unmappedFields,
      warnings,
    };
  }

  const testId = facts.testId;
  const capturedAt = facts.capturedAt;
  const environment = facts.environment || 'test';
  const isReal = facts.executionMode === 'real';

  // 1. 任务终态事实证据 (Task Status Evidence)
  const taskEvidence = facts.task;
  if (taskEvidence) {
    const isTaskPass = taskEvidence.status === 'PASS';
    const isTaskInProgress = taskEvidence.status === 'PROCESSING' || taskEvidence.status === 'UNVERIFIED';
    const collectionStatus: EvidenceCollectionStatus = 'SUCCESS';
    const evidenceKey = isReal ? 'SERVER_API:TASK_STATUS' : 'FIXTURE:TASK_STATUS';
    const observationStatus: EvidenceObservationStatus = isTaskPass
      ? 'PASS'
      : isTaskInProgress
      ? 'UNVERIFIED'
      : 'FAIL';

    envelopes.push({
      evidenceId: `${testId}-task-1`,
      testId,
      sourceTool: 'core-kernel.verify',
      sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
      evidenceKey,
      observationStatus,
      capturedAt,
      environment,
      subjectType: 'task',
      subjectId: facts.taskId,
      normalizedFields: {
        taskId: facts.taskId,
        rawTaskStatus: taskEvidence.status,
        observedStatus: observationStatus,
        actualValue: taskEvidence.status,
        expectedValue: 'PASS',
        assertionMatched: isTaskPass,
        progress: facts.progress,
      },
      provenance: isReal
        ? (taskEvidence.source || 'SERVER_API (/aivideo/v2/task_status/apiGetStatus)')
        : 'FIXTURE (task_status_fixture)',
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus,
    });
  }

  // 2. 媒体二进制验真证据 (Media Binary Evidence)
  if (facts.artifact) {
    const isOwnershipVerified = facts.artifactOwnership !== 'UNVERIFIED' && (facts.artifact as any).ownership !== 'UNVERIFIED';
    const isMediaPass = Boolean(facts.artifact.decodable) && isOwnershipVerified;
    const isFileAccessible = facts.artifact.fileAccessible !== false;
    const collectionStatus: EvidenceCollectionStatus = isFileAccessible ? 'SUCCESS' : 'MISSING';
    const evidenceKey = 'MEDIA_BINARY:CONTAINER_CHECK';
    const observationStatus: EvidenceObservationStatus = isFileAccessible
      ? (!isOwnershipVerified ? 'UNVERIFIED' : (isMediaPass ? 'PASS' : 'FAIL'))
      : 'UNVERIFIED';

    envelopes.push({
      evidenceId: `${testId}-artifact-1`,
      testId,
      sourceTool: 'media-inspector',
      sourceType: 'MEDIA_BINARY',
      evidenceKey,
      observationStatus,
      capturedAt,
      environment,
      subjectType: 'artifact',
      subjectId: facts.taskId,
      normalizedFields: {
        observedStatus: observationStatus,
        actualValue: facts.artifact.decodable,
        expectedValue: true,
        assertionMatched: isFileAccessible && isMediaPass,
        decodable: facts.artifact.decodable,
        durationSeconds: facts.artifact.durationSeconds,
        width: facts.artifact.dimensions?.width,
        height: facts.artifact.dimensions?.height,
        mediaType: facts.mediaType,
        ownership: isOwnershipVerified ? 'VERIFIED' : 'UNVERIFIED',
      },
      provenance: 'MEDIA_BINARY (Range 0-1024 binary inspection)',
      confidence: isFileAccessible ? 1.0 : 0.0,
      immutable: true,
      redacted: true,
      collectionStatus,
    });
  }

  // 3. 账单流水证据 (Billing Ledger Evidence)
  if (facts.billing || facts.pricingAllowPass === false) {
    const isPricingDetermined = facts.pricingAllowPass !== false;
    const isBillingPass = Boolean(facts.billing?.passed) && isPricingDetermined;
    const isSkippedLogs = !facts.billing || facts.billingAudit === 'SKIPPED_NO_LOGS';
    const isExplicitUnverified = facts.billing?.status === 'UNVERIFIED';
    const isExplicitFail = facts.billing?.status === 'FAIL';
    const collectionStatus: EvidenceCollectionStatus = isSkippedLogs ? 'MISSING' : 'SUCCESS';
    const evidenceKey = 'BILLING_LEDGER:TASK_RECORDS';
    const observationStatus: EvidenceObservationStatus = isSkippedLogs
      ? 'UNVERIFIED'
      : (!isPricingDetermined
          ? 'UNVERIFIED'
          : (isExplicitUnverified
              ? 'UNVERIFIED'
              : (isExplicitFail
                  ? 'FAIL'
                  : (isBillingPass ? 'PASS' : 'FAIL'))));

    const actualCharge =
      facts.billing && (facts.billing.settledPoints !== undefined && facts.billing.settledPoints > 0)
        ? facts.billing.settledPoints
        : (facts.billing?.netDeductedPoints ?? 0);

    envelopes.push({
      evidenceId: `${testId}-billing-1`,
      testId,
      sourceTool: 'billing-oracle',
      sourceType: 'BILLING_LEDGER',
      evidenceKey,
      observationStatus,
      capturedAt,
      environment,
      subjectType: 'billing',
      subjectId: facts.taskId,
      normalizedFields: {
        observedStatus: observationStatus,
        actualValue: actualCharge,
        expectedValue: facts.billing?.expectedPoints,
        assertionMatched: !isSkippedLogs && isBillingPass,
        preDeductedPoints: facts.billing?.preDeductedPoints,
        actualCharge,
        antiDoubleBilling: facts.invariants?.antiDoubleBilling,
        netChargeZero: facts.invariants?.netChargeZero,
        refundIdempotency: facts.invariants?.refundIdempotency,
      },
      provenance: facts.expectedChargeSource === 'REAL_BILLING_FACT'
        ? 'BILLING_LEDGER (GET /auth/adminscore/index)'
        : 'FIXTURE (billing_fixture)',
      confidence: isSkippedLogs ? 0.0 : 1.0,
      immutable: true,
      redacted: true,
      collectionStatus,
    });
  }

  // 4. 路由与渠道承接证据 (分流断言与服务端事实隔离)
  if (facts.provenance?.actualChannelId) {
    const channelProv = facts.provenance.actualChannelId;
    const isAssertedOnly = Boolean(facts.isActualChannelAssertedOnly);
    if (channelProv === 'UNVERIFIED') {
      warnings.push('旧版执行结果中渠道来源为 UNVERIFIED，未采集到有效渠道事实信封');
    } else if (
      isAssertedOnly ||
      channelProv.includes('CLI_ASSERTED_INPUT') ||
      channelProv.includes('USER_ASSERTION') ||
      (facts.executionMode === 'real' && channelProv.includes('FIXTURE_ASSERTED'))
    ) {
      envelopes.push({
        evidenceId: `${testId}-channel-1`,
        testId,
        sourceTool: 'caller-input',
        sourceType: 'USER_ASSERTION',
        evidenceKey: 'USER_ASSERTION:ROUTING_CHANNEL',
        observationStatus: 'UNVERIFIED',
        capturedAt,
        environment,
        subjectType: 'gateway_channel',
        subjectId: facts.channelDetail?.actualChannelId || 'unverified_channel',
        normalizedFields: {
          observedStatus: 'UNVERIFIED',
          actualValue: facts.channelDetail?.actualChannelId,
          expectedValue: facts.channelDetail?.targetChannelId,
          assertionMatched: false,
          channelDetail: facts.channelDetail,
          isActualChannelAssertedOnly: true,
        },
        provenance: 'USER_ASSERTION (CLI/MCP 手填传入，非服务端证实事实)',
        confidence: 0.1,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      });
      warnings.push('实际执行渠道仅来自调用者入参声明，已降级标记为 USER_ASSERTION 证据信封 (UNVERIFIED)');
    } else if (channelProv.includes('SOURCE_STATIC_CONTRACT') || channelProv.includes('STATIC')) {
      envelopes.push({
        evidenceId: `${testId}-channel-1`,
        testId,
        sourceTool: 'routing-oracle',
        sourceType: 'FIXTURE',
        evidenceKey: 'FIXTURE:ROUTING_CHANNEL',
        observationStatus: 'UNVERIFIED',
        capturedAt,
        environment,
        subjectType: 'gateway_channel',
        subjectId: facts.channelDetail?.actualChannelId || 'static_channel',
        normalizedFields: {
          observedStatus: 'UNVERIFIED',
          actualValue: facts.channelDetail?.actualChannelId,
          expectedValue: facts.channelDetail?.targetChannelId,
          assertionMatched: false,
          channelDetail: facts.channelDetail,
        },
        provenance: 'SOURCE_STATIC_CONTRACT (离线静态配置契约，非实时事实)',
        confidence: 0.5,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      });
      warnings.push('静态契约渠道未获得服务端运行时事实证实，映射为 FIXTURE 证据信封 (UNVERIFIED)');
    } else if (
      channelProv.includes('SERVER_RUN_FACT') ||
      channelProv.includes('SERVER_API') ||
      channelProv.includes('SOURCE_REAL_GATEWAY') ||
      channelProv.toLowerCase().includes('retrylog') ||
      channelProv.toLowerCase().includes('exceptionaltaskdata') ||
      channelProv.includes('FIXTURE_ASSERTED')
    ) {
      const detail = facts.channelDetail;
      const channelStatus = detail?.status;
      const channelMatched = detail?.channelMatched;
      const fallbackAvoided = detail?.fallbackAvoided !== false;
      const isFallback = !fallbackAvoided;

      let observationStatus: EvidenceObservationStatus;
      if (channelStatus === 'FAIL' || channelMatched === false || isFallback) {
        observationStatus = 'FAIL';
      } else if (channelStatus === 'PASS' || channelMatched === true) {
        observationStatus = 'PASS';
      } else {
        observationStatus = 'UNVERIFIED';
      }

      const isRealChannel = facts.executionMode === 'real' && !channelProv.includes('FIXTURE');
      const channelSourceType: EvidenceSourceType = isRealChannel ? 'SERVER_API' : 'FIXTURE';
      const channelEvidenceKey = isRealChannel ? 'SERVER_API:ROUTING_CHANNEL' : 'FIXTURE:ROUTING_CHANNEL';

      envelopes.push({
        evidenceId: `${testId}-channel-1`,
        testId,
        sourceTool: 'media-flow.runtime',
        sourceType: channelSourceType,
        evidenceKey: channelEvidenceKey,
        observationStatus,
        capturedAt,
        environment,
        subjectType: 'gateway_channel',
        subjectId: facts.channelDetail?.actualChannelId || 'runtime_channel',
        normalizedFields: {
          observedStatus: observationStatus,
          actualValue: facts.channelDetail?.actualChannelId,
          expectedValue: facts.channelDetail?.targetChannelId,
          assertionMatched: observationStatus === 'PASS',
          channelDetail: facts.channelDetail,
        },
        provenance: channelProv,
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      });
    } else {
      issues.push({
        field: 'provenance.actualChannelId',
        code: 'UNKNOWN_EVIDENCE_SOURCE',
        message: `无法识别渠道来源 (${channelProv})，禁止猜测或标记为 SERVER_API`,
        severity: 'ERROR',
        details: { provenance: channelProv },
      });
    }
  }

  // 5. 证据冲突捕获与信封生成 (总是生成证据信封，无冲突时 PASS，冲突时 FAIL)
  const isConflict = Boolean(facts.hasEvidenceConflict);
  if (isConflict) {
    issues.push({
      code: 'EVIDENCE_CONFLICT_DETECTED',
      message: `检测到证据冲突: ${facts.conflictReasons?.join('; ') || '未知冲突'}`,
      severity: 'WARNING',
      details: { conflictReasons: facts.conflictReasons },
    });
    warnings.push(`检测到证据冲突: ${facts.conflictReasons?.join('; ') || '未知冲突'}`);
  }
  envelopes.push({
    evidenceId: `${testId}-conflict-1`,
    testId,
    sourceTool: 'core-kernel.verify',
    sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
    evidenceKey: isReal ? 'SERVER_API:EVIDENCE_CONFLICT' : 'FIXTURE:EVIDENCE_CONFLICT',
    observationStatus: isConflict ? 'FAIL' : 'PASS',
    capturedAt,
    environment,
    subjectType: 'evidence_conflict',
    subjectId: facts.taskId,
    normalizedFields: {
      observedStatus: isConflict ? 'FAIL' : 'PASS',
      hasConflict: isConflict,
      conflictReasons: facts.conflictReasons,
      assertionMatched: !isConflict,
    },
    provenance: 'EVIDENCE_CONFLICT_DETECTOR',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
  });

  // 6. 回归比对事实证据 (Regression Baseline Evidence)
  if (facts.regressionDiff) {
    const isRegression = facts.regressionDiff.isRegression;
    const regStatus = facts.regressionDiff.regressionStatus;
    const observationStatus: EvidenceObservationStatus = isRegression
      ? 'FAIL'
      : 'PASS';

    envelopes.push({
      evidenceId: `${testId}-regression-1`,
      testId,
      sourceTool: 'core-kernel.baseline',
      sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
      evidenceKey: isReal ? 'SERVER_API:REGRESSION_BASELINE' : 'FIXTURE:REGRESSION_BASELINE',
      observationStatus,
      capturedAt,
      environment,
      subjectType: 'regression_baseline',
      subjectId: facts.taskId,
      normalizedFields: {
        isRegression,
        regressionStatus: regStatus,
        observedStatus: observationStatus,
        actualValue: isRegression ? 'REGRESSION' : (regStatus === 'CLEAN' ? 'CLEAN' : 'UNKNOWN'),
        expectedValue: 'CLEAN',
        assertionMatched: !isRegression && regStatus === 'CLEAN',
      },
      provenance: 'BASELINE_REGRESSION_ANALYSIS',
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    });
  }

  // 7. 契约配置冲突证据 (Contract Consistency Evidence: 总是生成信封)
  const conflictsCount = facts.contractConflicts?.length ?? 0;
  envelopes.push({
    evidenceId: `${testId}-contract-conflicts-1`,
    testId,
    sourceTool: 'core-kernel.contract',
    sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
    evidenceKey: isReal ? 'SERVER_API:CONTRACT_CONSISTENCY' : 'FIXTURE:CONTRACT_CONSISTENCY',
    observationStatus: conflictsCount > 0 ? 'FAIL' : 'PASS',
    capturedAt,
    environment,
    subjectType: 'contract_consistency',
    subjectId: facts.taskId,
    normalizedFields: {
      conflictsCount,
      conflicts: facts.contractConflicts,
      observedStatus: conflictsCount > 0 ? 'FAIL' : 'PASS',
      actualValue: conflictsCount,
      expectedValue: 0,
      assertionMatched: conflictsCount === 0,
    },
    provenance: 'CONTRACT_CONSISTENCY_CHECK',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
  });

  // 8. 领域业务校验事实证据 (Business Validation Evidence: 总是生成信封)
  const bValStatus = facts.businessValidationStatus || 'PASS';
  envelopes.push({
    evidenceId: `${testId}-business-validation-1`,
    testId,
    sourceTool: 'domain-knowledge',
    sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
    evidenceKey: isReal ? 'SERVER_API:BUSINESS_VALIDATION' : 'FIXTURE:BUSINESS_VALIDATION',
    observationStatus: bValStatus,
    capturedAt,
    environment,
    subjectType: 'business_validation',
    subjectId: facts.taskId,
    normalizedFields: {
      observedStatus: bValStatus,
      actualValue: bValStatus,
      expectedValue: 'PASS',
      assertionMatched: bValStatus === 'PASS',
    },
    provenance: 'DOMAIN_BUSINESS_VALIDATION',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
  });

  // 9. DB Extra 落库事实证据 (Extra Diversion Evidence)
  if (facts.isDbExtraVerified !== undefined) {
    const isPass = facts.isDbExtraVerified === true;
    envelopes.push({
      evidenceId: `${testId}-extra-diversion-1`,
      testId,
      sourceTool: 'media-flow.extra',
      sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
      evidenceKey: isReal ? 'SERVER_API:EXTRA_DIVERSION' : 'FIXTURE:EXTRA_DIVERSION',
      observationStatus: isPass ? 'PASS' : 'UNVERIFIED',
      capturedAt,
      environment,
      subjectType: 'diversion_extra',
      subjectId: facts.taskId,
      normalizedFields: {
        observedStatus: isPass ? 'PASS' : 'UNVERIFIED',
        actualValue: isPass ? 'extra.diversion=10' : 'MISSING_EXTRA',
        expectedValue: 'extra.diversion=10',
        assertionMatched: isPass,
      },
      provenance: isReal ? 'SERVER_API (/aivideo/v2/video/getEditData)' : 'FIXTURE (db_extra)',
      confidence: isPass ? 1.0 : 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: isPass ? 'SUCCESS' : 'MISSING',
    });
  }

  // 10. 网关渠道快照事实证据 (Gateway Channel Evidence)
  if (facts.gatewayChannelFact && facts.gatewayChannelFact.required) {
    const isGwPass = facts.gatewayChannelFact.verified === true;
    const isGwFail = Boolean(facts.gatewayChannelFact.failureReason);
    const observationStatus: EvidenceObservationStatus = isGwPass
      ? 'PASS'
      : 'UNVERIFIED';

    envelopes.push({
      evidenceId: `${testId}-gateway-channel-1`,
      testId,
      sourceTool: 'routing-oracle.gateway',
      sourceType: isReal ? 'SERVER_API' : 'FIXTURE',
      evidenceKey: isReal ? 'SERVER_API:GATEWAY_CHANNEL' : 'FIXTURE:GATEWAY_CHANNEL',
      observationStatus,
      capturedAt,
      environment,
      subjectType: 'gateway_channel_config',
      subjectId: facts.taskId,
      normalizedFields: {
        observedStatus: observationStatus,
        actualValue: isGwPass ? 'CONFIRMED' : (facts.gatewayChannelFact.failureReason || 'MISSING'),
        expectedValue: 'CONFIRMED',
        assertionMatched: isGwPass,
      },
      provenance: isReal ? 'GATEWAY_API (/api/channel/list)' : 'FIXTURE (gateway_channel)',
      confidence: isGwPass ? 1.0 : 0.0,
      immutable: true,
      redacted: true,
      collectionStatus: isGwPass || isGwFail ? 'SUCCESS' : 'MISSING',
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'ERROR').length;

  return {
    success: errorCount === 0,
    value: errorCount === 0 ? envelopes : undefined,
    issues,
    unmappedFields,
    warnings,
  };
}

/**
 * 兼容包装器：旧版 VerifyKernelResult 到 CanonicalEvidenceEnvelope[]
 * 必须复用 buildCanonicalEvidenceFromVerifyFacts，绝不维护第二套映射逻辑。
 */
export function mapVerifyToCanonicalEvidence(
  verifyResult: VerifyKernelResult,
  options: MapVerifyOptions
): MappingResult<CanonicalEvidenceEnvelope[]> {
  if (!verifyResult || typeof verifyResult !== 'object') {
    return {
      success: false,
      issues: [{ code: 'INVALID_INPUT', message: 'verifyResult 必须为有效对象', severity: 'ERROR' }],
      unmappedFields: [],
      warnings: [],
    };
  }

  const facts: CanonicalVerifyFacts = {
    testId: options?.testId,
    capturedAt: options?.capturedAt,
    environment: options?.environment,
    executionMode: verifyResult.executionMode,
    taskId: verifyResult.taskId,
    modelId: verifyResult.modelId,
    mediaType: verifyResult.mediaType,
    progress: verifyResult.progress,
    task: verifyResult.evidence?.task,
    artifact: verifyResult.artifact ? {
      ...verifyResult.artifact,
      ownership: verifyResult.evidence?.media?.ownership,
    } : undefined,
    artifactOwnership: verifyResult.evidence?.media?.ownership,
    billing: verifyResult.billing ? {
      ...verifyResult.billing,
      status: verifyResult.evidence?.billing?.status,
    } : undefined,
    billingAudit: verifyResult.billingAudit,
    expectedChargeSource: verifyResult.evidence?.billing?.expectedChargeSource,
    pricingAllowPass: verifyResult.contract?.pricing?.allowPass,
    invariants: verifyResult.invariants,
    channelDetail: verifyResult.channelDetail ?? verifyResult.businessValidation?.channelDetail,
    provenance: verifyResult.provenance,
    isActualChannelAssertedOnly: verifyResult.isActualChannelAssertedOnly,
    hasEvidenceConflict: verifyResult.hasEvidenceConflict,
    conflictReasons: verifyResult.conflictReasons,
  };

  const result = buildCanonicalEvidenceFromVerifyFacts(facts);

  // 严禁映射旧最终裁决字段：verdict, acceptance, passed, status
  result.unmappedFields.push(
    'verdict',
    'acceptance',
    'passed',
    'status',
    'acceptanceReport',
    'evidenceCompleteness',
    'expectedVsActual',
    'memoryCandidate'
  );
  result.warnings.push(
    'verifyResult 的最终裁决字段 (verdict, acceptance, passed, status) 绝不能反推或作为证据进入 EvidenceEnvelope'
  );

  return result;
}

// ============================================================================
// 七、单向兼容投影契约 (CanonicalVerdictResult → LegacyVerifyPresentation)
// ============================================================================

export interface LegacyLifecycleDisplayContext {
  terminalStatus?: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN' | 'PROCESSING';
  isProcessing?: boolean;
  progress?: number;
}
export type LegacyLifecycleContext = LegacyLifecycleDisplayContext;

export interface LegacyVerifyPresentation {
  verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'PROCESSING';
  acceptance: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'UNVERIFIED';
  passed: boolean;
  status: 'SUCCESS' | 'FAILED' | 'UNVERIFIED' | 'PROCESSING' | 'ERROR';
  evidenceCompleteness: EvidenceCompleteness;
  reasons: string[];
}

/**
 * 纯单向兼容投影函数：将 CanonicalVerdictResult 与生命周期上下文投影为旧版消费展示结构
 * 职责仅限格式与生命周期展示兼容，严禁重新计算业务结论或访问业务事实。
 *
 * 唯一固定映射规则：
 * - FAIL → REJECTED
 * - PASS 且无 blocker → ACCEPTED
 * - UNVERIFIED 且有 blocker → BLOCKED
 * - UNVERIFIED 且无 blocker → UNVERIFIED
 */
export function projectCanonicalVerdictToLegacy(
  canonicalResult: CanonicalVerdictResult,
  lifecycleContext?: LegacyLifecycleDisplayContext
): LegacyVerifyPresentation {
  const hasBlockers = Array.isArray(canonicalResult.blockers) && canonicalResult.blockers.length > 0;

  // 1. passed: 严格等于 canonical verdict === 'PASS' 且无 blocker
  const passed = canonicalResult.verdict === 'PASS' && !hasBlockers;

  // 2. status: 来自生命周期展示态，不得冒充业务 Verdict
  let status: 'SUCCESS' | 'FAILED' | 'UNVERIFIED' | 'PROCESSING' | 'ERROR';
  if (lifecycleContext?.isProcessing || lifecycleContext?.terminalStatus === 'PROCESSING') {
    status = 'PROCESSING';
  } else if (canonicalResult.verdict === 'PASS') {
    status = 'SUCCESS';
  } else if (canonicalResult.verdict === 'FAIL') {
    status = 'FAILED';
  } else {
    status = 'UNVERIFIED';
  }

  // 3. verdict: 唯一业务裁决；若处于 PROCESSING 兼容生命周期展示态且非明确 FAIL，展示为 PROCESSING
  let verdict: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'PROCESSING';
  if (canonicalResult.verdict === 'FAIL') {
    verdict = 'FAIL';
  } else if (lifecycleContext?.isProcessing || lifecycleContext?.terminalStatus === 'PROCESSING') {
    verdict = 'PROCESSING';
  } else {
    verdict = canonicalResult.verdict;
  }

  // 4. acceptance: 单向固定映射
  let acceptance: 'ACCEPTED' | 'REJECTED' | 'BLOCKED' | 'UNVERIFIED';
  if (canonicalResult.verdict === 'FAIL') {
    acceptance = 'REJECTED';
  } else if (canonicalResult.verdict === 'PASS') {
    acceptance = hasBlockers ? 'BLOCKED' : 'ACCEPTED';
  } else {
    // UNVERIFIED
    acceptance = hasBlockers ? 'BLOCKED' : 'UNVERIFIED';
  }

  // 5. evidenceCompleteness: 投影
  const reqKeys = canonicalResult.requiredEvidenceEvaluation.details.map((d) => d.key);
  const missingKeys = canonicalResult.requiredEvidenceEvaluation.missingEvidenceKeys.slice();
  const availableKeys = canonicalResult.evidenceIdsUsed.slice();
  const isComplete = missingKeys.length === 0 && canonicalResult.verdict === 'PASS' && !hasBlockers;

  const evidenceCompleteness: EvidenceCompleteness = {
    requiredEvidence: reqKeys,
    availableEvidence: availableKeys,
    missingEvidence: missingKeys,
    isComplete,
  };

  // 6. reasons: 合并 canonical reasons 与 blockers
  const reasons = [...canonicalResult.reasons];
  if (hasBlockers) {
    for (const b of canonicalResult.blockers) {
      const msg = `[BLOCKER:${b.code}] ${b.message}`;
      if (!reasons.includes(msg)) {
        reasons.push(msg);
      }
    }
  }

  return {
    verdict,
    acceptance,
    passed,
    status,
    evidenceCompleteness,
    reasons,
  };
}
