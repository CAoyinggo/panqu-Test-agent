// Execution Schema：执行结果的数据模型 + 归一化
// 目标：Execution Agent 产出结构化执行结果，供 Analysis Agent 分析、Memory 记忆、报告渲染。
// 与现有 ResultTracker/CaseResult 对齐（pass/passRate/timedOut/durationMs/tags），
// 额外携带 caseId（对应 Test DSL 用例 ID）与断言明细（CheckResult 摘要）。

import type { CheckResult } from '../../core/types.js';
import type { CoreExecutionStatus } from '../../core/execution-status.js';
import { effectiveAssertions } from '../../core/execution-evidence.js';
import type { AssertionKind } from '../../core/execution-evidence.js';
import { createHash } from 'node:crypto';

/** 单条用例执行结果 */
export interface CaseExecutionResult {
  /** Test DSL 用例 ID（如 tc-01） */
  caseId: string;
  name: string;
  feature?: string;
  scene?: string;
  processor?: string;
  processorInvoked?: boolean;
  requestId?: string;
  timestamp?: string;
  /** 优先级 P0~P3 */
  priority?: string;
  tags?: string[];
  pass: boolean;
  passRate: number;
  /** 当前用例是否完成了真实 Processor 调用。 */
  executed?: boolean;
  /** 核心执行状态；NOT_EXECUTED/BLOCKED 永远不能视为通过。 */
  status?: CoreExecutionStatus;
  /** 有效业务断言总数；不得仅由 status 反推。 */
  assertions?: number;
  /** 已通过的有效业务断言数。 */
  passedAssertions?: number;
  /** 未通过的有效业务断言数。 */
  failedAssertions?: number;
  /** BLOCKED/NOT_EXECUTED 等非通过状态的结构化或兼容文本原因。 */
  blockedReason?: unknown;
  /** 原始执行证据；具体 Acceptance/Scenario 结果可使用更强的专用结构。 */
  evidence?: unknown;
  error?: string;
  timedOut?: boolean;
  durationMs?: number;
  /** 断言明细（来自执行引擎 CheckResult 摘要） */
  checks?: Array<{
    name: string;
    pass: boolean;
    detail: string;
    level?: string;
    kind?: AssertionKind;
  }>;
}

/** 执行计划（Execution Agent 规划阶段产出） */
/** 执行策略：Plan → Runner 真实生效的行为约束（不再是报告里的摆设） */
export interface ExecutionPolicy {
  /** 首个失败用例后停止调度后续用例（已启动的允许完成） */
  stopOnFailure?: boolean;
  /** false = 禁止真实副作用执行（Runner 按 dry-run 语义强制，作为 Policy Gate 之后的第二道防线） */
  realExecution?: boolean;
  /** false = 禁止真实计费（源自 Policy Gate 判定；Runner 记录并透传审计） */
  realBilling?: boolean;
}

/** 执行计划（规划阶段产出，同时是 Runner 的真实控制契约：Plan → Runner → 行为） */
export interface ExecutionPlan {
  /** 按优先级排序的用例 ID 序列（Runner 按此顺序执行） */
  order: string[];
  /** 并发数（与 maxConcurrency 取较小值为有效并发） */
  concurrency: number;
  /** 是否启用失败重试（false 时忽略用例级 retries；true 时按用例 extra.retries 执行） */
  enableRetry: boolean;
  reason: string;
  /** 执行用例数上限：按 order 截断，被截断用例以 NOT_EXECUTED（预算截断）计入结果 */
  maxCases?: number;
  /** 并发硬顶（有效并发 = min(concurrency, maxConcurrency)） */
  maxConcurrency?: number;
  /** dry-run：Runner 强制零副作用（不触引擎） */
  dryRun?: boolean;
  /** 整体执行时间预算（毫秒）：到点中止全部在途用例（AbortSignal 贯穿），未启动用例标 TIMEOUT */
  timeoutMs?: number;
  /** 执行策略（stopOnFailure / realExecution / realBilling） */
  policy?: ExecutionPolicy;
}

/**
 * 计算执行计划控制面的稳定指纹。
 * realExecution / realBilling 是 Policy Gate 的执行约束输出，不参与计划身份；其余会影响
 * Runner 行为的字段全部参与，确保 Gate 审核的计划与 Runner 消费的计划一致。
 */
export function executionPlanFingerprint(plan: ExecutionPlan): string {
  const controlPlane = {
    order: plan.order,
    concurrency: plan.concurrency,
    enableRetry: plan.enableRetry,
    maxCases: plan.maxCases,
    maxConcurrency: plan.maxConcurrency,
    dryRun: plan.dryRun,
    timeoutMs: plan.timeoutMs,
    stopOnFailure: plan.policy?.stopOnFailure,
  };
  return createHash('sha256').update(JSON.stringify(controlPlane)).digest('hex');
}

