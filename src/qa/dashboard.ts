// Agent KPI Dashboard（Phase 20.8）
// 聚合单次 Agent 运行的 KPI，持久化到 output/<date>/agent-summary.json
// 指标：需求理解 / 用例（按优先级）/ 执行（通过率）/ 分析（RCA / 缺陷 / 自愈 / 审批）/
//       覆盖 / 可观测（Agent / LLM / Tool / Token / 耗时）
// 供 QA 复盘、Dashboard 展示与「人工 vs Agent」对照实验复用。
import fs from 'node:fs';
import type { AgentPipelineResult } from '../agents/orchestration/agent-pipeline.js';
import { outputDir, todayStr, writeJson } from '../utils/fs-utils.js';

/** 单次 Agent 运行的 KPI 快照 */
export interface AgentDashboard {
  taskId: string;
  feature: string;
  environment: string;
  at: string;
  requirement: {
    feature: string;
    confidence?: number;
    capabilities: number;
    inputs: number;
    businessRules: number;
    risks: number;
  };
  testCases: { total: number; byPriority: Record<string, number>; assertions: number };
  execution: { executed: boolean; total: number; passed: number; failed: number; timedOut: number; passRate: number };
  analysis: {
    rcas: number;
    defects: number;
    healingSuggestions: number;
    approvals: number;
    approved: number;
    rejected: number;
    pending: number;
  };
  coverage: Record<string, number>;
  observability: {
    agentCalls: number;
    llmCalls: number;
    toolCalls: number;
    tokensUsed: number;
    durationMs: number;
    traceSummary?: string;
  };
  summary: string;
}

/** 由 Agent 流水线结果构建 Dashboard */
export function buildAgentDashboard(
  result: AgentPipelineResult,
  meta: { environment?: string; at?: string } = {},
): AgentDashboard {
  const byPriority: Record<string, number> = {};
  let assertions = 0;
  for (const c of result.testCases) {
    byPriority[c.priority] = (byPriority[c.priority] ?? 0) + 1;
    assertions += (c.assertions ?? []).length;
  }

  const coverage: Record<string, number> = {};
  for (const d of result.coverage?.dimensions ?? []) coverage[d.name] = d.rate;

  const approved = result.approvalResults?.filter((r) => r.verdict === 'approved').length ?? 0;
  const rejected = result.approvalResults?.filter((r) => r.verdict === 'rejected').length ?? 0;
  const pending = result.approvalResults?.filter((r) => r.verdict === 'pending').length ?? 0;

  const budget = result.budgetStatus;
  const trace = result.trace;

  const dashboard: AgentDashboard = {
    taskId: result.taskId,
    feature: result.requirement.feature,
    environment: meta.environment ?? 'test',
    at: meta.at ?? new Date().toISOString(),
    requirement: {
      feature: result.requirement.feature,
      confidence: result.requirement.confidence,
      capabilities: (result.requirement.capabilities ?? []).length,
      inputs: (result.requirement.inputs ?? []).length,
      businessRules: (result.requirement.businessRules ?? []).length,
      risks: (result.requirement.risks ?? []).length,
    },
    testCases: { total: result.testCases.length, byPriority, assertions },
    execution: {
      executed: result.outcome.executed ?? false,
      total: result.outcome.total,
      passed: result.outcome.passed,
      failed: result.outcome.failed,
      timedOut: result.outcome.timedOut,
      passRate: result.outcome.passRate,
    },
    analysis: {
      rcas: result.rcas?.length ?? 0,
      defects: result.defects?.length ?? 0,
      healingSuggestions: result.healing?.suggestions?.length ?? 0,
      approvals: result.approvals?.length ?? 0,
      approved,
      rejected,
      pending,
    },
    coverage,
    observability: {
      agentCalls: budget?.agentCalls ?? 0,
      llmCalls: budget?.llmCalls ?? 0,
      toolCalls: budget?.toolCalls ?? 0,
      tokensUsed: budget?.tokensUsed ?? 0,
      durationMs: result.durationMs,
      traceSummary: trace?.summary,
    },
    summary: `${result.requirement.feature}：${result.testCases.length} 条用例，通过 ${result.outcome.passed}/${result.outcome.total}，RCA ${result.rcas?.length ?? 0}，缺陷 ${result.defects?.length ?? 0}，自愈 ${result.healing?.suggestions?.length ?? 0}，退出码 ${result.exitCode}`,
  };
  return dashboard;
}

/** 持久化到 output/<date>/agent-summary.json，返回文件路径 */
export function saveAgentDashboard(result: AgentPipelineResult, meta: { environment?: string; at?: string } = {}): string {
  const dashboard = buildAgentDashboard(result, meta);
  const dir = outputDir();
  const file = `${dir}/agent-summary.json`;
  writeJson(file, dashboard);
  return file;
}

/** 读取最新 Dashboard（output/<date>/agent-summary.json），不存在返回 null */
export function loadLatestDashboard(): AgentDashboard | null {
  const file = `${outputDir()}/agent-summary.json`;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as AgentDashboard;
  } catch {
    return null;
  }
}

/** 供脚本使用：输出目录的日期字符串（测试友好） */
export function dashboardDate(): string {
  return todayStr();
}
