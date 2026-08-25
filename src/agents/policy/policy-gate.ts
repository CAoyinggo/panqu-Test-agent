// Execution Policy Gate：Risk / Constraint Analysis 与真实执行之间的确定性控制面。
// 所有决策必须在 Data Prepare 和 execution.run 之前完成；未放行时 fail-closed。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { RiskAssessment, RiskCategory } from '../risk/risk-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { DataPlan } from '../data/data-schema.js';
import { executionPlanFingerprint, type ExecutionPlan } from '../execution/execution-schema.js';
import type { BudgetStatus } from '../observability/budget.js';
import { resolveEnvironmentTier, type EnvironmentTier } from '../../config/environment-policy.js';
import type { ToolPermission } from '../tools/tool.js';

export type PolicyGateVerdict = 'ALLOW' | 'BLOCK' | 'APPROVAL_REQUIRED';

export type ExecutionApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** 审批绑定的策略版本；策略语义变化后旧审批自动失效。 */
export const EXECUTION_POLICY_VERSION = 'execution-policy.v1';

/** 必须由审批中心等可信调用方注入，Policy Gate 不自行生成批准。 */
export interface ExecutionApproval {
  id?: string;
  status: ExecutionApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  environment?: string;
  executionPlanFingerprint?: string;
  policyVersion?: string;
  createdAt?: string;
  expiresAt?: string;
}

/** 项目级执行策略；显式 false 为不可由审批绕过的硬约束。 */
export interface ProjectExecutionPolicy {
  enabled?: boolean;
  allowedEnvironments?: string[];
  allowRealExecution?: boolean;
  allowRealBilling?: boolean;
  allowHighRiskOperations?: boolean;
  requireDataIsolation?: boolean;
  dataIsolationVerified?: boolean;
  requireHumanApproval?: boolean;
  /** 默认 true：Risk Agent 的 recommendedSkip 必须阻断并等待人工审批。 */
  honorRecommendedSkip?: boolean;
  /** 是否允许在真实执行前准备测试数据。 */
  allowDataPreparation?: boolean;
  /** 允许使用的数据工厂白名单。 */
  allowedDataFactories?: string[];
}

