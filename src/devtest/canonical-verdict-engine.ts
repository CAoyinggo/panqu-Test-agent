/**
 * Panqu AI DevTest — Canonical Verdict Engine
 * Phase 1.4 实现唯一 Canonical Verdict Engine 纯函数
 *
 * 核心架构边界 (遵守 docs/ARCHITECTURE_FREEZE.md 受控扩展原则):
 * 1. 本模块为只读无副作用纯函数，严禁从 core-kernel 中自动调用；
 * 2. 禁止使用 Date.now、环境变量、文件系统或网络；
 * 3. 严格遵循唯一 Verdict 裁决优先级 (FAIL 优先于 UNVERIFIED)；
 * 4. 绝对不返回 passed、acceptance 或其他第二套别名；
 * 5. 相同输入重复执行保证输出完全一致。
 */

import {
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
  evaluateRequiredEvidence,
  type CanonicalTestSpec,
  type CanonicalEvidenceEnvelope,
  type DeterministicAssertion,
  type RequiredEvidenceEvaluationResult,
} from './canonical-protocol.js';

// ============================================================================
// 一、类型契约
// ============================================================================

export type CanonicalVerdict = 'PASS' | 'FAIL' | 'UNVERIFIED';

export interface AssertionEvaluationResult {
  assertion: DeterministicAssertion;
  status: 'PASS' | 'FAIL' | 'UNVERIFIED';
  actualValue?: unknown;
  expectedValue: unknown;
  matched: boolean;
  evidenceId?: string;
  evidenceKey?: string;
  reason?: string;
}

export interface CanonicalBlocker {
  code: string;
  evidenceKey?: string;
  message: string;
}

export interface CanonicalVerdictResult {
  verdict: CanonicalVerdict;
  testId: string;
  requiredEvidenceEvaluation: RequiredEvidenceEvaluationResult;
  assertionResults: AssertionEvaluationResult[];
  evidenceIdsUsed: string[];
  reasons: string[];
  warnings: string[];
  blockers: CanonicalBlocker[];
}

// ============================================================================
// 二、嵌套字段解析工具函数 (纯函数)
// ============================================================================

export function getNestedValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return undefined;
  }
  // 优先直取 (以防字段自身包含点号)
  if (Object.prototype.hasOwnProperty.call(obj, path)) {
    return (obj as Record<string, unknown>)[path];
  }
  // 点路径遍历
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

// ============================================================================
// 三、确定性断言操作符求值 (纯函数，严禁 JS 隐式类型转换)
// ============================================================================