/** 结构化执行结果 */
export interface ExecutionOutcome {
  feature: string;
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  passRate: number;
  results: CaseExecutionResult[];
  reports: string[];
  /** 是否真正执行（Tool 缺失时为 false，仅产出计划） */
  executed: boolean;
  plan?: ExecutionPlan;
  /** 一句话汇总 */
  summary?: string;
}

/** 归一化单个用例执行结果 */
export function normalizeCaseExecutionResult(data: Record<string, unknown>): CaseExecutionResult {
  const result: CaseExecutionResult = {
    caseId: String(data.caseId ?? data.id ?? ''),
    name: String(data.name ?? data.caseId ?? ''),
    pass: data.pass === true,
    passRate: typeof data.passRate === 'number' ? data.passRate : (data.pass === true ? 100 : 0),
  };
  result.executed = data.executed === true;
  result.status = isCoreExecutionStatus(data.status) ? data.status : undefined;
  if (data.feature) result.feature = String(data.feature);
  if (data.scene) result.scene = String(data.scene);
  if (data.processor) result.processor = String(data.processor);
  if (data.processorInvoked !== undefined) result.processorInvoked = data.processorInvoked === true;
  if (data.requestId) result.requestId = String(data.requestId);
  if (data.timestamp) result.timestamp = String(data.timestamp);
  if (data.priority) result.priority = String(data.priority);
  if (Array.isArray(data.tags)) result.tags = data.tags.map(String);
  if (data.error) result.error = String(data.error);
  if (data.blockedReason !== undefined) result.blockedReason = data.blockedReason;
  if (data.evidence !== undefined) result.evidence = data.evidence;
  if (data.timedOut === true) result.timedOut = true;
  if (typeof data.durationMs === 'number') result.durationMs = data.durationMs;
  if (Array.isArray(data.checks)) {
    result.checks = data.checks
      .filter((c) => typeof c === 'object' && c !== null)
      .map((c) => {
        const raw = c as Record<string, unknown>;
        return {
          name: String(raw.name ?? ''),
          pass: raw.pass === true,
          detail: String(raw.detail ?? ''),
          level: raw.level !== undefined ? String(raw.level) : undefined,
          kind: isAssertionKind(raw.kind) ? raw.kind : undefined,
        };
      });
  }
  return enforceCaseExecutionIntegrity(result);
}

/** 从执行引擎 CheckResult 数组构造断言明细 */
export function checksFromResults(checks: CheckResult[]): CaseExecutionResult['checks'] {
  return checks.map((c) => ({
    name: c.name,
    pass: c.pass,
    detail: c.detail,
    level: c.level,
    kind: c.kind,
  }));
}

/**
 * 单一的 Case 结果完整性收敛点。`pass`、计数和通过率均从独立执行事实重建，
 * 外部 Runner 不能用相互矛盾的 status/pass 或汇总数字伪造 PASS。
 */
export function enforceCaseExecutionIntegrity<T extends CaseExecutionResult>(input: T): T {
  const result = { ...input } as T;
  const assertions = effectiveAssertions(result.checks);
  const passedAssertions = assertions.filter((assertion) => assertion.pass).length;
  const failedAssertions = assertions.length - passedAssertions;
  const suppliedStatus = isCoreExecutionStatus(result.status) ? result.status : undefined;
  const processorReady = Boolean(result.processor?.trim()) && result.processorInvoked === true;
  let status: CoreExecutionStatus;
  let executed = result.executed === true;

  if (!executed) {
    status = suppliedStatus === 'BLOCKED' || suppliedStatus === 'NOT_EXECUTED'
      || suppliedStatus === 'TIMEOUT' || suppliedStatus === 'CANCELLED'
      ? suppliedStatus : 'NOT_EXECUTED';
  } else if (suppliedStatus === 'TIMEOUT' || suppliedStatus === 'CANCELLED'
    || suppliedStatus === 'NOT_EXECUTED') {
    status = suppliedStatus;
    executed = false;
  } else if (!processorReady) {
    status = 'BLOCKED';
    executed = false;
  } else if (assertions.length === 0) {
    status = 'BLOCKED';
  } else if (suppliedStatus === 'BLOCKED') {
    status = 'BLOCKED';
  } else if (failedAssertions > 0) {
    status = 'FAIL';
  } else if (suppliedStatus === 'FAIL') {
    // FAIL 也必须由至少一个真实失败的业务断言支撑；只有状态字符串相互矛盾时 fail-close。
    status = 'BLOCKED';
  } else if (suppliedStatus === 'PASS' && failedAssertions === 0) {
    status = 'PASS';
  } else {
    status = 'BLOCKED';
  }

  result.executed = executed;
  result.status = status;
  result.assertions = assertions.length;
  result.passedAssertions = passedAssertions;
  result.failedAssertions = failedAssertions;
  result.pass = status === 'PASS';
  result.passRate = status === 'PASS' ? 100
    : status === 'FAIL' && assertions.length > 0
      ? Math.round((passedAssertions / assertions.length) * 1000) / 10
      : 0;
  result.timedOut = status === 'TIMEOUT';
  if (status === 'BLOCKED' && result.blockedReason === undefined) {
    result.blockedReason = !processorReady
      ? { code: 'MISSING_PROCESSOR', message: 'Processor 未明确调用，禁止 PASS' }
      : assertions.length === 0
        ? { code: 'MISSING_ASSERTION', message: '没有有效业务断言，禁止 PASS' }
        : { code: 'RESULT_INTEGRITY_VIOLATION', message: '执行结果字段相互矛盾' };
  }
  return result;
}

