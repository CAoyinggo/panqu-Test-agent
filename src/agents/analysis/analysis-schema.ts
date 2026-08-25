// Analysis Schema：AI 测试分析报告的数据模型 + 归一化
// 目标：Analysis Agent 结合 Requirement / TestCase / 执行结果 / 风险评估，
// 产出根因定位 + 改进建议 + 待记忆的失败记录（供 Memory 层持久化）。
// 报告字段与现有 CheckResult/IssueItem 语义对齐，便于报告渲染复用。

import type { CaseExecutionResult, ExecutionOutcome } from '../execution/execution-schema.js';

/** 分析结论类型 */
export type FindingType = 'pass' | 'fail' | 'flaky' | 'blocked' | 'info';

/** 单条分析结论 */
export interface AnalysisFinding {
  type: FindingType;
  caseId?: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  suggestion: string;
}

/** 分析汇总 */
export interface AnalysisSummary {
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  passRate: number;
  durationMs: number;
  exitCode: number;
  /** 整体结论：pass / fail / partial */
  overall: 'pass' | 'fail' | 'partial';
}

/** 待记忆的失败记录（Memory 层持久化结构） */
export interface MemoryWorthyFailure {
  caseId: string;
  category: string;
  message: string;
  evidence: string[];
  tags: string[];
}

/** 结构化分析报告 */
export interface AnalysisReport {
  feature: string;
  summary: AnalysisSummary;
  findings: AnalysisFinding[];
  /** 失败用例明细 */
  failedCases: CaseExecutionResult[];
  /** 顶部失败（前 N 条，按严重度排序） */
  topFailures: Array<{ caseId: string; name: string; error?: string }>;
  /** 改进建议 */
  recommendations: string[];
  /** 待记忆的失败记录 */
  memoryWorthy: MemoryWorthyFailure[];
  /** AI 生成的摘要（LLM 优先，规则兜底） */
  aiSummary?: string;
  source?: string;
}

/** 由失败用例生成待记忆记录 */
export function toMemoryWorthy(failed: CaseExecutionResult[]): MemoryWorthyFailure[] {
  return failed.map((c) => ({
    caseId: c.caseId,
    category: c.timedOut ? 'timeout' : c.error ? 'error' : 'assertion',
    message: c.error ?? `${c.name} 断言失败（passRate=${c.passRate}%）`,
    evidence: (c.checks ?? []).filter((ch) => !ch.pass).map((ch) => `${ch.name}: ${ch.detail}`),
    tags: [...(c.tags ?? []), c.feature ?? 'default'].filter(Boolean),
  }));
}

/**
 * 由真实执行结果（Runner Outcome）确定性计算汇总。
 * 统计唯一合法来源：total/passed/failed/timedOut 取自 Runner 自身计数，
 * duration 取自各用例真实耗时之和 —— LLM 输出永远不得触碰这些字段
 * （否则测试平台的结果会被模型输出污染）。
 */
export function summaryFromOutcome(outcome: ExecutionOutcome, durationMs?: number): AnalysisSummary {
  const realDuration = durationMs ?? outcome.results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const summary = computeAnalysisSummary(outcome.total, outcome.passed, outcome.timedOut, realDuration);
  // passRate 直接采用 Runner 计算值（同一公式，避免重复舍入产生漂移）
  summary.passRate = outcome.passRate;
  return summary;
}

/** 计算汇总 */
export function computeAnalysisSummary(
  total: number,
  passed: number,
  timedOut: number,
  durationMs: number,
): AnalysisSummary {
  const failed = total - passed - timedOut;
  const passRate = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
  // total=0 没有任何执行证据，必须 fail-close；不能把“没有失败”解释成“通过”。
  const noEvidence = total <= 0;
  // 任一硬失败 → fail；仅超时/待处理 → partial；有证据且全部通过 → pass
  const overall: AnalysisSummary['overall'] = noEvidence || failed > 0 ? 'fail' : timedOut > 0 ? 'partial' : 'pass';
  const exitCode = noEvidence ? 1 : timedOut > 0 ? 3 : failed > 0 ? 1 : 0;
  return { total, passed, failed, timedOut, passRate, durationMs, exitCode, overall };
}

/** 判断数据是否「像 AnalysisReport」 */
export function isAnalysisLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).feature === 'string'
  );
}

/**
 * 归一化外部产出的 AnalysisReport（过滤非法结论，重算汇总）。
 * trustedSummary：由真实执行结果计算的汇总（summaryFromOutcome）——提供时**逐字采用**，
 * data.summary（可能来自 LLM 输出）整体丢弃：统计字段（total/passed/failed/timedOut/duration/
 * exitCode/overall）只能由 Deterministic Summary 产生，模型只能贡献 findings/aiSummary/recommendations。
 */
export function normalizeAnalysis(data: Record<string, unknown>, opts: { trustedSummary?: AnalysisSummary } = {}): AnalysisReport {
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .filter((f) => typeof f === 'object' && f !== null)
    .map((f) => {
      const raw = f as Record<string, unknown>;
      const type = ['pass', 'fail', 'flaky', 'blocked', 'info'].includes(String(raw.type)) ? String(raw.type) as FindingType : 'info';
      const severity = ['high', 'medium', 'low'].includes(String(raw.severity)) ? String(raw.severity) as 'high' | 'medium' | 'low' : 'medium';
      return {
        type,
        caseId: raw.caseId !== undefined ? String(raw.caseId) : undefined,
        title: String(raw.title ?? ''),
        detail: String(raw.detail ?? ''),
        severity,
        suggestion: String(raw.suggestion ?? ''),
      };
    })
    .filter((f) => f.title.length > 0);

  const failedCases = (Array.isArray(data.failedCases) ? data.failedCases : []).map((c) => c as CaseExecutionResult);
  const failed = failedCases.length;

  // 汇总两条路径：可信汇总（真实执行结果）逐字采用；否则按归一化输入兜底（外部数据源兼容）
  const summary = opts.trustedSummary
    ? opts.trustedSummary
    : (() => {
      const s = data.summary as { total?: number; passed?: number; timedOut?: number; durationMs?: number } | undefined;
      const total = typeof s?.total === 'number' ? s.total : failed;
      const passed = typeof s?.passed === 'number' ? s.passed : total - failed;
      const timedOut = typeof s?.timedOut === 'number' ? s.timedOut : 0;
      const durationMs = typeof s?.durationMs === 'number' ? s.durationMs : 0;
      return computeAnalysisSummary(total, passed, timedOut, durationMs);
    })();

  return {
    feature: String(data.feature ?? ''),
    summary,
    findings,
    failedCases,
    topFailures: failedCases.slice(0, 10).map((c) => ({ caseId: c.caseId, name: c.name, error: c.error })),
    recommendations: Array.isArray(data.recommendations) ? data.recommendations.map(String) : [],
    memoryWorthy: Array.isArray(data.memoryWorthy) ? data.memoryWorthy as MemoryWorthyFailure[] : toMemoryWorthy(failedCases),
    aiSummary: data.aiSummary !== undefined ? String(data.aiSummary) : undefined,
    source: data.source !== undefined ? String(data.source) : undefined,
  };
}