export function evaluateOperator(
  operator: string,
  actual: unknown,
  expected: unknown,
): { status: 'PASS' | 'FAIL' | 'UNVERIFIED'; reason?: string } {
  switch (operator) {
    case 'EQUALS': {
      if (actual === expected) {
        return { status: 'PASS' };
      }
      if (
        typeof actual === 'object' &&
        typeof expected === 'object' &&
        actual !== null &&
        expected !== null &&
        JSON.stringify(actual) === JSON.stringify(expected)
      ) {
        return { status: 'PASS' };
      }
      return { status: 'FAIL', reason: `实际值 (${String(actual)}) 与期望值 (${String(expected)}) 不相等` };
    }

    case 'NOT_EQUALS': {
      if (actual !== expected) {
        if (
          typeof actual === 'object' &&
          typeof expected === 'object' &&
          actual !== null &&
          expected !== null &&
          JSON.stringify(actual) === JSON.stringify(expected)
        ) {
          return { status: 'FAIL', reason: '实际值与期望值深度相等' };
        }
        return { status: 'PASS' };
      }
      return { status: 'FAIL', reason: `实际值 (${String(actual)}) 与期望值 (${String(expected)}) 相等` };
    }

    case 'CONTAINS': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected)
          ? { status: 'PASS' }
          : { status: 'FAIL', reason: `字符串 "${actual}" 不包含 "${expected}"` };
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected)
          ? { status: 'PASS' }
          : { status: 'FAIL', reason: `数组不包含元素: ${String(expected)}` };
      }
      return { status: 'FAIL', reason: `CONTAINS 要求实际值为字符串或数组，收到: ${typeof actual}` };
    }

    case 'MATCHES_REGEX': {
      if (typeof expected !== 'string') {
        return { status: 'UNVERIFIED', reason: 'MATCHES_REGEX 期望值必须为正则表达式字符串' };
      }
      let regex: RegExp;
      try {
        regex = new RegExp(expected);
      } catch {
        // MATCHES_REGEX 非法表达式必须 fail-closed 为 UNVERIFIED
        return { status: 'UNVERIFIED', reason: `非法正则表达式: "${expected}"` };
      }
      if (typeof actual !== 'string') {
        return { status: 'FAIL', reason: `MATCHES_REGEX 要求实际值为字符串，收到: ${typeof actual}` };
      }
      return regex.test(actual)
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `实际值 "${actual}" 不匹配正则表达式 /${expected}/` };
    }

    case 'GREATER_THAN': {
      // 数值比较只接受有效数字，禁止隐式类型转换
      if (typeof actual !== 'number' || isNaN(actual) || typeof expected !== 'number' || isNaN(expected)) {
        return {
          status: 'UNVERIFIED',
          reason: `GREATER_THAN 仅支持有效数字比较，收到 actual=${String(actual)}, expected=${String(expected)}`,
        };
      }
      return actual > expected
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `实际值 (${actual}) 不大于期望值 (${expected})` };
    }

    case 'LESS_THAN': {
      if (typeof actual !== 'number' || isNaN(actual) || typeof expected !== 'number' || isNaN(expected)) {
        return {
          status: 'UNVERIFIED',
          reason: `LESS_THAN 仅支持有效数字比较，收到 actual=${String(actual)}, expected=${String(expected)}`,
        };
      }
      return actual < expected
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `实际值 (${actual}) 不小于期望值 (${expected})` };
    }

    case 'IN': {
      // IN 的 expectedValue 必须是数组
      if (!Array.isArray(expected)) {
        return { status: 'UNVERIFIED', reason: `IN 操作符的 expectedValue 必须为数组，收到: ${typeof expected}` };
      }
      return expected.includes(actual)
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `实际值 (${String(actual)}) 不在预期集合 [${expected.join(', ')}] 中` };
    }

    case 'IS_DEFINED': {
      return actual !== undefined && actual !== null
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `字段未定义 (实际值为 ${String(actual)})` };
    }

    case 'IS_UNDEFINED': {
      return actual === undefined || actual === null
        ? { status: 'PASS' }
        : { status: 'FAIL', reason: `字段已定义 (实际值为 ${String(actual)})` };
    }

    default:
      return { status: 'UNVERIFIED', reason: `未知或不支持的操作符: ${operator}` };
  }
}

// ============================================================================
// 四、Canonical Verdict Engine 核心纯函数
// ============================================================================

/**
 * 评估 TestSpec 与证据集合，产生唯一最终裁决结果
 *
 * 裁决顺序与优先级：
 * 1. 校验 TestSpec 和全部 Envelope；
 * 2. 排除 testId/environment 不匹配的 Envelope，并记录原因；
 * 3. 调用唯一的 evaluateRequiredEvidence 评估必需证据；
 * 4. 评估确定性断言；
 * 5. 按优先级裁决 (FAIL 优先于 UNVERIFIED)：
 *    - 任一必需证据 observationStatus=FAIL → FAIL；
 *    - 任一 critical deterministic assertion 明确失败 → FAIL；
 *    - 没有 FAIL，但必需证据缺失、BLOCKED、COLLECTION_FAILED 或 UNVERIFIED → UNVERIFIED；
 *    - 没有 FAIL，但关键断言缺少绑定、字段缺失或无法计算 → UNVERIFIED；
 *    - AI_OBSERVATION 或 USER_ASSERTION 不能单独让业务验收 PASS；
 *    - 所有必需证据 PASS 且所有关键断言 PASS → PASS。
 */