/** 由结果数组计算汇总 */
export function computeOutcome(feature: string, results: CaseExecutionResult[], extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  const safeResults = results.map((result) => enforceCaseExecutionIntegrity(result));
  const passed = safeResults.filter((result) => result.status === 'PASS' && result.pass === true).length;
  const timedOut = safeResults.filter((result) => result.status === 'TIMEOUT').length;
  const failed = safeResults.length - passed - timedOut;
  const total = safeResults.length;
  const passRate = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
  return {
    feature,
    total,
    passed,
    failed,
    timedOut,
    passRate,
    results: safeResults,
    reports: extra.reports ?? [],
    executed: extra.executed === false ? false : safeResults.length > 0 && safeResults.every((result) => (
      result.executed === true && Boolean(result.processor) && result.processorInvoked === true
    )),
    plan: extra.plan,
    summary: extra.summary ?? `共 ${total} 条：通过 ${passed}，失败 ${failed}${timedOut ? `，超时 ${timedOut}` : ''}，通过率 ${passRate}%`,
  };
}

function isCoreExecutionStatus(value: unknown): value is CoreExecutionStatus {
  return value === 'PASS' || value === 'FAIL' || value === 'BLOCKED' || value === 'NOT_EXECUTED'
    || value === 'TIMEOUT' || value === 'CANCELLED';
}

function isAssertionKind(value: unknown): value is AssertionKind {
  return value === 'BUSINESS' || value === 'INFORMATIONAL' || value === 'TEARDOWN'
    || value === 'SYSTEM' || value === 'SKIPPED';
}

/** Case 结果中真正能支持 PASS 的业务断言。 */
export function effectiveCaseAssertions(result: Pick<CaseExecutionResult, 'checks'>) {
  return effectiveAssertions(result.checks);
}

/**
 * Outcome 是否包含至少一条实际运行产生的确定性证据。
 * 空集合、显式未执行或仅含终止态结果都不是“执行成功”，下游不得据此生成 PASS。
 */
export function hasExecutableEvidence(outcome: Pick<ExecutionOutcome, 'total' | 'results' | 'executed'>): boolean {
  if (outcome.total <= 0 || outcome.results.length <= 0 || outcome.executed !== true) return false;
  return outcome.results.some((result) => (
    result.executed === true
    && Boolean(result.processor)
    && result.processorInvoked === true
    && (result.status === 'PASS' || result.status === 'FAIL')
    && effectiveAssertions(result.checks).length > 0
  ));
}

/** 判断数据是否「像 ExecutionOutcome」 */
export function isOutcomeLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && (Array.isArray((data as Record<string, unknown>).results) || Array.isArray((data as Record<string, unknown>).cases))
  );
}

/** 归一化外部产出的 ExecutionOutcome（LLM 一般不产出，供工具/适配使用） */
export function normalizeOutcome(data: Record<string, unknown>): ExecutionOutcome {
  const rawResults = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.cases)
      ? data.cases
      : [];
  const results = rawResults
    .filter((r) => typeof r === 'object' && r !== null)
    .map((r) => normalizeCaseExecutionResult(r as Record<string, unknown>));
  const feature = String(data.feature ?? data.func ?? 'default');
  return computeOutcome(feature, results, {
    reports: Array.isArray(data.reports) ? data.reports.map(String) : [],
    executed: data.executed === false ? false : undefined,
    plan: data.plan as ExecutionPlan | undefined,
  });
}
