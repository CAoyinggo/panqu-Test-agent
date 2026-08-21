// Execution Schema：执行结果的数据模型 + 归一化
// 目标：Execution Agent 产出结构化执行结果，供 Analysis Agent 分析、Memory 记忆、报告渲染。
// 与现有 ResultTracker/CaseResult 对齐（pass/passRate/timedOut/durationMs/tags），
// 额外携带 caseId（对应 Test DSL 用例 ID）与断言明细（CheckResult 摘要）。

import type { CheckResult } from '../../core/types.js';
import type { CoreExecutionStatus } from '../../core/execution-status.js';

/** 单条用例执行结果 */
export interface CaseExecutionResult {
  /** Test DSL 用例 ID（如 tc-01） */
  caseId: string;
  name: string;
  feature?: string;
  scene?: string;
  /** 优先级 P0~P3 */
  priority?: string;
  tags?: string[];
  pass: boolean;
  passRate: number;
  /** 当前用例是否完成了真实 Processor 调用。 */
  executed?: boolean;
  /** 核心执行状态；NOT_EXECUTED/BLOCKED 永远不能视为通过。 */
  status?: CoreExecutionStatus;
  error?: string;
  timedOut?: boolean;
  durationMs?: number;
  /** 断言明细（来自执行引擎 CheckResult 摘要） */
  checks?: Array<{
    name: string;
    pass: boolean;
    detail: string;
    level?: string;
  }>;
}

/** 执行计划（Execution Agent 规划阶段产出） */
export interface ExecutionPlan {
  /** 按优先级排序的用例 ID 序列 */
  order: string[];
  /** 并发数 */
  concurrency: number;
  /** 是否启用失败重试 */
  enableRetry: boolean;
  reason: string;
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
  result.executed = data.executed !== false;
  result.status = isCoreExecutionStatus(data.status)
    ? data.status
    : result.executed
      ? result.pass ? 'PASS' : 'FAIL'
      : 'NOT_EXECUTED';
  if (!result.executed || result.status === 'NOT_EXECUTED' || result.status === 'BLOCKED') {
    result.pass = false;
    result.passRate = 0;
  }
  if (data.feature) result.feature = String(data.feature);
  if (data.scene) result.scene = String(data.scene);
  if (data.priority) result.priority = String(data.priority);
  if (Array.isArray(data.tags)) result.tags = data.tags.map(String);
  if (data.error) result.error = String(data.error);
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
        };
      });
  }
  return result;
}

/** 从执行引擎 CheckResult 数组构造断言明细 */
export function checksFromResults(checks: CheckResult[]): CaseExecutionResult['checks'] {
  return checks.map((c) => ({
    name: c.name,
    pass: c.pass,
    detail: c.detail,
    level: c.level,
  }));
}

/** 由结果数组计算汇总 */
export function computeOutcome(feature: string, results: CaseExecutionResult[], extra: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  const safeResults = results.map((result) => {
    if (result.executed === false || result.status === 'BLOCKED' || result.status === 'NOT_EXECUTED') {
      return { ...result, pass: false, passRate: 0 };
    }
    return result;
  });
  const passed = safeResults.filter((r) => r.pass && !r.timedOut).length;
  const timedOut = safeResults.filter((r) => r.timedOut).length;
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
    executed: extra.executed ?? (safeResults.length > 0 && safeResults.every((r) => r.executed !== false && r.status !== 'NOT_EXECUTED')),
    plan: extra.plan,
    summary: extra.summary ?? `共 ${total} 条：通过 ${passed}，失败 ${failed}${timedOut ? `，超时 ${timedOut}` : ''}，通过率 ${passRate}%`,
  };
}

function isCoreExecutionStatus(value: unknown): value is CoreExecutionStatus {
  return value === 'PASS' || value === 'FAIL' || value === 'BLOCKED' || value === 'NOT_EXECUTED';
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
    executed: data.executed !== false,
    plan: data.plan as ExecutionPlan | undefined,
  });
}
