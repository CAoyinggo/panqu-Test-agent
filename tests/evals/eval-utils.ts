// Agent Evaluation：评测工具（Phase 18）
// 集合准确率（precision/recall/F1）、维度评分、Agent Quality Score 汇总。
import { AgentTrace } from '../../src/agents/observability/observability-schema.js';

/** 集合评分 */
export interface SetScore {
  precision: number; // 0~1
  recall: number;    // 0~1
  f1: number;        // 0~1
}

/** 集合 F1：actual 覆盖 expected 的程度（大小写不敏感） */
export function setScore(actual: string[], expected: string[]): SetScore {
  const a = new Set(actual.map((x) => x.toLowerCase()));
  const e = new Set(expected.map((x) => x.toLowerCase()));
  if (e.size === 0) {
    return a.size === 0 ? { precision: 1, recall: 1, f1: 1 } : { precision: 0, recall: 0, f1: 0 };
  }
  let inter = 0;
  for (const x of a) if (e.has(x)) inter++;
  const precision = a.size === 0 ? 0 : inter / a.size;
  const recall = inter / e.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** 单值匹配（0/1） */
export function exactMatch(actual: unknown, expected: unknown): number {
  return String(actual).toLowerCase() === String(expected).toLowerCase() ? 1 : 0;
}

/** 均值（空列表返回 0） */
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, x) => s + x, 0) / values.length;
}

/** 转百分比（0~100，保留 1 位小数） */
export function pct(v: number): number {
  return Math.round(v * 1000) / 10;
}

/** 评测维度 */
export interface EvalDimension {
  key: string;
  label: string;
  /** 0~100 */
  score: number;
  passed: number;
  total: number;
  detail?: string;
}

/** 质量报告 */
export interface QualityReport {
  taskId: string;
  createdAt: string;
  dimensions: EvalDimension[];
  /** 加权平均（0~100） */
  overall: number;
  /** 回退率 0~1 */
  fallbackRate: number;
  /** 幻觉率 0~1 */
  hallucinationRate: number;
  /** 估算 token 成本 */
  tokenCost: number;
  /** 总耗时（ms） */
  latencyMs: number;
  meta: Record<string, unknown>;
}

/** 从 Trace 提取成本指标 */
export function traceMetrics(trace: AgentTrace | undefined): { tokenCost: number; latencyMs: number; tokenTotal: number } {
  if (!trace) return { tokenCost: 0, latencyMs: 0, tokenTotal: 0 };
  return {
    tokenCost: trace.totalCost ?? 0,
    latencyMs: trace.totalLatencyMs,
    tokenTotal: trace.totalTokens,
  };
}

/** 汇总质量报告：维度加权（requirements 0.25 / rca 0.25 / healing 0.15 / defect 0.15 / risk 0.2） */
export function buildQualityReport(
  dimensions: EvalDimension[],
  weights: Record<string, number>,
  meta: QualityReport['meta'] = {},
): QualityReport {
  const overall = dimensions.reduce((s, d) => s + d.score * (weights[d.key] ?? 0), 0);
  return {
    taskId: `eval-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    dimensions,
    overall: Math.round(overall * 10) / 10,
    fallbackRate: 0,
    hallucinationRate: 0,
    tokenCost: 0,
    latencyMs: 0,
    meta,
  };
}

/** 填充报告中的成本/回退/幻觉指标 */
export function finalizeReport(report: QualityReport, extras: Partial<QualityReport>): QualityReport {
  return { ...report, ...extras };
}
