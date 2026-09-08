// Plan Policy Gate：execute_test_plan 路径的确定性门禁（无 LLM、无网络、无副作用）。
//
// 在 run-plan 的 execute 分支中、调用 fetch 之前强制评估；未放行（verdict=BLOCK）时
// 绝不发起任何 HTTP 请求。门禁结果必须落盘并返回：
//   verdict / checks / blocking_reasons / approval_required / evaluated_at
//
// 第一阶段只允许：
//   - environment = test
//   - GET / HEAD / OPTIONS（只读幂等）
//   - target origin 位于服务端允许列表（TESTFLOW_ALLOWED_TARGET_ORIGINS）
//   - 无 credential_ref / auth_ref
//   - 单一 HTTP_REQUEST + 确定性断言
//
// preonline / prod 一律 BLOCK（APPROVAL_BACKEND_NOT_IMPLEMENTED）：当前没有真实审批中心，
// 不能把任意字符串当作有效审批。

import {
  classifyPlanCase,
  isSafeHttpMethod,
  type NormalizedCase,
  type NormalizedPlan,
} from './plan-contract.js';

export type PlanPolicyVerdict = 'ALLOW' | 'BLOCK';

export interface PlanPolicyCheck {
  name: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface PlanPolicyGateConfig {
  /** 服务端运维配置的允许 origin（不含 Trae 传入的 plan 参数）。 */
  allowedTargetOrigins?: ReadonlySet<string>;
  budgetCases?: number;
  budgetDurationMs?: number;
}

export interface PlanPolicyGateResult {
  verdict: PlanPolicyVerdict;
  checks: PlanPolicyCheck[];
  blockingReasons: string[];
  approvalRequired: boolean;
  evaluatedAt: string;
}

const BILLING_PATTERN = /billing|计费|扣费|扣积分|积分|支付|余额|credit/i;
const SECURITY_PATTERN = /security|安全|鉴权|认证|越权|权限|注入|credentials?|\bauth\b/i;

function originOf(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}`;
}

/** 解析服务端环境变量 TESTFLOW_ALLOWED_TARGET_ORIGINS（逗号分隔完整 origin）。 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== 'string' || raw.trim().length === 0) return out;
  for (const token of raw.split(',')) {
    const origin = token.trim();
    if (!origin) continue;
    out.add(origin.replace(/\/+$/, ''));
  }
  return out;
}

function httpStepOf(c: NormalizedCase): NormalizedCase['steps'][number] | undefined {
  return c.steps.find((step) => step.type === 'HTTP_REQUEST');
}

/** 纯函数：同一计划 + 同一配置得到相同 verdict（evaluatedAt 除外）。 */
export function evaluatePlanPolicyGate(
  normalized: NormalizedPlan,
  config: PlanPolicyGateConfig = {},
): PlanPolicyGateResult {
  const checks: PlanPolicyCheck[] = [];
  const blockingReasons: string[] = [];
  const addCheck = (check: PlanPolicyCheck): void => { checks.push(check); };
  const block = (name: string, detail: string): void => {
    blockingReasons.push(detail);
    addCheck({ name, passed: false, blocking: true, detail });
  };

  // 1) environment：第一阶段仅 test；preonline/prod 无审批后端 → 直接 BLOCK。
  if (normalized.environment !== 'test') {
    block('environment', `${normalized.environment} 环境真实执行需要后端审批中心，当前未实现（APPROVAL_BACKEND_NOT_IMPLEMENTED）`);
  } else {
    addCheck({ name: 'environment', passed: true, blocking: false, detail: 'environment=test，允许第一阶段只读执行' });
  }

  // 2) target origin allowlist：未配置 fail-closed；origin 不在列表 BLOCK。
  const allowed = config.allowedTargetOrigins ?? new Set<string>();
  let targetOrigin = '';
  try {
    targetOrigin = originOf(normalized.targetUrl);
  } catch {
    block('target_origin_allowlist', 'target_url 无法解析 origin');
  }
  if (allowed.size === 0) {
    block('target_origin_allowlist', 'TESTFLOW_ALLOWED_TARGET_ORIGINS 未配置，fail-closed');
  } else if (targetOrigin && !allowed.has(targetOrigin)) {
    block('target_origin_allowlist', `target_url origin ${targetOrigin} 不在服务端允许列表`);
  } else if (targetOrigin) {
    addCheck({ name: 'target_origin_allowlist', passed: true, blocking: false, detail: `${targetOrigin} 在允许列表` });
  }

  // 3) 独立推导用例分类（不信任外部传入的分类）。
  const executable: NormalizedCase[] = [];
  const designedOnlyReasons: string[] = [];
  for (const testCase of normalized.testCases) {
    const c = classifyPlanCase(testCase);
    if (c.classification === 'EXECUTABLE') executable.push(testCase);
    else designedOnlyReasons.push(`${testCase.id}(${c.reason ?? '不满足执行条件'})`);
  }
  addCheck({
    name: 'case_classification',
    passed: true,
    blocking: false,
    detail: `EXECUTABLE=${executable.length}，DESIGNED_ONLY=${designedOnlyReasons.length}`,
  });

  // 4) HTTP method / destructive operation：可执行用例必须只读幂等。
  const unsafeExecutable = executable.filter((c) => {
    const step = httpStepOf(c);
    return !step?.method || !isSafeHttpMethod(step.method);
  });
  if (unsafeExecutable.length > 0) {
    block('http_method', `存在可执行用例使用非只读方法：${unsafeExecutable.map((c) => c.id).join(',')}`);
    block('destructive_operation', `检测到破坏性操作（非 GET/HEAD/OPTIONS）：${unsafeExecutable.map((c) => c.id).join(',')}`);
  } else {
    addCheck({ name: 'http_method', passed: true, blocking: false, detail: '所有可执行用例均使用 GET/HEAD/OPTIONS' });
    addCheck({ name: 'destructive_operation', passed: true, blocking: false, detail: '无可执行破坏性操作（仅只读方法）' });
  }

  // 5) credential requirement：可执行用例不得携带凭据引用。
  const credentialedExec = executable.filter((c) => c.credentialRef);
  if (credentialedExec.length > 0) {
    block('credential_requirement', `可执行用例携带凭据引用：${credentialedExec.map((c) => c.id).join(',')}`);
  } else {
    addCheck({ name: 'credential_requirement', passed: true, blocking: false, detail: '可执行用例无凭据要求' });
  }

  // 6) risk level：CRITICAL 风险第一阶段不准执行。
  const critical = normalized.risks.filter((r) => r.level === 'CRITICAL');
  if (critical.length > 0) {
    block('risk_level', `存在 CRITICAL 风险：${critical.map((r) => r.id).join(',')}`);
  } else {
    addCheck({ name: 'risk_level', passed: true, blocking: false, detail: '无 CRITICAL 级别风险' });
  }

  // 7) billing 风险。
  const billingRisks = normalized.risks.filter((r) => BILLING_PATTERN.test(`${r.category} ${r.description}`));
  if (billingRisks.length > 0) {
    block('billing', `存在计费风险：${billingRisks.map((r) => r.id).join(',')}`);
  } else {
    addCheck({ name: 'billing', passed: true, blocking: false, detail: '无计费风险' });
  }

  // 8) security 风险。
  const securityRisks = normalized.risks.filter((r) => SECURITY_PATTERN.test(`${r.category} ${r.description}`));
  if (securityRisks.length > 0) {
    block('security', `存在安全风险：${securityRisks.map((r) => r.id).join(',')}`);
  } else {
    addCheck({ name: 'security', passed: true, blocking: false, detail: '无安全风险' });
  }

  // 9) budget：仅校验取值合法；超量用例在 executor 内按 BLOCKED_BY_BUDGET 处理（非门禁阻断）。
  const budgetCases = config.budgetCases;
  const budgetDurationMs = config.budgetDurationMs;
  if (budgetCases !== undefined && (!Number.isInteger(budgetCases) || budgetCases <= 0)) {
    block('budget', 'budget_cases 必须为正整数');
  } else if (budgetDurationMs !== undefined && (!Number.isInteger(budgetDurationMs) || budgetDurationMs <= 0)) {
    block('budget', 'budget_duration 必须为正整数');
  } else {
    const detail = budgetCases !== undefined
      ? `budget_cases=${budgetCases}（可执行用例 ${executable.length} 条，超出部分将在执行阶段标为 BLOCKED_BY_BUDGET）`
      : '未配置执行预算上限';
    addCheck({ name: 'budget', passed: true, blocking: false, detail });
  }

  const verdict: PlanPolicyVerdict = blockingReasons.length > 0 ? 'BLOCK' : 'ALLOW';
  return {
    verdict,
    checks,
    blockingReasons: [...new Set(blockingReasons)],
    approvalRequired: false,
    evaluatedAt: new Date().toISOString(),
  };
}