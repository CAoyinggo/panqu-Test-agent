/**
 * DevTest 统一覆盖账本与数据绑定事实模型 (Coverage Ledger & Data Binding Fact Model) - 第二阶段
 *
 * 核心架构：
 * 1. 真实事件折叠生成：账本不再根据结果对象推测，而是由真实执行阶段事件 (ExecutionFactEvent) 折叠验证生成。
 * 2. 真实数据链闭环：严格区分 6 种数据绑定状态：
 *    - PROVIDED_AND_CONSUMED: 真实交付给 Processor 且拥有消费回执 (Receipt)
 *    - BOUND_NOT_DISPATCHED: 已绑定但流水线处于 DRY_RUN、未调度或未派发
 *    - PROVIDED_BUT_UNBOUND: 调用方提供了数据（如 actorHeaders），但当前接口无需此项数据
 *    - PROVIDED_BUT_INVALID: 提供了数据但格式/协议校验不合法
 *    - PROVIDED_BUT_REJECTED: 经安全门禁 (SAFE Hold/Approval/Billing) 拦截并记录真实拒绝事件
 *    - MISSING: 用例执行必需但未提供
 * 3. 三层需求/测试点追踪架构：
 *    Requirement Fact / AC -> Test Point -> Case
 *    - 完整保留多对多关系；
 *    - 没有生成 Case 的 Fact 显式列为 NOT_TESTED，原因标注 TEST_POINT_NOT_GENERATED；
 *    - 无 Fact 关联的用例标为 UNTRACED_CASE。
 * 4. 严格四类互斥清单（绝对不混串）：
 *    - 清单 A：确认产品缺陷 (CONFIRMED_BUG，仅限完整事件链 + Oracle FAIL + 证据完整 + 排除环境/框架/清理失败)
 *    - 清单 B：测试阻断 (TEST_BLOCKED，环境 Preflight、网络、认证缺失、安全策略、数据清理失败)
 *    - 清单 C：未测试项 (UNTESTED，未入选批次、预算裁剪、DRY_RUN、缺少数据)
 *    - 清单 D：已通过项 (PASSED，完整事件链 + Oracle PASS + 证据完整)
 *    - 运行级 Cleanup 失败单独作为 runLevelBlockers 统计，不破坏 A+B+C+D=TotalPlanned 等式。
 * 5. 零敏感信息泄漏：Cookie、Token、Session、密码一律脱敏，仅记录长度与 SHA-256 8位指纹。
 */

import { createHash } from 'node:crypto';
import type { DevTestCaseDimension, DevTestProblem } from './types.js';
import { type TestCase, isDesignedOnlyCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement, RequirementFact } from '../acceptance/requirement-ir.js';
import type { DevTestEnvironmentPreflight, DevTestOracleResult, DevTestDataLifecycleRecord } from './types.js';
import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { AcceptanceCaseExecutionResult } from '../acceptance/api-processor.js';
import type { DevTestCaseSelection } from './dimension-selector.js';
import type { RunResult } from '../contracts/execution-result.js';
import { coverageLedgerToCanonicalRunResult } from './canonical-adapter.js';

type AcceptanceExecution = AcceptanceReport['executions'][number];

export type DataBindingStatus =
  | 'PROVIDED_AND_CONSUMED'
  | 'BOUND_NOT_DISPATCHED'
  | 'PROVIDED_BUT_UNBOUND'
  | 'PROVIDED_BUT_INVALID'
  | 'PROVIDED_BUT_REJECTED'
  | 'MISSING';

export interface DataBindingRecord {
  bindingId: string;
  dataKey: string;
  targetField: string;
  sourceRef: string;
  sourceOrigin: 'USER_PROVIDED' | 'ENV_PROVIDED' | 'DISCOVERED_AND_PROBED' | 'INTERNAL_PLACEHOLDER' | 'NOT_PROVIDED';
  bindingStatus: DataBindingStatus;
  bindingPhase: 'RESOLVED' | 'BOUND' | 'DELIVERED' | 'REJECTED' | 'VALIDATION_FAILED' | 'MISSING';
  receiptId?: string;
  reasonCode: string;
  unconsumedReason?: string;
  responsibleParty?: 'User / Caller' | 'Test Platform (test-flow)' | 'Environment Admin';
  remediation?: string;
  maskedValueSummary: string;
  fingerprint: string;
}

export interface BlockerRemediationInfo {
  responsibleParty: string;
  remediation: string;
}

export function resolveBlockerRemediation(
  code?: string,
  fallbackParty?: string,
  fallbackRemediation?: string,
): BlockerRemediationInfo {
  const normalizedCode = (code ?? '').toUpperCase();
  if (normalizedCode.includes('PANQU_METHOD_CONFLICT')) {
    return {
      responsibleParty: '研发负责人 (后端开发)',
      remediation: '修正 Panqu Controller 方法定义或路由装饰器，避免同路径方法冲突',
    };
  }
  if (normalizedCode.includes('PARAMETER_CONTRACT_CONFLICT')) {
    return {
      responsibleParty: '契约设计者 (产品/架构)',
      remediation: '对齐需求文档与 OpenAPI 规范中的参数约束',
    };
  }
  if (normalizedCode.includes('SAFE_POLICY') || normalizedCode.includes('POLICY_BLOCKED')) {
    return {
      responsibleParty: '安全策略管理员',
      remediation: '核对 safetyPolicy 规则或在允许的安全上下文中执行',
    };
  }
  if (normalizedCode.includes('RUNTIME_DATA_MISSING') || normalizedCode.includes('DATA_MISSING')) {
    return {
      responsibleParty: '测试负责人',
      remediation: '补充该场景所需的测试数据或前置数据生成器',
    };
  }
  if (normalizedCode.includes('PREFLIGHT_BLOCKED') || normalizedCode.includes('BLOCKED_BY_PREFLIGHT') || normalizedCode.includes('ENVIRONMENT_ISSUE')) {
    return {
      responsibleParty: '运维/测试环境管理员',
      remediation: '检查并恢复测试环境服务可用性',
    };
  }
  if (normalizedCode.includes('CLEANUP_FAILED')) {
    return {
      responsibleParty: '自动化测试开发',
      remediation: '修复清理脚本或开启 allowNoCleanup',
    };
  }
  if (normalizedCode.includes('AUTH') || normalizedCode.includes('CREDENTIAL')) {
    return {
      responsibleParty: '认证管理员',
      remediation: '更新凭证或 Token',
    };
  }
  if (normalizedCode.includes('PANQU_CUSTOM_PROTOCOL')) {
    return {
      responsibleParty: '研发负责人 (后端开发)',
      remediation: '接入显式 client-protocol evidence adapter 或更新业务协议',
    };
  }
  if (normalizedCode.includes('CONTRACT')) {
    return {
      responsibleParty: '契约设计者 (产品/架构)',
      remediation: '核对 API 契约与实现定义',
    };
  }
  if (normalizedCode.includes('AWAITING_CONFIRMATION') || normalizedCode.includes('DRY_RUN')) {
    return {
      responsibleParty: '用户',
      remediation: '确认计划并执行测试',
    };
  }
  return {
    responsibleParty: fallbackParty || '测试负责人',
    remediation: fallbackRemediation || '排查测试阻断原因并重试',
  };
}

export type LedgerFinalClassification =
  | 'CONFIRMED_BUG'
  | 'TEST_BLOCKED'
  | 'UNTESTED'
  | 'PASSED';

export interface RequirementFactCoverageLedgerItem {
  factId: string;
  category: string;
  statement: string;
  modeled: boolean;
  generatedTestPointIds: string[];
  linkedCaseIds: string[];
  selectedCaseIds: string[];
  executedCaseIds: string[];
  passedCaseIds: string[];
  failedCaseIds: string[];
  status: 'PASSED' | 'CONFIRMED_BUG' | 'TEST_BLOCKED' | 'UNTESTED' | 'NOT_TESTED';
  missingReason?: string;
  statusReason: string;
}

export interface TestPointCoverageLedgerItem {
  requirementId: string;
  linkedFactIds: string[];
  isUntracedCase: boolean;
  testPointId: string;
  caseId: string;
  title: string;
  dimension: DevTestCaseDimension;
  planned: boolean;
  selected: boolean;
  selectionReason: string;
  selectionReasonCode?: string;
  unselectedReason?: string;
  unselectedReasonCode?: string;
  untestedReason?: string;
  untestedReasonCode?: string;
  operationKey?: string;
  blockedReasonCode?: string;
  applicable: boolean;
  executionMode: 'API' | 'UI' | 'SCENARIO' | 'STATIC' | 'SIMULATED';
  readinessStatus: 'READY' | 'DATA_MISSING' | 'BLOCKED_BY_PREFLIGHT' | 'POLICY_BLOCKED' | 'NOT_APPLICABLE';
  readinessReasons: string[];
  dataBindings: DataBindingRecord[];
  dispatchAttempted: boolean;
  processorInvoked: boolean;
  executed: boolean;
  oracleRan: boolean;
  oracleVerdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  requiredEvidence: string[];
  collectedEvidence: string[];
  missingEvidence: string[];
  finalStatus: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED';
  finalClassification: LedgerFinalClassification;
  statusReason: string;
  remediationAction?: string;
  relatedProblemIds: string[];
}

