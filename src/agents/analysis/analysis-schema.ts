// Analysis Schema：AI 测试分析报告的数据模型 + 归一化
// 目标：Analysis Agent 结合 Requirement / TestCase / 执行结果 / 风险评估，
// 产出根因定位 + 改进建议 + 待记忆的失败记录（供 Memory 层持久化）。
// 报告字段与现有 CheckResult/IssueItem 语义对齐，便于报告渲染复用。

import type { CaseExecutionResult } from '../execution/execution-schema.js';

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

/** 计算汇总 */
export function computeAnalysisSummary(
  total: number,
  passed: number,
  timedOut: number,
  durationMs: number,
): AnalysisSummary {
  const failed = total - passed - timedOut;
  const passRate = total > 0 ? Math.round((passed / total) * 1000) / 10 : 0;
  // 任一硬失败 → fail；仅超时/待处理 → partial；全部通过 → pass
  const overall: AnalysisSummary['overall'] = failed > 0 ? 'fail' : timedOut > 0 ? 'partial' : 'pass';
  const exitCode = timedOut > 0 ? 3 : failed > 0 ? 1 : 0;
  return { total, passed, failed, timedOut, passRate, durationMs, exitCode, overall };
}

/** 判断数据是否「像 AnalysisReport」 */
export function isAnalysisLike(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === 'object' && data !== null
    && typeof (data as Record<string, unknown>).feature === 'string'
  );
}

/** 归一化外部产出的 AnalysisReport（过滤非法结论，重算汇总） */
export function normalizeAnalysis(data: Record<string, unknown>): AnalysisReport {
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
  const s = data.summary as { total?: number; passed?: number; timedOut?: number; durationMs?: number } | undefined;
  const total = typeof s?.total === 'number' ? s.total : failed;
  const passed = typeof s?.passed === 'number' ? s.passed : total - failed;
  const timedOut = typeof s?.timedOut === 'number' ? s.timedOut : 0;
  const durationMs = typeof s?.durationMs === 'number' ? s.durationMs : 0;

  return {
    feature: String(data.feature ?? ''),
    summary: computeAnalysisSummary(total, passed, timedOut, durationMs),
    findings,
    failedCases,
    topFailures: failedCases.slice(0, 10).map((c) => ({ caseId: c.caseId, name: c.name, error: c.error })),
    recommendations: Array.isArray(data.recommendations) ? data.recommendations.map(String) : [],
    memoryWorthy: Array.isArray(data.memoryWorthy) ? data.memoryWorthy as MemoryWorthyFailure[] : toMemoryWorthy(failedCases),
    aiSummary: data.aiSummary !== undefined ? String(data.aiSummary) : undefined,
    source: data.source !== undefined ? String(data.source) : undefined,
  };
}