export function evaluateCanonicalVerdict(
  spec: Readonly<CanonicalTestSpec>,
  envelopes: ReadonlyArray<CanonicalEvidenceEnvelope>,
): CanonicalVerdictResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: CanonicalBlocker[] = [];
  const evidenceIdsUsedSet = new Set<string>();

  const addBlocker = (b: CanonicalBlocker) => {
    if (
      !blockers.some((item) => item.code === b.code && item.evidenceKey === b.evidenceKey && item.message === b.message)
    ) {
      blockers.push(b);
    }
  };

  // 1. 校验 TestSpec
  const specValidation = validateCanonicalTestSpec(spec);
  if (!specValidation.valid) {
    const errorMsgs = specValidation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    return {
      verdict: 'UNVERIFIED',
      testId: spec?.testId || 'invalid-spec',
      requiredEvidenceEvaluation: {
        satisfied: false,
        missingEvidenceKeys: spec?.requiredEvidence || [],
        failedEvidenceKeys: [],
        unverifiedEvidenceKeys: [],
        matchedEnvelopes: {},
        details: [],
      },
      assertionResults: [],
      evidenceIdsUsed: [],
      reasons: [`TestSpec 协议格式校验未通过: ${errorMsgs}`],
      warnings,
      blockers: [{ code: 'INVALID_TEST_SPEC', message: `TestSpec 协议格式校验未通过: ${errorMsgs}` }],
    };
  }

  // 1.1 最小可求值底线门禁 (Fail-Closed)
  // 若规约既未声明必需证据，也未定义确定性断言，缺少可求值证据契约，严禁返回假 PASS
  const hasReqEvidenceSpec = Array.isArray(spec.requiredEvidence) && spec.requiredEvidence.length > 0;
  const hasAssertionsSpec = Array.isArray(spec.deterministicAssertions) && spec.deterministicAssertions.length > 0;
  if (!hasReqEvidenceSpec && !hasAssertionsSpec) {
    return {
      verdict: 'UNVERIFIED',
      testId: spec.testId,
      requiredEvidenceEvaluation: {
        satisfied: false,
        missingEvidenceKeys: [],
        failedEvidenceKeys: [],
        unverifiedEvidenceKeys: [],
        matchedEnvelopes: {},
        details: [],
      },
      assertionResults: [],
      evidenceIdsUsed: [],
      reasons: ['TestSpec 未声明任何必需证据或确定性断言，缺少可求值证据契约，严禁产生空规格 PASS [FAIL_CLOSED]'],
      warnings,
      blockers: [
        {
          code: 'NO_EVALUABLE_EVIDENCE_SPEC',
          message: 'TestSpec 既无 requiredEvidence 也无 deterministicAssertions，缺少最小证据求值底线',
        },
      ],
    };
  }

  // 2. 校验并过滤 Envelope：排除格式错误、testId 不匹配、environment 不匹配的信封
  const validEnvelopes: CanonicalEvidenceEnvelope[] = [];
  const rawEnvelopes = Array.isArray(envelopes) ? envelopes : [];

  for (const env of rawEnvelopes) {
    const envValidation = validateEvidenceEnvelope(env);
    if (!envValidation.valid) {
      warnings.push(
        `证据 [${env?.evidenceId || 'unknown'}] 协议校验未通过 (${envValidation.errors.map((e) => e.message).join('; ')})，已排除`,
      );
      if (
        envValidation.errors.some(
          (e) => e.code === 'SERVER_API_IMPERSONATION_FORBIDDEN' || e.code === 'SOURCE_TYPE_KEY_MISMATCH',
        )
      ) {
        addBlocker({
          code: 'UNTRUSTED_EVIDENCE_SOURCE',
          evidenceKey: env?.evidenceKey || 'UNKNOWN',
          message: `证据来源不可信或试图冒充 SERVER_API [${env?.evidenceKey}]: ${envValidation.errors.map((e) => e.message).join('; ')}`,
        });
      }
      continue;
    }

    if (env.testId !== spec.testId) {
      warnings.push(`证据 [${env.evidenceId}] 的 testId (${env.testId}) 与 TestSpec (${spec.testId}) 不匹配，已排除`);
      continue;
    }

    if (env.environment !== spec.environment) {
      warnings.push(
        `证据 [${env.evidenceId}] 的 environment (${env.environment}) 与 TestSpec (${spec.environment}) 不匹配，已排除`,
      );
      continue;
    }

    validEnvelopes.push(env);
  }

  // 3. 调用唯一的 evaluateRequiredEvidence 评估必需证据契约
  const reqEvaluation = evaluateRequiredEvidence(spec, validEnvelopes);

  // 记录必需证据匹配到的 evidenceId
  for (const env of Object.values(reqEvaluation.matchedEnvelopes)) {
    if (env?.evidenceId) {
      evidenceIdsUsedSet.add(env.evidenceId);
    }
  }

  // 4. 检查用户渠道声明与服务端事实冲突
  const userChannelEnv = validEnvelopes.find((e) => e.evidenceKey === 'USER_ASSERTION:ROUTING_CHANNEL');
  const serverChannelEnv = validEnvelopes.find((e) => e.evidenceKey === 'SERVER_API:ROUTING_CHANNEL');

  if (userChannelEnv && serverChannelEnv) {
    const userVal = userChannelEnv.normalizedFields.actualValue;
    const serverVal = serverChannelEnv.normalizedFields.actualValue;
    if (userVal !== undefined && serverVal !== undefined && userVal !== serverVal) {
      const conflictMsg = `EVIDENCE_CONFLICT: 用户渠道声明 (${String(userVal)}) 与服务端事实渠道 (${String(serverVal)}) 冲突，以服务端事实为准`;
      warnings.push(conflictMsg);
      reasons.push(conflictMsg);
      evidenceIdsUsedSet.add(userChannelEnv.evidenceId);
      evidenceIdsUsedSet.add(serverChannelEnv.evidenceId);
    }
  }

  // 5. 评估确定性断言
  const assertionResults: AssertionEvaluationResult[] = [];
  const assertions = Array.isArray(spec.deterministicAssertions) ? spec.deterministicAssertions : [];

  for (const assertion of assertions) {
    const isCritical = assertion.critical === true;
    // Fail-closed 默认：断言 FAIL 一律阻断裁决，除非显式声明 critical:false（顾问性/advisory）。
    // 修复「critical 省略即被静默降级」的假 PASS 通路：省略 critical 视为阻断（等价 critical:true）。
    const isBlocking = assertion.critical !== false;

    // 关键断言必须有明确 evidenceKey 和 actualField；缺少绑定不得猜测，结果为 UNVERIFIED
    if (isCritical && (!assertion.evidenceKey || !assertion.actualField)) {
      assertionResults.push({
        assertion,
        status: 'UNVERIFIED',
        expectedValue: assertion.expectedValue,
        matched: false,
        reason: '关键断言缺少 evidenceKey 或 actualField 绑定，严禁猜测',
      });
      continue;
    }

    // 若无 evidenceKey 绑定，无法定位证据
    if (!assertion.evidenceKey) {
      assertionResults.push({
        assertion,
        status: 'UNVERIFIED',
        expectedValue: assertion.expectedValue,
        matched: false,
        reason: '断言未绑定 evidenceKey，无法读取证据',
      });
      if (!isCritical) {
        warnings.push(`非关键断言 [${assertion.field}] 未绑定 evidenceKey，无法执行求值`);
      }
      continue;
    }

    // 在有效信封集合中定位对应 evidenceKey 的证据信封
    const targetEnvs = validEnvelopes.filter((e) => e.evidenceKey === assertion.evidenceKey);
    if (targetEnvs.length === 0) {
      assertionResults.push({
        assertion,
        status: 'UNVERIFIED',
        expectedValue: assertion.expectedValue,
        matched: false,
        evidenceKey: assertion.evidenceKey,
        reason: `未找到断言所需的证据信封 [${assertion.evidenceKey}]`,
      });
      continue;
    }

    // 优先选择成功采集且确定状态的信封
    const targetEnv = targetEnvs.find((e) => e.collectionStatus === 'SUCCESS') || targetEnvs[0];
    evidenceIdsUsedSet.add(targetEnv.evidenceId);

    // 若证据采集未成功，断言无法计算
    if (targetEnv.collectionStatus !== 'SUCCESS') {
      assertionResults.push({
        assertion,
        status: 'UNVERIFIED',
        expectedValue: assertion.expectedValue,
        matched: false,
        evidenceId: targetEnv.evidenceId,
        evidenceKey: targetEnv.evidenceKey,
        reason: `断言所绑定的证据采集未成功 (collectionStatus: ${targetEnv.collectionStatus})`,
      });
      continue;
    }

    // 从 normalizedFields 中提取 actualField
    const actualFieldPath = assertion.actualField || assertion.field;
    const actualValue = getNestedValue(targetEnv.normalizedFields, actualFieldPath);

    // 字段不存在时为 UNVERIFIED
    if (actualValue === undefined) {
      assertionResults.push({
        assertion,
        status: 'UNVERIFIED',
        expectedValue: assertion.expectedValue,
        matched: false,
        evidenceId: targetEnv.evidenceId,
        evidenceKey: targetEnv.evidenceKey,
        reason: `字段 [${actualFieldPath}] 在证据信封 [${targetEnv.evidenceKey}] 中不存在`,
      });
      continue;
    }

    // 求值操作符
    const evalRes = evaluateOperator(assertion.operator, actualValue, assertion.expectedValue);

    assertionResults.push({
      assertion,
      status: evalRes.status,
      actualValue,
      expectedValue: assertion.expectedValue,
      matched: evalRes.status === 'PASS',
      evidenceId: targetEnv.evidenceId,
      evidenceKey: targetEnv.evidenceKey,
      reason: evalRes.reason,
    });

    if (isBlocking && evalRes.status === 'FAIL') {
      if (assertion.field === 'db.taskFound') {
        addBlocker({
          code: 'FRONTEND_TASK_NOT_FOUND',
          evidenceKey: 'SERVER_API:DB_TASK_RECORD',
          message: '前台任务源表（视频 pq_aivideo_new / 图片 goods·character·scene·fusion）中未查到物理入库记录 [FAIL]',
        });
      } else if (assertion.field === 'db.backendTaskFound') {
        addBlocker({
          code: 'BACKEND_TASK_NOT_FOUND',
          evidenceKey: 'SERVER_API:DB_TASK_RECORD',
          message: '后台调度表 pq_volcengine_ai_task 中未查到关联调度记录 [FAIL]',
        });
      } else if (assertion.field === 'db.frontendStatus') {
        addBlocker({
          code: 'FRONTEND_STATUS_MISMATCH',
          evidenceKey: 'SERVER_API:DB_TASK_RECORD',
          message: `前台任务表 task_status 物理状态未达到期望终态 (期望: ${String(assertion.expectedValue)}, 实际: ${String(actualValue)}) [FAIL]`,
        });
      } else if (assertion.field === 'db.billingNetPoints') {
        addBlocker({
          code: 'REFUND_AMOUNT_MISMATCH',
          evidenceKey: 'BILLING_LEDGER:DB_SCORE_LOGS',
          message: `积分流水净扣不对账 (期望: ${String(assertion.expectedValue)} pt, 实际: ${String(actualValue)} pt，可能存在退款不一致或资损风险) [FAIL]`,
        });
      }
    }

    if (!isBlocking && evalRes.status === 'FAIL') {
      warnings.push(`顾问性断言 [${assertion.field}] 失败(critical:false，不阻断): ${evalRes.reason || '未达预期'}`);
    }
  }

  // 6. 检查可选证据 (Optional Evidence) 的 FAIL 影响
  // optional Evidence FAIL 只有在关联 critical assertion 时才影响 Verdict；未关联时仅出 warning
  for (const env of validEnvelopes) {
    const isRequired = spec.requiredEvidence?.includes(env.evidenceKey);
    if (!isRequired && env.observationStatus === 'FAIL') {
      const isLinkedToCriticalAssertion = assertions.some(
        (a) => a.critical === true && a.evidenceKey === env.evidenceKey,
      );
      if (!isLinkedToCriticalAssertion) {
        warnings.push(`可选证据 [${env.evidenceKey}] 观察状态为 FAIL，但未关联关键断言，不影响最终裁决`);
      }
    }
  }

  // ==========================================================================
  // 7. 终态优先级裁决 (FAIL 优先于 UNVERIFIED)
  // ==========================================================================

  // (1) 收集结构化 Blockers
  for (const d of reqEvaluation.details) {
    if (!d.matched) {
      if (d.envelope?.collectionStatus === 'BLOCKED') {
        addBlocker({
          code: 'EVIDENCE_COLLECTION_BLOCKED',
          evidenceKey: d.key,
          message: d.reason || `证据采集被阻断 [${d.key}]`,
        });
      } else if (d.reason?.includes('REAL 模式下') || d.reason?.includes('来源不能满足')) {
        addBlocker({ code: 'UNTRUSTED_EVIDENCE_SOURCE', evidenceKey: d.key, message: d.reason });
      } else if (d.key === 'SERVER_API:DB_TASK_RECORD') {
        if (
          d.envelope?.error?.code === 'MISSING_CREDENTIALS' ||
          d.envelope?.error?.message?.includes('找不到 db-credentials')
        ) {
          addBlocker({
            code: 'DB_CREDENTIALS_MISSING',
            evidenceKey: d.key,
            message:
              d.envelope?.error?.message ||
              '缺少 db-credentials.json 数据库凭据，无法通过 SSH 隧道执行物理取证 [UNVERIFIED]',
          });
        } else if (
          d.envelope?.error?.code === 'DB_QUERY_FAILED' ||
          d.envelope?.error?.message?.includes('SSH') ||
          d.envelope?.error?.message?.includes('连接')
        ) {
          addBlocker({
            code: 'DB_CONNECTION_FAILED',
            evidenceKey: d.key,
            message: d.envelope?.error?.message || '数据库 SSH 隧道连接或只读查询失败 [UNVERIFIED]',
          });
        } else if (d.envelope?.normalizedFields?.taskFound === false) {
          addBlocker({
            code: 'FRONTEND_TASK_NOT_FOUND',
            evidenceKey: d.key,
            message:
              '前台任务源表（视频 pq_aivideo_new / 图片 goods·character·scene·fusion）中未查到物理入库记录 [FAIL]',
          });
        } else if (d.envelope?.normalizedFields?.backendTaskFound === false) {
          addBlocker({
            code: 'BACKEND_TASK_NOT_FOUND',
            evidenceKey: d.key,
            message: '后台调度表 pq_volcengine_ai_task 中未查到关联调度记录 [FAIL]',
          });
        } else {
          addBlocker({
            code: 'DB_TASK_RECORD_MISSING',
            evidenceKey: d.key,
            message: d.reason || '缺少前后台任务数据库物理落库证据 [SERVER_API:DB_TASK_RECORD]',
          });
        }
      } else if (d.key === 'BILLING_LEDGER:DB_SCORE_LOGS') {
        if (
          d.envelope?.error?.code === 'MISSING_CREDENTIALS' ||
          d.envelope?.error?.message?.includes('找不到 db-credentials')
        ) {
          addBlocker({
            code: 'DB_CREDENTIALS_MISSING',
            evidenceKey: d.key,
            message: d.envelope?.error?.message || '缺少 db-credentials.json 凭据，无法查询积分流水 [UNVERIFIED]',
          });
        } else if (d.envelope?.error?.code === 'DB_QUERY_FAILED' || d.envelope?.error?.message?.includes('SSH')) {
          addBlocker({
            code: 'DB_CONNECTION_FAILED',
            evidenceKey: d.key,
            message: d.envelope?.error?.message || '数据库连接失败，无法获取积分流水 [UNVERIFIED]',
          });
        } else {
          addBlocker({
            code: 'DB_SCORE_LOGS_MISSING',
            evidenceKey: d.key,
            message: d.reason || '数据库积分流水 pq_score_log 中未查到扣费或退款流水记录 [UNVERIFIED]',
          });
        }
      } else if (spec.executionMode === 'REAL' && d.key.includes('GATEWAY_CHANNEL')) {
        addBlocker({
          code: 'GATEWAY_CHANNEL_BLOCKED',
          evidenceKey: d.key,
          message: d.reason || `缺少 NewAPI 网关渠道凭据 [${d.key}]`,
        });
      } else if (d.key.includes('ROUTING_RECONCILIATION')) {
        addBlocker({
          code: 'ROUTING_PREDICTION_MISMATCH',
          evidenceKey: d.key,
          message:
            (typeof d.envelope?.normalizedFields?.mismatchReason === 'string'
              ? d.envelope.normalizedFields.mismatchReason
              : undefined) ||
            d.envelope?.error?.message ||
            d.reason ||
            '契约预测走网关分流但真实落库为直连，分流实际未发生，需人工确认是否为合法能力降级 [UNVERIFIED]',
        });
      } else if (
        d.key.includes('PRICING') ||
        (d.key === 'BILLING_LEDGER:TASK_RECORDS' &&
          ((spec.inputs as any)?.pricingDetermined === false ||
            (spec.metadata as any)?.allowPassPricing === false ||
            (spec.inputs as any)?.pricingAllowPass === false))
      ) {
        addBlocker({ code: 'PRICING_UNVERIFIED', evidenceKey: d.key, message: '刊例定价未核准或未确定单价' });
      } else if (d.key.includes('TASK_STATUS')) {
        addBlocker({ code: 'TASK_NOT_TERMINAL', evidenceKey: d.key, message: d.reason || '任务尚未到达终态 SUCCESS' });
      }
    }
  }

  for (const key of reqEvaluation.unverifiedEvidenceKeys) {
    if (key.includes('TASK_STATUS')) {
      addBlocker({ code: 'TASK_NOT_TERMINAL', evidenceKey: key, message: '任务尚未到达终态 SUCCESS' });
    } else if (key === 'SERVER_API:DB_TASK_RECORD') {
      addBlocker({
        code: 'DB_TASK_RECORD_MISSING',
        evidenceKey: key,
        message: '数据库前后台任务物理落库证据未确认通过 [UNVERIFIED]',
      });
    } else if (key === 'BILLING_LEDGER:DB_SCORE_LOGS') {
      addBlocker({
        code: 'DB_SCORE_LOGS_MISSING',
        evidenceKey: key,
        message: '数据库积分流水记录未确认通过 [UNVERIFIED]',
      });
    } else if (spec.executionMode === 'REAL' && key.includes('GATEWAY_CHANNEL')) {
      addBlocker({ code: 'GATEWAY_CHANNEL_BLOCKED', evidenceKey: key, message: '网关渠道证据未确认通过' });
    } else if (
      key === 'BILLING_LEDGER:TASK_RECORDS' &&
      ((spec.inputs as any)?.pricingDetermined === false ||
        (spec.metadata as any)?.allowPassPricing === false ||
        (spec.inputs as any)?.pricingAllowPass === false)
    ) {
      addBlocker({ code: 'PRICING_UNVERIFIED', evidenceKey: key, message: '刊例定价未核准或未确定单价' });
    }
  }

  for (const env of validEnvelopes) {
    if (env.collectionStatus === 'BLOCKED') {
      addBlocker({
        code: 'EVIDENCE_BLOCKED',
        evidenceKey: env.evidenceKey,
        message: env.error?.message || `证据 [${env.evidenceKey}] 处于 BLOCKED 状态`,
      });
    }
    if (
      spec.executionMode === 'REAL' &&
      env.evidenceKey.includes('GATEWAY_CHANNEL') &&
      env.observationStatus === 'UNVERIFIED'
    ) {
      addBlocker({
        code: 'GATEWAY_CHANNEL_BLOCKED',
        evidenceKey: env.evidenceKey,
        message: `网关渠道证据未确认通过: ${String(env.normalizedFields?.actualValue || 'UNVERIFIED')}`,
      });
    }
  }

  // (2) FAIL 优先级一：任一必需证据 observationStatus=FAIL
  const hasRequiredEvidenceFail = reqEvaluation.failedEvidenceKeys.length > 0;

  // (3) FAIL 优先级二：任一 critical deterministic assertion 明确失败
  const hasCriticalAssertionFail = assertionResults.some((a) => a.assertion.critical !== false && a.status === 'FAIL');

  if (hasRequiredEvidenceFail || hasCriticalAssertionFail) {
    if (hasRequiredEvidenceFail) {
      reasons.push(`必需证据观察明确失败: ${reqEvaluation.failedEvidenceKeys.join(', ')}`);
      for (const d of reqEvaluation.details) {
        if (d.reason && reqEvaluation.failedEvidenceKeys.includes(d.key)) {
          reasons.push(d.reason);
        }
      }
    }
    if (hasCriticalAssertionFail) {
      const failedCritList = assertionResults
        .filter((a) => a.assertion.critical !== false && a.status === 'FAIL')
        .map((a) => `${a.assertion.field} (${a.reason || '断言失败'})`);
      reasons.push(`关键确定性断言明确失败: ${failedCritList.join('; ')}`);
    }

    return {
      verdict: 'FAIL',
      testId: spec.testId,
      requiredEvidenceEvaluation: reqEvaluation,
      assertionResults,
      evidenceIdsUsed: Array.from(evidenceIdsUsedSet),
      reasons,
      warnings,
      blockers,
    };
  }

  // (4) UNVERIFIED 优先级一：必需证据缺失、BLOCKED、COLLECTION_FAILED 或 UNVERIFIED
  const hasMissingRequiredEvidence = reqEvaluation.missingEvidenceKeys.length > 0;
  const hasUnverifiedRequiredEvidence = reqEvaluation.unverifiedEvidenceKeys.length > 0;

  // (5) UNVERIFIED 优先级二：关键断言缺少绑定、字段缺失或无法计算
  const hasUnverifiedCriticalAssertion = assertionResults.some(
    (a) => a.assertion.critical === true && a.status === 'UNVERIFIED',
  );

  // (6) UNVERIFIED 优先级三：AI_OBSERVATION 和 USER_ASSERTION 不能单独让业务验收 PASS
  const allUsedEnvelopes = validEnvelopes.filter((e) => evidenceIdsUsedSet.has(e.evidenceId));
  const onlySubjectiveEvidence =
    allUsedEnvelopes.length > 0 &&
    allUsedEnvelopes.every((e) => e.sourceType === 'AI_OBSERVATION' || e.sourceType === 'USER_ASSERTION');

  if (
    hasMissingRequiredEvidence ||
    hasUnverifiedRequiredEvidence ||
    hasUnverifiedCriticalAssertion ||
    onlySubjectiveEvidence
  ) {
    if (hasMissingRequiredEvidence) {
      reasons.push(`必需证据缺失或采集未成功: ${reqEvaluation.missingEvidenceKeys.join(', ')}`);
    }
    if (hasUnverifiedRequiredEvidence) {
      reasons.push(`必需证据未获得明确通过事实 (UNVERIFIED): ${reqEvaluation.unverifiedEvidenceKeys.join(', ')}`);
    }
    if (hasUnverifiedCriticalAssertion) {
      const unvCritList = assertionResults
        .filter((a) => a.assertion.critical === true && a.status === 'UNVERIFIED')
        .map((a) => `${a.assertion.field} (${a.reason || '无法计算'})`);
      reasons.push(`关键断言缺少绑定或字段缺失: ${unvCritList.join('; ')}`);
    }
    if (onlySubjectiveEvidence) {
      reasons.push('AI_OBSERVATION / USER_ASSERTION 不能单独产生 PASS 最终裁决');
    }

    return {
      verdict: 'UNVERIFIED',
      testId: spec.testId,
      requiredEvidenceEvaluation: reqEvaluation,
      assertionResults,
      evidenceIdsUsed: Array.from(evidenceIdsUsedSet),
      reasons,
      warnings,
      blockers,
    };
  }

  // (7) PASS：所有必需证据 PASS 且所有关键断言 PASS
  reasons.push('全部必需证据通过且所有关键确定性断言验证成功');

  return {
    verdict: 'PASS',
    testId: spec.testId,
    requiredEvidenceEvaluation: reqEvaluation,
    assertionResults,
    evidenceIdsUsed: Array.from(evidenceIdsUsedSet),
    reasons,
    warnings,
    blockers,
  };
}