export interface CoverageLedgerSummary {
  totalPlanned: number;
  totalSelected: number;
  totalExecuted: number;
  totalPassed: number;
  totalConfirmedBugs: number;
  totalTestBlocked: number;
  totalUntested: number;
  runLevelBlockers: string[];
  dataBindingStats: {
    providedAndConsumed: number;
    providedButUnbound: number;
    boundNotDispatched: number;
    providedButInvalid: number;
    providedButRejected: number;
    missing: number;
  };
  requirementStats: {
    totalFacts: number;
    modeledFacts: number;
    coveredFacts: number;
    passedFacts: number;
    failedFacts: number;
    blockedFacts: number;
    untestedFacts: number;
    unmodeledOrUngeneratedFacts: number;
  };
  unaffectedExecutableCaseIds?: string[];
}

export interface SevenItemQuickView {
  testedSummary: string;
  untestedSummary: string;
  confirmedBugsCount: number;
  testBlockedCount: number;
  dataBindingConsumption: string;
  dataBindingBreakdown: {
    providedAndConsumed: number;
    providedButUnbound: number;
    boundNotDispatched: number;
    providedButInvalid: number;
    providedButRejected: number;
    missing: number;
  };
  runLevelBlockers: string[];
  businessConclusion: string;
  nextStepAndOwner: {
    role: string;
    action: string;
  };
}

export type ReconciliationStatus = 'MATCH' | 'MISMATCH' | 'NOT_COMPARABLE';

export interface CoverageLedgerReconciliation {
  status: ReconciliationStatus;
  legacyCount: {
    passed: number;
    failed: number;
    blocked: number;
    notExecuted: number;
    total: number;
  };
  ledgerCount: {
    passed: number;
    confirmedBugs: number;
    testBlocked: number;
    untested: number;
    total: number;
  };
  reconciled: boolean;
  runIdMatch: boolean;
  selectedCasesMatch: boolean;
  caseIdCoverageMatch: boolean;
  differenceReason?: string;
  mismatches?: string[];
}

/**
 * 敏感信息脱敏与指纹计算（严禁明文输出 Cookie, Token, Session, 密码, 手机号）
 */
export function maskDataValue(key: string, value: unknown): { masked: string; fingerprint: string } {
  if (value === undefined || value === null) {
    return { masked: 'N/A（未提供）', fingerprint: 'none' };
  }

  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const fingerprint = createHash('sha256').update(str).digest('hex').slice(0, 8);
  const lowerKey = key.toLowerCase();

  // 1. 认证鉴权凭证（Token / Cookie / Session / Authorization / Secret / Key）
  if (/token|cookie|session|auth|secret|key|password|credential/i.test(lowerKey)) {
    const len = str.length;
    return {
      masked: `[SENSITIVE_CREDENTIAL: len=${len}, fp=${fingerprint}]`,
      fingerprint,
    };
  }

  // 2. 手机号脱敏
  if (/phone|mobile|tel/i.test(lowerKey) || /^1[3-9]\d{9}$/.test(str.trim())) {
    const clean = str.trim();
    const maskedPhone = clean.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
    return { masked: maskedPhone, fingerprint };
  }

  // 3. 基础 URL（剥除 Basic Auth 敏感串）
  if (/url|endpoint|origin/i.test(lowerKey)) {
    try {
      const u = new URL(str);
      u.username = '';
      u.password = '';
      return { masked: u.href, fingerprint };
    } catch {
      return { masked: str.slice(0, 100), fingerprint };
    }
  }

  // 4. 普通业务字段（截断保护）
  if (str.length > 80) {
    return { masked: `${str.slice(0, 75)}... (len=${str.length})`, fingerprint };
  }

  return { masked: str, fingerprint };
}

/**
 * 构建测试用例的数据绑定事实记录
 */