export interface PolicyGateCheck {
  name:
    | 'environment'
    | 'realExecution'
    | 'realBilling'
    | 'highRiskOperation'
    | 'dataIsolation'
    | 'humanApproval'
    | 'recommendedSkip'
    | 'projectPolicy'
    | 'executionPlan'
    | 'budget'
    | 'dataPolicy';
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface PolicyGateInput {
  requirement: Requirement;
  risk: RiskAssessment;
  testCases: TestCase[];
  environment?: string;
  dryRun?: boolean;
  skipExecution?: boolean;
  projectPolicy?: ProjectExecutionPolicy;
  approval?: ExecutionApproval;
  /** Orchestrator 在 Gate 前确定、Runner 后续必须原样消费的计划。 */
  executionPlan?: ExecutionPlan;
  /** 纯规划产物；允许在 Gate 前生成，但不得在 Gate 前执行 prepare。 */
  dataPlan?: DataPlan;
  /** Gate 评估时的实时预算状态。 */
  budgetStatus?: BudgetStatus;
}

export interface PolicyGateResult {
  allowed: boolean;
  verdict: PolicyGateVerdict;
  environment: string;
  environmentTier: EnvironmentTier;
  actionLevel: ToolPermission;
  realExecution: boolean;
  realBilling: boolean;
  highRiskOperation: boolean;
  dataIsolationRisk: boolean;
  requiresApproval: boolean;
  approvalStatus?: ExecutionApprovalStatus;
  reasons: string[];
  checks: PolicyGateCheck[];
  /** Gate 实际审核的 Execution Plan 控制面指纹。 */
  executionPlanFingerprint?: string;
  evaluatedAt: string;
}

const REAL_EXECUTION_DENY = [
  /禁止.{0,4}真实执行/i,
  /不允许.{0,4}真实执行/i,
  /不得.{0,4}真实执行/i,
  /仅限.{0,4}(dry[- ]?run|演练|计划)/i,
  /no\s+real\s+execution/i,
];

const REAL_BILLING_DENY = [
  /禁止.{0,4}(真实)?(扣费|计费|扣积分|支付)/i,
  /不允许.{0,4}(真实)?(扣费|计费|扣积分|支付)/i,
  /不得.{0,4}(真实)?(扣费|计费|扣积分|支付)/i,
  /no\s+real\s+(billing|charge|payment)/i,
];

const DATA_ISOLATION_REQUIRED = [
  /需要.{0,4}数据隔离/i,
  /必须.{0,4}数据隔离/i,
  /仅使用.{0,4}(隔离|测试)数据/i,
  /data\s+isolation\s+required/i,
];

const TEST_ENVIRONMENT_ONLY = [
  /仅限.{0,4}(测试|test)环境/i,
  /只允许.{0,4}(测试|test)环境/i,
  /(测试|test)环境.{0,6}(执行|运行)/i,
];

const PRODUCTION_EXECUTION_DENY = [
  /禁止.{0,4}(在)?生产环境.{0,4}(执行|运行)/i,
  /生产环境.{0,4}禁止.{0,4}(执行|运行)/i,
  /no\s+production\s+execution/i,
];

const DANGEROUS_OPERATION = [
  /删库|删除生产数据|直接修改数据库|真实支付|系统命令|生产压测/i,
  /drop\s+(database|table)|delete\s+production|shell\s+command/i,
];

function allText(requirement: Requirement): string {
  return [
    requirement.goal,
    requirement.source,
    ...(requirement.constraints ?? []),
    ...requirement.businessRules,
    ...(requirement.risks ?? []),
  ].filter(Boolean).join('\n');
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function hasRisk(risk: RiskAssessment, category: RiskCategory, level?: 'high' | 'medium' | 'low'): boolean {
  return risk.risks.some((item) => item.category === category && (!level || item.level === level));
}

function normalizedEnvironment(value: string | undefined): string {
  return (value ?? 'test').trim().toLowerCase() || 'test';
}

function environmentAllowed(environment: string, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return true;
  const aliases = new Set([environment, resolveEnvironmentTier(environment)]);
  return allowed.some((item) => aliases.has(item.trim().toLowerCase()));
}

/** 纯函数：同一输入始终得到同一 verdict（evaluatedAt 除外）。 */
export function evaluateExecutionPolicy(input: PolicyGateInput): PolicyGateResult {
  const environment = normalizedEnvironment(input.environment);
  const environmentTier = resolveEnvironmentTier(environment);
  const policy = input.projectPolicy ?? {};
  const approvalStatus = input.approval?.status;
  const reviewedPlanFingerprint = input.executionPlan ? executionPlanFingerprint(input.executionPlan) : undefined;
  const approvalBindingErrors: string[] = [];
  // production 审批必须与本次环境、计划和策略版本逐项绑定，旧的通用 APPROVED 标记无效。
  if (approvalStatus === 'APPROVED' && environmentTier === 'production' && input.executionPlan) {
    if (normalizedEnvironment(input.approval?.environment) !== environment) {
      approvalBindingErrors.push(`审批环境不匹配：approved=${input.approval?.environment ?? 'missing'} current=${environment}`);
    }
    if (!input.approval?.executionPlanFingerprint
      || input.approval.executionPlanFingerprint !== reviewedPlanFingerprint) {
      approvalBindingErrors.push('PLAN_FINGERPRINT_MISMATCH：审批 fingerprint 与当前 Execution Plan 不一致');
    }
    if (input.approval?.policyVersion !== EXECUTION_POLICY_VERSION) {
      approvalBindingErrors.push(`审批 policyVersion 无效：期望 ${EXECUTION_POLICY_VERSION}`);
    }
    const createdAt = Date.parse(input.approval?.createdAt ?? input.approval?.approvedAt ?? '');
    const expiresAt = Date.parse(input.approval?.expiresAt ?? '');
    if (!Number.isFinite(createdAt)) approvalBindingErrors.push('审批缺少有效 createdAt/approvedAt');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || (Number.isFinite(createdAt) && expiresAt <= createdAt)) {
      approvalBindingErrors.push('审批 expiresAt 已过期或无效');
    }
  }
  const approvalEvidenceValid = Boolean(input.approval?.id?.trim() && input.approval?.approvedBy?.trim())
    && approvalBindingErrors.length === 0;
  const approved = approvalStatus === 'APPROVED' && approvalEvidenceValid;
  const realExecution = input.skipExecution !== true && input.dryRun !== true
    && input.executionPlan?.dryRun !== true
    && input.executionPlan?.policy?.realExecution !== false;
  const text = allText(input.requirement);

  const realBilling = input.testCases.some((testCase) =>
    testCase.assertions.some((assertion) => assertion.target === 'billing'),
  ) || hasRisk(input.risk, 'billing') || /billing|计费|扣费|积分|支付/i.test(text);
  const highRiskOperation = input.risk.summary.overall === 'high'
    || input.risk.risks.some((item) => item.level === 'high')
    || input.testCases.some((testCase) => testCase.priority === 'P0')
    || matchesAny(text, DANGEROUS_OPERATION);
  const dataIsolationRisk = hasRisk(input.risk, 'data', 'high')
    || hasRisk(input.risk, 'security', 'high')
    || matchesAny(text, DATA_ISOLATION_REQUIRED);
  const dangerous = matchesAny(text, DANGEROUS_OPERATION);
  // execution.run 本身属于 risky；只有不执行（plan/dry-run）才能降为 safe。
  const actionLevel: ToolPermission = !realExecution ? 'safe' : dangerous ? 'dangerous' : 'risky';

  const checks: PolicyGateCheck[] = [];
  const hardBlocks: string[] = [];
  const approvalReasons: string[] = [];
  const addCheck = (check: PolicyGateCheck): void => { checks.push(check); };

  if (approvalBindingErrors.length > 0) {
    hardBlocks.push(...approvalBindingErrors);
  }

  if (input.executionPlan) {
    const caseIds = input.testCases.map((testCase) => testCase.id);
    const planned = new Set(input.executionPlan.order);
    const invalidPlan = input.executionPlan.order.length !== caseIds.length
      || planned.size !== caseIds.length
      || caseIds.some((caseId) => !planned.has(caseId))
      || !Number.isInteger(input.executionPlan.concurrency)
      || input.executionPlan.concurrency < 1
      || (input.executionPlan.maxConcurrency !== undefined && input.executionPlan.maxConcurrency < 1)
      || (input.executionPlan.maxCases !== undefined && input.executionPlan.maxCases < 0);
    if (invalidPlan) {
      const reason = 'Execution Plan 与待执行用例或控制参数不一致';
      hardBlocks.push(reason);
      addCheck({ name: 'executionPlan', passed: false, blocking: true, detail: reason });
    } else {
      addCheck({
        name: 'executionPlan', passed: true, blocking: false,
        detail: `Execution Plan 已固定（${executionPlanFingerprint(input.executionPlan).slice(0, 12)}）`,
      });
    }
  } else {
    addCheck({ name: 'executionPlan', passed: true, blocking: false, detail: '兼容调用未提供 Execution Plan' });
  }

  if (input.budgetStatus?.exceededAny && realExecution) {
    const reason = `执行前预算已耗尽：${input.budgetStatus.exceeded.join('、')}`;
    hardBlocks.push(reason);
    addCheck({ name: 'budget', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({
      name: 'budget', passed: true, blocking: false,
      detail: input.budgetStatus ? '执行前预算仍可用' : '未配置执行预算上限',
    });
  }

  if (input.dataPlan?.needsSetup && realExecution && policy.allowDataPreparation === false) {
    const reason = '项目数据策略禁止执行前数据准备';
    hardBlocks.push(reason);
    addCheck({ name: 'dataPolicy', passed: false, blocking: true, detail: reason });
  } else if (input.dataPlan?.needsSetup && realExecution && policy.allowedDataFactories?.length
    && !policy.allowedDataFactories.includes(input.dataPlan.factoryName)) {
    const reason = `数据工厂 ${input.dataPlan.factoryName} 不在项目白名单`;
    hardBlocks.push(reason);
    addCheck({ name: 'dataPolicy', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({
      name: 'dataPolicy', passed: true, blocking: false,
      detail: input.dataPlan?.needsSetup
        ? `数据准备计划已审核（factory=${input.dataPlan.factoryName}）`
        : '本次无需数据准备',
    });
  }

  if (realExecution && environmentTier !== 'test' && matchesAny(text, TEST_ENVIRONMENT_ONLY)) {
    const reason = `Requirement 仅允许测试环境执行，当前为 ${environment}`;
    hardBlocks.push(reason);
    addCheck({ name: 'environment', passed: false, blocking: true, detail: reason });
  } else if (realExecution && environmentTier === 'production' && matchesAny(text, PRODUCTION_EXECUTION_DENY)) {
    const reason = 'Requirement 明确禁止在生产环境执行';
    hardBlocks.push(reason);
    addCheck({ name: 'environment', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({
      name: 'environment',
      passed: true,
      blocking: false,
      detail: `执行环境 ${environment}（tier=${environmentTier}）`,
    });
  }

  if (!realExecution) {
    addCheck({ name: 'realExecution', passed: true, blocking: false, detail: '仅计划或 dry-run，不触发真实执行' });
  } else if (matchesAny(text, REAL_EXECUTION_DENY)) {
    const reason = 'Requirement 明确禁止真实执行';
    hardBlocks.push(reason);
    addCheck({ name: 'realExecution', passed: false, blocking: true, detail: reason });
  } else if (policy.allowRealExecution === false) {
    const reason = '项目策略禁止真实执行';
    hardBlocks.push(reason);
    addCheck({ name: 'realExecution', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({ name: 'realExecution', passed: true, blocking: false, detail: '未发现禁止真实执行的硬约束' });
  }

  if (!realBilling || !realExecution) {
    addCheck({ name: 'realBilling', passed: true, blocking: false, detail: '本次不触发真实计费' });
  } else if (matchesAny(text, REAL_BILLING_DENY)) {
    const reason = 'Requirement 明确禁止真实扣费/支付';
    hardBlocks.push(reason);
    addCheck({ name: 'realBilling', passed: false, blocking: true, detail: reason });
  } else if (environmentTier === 'production' && policy.allowRealBilling !== true) {
    const reason = '生产环境真实计费默认禁止，项目策略未显式允许';
    hardBlocks.push(reason);
    addCheck({ name: 'realBilling', passed: false, blocking: true, detail: reason });
  } else if (policy.allowRealBilling === false) {
    const reason = '项目策略禁止真实计费';
    hardBlocks.push(reason);
    addCheck({ name: 'realBilling', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({ name: 'realBilling', passed: true, blocking: false, detail: '真实计费已通过项目策略检查' });
  }

  if (dangerous && environmentTier !== 'test') {
    const reason = `${environmentTier} 环境禁止 dangerous 操作`;
    hardBlocks.push(reason);
    addCheck({ name: 'highRiskOperation', passed: false, blocking: true, detail: reason });
  } else if (highRiskOperation && realExecution && policy.allowHighRiskOperations === false) {
    const reason = '项目策略禁止高风险操作';
    hardBlocks.push(reason);
    addCheck({ name: 'highRiskOperation', passed: false, blocking: true, detail: reason });
  } else if (highRiskOperation && realExecution && policy.allowHighRiskOperations !== true) {
    const reason = '高风险操作需要人工审批';
    approvalReasons.push(reason);
    addCheck({ name: 'highRiskOperation', passed: approved, blocking: !approved, detail: approved ? `${reason}（已批准）` : reason });
  } else {
    addCheck({ name: 'highRiskOperation', passed: true, blocking: false, detail: highRiskOperation ? '项目策略允许高风险操作' : '未识别高风险操作' });
  }

  const isolationRequired = policy.requireDataIsolation === true || matchesAny(text, DATA_ISOLATION_REQUIRED);
  if (realExecution && dataIsolationRisk && isolationRequired && policy.dataIsolationVerified !== true) {
    const reason = '存在数据隔离风险，但项目未提供隔离已验证凭据';
    hardBlocks.push(reason);
    addCheck({ name: 'dataIsolation', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({
      name: 'dataIsolation',
      passed: true,
      blocking: false,
      detail: dataIsolationRisk ? '数据隔离风险已确认或当前策略不要求隔离凭据' : '未识别数据隔离风险',
    });
  }

  const honorRecommendedSkip = policy.honorRecommendedSkip !== false;
  if (realExecution && input.risk.summary.recommendedSkip && honorRecommendedSkip) {
    const reason = 'Risk Assessment 给出 recommendedSkip=true';
    approvalReasons.push(reason);
    addCheck({ name: 'recommendedSkip', passed: approved, blocking: !approved, detail: approved ? `${reason}（人工批准覆盖）` : reason });
  } else {
    addCheck({ name: 'recommendedSkip', passed: true, blocking: false, detail: input.risk.summary.recommendedSkip ? '项目策略显式忽略 recommendedSkip' : 'recommendedSkip=false' });
  }

  if (policy.enabled === false) {
    const reason = '项目执行策略已禁用测试执行';
    hardBlocks.push(reason);
    addCheck({ name: 'projectPolicy', passed: false, blocking: true, detail: reason });
  } else if (!environmentAllowed(environment, policy.allowedEnvironments)) {
    const reason = `项目策略不允许在 ${environment} 环境执行`;
    hardBlocks.push(reason);
    addCheck({ name: 'projectPolicy', passed: false, blocking: true, detail: reason });
  } else {
    addCheck({ name: 'projectPolicy', passed: true, blocking: false, detail: '项目级执行策略检查通过' });
  }

  if (realExecution && environmentTier !== 'test' && actionLevel === 'risky') {
    approvalReasons.push(`${environmentTier} + risky operation 默认拒绝，必须人工审批`);
  }
  if (realExecution && policy.requireHumanApproval === true) {
    approvalReasons.push('项目策略要求人工审批');
  }
  const uniqueApprovalReasons = [...new Set(approvalReasons)];
  const requiresApproval = realExecution && uniqueApprovalReasons.length > 0;

  if (approvalStatus === 'REJECTED' && requiresApproval) {
    hardBlocks.push('人工审批已拒绝');
  }
  addCheck({
    name: 'humanApproval',
    passed: !requiresApproval || approved,
    blocking: requiresApproval && !approved,
    detail: !requiresApproval
      ? '无需人工审批'
      : approved
        ? `人工审批已通过${input.approval?.id ? `（${input.approval.id}）` : ''}`
        : approvalBindingErrors.length > 0
          ? `审批绑定无效：${approvalBindingErrors.join('；')}`
        : approvalStatus === 'APPROVED' && !approvalEvidenceValid
          ? '审批状态为 APPROVED，但缺少 approval id 或 approvedBy，按未批准处理'
          : approvalStatus === 'REJECTED'
            ? '人工审批已拒绝'
            : '等待人工审批',
  });

  const reasons = [...new Set([...hardBlocks, ...uniqueApprovalReasons])];
  let verdict: PolicyGateVerdict;
  if (hardBlocks.length > 0) verdict = 'BLOCK';
  else if (requiresApproval && !approved) verdict = 'APPROVAL_REQUIRED';
  else verdict = 'ALLOW';

  return {
    allowed: verdict === 'ALLOW',
    verdict,
    environment,
    environmentTier,
    actionLevel,
    realExecution,
    realBilling,
    highRiskOperation,
    dataIsolationRisk,
    requiresApproval,
    approvalStatus,
    reasons,
    checks,
    executionPlanFingerprint: input.executionPlan
      ? executionPlanFingerprint(input.executionPlan)
      : undefined,
    evaluatedAt: new Date().toISOString(),
  };
}