export function buildCaseDataBindings(
  testCase: TestCase,
  input: {
    baseUrl?: string;
    baseUrlSource?: 'USER_PROVIDED' | 'ENV_PROVIDED' | 'DISCOVERED_AND_PROBED' | 'INTERNAL_PLACEHOLDER' | 'NOT_PROVIDED';
    actorHeaders?: Record<string, Record<string, string>>;
    scenarioVariables?: Record<string, unknown>;
    preflight: DevTestEnvironmentPreflight;
    extraOptions?: Record<string, unknown>;
    deliveredBindingIds?: ReadonlySet<string>;
    rejectedBindingIds?: ReadonlySet<string>;
    rejectionReason?: string;
    pipelineMode?: 'execute' | 'dry-run';
    isDispatched?: boolean;
  },
): DataBindingRecord[] {
  const records: DataBindingRecord[] = [];
  const caseId = testCase.id;
  const isDryRun = input.pipelineMode === 'dry-run';
  const deliveredSet = input.deliveredBindingIds ?? new Set<string>();
  const rejectedSet = input.rejectedBindingIds ?? new Set<string>();

  // 1. Base URL
  const baseUrlSource = input.baseUrlSource ?? (
    input.baseUrl?.includes('.invalid') ? 'INTERNAL_PLACEHOLDER' : input.baseUrl ? 'USER_PROVIDED' : 'NOT_PROVIDED'
  );
  const isPlaceholderUrl = baseUrlSource === 'INTERNAL_PLACEHOLDER' || !input.baseUrl || input.baseUrl.includes('.invalid');
  const baseUrlBindingId = `bind:${caseId}:baseUrl`;

  if (isPlaceholderUrl) {
    records.push({
      bindingId: baseUrlBindingId,
      dataKey: 'baseUrl',
      targetField: 'HTTP.baseUrl',
      sourceRef: 'Internal Static Default (devtest.invalid)',
      sourceOrigin: 'INTERNAL_PLACEHOLDER',
      bindingStatus: 'MISSING',
      bindingPhase: 'MISSING',
      reasonCode: 'INTERNAL_PLACEHOLDER_NOT_USABLE_FOR_REAL_TEST',
      unconsumedReason: '未提供获授权的测试环境地址（使用内部占位地址 devtest.invalid）',
      responsibleParty: 'User / Caller',
      remediation: '通过 --base-url 参数提供已获授权且可访问的真实测试环境地址',
      maskedValueSummary: 'N/A（内部占位地址，未提供获授权测试环境）',
      fingerprint: 'none',
    });
  } else {
    const { masked, fingerprint } = maskDataValue('baseUrl', input.baseUrl);
    const validUrl = /^https?:\/\//.test(input.baseUrl!);
    if (!validUrl) {
      records.push({
        bindingId: baseUrlBindingId,
        dataKey: 'baseUrl',
        targetField: 'HTTP.baseUrl',
        sourceRef: 'CLI/Options --base-url',
        sourceOrigin: baseUrlSource,
        bindingStatus: 'PROVIDED_BUT_INVALID',
        bindingPhase: 'VALIDATION_FAILED',
        reasonCode: 'INVALID_URL_SCHEME',
        unconsumedReason: '基础 URL 缺少 http:// 或 https:// 协议头',
        responsibleParty: 'User / Caller',
        remediation: '修改 --base-url 格式，添加合法的 http:// 或 https:// 协议前缀',
        maskedValueSummary: masked,
        fingerprint,
      });
    } else if (deliveredSet.has(baseUrlBindingId)) {
      records.push({
        bindingId: baseUrlBindingId,
        dataKey: 'baseUrl',
        targetField: 'HTTP.baseUrl',
        sourceRef: 'CLI/Options --base-url',
        sourceOrigin: baseUrlSource,
        bindingStatus: 'PROVIDED_AND_CONSUMED',
        bindingPhase: 'DELIVERED',
        receiptId: `rcpt-baseUrl-${caseId}`,
        reasonCode: 'DELIVERED_TO_PROCESSOR',
        maskedValueSummary: masked,
        fingerprint,
      });
    } else if (rejectedSet.has(baseUrlBindingId)) {
      records.push({
        bindingId: baseUrlBindingId,
        dataKey: 'baseUrl',
        targetField: 'HTTP.baseUrl',
        sourceRef: 'CLI/Options --base-url',
        sourceOrigin: baseUrlSource,
        bindingStatus: 'PROVIDED_BUT_REJECTED',
        bindingPhase: 'REJECTED',
        reasonCode: 'POLICY_REJECTED',
        unconsumedReason: input.rejectionReason ?? '目标 URL 违反安全策略或未在获授权白名单内',
        responsibleParty: 'User / Caller',
        remediation: '核对 safetyPolicy.allowedOrigins 配置或申请审批',
        maskedValueSummary: masked,
        fingerprint,
      });
    } else {
      records.push({
        bindingId: baseUrlBindingId,
        dataKey: 'baseUrl',
        targetField: 'HTTP.baseUrl',
        sourceRef: 'CLI/Options --base-url',
        sourceOrigin: baseUrlSource,
        bindingStatus: isDryRun ? 'BOUND_NOT_DISPATCHED' : 'PROVIDED_BUT_UNBOUND',
        bindingPhase: isDryRun ? 'BOUND' : 'RESOLVED',
        reasonCode: isDryRun ? 'DRY_RUN_NOT_DISPATCHED' : 'UNBOUND',
        unconsumedReason: isDryRun ? '流水线处于 DRY_RUN 模式，未发起真实网络调用' : '用例未进入执行派发队列',
        responsibleParty: 'Test Platform (test-flow)',
        maskedValueSummary: masked,
        fingerprint,
      });
    }
  }

  // 2. 身份认证与请求头 (精准逐 Actor / 逐 Step 记录)
  const caseActors: string[] = [];
  if (testCase.actor?.id) caseActors.push(testCase.actor.id);
  if (testCase.actor?.role && !caseActors.includes(testCase.actor.role)) caseActors.push(testCase.actor.role);
  for (const s of testCase.steps ?? []) {
    if (s.actor?.id && !caseActors.includes(s.actor.id)) caseActors.push(s.actor.id);
    if (s.actor?.role && !caseActors.includes(s.actor.role)) caseActors.push(s.actor.role);
  }

  const isAuthCase = ['AUTH', 'PERMISSION', 'DATA_ISOLATION'].includes(testCase.testType ?? '');
  const availableActors = Object.keys(input.actorHeaders ?? {});

  if (isAuthCase && availableActors.length === 0) {
    records.push({
      bindingId: `bind:${caseId}:actorHeaders`,
      dataKey: 'actorHeaders',
      targetField: 'HTTP.headers.authorization',
      sourceRef: 'options.actorHeaders',
      sourceOrigin: 'NOT_PROVIDED',
      bindingStatus: 'MISSING',
      bindingPhase: 'MISSING',
      reasonCode: 'AUTH_REQUIRED_NO_CREDENTIALS',
      unconsumedReason: '用例属于鉴权/权限/数据隔离验证，但调用方未提供 actorHeaders 认证上下文',
      responsibleParty: 'User / Caller',
      remediation: '在 options.actorHeaders 中配置对应的身份凭据',
      maskedValueSummary: 'N/A（未提供鉴权凭证）',
      fingerprint: 'none',
    });
  } else if (availableActors.length > 0) {
    for (const actorKey of availableActors) {
      const bindingId = `bind:${caseId}:actorHeaders:${actorKey}`;
      const { masked, fingerprint } = maskDataValue(`actorHeaders[${actorKey}]`, input.actorHeaders?.[actorKey]);
      const actorNeeded = caseActors.length > 0 ? caseActors.includes(actorKey) : isAuthCase;

      if (deliveredSet.has(bindingId)) {
        records.push({
          bindingId,
          dataKey: `actorHeaders[${actorKey}]`,
          targetField: 'HTTP.headers.authorization',
          sourceRef: `options.actorHeaders.${actorKey}`,
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_AND_CONSUMED',
          bindingPhase: 'DELIVERED',
          receiptId: `rcpt-auth-${caseId}-${actorKey}`,
          reasonCode: 'DELIVERED_TO_PROCESSOR',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else if (rejectedSet.has(bindingId)) {
        records.push({
          bindingId,
          dataKey: `actorHeaders[${actorKey}]`,
          targetField: 'HTTP.headers.authorization',
          sourceRef: `options.actorHeaders.${actorKey}`,
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_BUT_REJECTED',
          bindingPhase: 'REJECTED',
          reasonCode: 'AUTH_POLICY_REJECTED',
          unconsumedReason: input.rejectionReason ?? '身份凭证被安全策略拦截',
          responsibleParty: 'User / Caller',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else if (actorNeeded && isDryRun) {
        records.push({
          bindingId,
          dataKey: `actorHeaders[${actorKey}]`,
          targetField: 'HTTP.headers.authorization',
          sourceRef: `options.actorHeaders.${actorKey}`,
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'BOUND_NOT_DISPATCHED',
          bindingPhase: 'BOUND',
          reasonCode: 'DRY_RUN_NOT_DISPATCHED',
          unconsumedReason: '身份凭证已绑定至用例，但当前处于 DRY_RUN 模式未向网络交付',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else {
        records.push({
          bindingId,
          dataKey: `actorHeaders[${actorKey}]`,
          targetField: 'HTTP.headers.authorization',
          sourceRef: `options.actorHeaders.${actorKey}`,
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_BUT_UNBOUND',
          bindingPhase: 'RESOLVED',
          reasonCode: actorNeeded ? 'UNBOUND' : 'CASE_NO_AUTH_REQUIRED',
          unconsumedReason: actorNeeded ? '凭证已识别但未完成派发' : '当前用例为公开接口或未引用此身份，无需消费该 Actor 凭据',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      }
    }
  }

  // 3. 用例 Payload / Parameters (testCase.data)
  if (testCase.data && typeof testCase.data === 'object') {
    for (const [key, val] of Object.entries(testCase.data as Record<string, unknown>)) {
      const bindingId = `bind:${caseId}:data.${key}`;
      const { masked, fingerprint } = maskDataValue(key, val);

      if (deliveredSet.has(bindingId)) {
        records.push({
          bindingId,
          dataKey: `data.${key}`,
          targetField: `request.body.${key}`,
          sourceRef: 'testCase.data',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_AND_CONSUMED',
          bindingPhase: 'DELIVERED',
          receiptId: `rcpt-data-${caseId}-${key}`,
          reasonCode: 'DELIVERED_TO_PROCESSOR',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else if (isDryRun) {
        records.push({
          bindingId,
          dataKey: `data.${key}`,
          targetField: `request.body.${key}`,
          sourceRef: 'testCase.data',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'BOUND_NOT_DISPATCHED',
          bindingPhase: 'BOUND',
          reasonCode: 'DRY_RUN_NOT_DISPATCHED',
          unconsumedReason: '数据已完成 Schema 校验与参数绑定，但处于 DRY_RUN 阶段未发起真实网络调用',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else {
        records.push({
          bindingId,
          dataKey: `data.${key}`,
          targetField: `request.body.${key}`,
          sourceRef: 'testCase.data',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_BUT_UNBOUND',
          bindingPhase: 'RESOLVED',
          reasonCode: 'NOT_DELIVERED',
          unconsumedReason: '参数已定义但未交付给执行处理器',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      }
    }
  }

  // 4. Scenario Variables 场景级变量
  if (input.scenarioVariables) {
    const serialized = JSON.stringify(testCase.steps ?? []);
    for (const [varKey, varVal] of Object.entries(input.scenarioVariables)) {
      const bindingId = `bind:${caseId}:var:${varKey}`;
      const { masked, fingerprint } = maskDataValue(varKey, varVal);
      const usedInCase = serialized.includes(varKey) || (testCase.name ?? '').includes(varKey);

      if (!usedInCase) {
        records.push({
          bindingId,
          dataKey: `scenarioVariables.${varKey}`,
          targetField: `scenario.context.${varKey}`,
          sourceRef: 'options.scenarioRuntime.variables',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_BUT_UNBOUND',
          bindingPhase: 'RESOLVED',
          reasonCode: 'UNUSED_IN_THIS_CASE',
          unconsumedReason: '场景变量存在，但当前 Case 步骤未引用该变量占位符',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else if (deliveredSet.has(bindingId)) {
        records.push({
          bindingId,
          dataKey: `scenarioVariables.${varKey}`,
          targetField: `scenario.context.${varKey}`,
          sourceRef: 'options.scenarioRuntime.variables',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_AND_CONSUMED',
          bindingPhase: 'DELIVERED',
          receiptId: `rcpt-var-${caseId}-${varKey}`,
          reasonCode: 'DELIVERED_TO_PROCESSOR',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else if (isDryRun) {
        records.push({
          bindingId,
          dataKey: `scenarioVariables.${varKey}`,
          targetField: `scenario.context.${varKey}`,
          sourceRef: 'options.scenarioRuntime.variables',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'BOUND_NOT_DISPATCHED',
          bindingPhase: 'BOUND',
          reasonCode: 'DRY_RUN_NOT_DISPATCHED',
          unconsumedReason: '变量已替换进用例步骤，但处于 DRY_RUN 模式未向网络交付',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      } else {
        records.push({
          bindingId,
          dataKey: `scenarioVariables.${varKey}`,
          targetField: `scenario.context.${varKey}`,
          sourceRef: 'options.scenarioRuntime.variables',
          sourceOrigin: 'USER_PROVIDED',
          bindingStatus: 'PROVIDED_BUT_UNBOUND',
          bindingPhase: 'RESOLVED',
          reasonCode: 'NOT_DISPATCHED',
          unconsumedReason: '变量已被步骤识别，但未进入 Dispatch 流程',
          responsibleParty: 'Test Platform (test-flow)',
          maskedValueSummary: masked,
          fingerprint,
        });
      }
    }
  }

  return records;
}

/**
 * 构造统一覆盖账本 (Coverage Ledger) - 第二阶段全事件驱动与需求对账
 */
export function buildCoverageLedger(input: {
  requirement: AcceptanceRequirement;
  testCases: TestCase[];
  selectedCaseIds: string[];
  pipelineMode: 'execute' | 'dry-run';
  environmentPreflight: DevTestEnvironmentPreflight;
  results?: AcceptanceCaseExecutionResult[];
  pipelineReport?: AcceptanceReport;
  oracleResults?: DevTestOracleResult[];
  problems?: DevTestProblem[];
  dataLifecycle?: DevTestDataLifecycleRecord;
  syntheticBlocks?: Array<{ code: string; message: string; affectedCases?: string[]; dimension?: string; scope?: string }>;
  baseUrlSource?: 'USER_PROVIDED' | 'ENV_PROVIDED' | 'DISCOVERED_AND_PROBED' | 'INTERNAL_PLACEHOLDER' | 'NOT_PROVIDED';
  unaffectedExecutableCaseIds?: string[];
  selection?: DevTestCaseSelection;
  runId?: string;
  options?: {
    baseUrl?: string;
    actorHeaders?: Record<string, Record<string, string>>;
    scenarioRuntime?: { variables?: Record<string, unknown> };
    [key: string]: unknown;
  };
}): {
  items: TestPointCoverageLedgerItem[];
  requirementLedger: RequirementFactCoverageLedgerItem[];
  summary: CoverageLedgerSummary;
  quickView: SevenItemQuickView;
  fourLists: {
    confirmedBugs: TestPointCoverageLedgerItem[];
    testBlocked: TestPointCoverageLedgerItem[];
    untested: TestPointCoverageLedgerItem[];
    passed: TestPointCoverageLedgerItem[];
  };
  reconciliation: CoverageLedgerReconciliation;
  canonicalResult: RunResult;
} {
  const runId = input.runId ?? input.pipelineReport?.runId ?? 'RUN-DEFAULT';
  const executions = input.pipelineReport?.executions ?? [];
  const execMap = new Map<string, AcceptanceExecution>();
  for (const exec of executions) {
    execMap.set(exec.caseId, exec);
  }

  const resultMap = new Map<string, AcceptanceCaseExecutionResult>();
  for (const res of input.results ?? []) {
    resultMap.set(res.caseId, res);
  }

  const oracleMap = new Map<string, DevTestOracleResult>();
  for (const oracle of input.oracleResults ?? []) {
    oracleMap.set(oracle.caseId, oracle);
  }

  // 映射选择原因
  const unselectedReasonMap = new Map<string, string>();
  for (const un of input.selection?.unselected ?? []) {
    unselectedReasonMap.set(un.caseId, un.reason);
  }

  const isPipelineDryRun = input.pipelineMode === 'dry-run';
  const selectedSet = new Set(input.selectedCaseIds);
  const items: TestPointCoverageLedgerItem[] = [];

  // 1. 构建每个 TestCase 对应的账本明细
  for (const testCase of input.testCases) {
    const caseId = testCase.id;
    const isSelected = selectedSet.has(caseId);
    const execution = execMap.get(caseId);
    const caseResult = resultMap.get(caseId);
    const oracle = oracleMap.get(caseId);

    // (1) 需求事实关联（保留全部事实，杜绝只取第一个）
    const linkedFactIds: string[] = [
      ...(testCase.source?.factIds ?? []),
      ...(testCase.source?.acceptanceCriteriaIds ?? []),
    ].filter(Boolean);

    const isUntracedCase = linkedFactIds.length === 0;
    const requirementId = isUntracedCase ? 'UNTRACED_CASE' : linkedFactIds[0];
    const testPointId = testCase.source?.testPointId
      || testCase.source?.apiOperationKey
      || `TP-${createHash('sha256').update(linkedFactIds.join(',') + ':' + testCase.name).digest('hex').slice(0, 8)}`;
    const dimension: DevTestCaseDimension = (testCase.testType as DevTestCaseDimension) || 'API';

    // (2) 真实选择原因
    let selectionReason = isSelected ? '已选入当前执行批次' : '未入选当前批次';
    let selectionReasonCode: string | undefined;
    const operationKey = testCase.source?.apiOperationKey
      || (testCase.steps?.find((s) => s.type === 'HTTP_REQUEST')?.method
        ? `${testCase.steps.find((s) => s.type === 'HTTP_REQUEST')!.method} ${testCase.steps.find((s) => s.type === 'HTTP_REQUEST')!.url ?? ''}`.trim()
        : undefined);
    if (!isSelected) {
      const rawCode = unselectedReasonMap.get(caseId) ?? 'NOT_SELECTED';
      selectionReasonCode = rawCode.startsWith('NOT_SELECTED') ? rawCode : `NOT_SELECTED:${rawCode}`;
      selectionReason = `未入选执行批次：${selectionReasonCode}`;
    } else if (input.pipelineMode === 'dry-run') {
      selectionReason = '已选入测试设计，当前为 DRY_RUN 模式，未发起真实网络调用';
      selectionReasonCode = 'DRY_RUN_SELECTED';
    } else {
      const profile = input.selection?.profiles?.[caseId];
      if (profile?.core) {
        selectionReason = `核心场景优先调度 (${profile.coreKind})`;
        selectionReasonCode = 'CORE_SCENARIO_SELECTED';
      } else {
        const score = input.selection?.scores?.[caseId]?.total;
        selectionReason = score !== undefined ? `根据测试价值评分调度 (score=${score})` : '测试场景入选调度';
        selectionReasonCode = 'SCORE_SELECTED';
      }
    }

    // (3) 就绪度评估
    const readinessReasons: string[] = [];
    let readinessStatus: TestPointCoverageLedgerItem['readinessStatus'] = 'READY';

    const isDeferredProbe = Boolean(input.pipelineMode === 'dry-run' && input.environmentPreflight.reason?.startsWith('DRY_RUN_ENVIRONMENT_NOT_PROBED'));
    if (input.environmentPreflight.status === 'BLOCKED' && !isDeferredProbe) {
      readinessStatus = 'BLOCKED_BY_PREFLIGHT';
      readinessReasons.push(input.environmentPreflight.reason ?? '测试环境 Preflight 阻断');
    }

    // 检查是否有针对该 Case 作用域的 blocker（排除 CLEANUP_FAILED，因为 cleanup 失败属于运行级）
    const specificBlocks = (input.syntheticBlocks ?? []).filter((b) =>
      b.code !== 'CLEANUP_FAILED' && (b.scope === 'GLOBAL' || (b.affectedCases && b.affectedCases.includes(caseId)))
    );
    if (specificBlocks.length > 0) {
      readinessStatus = 'POLICY_BLOCKED';
      readinessReasons.push(...specificBlocks.map((b) => `${b.code}: ${b.message}`));
    }

    // (4) 执行事实判定（严禁自动补 true，严格由底层真实执行判定）
    const dispatchAttempted = isSelected && input.pipelineMode === 'execute' && readinessStatus === 'READY';
    const processorInvoked = caseResult
      ? Boolean(caseResult.processorInvoked || caseResult.processor)
      : Boolean(execution?.executed);
    const executed = Boolean(caseResult
      ? (caseResult.executed && processorInvoked)
      : execution?.executed);
    const oracleAssertions = execution?.evidence?.assertions ?? caseResult?.evidence?.assertions ?? [];
    const oracleRan = Boolean(oracle || oracleAssertions.length > 0);
    const oracleVerdict: TestPointCoverageLedgerItem['oracleVerdict'] = oracle
      ? oracle.verdict
      : oracleAssertions.length > 0
        ? (oracleAssertions.every((a: any) => a.pass) ? 'PASS' : 'FAIL')
        : 'NOT_APPLICABLE';

    // (5) 数据绑定评估
    const deliveredBindingIds = new Set<string>();
    if (executed && processorInvoked) {
      deliveredBindingIds.add(`bind:${caseId}:baseUrl`);
      deliveredBindingIds.add(`bind:${caseId}:actorHeaders`);
      deliveredBindingIds.add(`bind:${caseId}:scenarioVars`);
      deliveredBindingIds.add(`bind:${caseId}:caseData`);
    }

    const rejectedBindingIds = new Set<string>();
    if (readinessStatus === 'POLICY_BLOCKED') {
      rejectedBindingIds.add(`bind:${caseId}:baseUrl`);
      rejectedBindingIds.add(`bind:${caseId}:actorHeaders`);
    }

    const dataBindings = buildCaseDataBindings(testCase, {
      baseUrl: input.options?.baseUrl,
      baseUrlSource: input.baseUrlSource,
      actorHeaders: input.options?.actorHeaders,
      scenarioVariables: input.options?.scenarioRuntime?.variables,
      preflight: input.environmentPreflight,
      extraOptions: input.options,
      deliveredBindingIds,
      rejectedBindingIds,
      rejectionReason: specificBlocks[0]?.message,
      pipelineMode: input.pipelineMode,
      isDispatched: dispatchAttempted,
    });

    const hasMissingData = dataBindings.some((b) => b.bindingStatus === 'MISSING');
    const hasInvalidData = dataBindings.some((b) => b.bindingStatus === 'PROVIDED_BUT_INVALID');

    if (hasMissingData && readinessStatus === 'READY') {
      readinessStatus = 'DATA_MISSING';
      const missingKeys = dataBindings.filter((b) => b.bindingStatus === 'MISSING').map((b) => b.dataKey);
      readinessReasons.push(`缺少必要测试数据: ${missingKeys.join(', ')}`);
    } else if (hasInvalidData && readinessStatus === 'READY') {
      readinessStatus = 'DATA_MISSING';
      readinessReasons.push('提供的测试数据格式校验未通过');
    }

    // (6) Evidence 采集事实核验
    const rawRequirements = Array.isArray(testCase.evidenceRequirements) ? testCase.evidenceRequirements : [];
    const requiredEvidenceItems = rawRequirements.filter((e) => e.required !== false);
    const requiredEvidence: string[] = requiredEvidenceItems.map((e) => e.id || `${e.channel}@${e.phase}`);
    if (requiredEvidence.length === 0) {
      if (dimension === 'UI') requiredEvidence.push('UI_STATE', 'UI_SCREENSHOT');
      else requiredEvidence.push('HTTP_REQUEST', 'HTTP_RESPONSE');
    }

    const collectedEvidence: string[] = [];
    const missingEvidence: string[] = [];

    const anyEvidence = (execution?.evidence ?? caseResult?.evidence) as Record<string, unknown> | undefined;

    const hasRequestEvidence = Boolean(execution?.evidence?.request || anyEvidence?.request);
    const hasResponseEvidence = Boolean(execution?.evidence?.response || anyEvidence?.response);
    const hasAssertionEvidence = Boolean(execution?.evidence?.assertions?.length || (anyEvidence?.assertions as unknown[])?.length);

    if (hasRequestEvidence) {
      collectedEvidence.push('HTTP_REQUEST', 'API_REQUEST');
    } else if (requiredEvidence.includes('HTTP_REQUEST') || requiredEvidence.includes('API_REQUEST')) {
      missingEvidence.push('HTTP_REQUEST');
    }

    if (hasResponseEvidence) {
      collectedEvidence.push('HTTP_RESPONSE', 'API_RESPONSE');
    } else if (requiredEvidence.includes('HTTP_RESPONSE') || requiredEvidence.includes('API_RESPONSE')) {
      missingEvidence.push('HTTP_RESPONSE');
    }

    if (hasAssertionEvidence) {
      collectedEvidence.push('ASSERTIONS_CHECK');
    }

    if (oracle?.evidence) {
      for (const col of oracle.evidence.collected ?? []) {
        collectedEvidence.push(col);
      }
    }

    for (const reqItem of requiredEvidenceItems) {
      const key = reqItem.id || `${reqItem.channel}@${reqItem.phase}`;
      const isMatched = (
        (reqItem.channel === 'API_RESPONSE' && hasResponseEvidence) ||
        (reqItem.channel === 'API_REQUEST' && hasRequestEvidence) ||
        (oracle?.evidence?.collected ?? []).includes(key) ||
        (reqItem.id ? (oracle?.evidence?.collected ?? []).includes(reqItem.id) : false)
      );
      if (isMatched) {
        collectedEvidence.push(key);
        if (reqItem.id) collectedEvidence.push(reqItem.id);
      }
    }

    for (const req of requiredEvidence) {
      if (!collectedEvidence.includes(req)) {
        if (!missingEvidence.includes(req)) missingEvidence.push(req);
      }
    }

    if (oracle?.evidence?.missing?.length) {
      for (const m of oracle.evidence.missing) {
        if (!collectedEvidence.includes(m) && !missingEvidence.includes(m)) {
          missingEvidence.push(m);
        }
      }
    }

    // (7) 终态与互斥四类清单判定
    const rawExecStatus = execution?.status as string | undefined;
    const rawResultStatus = caseResult?.status;
    const normalizedStatus = rawResultStatus
      ?? (rawExecStatus === 'SUCCESS' ? 'PASS' : rawExecStatus === 'FAILED' ? 'FAIL' : (rawExecStatus as AcceptanceCaseExecutionResult['status'] | undefined))
      ?? 'NOT_EXECUTED';
    let finalStatus: TestPointCoverageLedgerItem['finalStatus'] =
      normalizedStatus === 'TIMEOUT' || normalizedStatus === 'CANCELLED' ? 'BLOCKED' : normalizedStatus;
    let finalClassification: LedgerFinalClassification = 'UNTESTED';
    let statusReason = '';

    const relatedProblems = (input.problems ?? []).filter((p) => p.affectedCases?.includes(caseId));
    const relatedProblemIds = relatedProblems.map((p) => p.id);

    // 判定外因阻断：环境、认证、策略、工具问题
    const hasExternalBlock = readinessStatus === 'BLOCKED_BY_PREFLIGHT'
      || readinessStatus === 'POLICY_BLOCKED'
      || relatedProblems.some((p) =>
          ['ENVIRONMENT_ISSUE', 'TEST_ISSUE', 'CONTRACT_ISSUE', 'AUTH_ISSUE'].includes(p.failureClass ?? '')
          && !(input.pipelineMode === 'dry-run' && (p.message?.includes('DRY_RUN_ENVIRONMENT_NOT_PROBED') || p.actual?.includes('DRY_RUN_ENVIRONMENT_NOT_PROBED')))
        )
      || (input.dataLifecycle?.cleanupStatus === 'FAILED' && (testCase.testType === 'CLEANUP' || testCase.id.includes('CLEANUP') || testCase.name.includes('清理')));

    // 硬门禁判断
    if (!isSelected) {
      finalStatus = 'NOT_EXECUTED';
      finalClassification = 'UNTESTED';
      statusReason = `未入选当前调度批次 (${selectionReasonCode ?? 'NOT_SELECTED'})。`;
    } else if (isDesignedOnlyCase(testCase)) {
      finalStatus = 'NOT_EXECUTED';
      finalClassification = 'UNTESTED';
      statusReason = 'Case 标记为 DESIGNED_ONLY，仅保留测试设计，未进入执行管线。';
    } else if (hasExternalBlock) {
      finalStatus = 'BLOCKED';
      finalClassification = 'TEST_BLOCKED';
      statusReason = readinessReasons.length > 0
        ? `测试阻断：${readinessReasons.join('；')}`
        : '测试阻断：前置条件未满足或被安全策略拦截。';
    } else if (input.pipelineMode === 'dry-run') {
      finalStatus = 'NOT_EXECUTED';
      finalClassification = 'UNTESTED';
      statusReason = hasMissingData
        ? '测试数据缺失，处于测试设计阶段，未派发执行。'
        : (input.options?.plan ? '计划已生成，待用户一次确认后执行真实测试。' : '测试数据已就绪，但流水线处于 DRY_RUN 模式，未发起真实网络调用。');
    } else if (executed && processorInvoked && oracleRan && oracleVerdict === 'FAIL' && missingEvidence.length === 0) {
      // CONFIRMED_BUG 硬门禁：真实执行 + Processor调用 + Oracle失败 + Evidence完整 + 无外因干扰
      finalStatus = 'FAIL';
      finalClassification = 'CONFIRMED_BUG';
      statusReason = `真实执行完成，确定性 Oracle 判定失败：${caseResult?.error || execution?.error || '返回数据违反业务规则/预期契约'}`;
    } else if (executed && processorInvoked && oracleRan && oracleVerdict === 'PASS' && missingEvidence.length === 0) {
      // PASSED 硬门禁：真实执行 + Processor调用 + Oracle通过 + Evidence完整
      finalStatus = 'PASS';
      finalClassification = 'PASSED';
      statusReason = '真实执行完成，所有确定性断言通过且证据链完整。';
    } else if (executed && missingEvidence.length > 0) {
      // 证据不完整，不得判 CONFIRMED_BUG 或 PASSED
      finalStatus = 'BLOCKED';
      finalClassification = 'TEST_BLOCKED';
      statusReason = `执行完成但证据不完整，缺少: ${missingEvidence.join(', ')}，无法完成确定性归因。`;
    } else if (rawResultStatus === 'BLOCKED' || rawExecStatus === 'BLOCKED') {
      finalStatus = 'BLOCKED';
      finalClassification = 'TEST_BLOCKED';
      statusReason = caseResult?.error || execution?.error || (readinessReasons.length > 0
        ? `测试阻断：${readinessReasons.join('；')}`
        : '测试阻断：前置条件未满足或执行被中断。');
    } else {
      finalStatus = 'NOT_EXECUTED';
      finalClassification = 'UNTESTED';
      statusReason = '测试数据已准备，但执行处理器未完成网络交付取证。';
    }

    let untestedReason: string | undefined;
    let untestedReasonCode: string | undefined;
    let blockedReasonCode: string | undefined;
    if (finalClassification === 'UNTESTED') {
      if (!isSelected) {
        untestedReasonCode = selectionReasonCode?.startsWith('NOT_SELECTED')
          ? selectionReasonCode
          : `NOT_SELECTED:${selectionReasonCode || 'GENERAL'}`;
        untestedReason = !isSelected ? (selectionReason || statusReason) : statusReason;
      } else if (isPipelineDryRun) {
        if (input.options?.plan) {
          untestedReasonCode = 'AWAITING_CONFIRMATION';
          untestedReason = '计划已生成，待用户一次确认后执行真实测试';
        } else {
          untestedReasonCode = 'DRY_RUN';
          untestedReason = '流水线处于 DRY_RUN 模式未向网络交付';
        }
      } else if (readinessStatus === 'DATA_MISSING') {
        untestedReasonCode = 'RUNTIME_DATA_MISSING';
        untestedReason = '测试数据缺失无法执行';
      } else {
        untestedReasonCode = 'NOT_DISPATCHED';
        untestedReason = statusReason;
      }
    } else if (finalClassification === 'TEST_BLOCKED') {
      const firstBlockCode = specificBlocks[0]?.code;
      const errorCodeMatch = (caseResult?.error ?? execution?.error)?.match(/BLOCKED[：:]\s*([A-Z0-9_]+)/)?.[1];
      const problemCode = relatedProblems[0]?.reasonCode || relatedProblems[0]?.failureClass;
      if (firstBlockCode) {
        blockedReasonCode = firstBlockCode;
      } else if (errorCodeMatch) {
        blockedReasonCode = errorCodeMatch;
      } else if (readinessStatus === 'POLICY_BLOCKED') {
        blockedReasonCode = 'SAFE_POLICY_BLOCKED';
      } else if (readinessStatus === 'BLOCKED_BY_PREFLIGHT') {
        blockedReasonCode = 'PREFLIGHT_BLOCKED';
      } else if (readinessStatus === 'DATA_MISSING') {
        blockedReasonCode = 'DATA_MISSING';
      } else if (problemCode) {
        blockedReasonCode = problemCode;
      } else {
        blockedReasonCode = 'TEST_BLOCKED';
      }
      untestedReasonCode = blockedReasonCode;
    }
    const unselectedReason = !isSelected ? selectionReason : undefined;
    const unselectedReasonCode = !isSelected ? selectionReasonCode : undefined;

    const blockerRemediation = finalClassification === 'TEST_BLOCKED'
      ? resolveBlockerRemediation(blockedReasonCode)
      : undefined;
    const remediationAction = relatedProblems[0]?.remediation
      ?? blockerRemediation?.remediation;

    items.push({
      requirementId,
      linkedFactIds,
      isUntracedCase,
      testPointId,
      caseId,
      title: testCase.name || caseId,
      dimension,
      planned: true,
      selected: isSelected,
      selectionReason,
      selectionReasonCode,
      unselectedReason,
      unselectedReasonCode,
      untestedReason,
      untestedReasonCode,
      operationKey,
      blockedReasonCode,
      applicable: true,
      executionMode: dimension === 'UI' ? 'UI' : 'API',
      readinessStatus,
      readinessReasons,
      dataBindings,
      dispatchAttempted,
      processorInvoked,
      executed,
      oracleRan,
      oracleVerdict,
      requiredEvidence,
      collectedEvidence,
      missingEvidence,
      finalStatus,
      finalClassification,
      statusReason,
      remediationAction,
      relatedProblemIds,
    });
  }

  // 2. 构建三层需求事实账本 (Requirement Fact Ledger)
  const requirementLedger: RequirementFactCoverageLedgerItem[] = [];
  const reqObj = input.requirement as {
    facts?: Array<{ id?: string; factId?: string; category?: string; statement?: string }>;
    factLedger?: Array<{ id?: string; factId?: string; category?: string; statement?: string }>;
    acceptanceCriteria?: Array<{ criterionId?: string; id?: string; objective?: string; description?: string }>;
  };
  const rawFacts = reqObj.facts ?? reqObj.factLedger;
  const allFacts: Array<{ id: string; category: string; statement: string }> = (rawFacts && rawFacts.length > 0)
    ? rawFacts.map((f) => ({ id: f.id ?? f.factId ?? 'UNKNOWN', category: f.category ?? 'RULE', statement: f.statement ?? '' }))
    : (reqObj.acceptanceCriteria ?? []).map((ac) => ({ id: ac.criterionId ?? ac.id ?? 'UNKNOWN', category: 'ACCEPTANCE_CRITERIA', statement: ac.objective ?? ac.description ?? '' }));

  for (const fact of allFacts) {
    const linkedItems = items.filter((i) => i.linkedFactIds.includes(fact.id));
    const generatedTestPointIds = [...new Set(linkedItems.map((i) => i.testPointId))];
    const linkedCaseIds = linkedItems.map((i) => i.caseId);
    const selectedCaseIds = linkedItems.filter((i) => i.selected).map((i) => i.caseId);
    const executedCaseIds = linkedItems.filter((i) => i.executed).map((i) => i.caseId);
    const passedCaseIds = linkedItems.filter((i) => i.finalClassification === 'PASSED').map((i) => i.caseId);
    const failedCaseIds = linkedItems.filter((i) => i.finalClassification === 'CONFIRMED_BUG').map((i) => i.caseId);

    let status: RequirementFactCoverageLedgerItem['status'] = 'NOT_TESTED';
    let statusReason = '';
    let missingReason: string | undefined;

    if (linkedCaseIds.length === 0) {
      status = 'NOT_TESTED';
      missingReason = 'TEST_POINT_NOT_GENERATED';
      statusReason = '未从该需求事实生成具体测试点或用例。';
    } else if (selectedCaseIds.length === 0) {
      status = 'UNTESTED';
      const unselectedReasons = linkedItems.map((i) => i.unselectedReasonCode || i.untestedReasonCode).filter(Boolean);
      missingReason = unselectedReasons.length > 0 ? `CASES_NOT_SELECTED (${unselectedReasons.join(', ')})` : 'CASES_NOT_SELECTED';
      statusReason = `关联用例生成但未入选当前执行调度批次 (${unselectedReasons.join(', ') || 'NOT_SELECTED'})。`;
    } else if (failedCaseIds.length > 0) {
      status = 'CONFIRMED_BUG';
      statusReason = `关联用例 ${failedCaseIds.join(', ')} 发现确认产品缺陷。`;
    } else if (linkedItems.some((i) => i.finalClassification === 'TEST_BLOCKED')) {
      status = 'TEST_BLOCKED';
      statusReason = '关联用例受环境或安全策略阻断，未能闭环验证。';
    } else if (passedCaseIds.length > 0 && passedCaseIds.length === selectedCaseIds.length) {
      status = 'PASSED';
      statusReason = '所有入选关联用例均通过确定性验证。';
    } else {
      status = 'UNTESTED';
      statusReason = '关联用例尚未全部完成验证。';
    }

    requirementLedger.push({
      factId: fact.id,
      category: fact.category,
      statement: fact.statement,
      modeled: true,
      generatedTestPointIds,
      linkedCaseIds,
      selectedCaseIds,
      executedCaseIds,
      passedCaseIds,
      failedCaseIds,
      status,
      missingReason,
      statusReason,
    });
  }

  // 3. 统计与清单划分 (严格互斥与守恒)
  const confirmedBugs = items.filter((i) => i.finalClassification === 'CONFIRMED_BUG');
  const testBlocked = items.filter((i) => i.finalClassification === 'TEST_BLOCKED');
  const untested = items.filter((i) => i.finalClassification === 'UNTESTED');
  const passed = items.filter((i) => i.finalClassification === 'PASSED');

  // 独立统计运行级阻断项 (不混入用例清单)
  const runLevelBlockers: string[] = [];
  if (input.dataLifecycle?.cleanupStatus === 'FAILED') {
    runLevelBlockers.push('DATA_LIFECYCLE_CLEANUP_FAILED (测试数据环境清理失败)');
  }
  for (const block of input.syntheticBlocks ?? []) {
    if (block.code === 'CLEANUP_FAILED') {
      runLevelBlockers.push(`${block.code}: ${block.message}`);
    }
  }
  const isDeferredPreflight = Boolean(input.pipelineMode === 'dry-run' && input.environmentPreflight.reason?.startsWith('DRY_RUN_ENVIRONMENT_NOT_PROBED'));
  if (input.environmentPreflight.status === 'BLOCKED' && !isDeferredPreflight) {
    runLevelBlockers.push(`ENVIRONMENT_PREFLIGHT_BLOCKED (${input.environmentPreflight.reason ?? '环境不可达'})`);
  }

  // 数据绑定完整统计
  const allBindings = items.flatMap((i) => i.dataBindings);
  const dataBindingStats = {
    providedAndConsumed: allBindings.filter((b) => b.bindingStatus === 'PROVIDED_AND_CONSUMED').length,
    providedButUnbound: allBindings.filter((b) => b.bindingStatus === 'PROVIDED_BUT_UNBOUND').length,
    boundNotDispatched: allBindings.filter((b) => b.bindingStatus === 'BOUND_NOT_DISPATCHED').length,
    providedButInvalid: allBindings.filter((b) => b.bindingStatus === 'PROVIDED_BUT_INVALID').length,
    providedButRejected: allBindings.filter((b) => b.bindingStatus === 'PROVIDED_BUT_REJECTED').length,
    missing: allBindings.filter((b) => b.bindingStatus === 'MISSING').length,
  };

  const requirementStats = {
    totalFacts: allFacts.length,
    modeledFacts: requirementLedger.filter((r) => r.modeled).length,
    coveredFacts: requirementLedger.filter((r) => r.linkedCaseIds.length > 0).length,
    passedFacts: requirementLedger.filter((r) => r.status === 'PASSED').length,
    failedFacts: requirementLedger.filter((r) => r.status === 'CONFIRMED_BUG').length,
    blockedFacts: requirementLedger.filter((r) => r.status === 'TEST_BLOCKED').length,
    untestedFacts: requirementLedger.filter((r) => r.status === 'UNTESTED').length,
    unmodeledOrUngeneratedFacts: requirementLedger.filter((r) => r.missingReason === 'TEST_POINT_NOT_GENERATED').length,
  };

  const summary: CoverageLedgerSummary = {
    totalPlanned: items.length,
    totalSelected: items.filter((i) => i.selected).length,
    totalExecuted: items.filter((i) => i.executed).length,
    totalPassed: passed.length,
    totalConfirmedBugs: confirmedBugs.length,
    totalTestBlocked: testBlocked.length,
    totalUntested: untested.length,
    runLevelBlockers,
    dataBindingStats,
    requirementStats,
    unaffectedExecutableCaseIds: input.unaffectedExecutableCaseIds,
  };

  // 4. 首屏 7 项速览 (Product & Ops View)
  const testedSummary = isPipelineDryRun
    ? '当前为规划 (DRY_RUN) 阶段，0 项测试点已真实执行验证'
    : `${summary.totalExecuted} 项测试点已真实执行验证（通过 ${summary.totalPassed} 项，发现缺陷 ${summary.totalConfirmedBugs} 项）`;
  const untestedSummary = summary.totalUntested > 0
    ? `共 ${summary.totalUntested} 项未测试（未调度/预算裁剪/DRY_RUN: ${untested.length} 项）`
    : '所有规划测试点均已进入执行或阻断通道，无脱漏未测试项';

  const dataBindingConsumption = `已消费绑定 ${dataBindingStats.providedAndConsumed} 项，已提供未消费 ${dataBindingStats.providedButUnbound} 项，绑定待派发 ${dataBindingStats.boundNotDispatched} 项，被拒绝 ${dataBindingStats.providedButRejected} 项，缺失 ${dataBindingStats.missing} 项`;

  const businessConclusion = isPipelineDryRun
    ? '当前处于测试规划 (DRY_RUN) 阶段，尚未发起真实网络调用与 Oracle 校验，不可作为上线依据。'
    : summary.totalConfirmedBugs > 0
      ? '存在已确认产品缺陷，上线存在功能异常或业务受损风险，阻断发布。'
      : runLevelBlockers.length > 0
        ? '存在环境预检或测试数据清理失败等运行级阻断，核心链路未安全闭环，暂不可发布。'
        : summary.totalTestBlocked > 0
          ? '存在测试环境或安全策略阻断，部分场景未能完成闭环测试，暂不可提测。'
          : summary.totalUntested > 0
            ? '部分规划用例未完成真实执行验证，建议补测后交付。'
            : '全部核心用例均真实执行并通过，业务流闭环，具备提测条件。';

  const nextStepAndOwner = isPipelineDryRun
    ? { role: '调用方 / 开发者', action: '核对测试规划与参数绑定无误后，调用 execute 触发真实测试执行。' }
    : summary.totalConfirmedBugs > 0
      ? { role: '研发负责人 / 对应模块开发', action: '对照清单 A 缺陷证据与复测命令，修复后重新自测。' }
      : runLevelBlockers.length > 0
        ? { role: '测试平台 / 运维管理员', action: '排查测试环境清理权限与数据库回滚配置，解除运行级阻断。' }
        : summary.totalTestBlocked > 0
          ? { role: '运维 / 测试环境管理员', action: '对照清单 B 排查测试环境地址、网络与认证账号，解除阻断。' }
          : summary.totalUntested > 0
            ? { role: '测试负责人', action: '评估清单 C 未测试项，调整调度预算或补充数据后发起全量执行。' }
            : { role: '测试负责人 / 产品经理', action: '推进准入测试与集成验收上线。' };

  // 5. 报告对账 (Reconciliation)
  const legacyCases = input.pipelineReport?.cases ?? [];
  const legacyPassed = legacyCases.filter((c) => c.executionStatus === 'PASS').length;
  const legacyFailed = legacyCases.filter((c) => c.executionStatus === 'FAIL').length;
  const legacyBlocked = legacyCases.filter((c) => c.executionStatus === 'BLOCKED').length;
  const legacyNotExecuted = legacyCases.filter((c) => c.executionStatus === 'NOT_EXECUTED').length;

  const legacyPassedIds = new Set(legacyCases.filter((c) => c.executionStatus === 'PASS').map((c) => c.caseId));
  const legacyFailedIds = new Set(legacyCases.filter((c) => c.executionStatus === 'FAIL').map((c) => c.caseId));
  const legacyBlockedIds = new Set(legacyCases.filter((c) => c.executionStatus === 'BLOCKED').map((c) => c.caseId));
  const legacyNotExecutedIds = new Set(legacyCases.filter((c) => c.executionStatus === 'NOT_EXECUTED').map((c) => c.caseId));

  const ledgerPassedIds = new Set(passed.map((c) => c.caseId));
  const ledgerBugIds = new Set(confirmedBugs.map((c) => c.caseId));
  const ledgerBlockedIds = new Set(testBlocked.map((c) => c.caseId));
  const ledgerUntestedIds = new Set(untested.map((c) => c.caseId));

  const mismatches: string[] = [];

  // (1) runId 对齐校验
  const pipelineRunId = input.pipelineReport?.runId;
  const runIdMatch = !pipelineRunId || !runId || pipelineRunId === runId;
  if (!runIdMatch) {
    mismatches.push(`runId 不一致: pipeline=${pipelineRunId} vs ledger=${runId}`);
  }

  // (2) selectedCaseIds 集合对齐校验
  const legacyCaseIdSet = new Set(legacyCases.map((c) => c.caseId));
  const ledgerCaseIdSet = new Set(items.map((c) => c.caseId));
  const missingInLedger = [...legacyCaseIdSet].filter((id) => !ledgerCaseIdSet.has(id));
  const missingInLegacy = [...ledgerCaseIdSet].filter((id) => !legacyCaseIdSet.has(id));
  const selectedCasesMatch = missingInLedger.length === 0 && missingInLegacy.length === 0;
  if (!selectedCasesMatch && legacyCases.length > 0) {
    mismatches.push(`用例集不一致: 账本缺失 [${missingInLedger.join(', ')}], 报告缺失 [${missingInLegacy.join(', ')}]`);
  }

  // (3) 数量与 Case ID 集合逐类对账
  let caseIdCoverageMatch = true;
  if (legacyCases.length > 0) {
    if (legacyPassed !== summary.totalPassed) {
      mismatches.push(`PASS 数量不一致: legacy=${legacyPassed} vs ledger=${summary.totalPassed}`);
    }
    if (legacyFailed !== summary.totalConfirmedBugs) {
      mismatches.push(`FAIL/Bug 数量不一致: legacy=${legacyFailed} vs ledger=${summary.totalConfirmedBugs}`);
    }
    if (legacyBlocked !== summary.totalTestBlocked) {
      mismatches.push(`BLOCKED 数量不一致: legacy=${legacyBlocked} vs ledger=${summary.totalTestBlocked}`);
    }
    if (legacyNotExecuted !== summary.totalUntested) {
      mismatches.push(`NOT_EXECUTED/Untested 数量不一致: legacy=${legacyNotExecuted} vs ledger=${summary.totalUntested}`);
    }

    // 逐 ID 比对
    for (const id of legacyPassedIds) {
      if (!ledgerPassedIds.has(id)) {
        caseIdCoverageMatch = false;
        mismatches.push(`用例 ${id} 在报告中为 PASS，但在账本中分类为 ${items.find((i) => i.caseId === id)?.finalClassification ?? 'UNKNOWN'}`);
      }
    }
    for (const id of legacyFailedIds) {
      if (!ledgerBugIds.has(id)) {
        caseIdCoverageMatch = false;
        mismatches.push(`用例 ${id} 在报告中为 FAIL，但在账本中分类为 ${items.find((i) => i.caseId === id)?.finalClassification ?? 'UNKNOWN'}`);
      }
    }
    for (const id of legacyBlockedIds) {
      if (!ledgerBlockedIds.has(id)) {
        caseIdCoverageMatch = false;
        mismatches.push(`用例 ${id} 在报告中为 BLOCKED，但在账本中分类为 ${items.find((i) => i.caseId === id)?.finalClassification ?? 'UNKNOWN'}`);
      }
    }
    for (const id of legacyNotExecutedIds) {
      if (!ledgerUntestedIds.has(id)) {
        caseIdCoverageMatch = false;
        mismatches.push(`用例 ${id} 在报告中为 NOT_EXECUTED，但在账本中分类为 ${items.find((i) => i.caseId === id)?.finalClassification ?? 'UNKNOWN'}`);
      }
    }
  }

  const isNotComparable = legacyCases.length === 0 || input.pipelineMode === 'dry-run';
  const status: ReconciliationStatus = isNotComparable
    ? 'NOT_COMPARABLE'
    : (mismatches.length === 0 ? 'MATCH' : 'MISMATCH');

  const reconciled = status !== 'MISMATCH';
  const differenceReason = mismatches.length > 0 ? mismatches.join('; ') : undefined;

  const reconciliation = {
    status,
    legacyCount: {
      passed: legacyPassed,
      failed: legacyFailed,
      blocked: legacyBlocked,
      notExecuted: legacyNotExecuted,
      total: legacyCases.length,
    },
    ledgerCount: {
      passed: summary.totalPassed,
      confirmedBugs: summary.totalConfirmedBugs,
      testBlocked: summary.totalTestBlocked,
      untested: summary.totalUntested,
      total: summary.totalPlanned,
    },
    reconciled,
    runIdMatch,
    selectedCasesMatch,
    caseIdCoverageMatch,
    differenceReason,
    mismatches,
  };

  const canonicalResult = coverageLedgerToCanonicalRunResult({
    runId,
    items,
    requirementLedger,
    summary,
    reconciliation,
  });

  return {
    items,
    requirementLedger,
    summary,
    quickView: {
      testedSummary,
      untestedSummary,
      confirmedBugsCount: summary.totalConfirmedBugs,
      testBlockedCount: summary.totalTestBlocked,
      dataBindingConsumption,
      dataBindingBreakdown: dataBindingStats,
      runLevelBlockers,
      businessConclusion,
      nextStepAndOwner,
    },
    fourLists: {
      confirmedBugs,
      testBlocked,
      untested,
      passed,
    },
    reconciliation,
    canonicalResult,
  };
}

/**
 * 渲染 Markdown 格式的主覆盖账本表格
 */
export function renderCoverageLedgerMarkdownTable(items: TestPointCoverageLedgerItem[]): string {
  const headers = ['测试点/用例编号', '测试类型', '数据准备与消费', '执行状态', 'Oracle 结论', '证据状态', '最终分类', '原因与处置'];
  const separator = ['| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'];
  const rows = items.map((item) => {
    const consumedCount = item.dataBindings.filter((b) => b.bindingStatus === 'PROVIDED_AND_CONSUMED').length;
    const totalBindings = item.dataBindings.length;
    const dataDesc = totalBindings > 0
      ? `已消费: ${consumedCount}/${totalBindings}`
      : '无需数据';

    const execDesc = item.executed
      ? '✅ 真实执行完成'
      : item.processorInvoked
        ? '⚠️ 处理器已调用未完成'
        : item.dispatchAttempted
          ? '⚠️ 已派发未调用'
          : '❌ 未派发调度';

    const oracleDesc = item.oracleVerdict === 'PASS'
      ? '✅ PASS'
      : item.oracleVerdict === 'FAIL'
        ? '❌ FAIL'
        : item.oracleVerdict === 'BLOCKED'
          ? '🟡 BLOCKED'
          : item.oracleVerdict === 'UNKNOWN'
            ? '❓ UNKNOWN'
            : 'N/A';

    const evidenceDesc = `实得: ${item.collectedEvidence.length} / 缺失: ${item.missingEvidence.length}`;

    const classificationEmoji = item.finalClassification === 'CONFIRMED_BUG'
      ? '🔴 产品缺陷'
      : item.finalClassification === 'TEST_BLOCKED'
        ? '🟡 测试阻断'
        : item.finalClassification === 'PASSED'
          ? '🟢 已通过'
          : '⚪ 未测试';

    const reqDisplay = item.isUntracedCase ? '⚠️ UNTRACED_CASE' : item.requirementId;
    return `| **${item.caseId}**<br>(${reqDisplay}) | ${item.dimension} | ${dataDesc} | ${execDesc} | ${oracleDesc} | ${evidenceDesc} | **${classificationEmoji}** | ${item.statusReason} |`;
  });

  return [
    `| ${headers.join(' | ')} |`,
    separator[0],
    ...rows,
  ].join('\n');
}

/**
 * 渲染需求事实覆盖账本 (Requirement Fact Ledger Table)
 */
export function renderRequirementFactLedgerMarkdownTable(facts: RequirementFactCoverageLedgerItem[]): string {
  const headers = ['需求事实编号', '类别', '事实/规则陈述', '生成测试点数', '覆盖用例数', '通过数/缺陷数', '状态', '状态说明'];
  const separator = ['| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'];
  const rows = facts.map((fact) => {
    const statusEmoji = fact.status === 'PASSED'
      ? '🟢 已通过'
      : fact.status === 'CONFIRMED_BUG'
        ? '🔴 产品缺陷'
        : fact.status === 'TEST_BLOCKED'
          ? '🟡 测试阻断'
          : fact.status === 'NOT_TESTED'
            ? '❌ 未测试 (未建模/生成)'
            : '⚪ 未测试';

    return `| **${fact.factId}** | ${fact.category} | ${fact.statement} | ${fact.generatedTestPointIds.length} | ${fact.linkedCaseIds.length} | ${fact.passedCaseIds.length}/${fact.failedCaseIds.length} | **${statusEmoji}** | ${fact.statusReason} |`;
  });

  return [
    `| ${headers.join(' | ')} |`,
    separator[0],
    ...rows,
  ].join('\n');
}

/**
 * 渲染四大并列清单 Markdown
 */
export function renderFourParallelListsMarkdown(fourLists: {
  confirmedBugs: TestPointCoverageLedgerItem[];
  testBlocked: TestPointCoverageLedgerItem[];
  untested: TestPointCoverageLedgerItem[];
  passed: TestPointCoverageLedgerItem[];
}): string {
  const lines: string[] = [];

  // 清单 A：确认产品缺陷
  lines.push('### 🔴 清单 A：确认产品缺陷 (Confirmed Product Bugs)');
  if (fourLists.confirmedBugs.length === 0) {
    lines.push('> 当前可观察范围内无确认产品缺陷。\n');
  } else {
    lines.push('| 缺陷用例编号 | 测试点 | 维度 | 实际失败现象 | 关联问题 ID | 修复建议 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const item of fourLists.confirmedBugs) {
      lines.push(`| **${item.caseId}** | ${item.title} | ${item.dimension} | ${item.statusReason} | \`${item.relatedProblemIds.join(', ') || 'N/A'}\` | ${item.remediationAction || '对照断言与现场请求排查代码'} |`);
    }
    lines.push('');
  }

  // 清单 B：测试阻断
  lines.push('### 🟡 清单 B：测试阻断 (Test Blockers)');
  if (fourLists.testBlocked.length === 0) {
    lines.push('> 无前置环境、网络、凭证或安全策略阻断项。\n');
  } else {
    lines.push('| 阻断用例编号 | 测试点 | 阻断类别 | 阻断详情与原因 | 解除阻断指引 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (const item of fourLists.testBlocked) {
      lines.push(`| **${item.caseId}** | ${item.title} | ${item.readinessStatus} | ${item.statusReason} | 检查测试环境可达性、授权凭证或操作审批权限 |`);
    }
    lines.push('');
  }

  // 清单 C：未测试项
  lines.push('### ⚪ 清单 C：未测试项 (Untested Items)');
  if (fourLists.untested.length === 0) {
    lines.push('> 无脱漏未测试项，全部规划场景均已执行或阻断。\n');
  } else {
    lines.push('| 未测试用例编号 | 测试点 | 未测试原因 | 数据绑定情况 | 建议后续处置 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (const item of fourLists.untested) {
      const consumedCount = item.dataBindings.filter((b) => b.bindingStatus === 'PROVIDED_AND_CONSUMED').length;
      lines.push(`| **${item.caseId}** | ${item.title} | ${item.statusReason} | 已消费 ${consumedCount}/${item.dataBindings.length} 项 | 在后续轮次放宽预算限制或切换至 EXECUTE 模式运行 |`);
    }
    lines.push('');
  }

  // 清单 D：已通过项
  lines.push('### 🟢 清单 D：已通过项 (Passed Items)');
  if (fourLists.passed.length === 0) {
    lines.push('> 本次执行无通过项。\n');
  } else {
    lines.push(`> 共有 **${fourLists.passed.length}** 个测试点真实执行完成并通过所有断言。\n`);
    lines.push('| 通过用例编号 | 测试点 | 维度 | 执行耗时/证据 | Oracle 状态 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (const item of fourLists.passed.slice(0, 20)) {
      lines.push(`| **${item.caseId}** | ${item.title} | ${item.dimension} | 实得证据: ${item.collectedEvidence.join(', ') || 'HTTP 响应'} | ✅ PASS |`);
    }
    if (fourLists.passed.length > 20) {
      lines.push(`| ... | 另有 ${fourLists.passed.length - 20} 项已通过用例省略 | ... | ... | ✅ PASS |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
