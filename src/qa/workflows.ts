// QA Workflow：4 种日常模式（Phase 20.6）
// 模式 A：--requirement <file> 从需求开始全流程
// 模式 B：--requirement <file> --plan-only 只生成测试（Requirement/TestDesign/Risk/Coverage）
// 模式 C：--analyze result.json --rca 只分析失败（RCA → Defect → Healing → Approval）
// 模式 D：--resume task-id 恢复任务（RCA → Healing → Approval → 应用 → 重新执行）
// 任务记录 TaskRecord 持久化于 output/tasks/<taskId>.json，供 Mode D 恢复。
import fs from 'node:fs';
import path from 'node:path';
import type { AgentContext } from '../agents/core/agent-context.js';
import type { CaseExecutionResult, ExecutionOutcome } from '../agents/execution/execution-schema.js';
import { computeOutcome, normalizeCaseExecutionResult, normalizeOutcome } from '../agents/execution/execution-schema.js';
import type { RootCauseAnalysis } from '../agents/analysis/root-cause-schema.js';
import { RootCauseAgent } from '../agents/analysis/root-cause-agent.js';
import type { DefectDraft } from '../agents/defect/defect-schema.js';
import { DefectAgent } from '../agents/defect/defect-agent.js';
import type { HealingAnalysis, HealingSuggestion } from '../agents/self-healing/healing-schema.js';
import { SelfHealingAgent } from '../agents/self-healing/self-healing-agent.js';
import { applyHealingPatch } from '../agents/self-healing/healing-loop.js';
import { ExecutionAgent } from '../agents/execution/execution-agent.js';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { ApprovalRequest, ApprovalResult } from '../agents/approval/approval-schema.js';
import type { AuditEntry } from '../agents/approval/approval-audit.js';
import { buildApprovalRequests } from '../agents/orchestration/agent-pipeline.js';
import { RiskAgent } from '../agents/risk/risk-agent.js';
import {
  evaluateExecutionPolicy,
  type ExecutionApproval,
  type PolicyGateResult,
  type ProjectExecutionPolicy,
} from '../agents/policy/policy-gate.js';
import type { Requirement } from '../agents/requirement/requirement-schema.js';
import { resolveEnvironmentTier } from '../config/environment-policy.js';

/**
 * 归一化各种执行结果输入为 ExecutionOutcome。
 * 支持：ExecutionOutcome / CaseExecutionResult[] / agent-summary.json（含 outcome / execution.outcome）。
 */
export function normalizeExecutionOutcome(input: unknown): ExecutionOutcome {
  if (Array.isArray(input)) {
    const results = input
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => normalizeCaseExecutionResult(r));
    const feature = results[0]?.feature ?? 'default';
    return computeOutcome(feature, results, { reports: [], executed: true });
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('无法解析执行结果：需 ExecutionOutcome / CaseExecutionResult[] / agent-summary.json');
  }
  const data = input as Record<string, unknown>;
  let nested = (data.outcome ?? data.execution) as Record<string, unknown> | undefined;
  // 兼容 execution: { outcome: ExecutionOutcome } 再包一层的形态
  if (nested && !Array.isArray(nested.results) && nested.outcome && typeof nested.outcome === 'object') {
    nested = nested.outcome as Record<string, unknown>;
  }
  if (nested && Array.isArray(nested.results)) {
    return normalizeOutcome(nested);
  }
  if (Array.isArray(data.results)) {
    return normalizeOutcome(data);
  }
  throw new Error('无法识别执行结果格式（缺少 results 数组）');
}

/** 失败分析选项 */
export interface AnalyzeFailuresOptions {
  maxRca?: number;
  maxDefects?: number;
  autoApprove?: boolean;
}

/** 失败分析输出（Mode C） */
export interface AnalyzeFailuresOutput {
  feature: string;
  failedCount: number;
  rcas: RootCauseAnalysis[];
  defects: DefectDraft[];
  healing?: HealingAnalysis;
  approvals: ApprovalRequest[];
  approvalResults: ApprovalResult[];
  audit: AuditEntry[];
  summary: string;
}

/** Mode C：只分析失败（RCA → Defect → Healing → Approval），不执行 */
export async function analyzeFailures(
  outcome: ExecutionOutcome,
  context: AgentContext,
  options: AnalyzeFailuresOptions = {},
): Promise<AnalyzeFailuresOutput> {
  const env = context.environment ?? 'test';
  const maxRca = options.maxRca ?? 10;
  const maxDefects = options.maxDefects ?? 10;
  const failedCases = outcome.results.filter((r) => !r.pass && !r.timedOut);
  const feature = outcome.feature;

  // 1. RCA：逐条失败用例证据链根因分析
  const rcas: RootCauseAnalysis[] = [];
  const rootAgent = new RootCauseAgent();
  for (const fc of failedCases.slice(0, maxRca)) {
    try {
      rcas.push(await rootAgent.execute({ executionResult: fc, outcome, environment: env }, context));
    } catch (e) {
      context.logger.warn(`[Analyze] RCA 跳过 ${fc.caseId}: ${(e as Error).message}`);
    }
  }

  // 2. Defect：仅 DRAFT 草稿
  const defects: DefectDraft[] = [];
  if (failedCases.length) {
    try {
      const defAgent = new DefectAgent();
      defects.push(...(await defAgent.execute(
        { feature, environment: env, failedCases: failedCases.slice(0, maxDefects), rcas, outcome },
        context,
      )));
    } catch (e) {
      context.logger.warn(`[Analyze] Defect 生成失败: ${(e as Error).message}`);
    }
  }

  // 3. Healing：仅 SUGGESTED 建议
  let healing: HealingAnalysis | undefined;
  if (failedCases.length) {
    try {
      const healAgent = new SelfHealingAgent();
      healing = await healAgent.execute({ feature, failedCases }, context);
    } catch (e) {
      context.logger.warn(`[Analyze] Healing 分析失败: ${(e as Error).message}`);
    }
  }

  // 4. Approval：分级审批 + 审计
  const built = buildApprovalRequests(env, defects, healing, options.autoApprove ?? false);

  return {
    feature,
    failedCount: failedCases.length,
    rcas,
    defects,
    healing,
    approvals: built.requests,
    approvalResults: built.results,
    audit: built.audit,
    summary: `分析 ${feature}：失败 ${failedCases.length} 条，RCA ${rcas.length}，缺陷草稿 ${defects.length}，自愈建议 ${healing?.suggestions.length ?? 0}，审批 ${built.requests.length}（approved ${built.results.filter((r) => r.verdict === 'approved').length} / pending ${built.results.filter((r) => r.verdict === 'pending').length} / rejected ${built.results.filter((r) => r.verdict === 'rejected').length}）`,
  };
}

/**
 * 任务记录（Mode D 恢复依据），持久化于 output/tasks/<runId>.json。
 * 标识三件套分别保存（解决「同需求并发运行冲突 / 记录覆盖」）：
 *   runId            —— 文件名（每次运行唯一，绝不互相覆盖）；
 *   taskId           —— 稳定任务标识（需求哈希派生，同需求跨运行一致，供聚合/检索）；
 *   requirementsHash —— 需求内容 SHA-256；createdAt —— 运行创建时间。
 * 兼容：旧记录（无 runId）按 <taskId>.json 读写。
 */
export interface TaskRecord {
  /** 本次运行唯一标识（ULID；缺省时回退以 taskId 命名，兼容旧记录） */
  runId?: string;
  /** 稳定任务标识（需求哈希派生） */
  taskId: string;
  /** 需求内容哈希（SHA-256，归一化后） */
  requirementsHash?: string;
  /** 运行创建时间（ISO） */
  createdAt?: string;
  feature: string;
  requirement: string;
  environment: string;
  testCases: TestCase[];
  outcome: ExecutionOutcome;
  failedCases: CaseExecutionResult[];
  updatedAt: string;
}

export const DEFAULT_TASK_DIR = path.resolve('output', 'tasks');

/** 记录文件名：优先 runId（并发安全），旧记录回退 taskId */
function recordFileName(record: TaskRecord): string {
  return `${record.runId ?? record.taskId}.json`;
}

export function saveTaskRecord(record: TaskRecord, dir: string = DEFAULT_TASK_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, recordFileName(record));
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return file;
}

/**
 * 加载任务记录：按 runId（ULID，新记录）→ taskId（旧记录）两段查找。
 * --resume 传 runId 可精确恢复某次运行；传 taskId 恢复旧格式记录。
 */
export function loadTaskRecord(id: string, dir: string = DEFAULT_TASK_DIR): TaskRecord | null {
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TaskRecord;
  } catch {
    return null;
  }
}

/** 列出全部任务记录（按创建时间倒序；runId 时间有序，便于 --resume 选择） */
export function listTaskRecords(dir: string = DEFAULT_TASK_DIR): TaskRecord[] {
  if (!fs.existsSync(dir)) return [];
  const records: TaskRecord[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TaskRecord);
    } catch { /* 跳过损坏记录 */ }
  }
  // runId（ULID）字典序即创建序：倒序 = 最新在前
  return records.sort((a, b) => (b.runId ?? '').localeCompare(a.runId ?? ''));
}

/** 恢复任务选项 */
export interface ResumeTaskOptions {
  maxRca?: number;
  maxDefects?: number;
  autoApprove?: boolean;
  concurrency?: number;
  /** 仅可信审批中心可注入；autoApprove 不能代替执行审批。 */
  executionApproval?: ExecutionApproval;
  projectPolicy?: ProjectExecutionPolicy;
}

/** 恢复任务输出（Mode D） */
export interface ResumeTaskOutput {
  taskId: string;
  rcas: RootCauseAnalysis[];
  defects: DefectDraft[];
  healing?: HealingAnalysis;
  approvals: ApprovalRequest[];
  approvalResults: ApprovalResult[];
  /** 获批并已应用的自愈补丁 */
  applied: Array<{ suggestion: HealingSuggestion; caseId: string; diff: string }>;
  reexecuted?: ExecutionOutcome;
  policyGate?: PolicyGateResult;
  recoveredCount: number;
  stillFailed: CaseExecutionResult[];
  summary: string;
}

/**
 * Mode D：恢复任务（RCA → Healing → Approval → 应用获批补丁 → 重新执行）。
 * runner 可选：注入自定义执行器便于测试；缺省用 ExecutionAgent（需 execution.run Tool）。
 */
export async function resumeTask(
  record: TaskRecord,
  context: AgentContext,
  runner?: (def: TestCase) => Promise<CaseExecutionResult>,
  options: ResumeTaskOptions = {},
): Promise<ResumeTaskOutput> {
  const env = record.environment ?? 'test';
  const failedCases = record.failedCases.length
    ? record.failedCases
    : record.outcome.results.filter((r) => !r.pass);

  // 1. RCA
  const rcas: RootCauseAnalysis[] = [];
  const rootAgent = new RootCauseAgent();
  for (const fc of failedCases.slice(0, options.maxRca ?? 10)) {
    try {
      rcas.push(await rootAgent.execute({ executionResult: fc, outcome: record.outcome, environment: env }, context));
    } catch (e) {
      context.logger.warn(`[Resume] RCA 跳过 ${fc.caseId}: ${(e as Error).message}`);
    }
  }

  // 2. Defect + Healing
  const defects: DefectDraft[] = [];
  if (failedCases.length) {
    try {
      const defAgent = new DefectAgent();
      defects.push(...(await defAgent.execute(
        { feature: record.feature, environment: env, failedCases, rcas, outcome: record.outcome },
        context,
      )));
    } catch (e) {
      context.logger.warn(`[Resume] Defect 生成失败: ${(e as Error).message}`);
    }
  }
  let healing: HealingAnalysis | undefined;
  if (failedCases.length) {
    try {
      const healAgent = new SelfHealingAgent();
      healing = await healAgent.execute({ feature: record.feature, failedCases }, context);
    } catch (e) {
      context.logger.warn(`[Resume] Healing 分析失败: ${(e as Error).message}`);
    }
  }

  // 3. Approval
  const built = buildApprovalRequests(env, defects, healing, options.autoApprove ?? false);

  // 4. 应用获批的自愈建议（仅修改 Test DSL 副本）
  const applied: ResumeTaskOutput['applied'] = [];
  const healedByCase = new Map<string, TestCase>();
  for (const s of healing?.suggestions ?? []) {
    const verdict = built.results.find((r) => r.requestId === `apr-heal-${s.id}`)?.verdict;
    if (verdict !== 'approved') continue;
    const tc = record.testCases.find((t) => t.id === s.caseId);
    if (!tc) continue;
    const { def, diff } = applyHealingPatch(s, tc);
    healedByCase.set(s.caseId, def);
    applied.push({ suggestion: s, caseId: s.caseId, diff });
  }

  // 5. 重新执行：仅当有获批并应用的自愈补丁时才回归（Approval → Execution 门禁）
  let reexecuted: ExecutionOutcome | undefined;
  let policyGate: PolicyGateResult | undefined;
  if (applied.length > 0) {
    const candidates = applied
      .map((item) => healedByCase.get(item.caseId))
      .filter((item): item is TestCase => Boolean(item));

    // Resume 不是审批旁路：production 必须基于当前补丁重新评估 Risk、重建 Plan 并再过 Gate。
    if (resolveEnvironmentTier(env) === 'production' && candidates.length > 0) {
      const requirement: Requirement = {
        feature: record.feature,
        goal: record.requirement,
        capabilities: [],
        inputs: [],
        requirements: [],
        businessRules: [],
        dependencies: [],
        constraints: [],
        risks: [],
        source: record.requirement,
      };
      const risk = await new RiskAgent().execute({ requirement, testCases: candidates, environment: env }, context);
      const plan = new ExecutionAgent().planExecution(candidates, options.concurrency ?? 1, {
        policy: { realExecution: true },
      });
      policyGate = evaluateExecutionPolicy({
        requirement,
        risk,
        testCases: candidates,
        environment: env,
        executionPlan: plan,
        approval: options.executionApproval,
        projectPolicy: options.projectPolicy,
      });
      if (!policyGate.allowed) {
        context.logger.warn(`[Resume] Policy Gate ${policyGate.verdict}：${policyGate.reasons.join('；')}`);
      }
    }

    if (policyGate && !policyGate.allowed) {
      reexecuted = undefined;
    } else if (runner) {
      const results: CaseExecutionResult[] = [];
      for (const s of applied) {
        const def = healedByCase.get(s.caseId);
        if (!def) continue;
        results.push(await runner(def));
      }
      if (results.length) reexecuted = computeOutcome(record.feature, results, { reports: [], executed: true });
    } else {
      const healedCases = [...healedByCase.values()];
      if (healedCases.length) {
        const execAgent = new ExecutionAgent();
        reexecuted = await execAgent.execute(
          { testCases: healedCases, environment: env, options: { concurrency: options.concurrency } },
          context,
        );
      }
    }
  }

  const recoveredCount = reexecuted ? reexecuted.results.filter((r) => r.pass).length : 0;
  const stillFailed = reexecuted ? reexecuted.results.filter((r) => !r.pass) : failedCases;

  return {
    taskId: record.taskId,
    rcas,
    defects,
    healing,
    approvals: built.requests,
    approvalResults: built.results,
    applied,
    reexecuted,
    ...(policyGate ? { policyGate } : {}),
    recoveredCount,
    stillFailed,
    summary: `恢复任务 ${record.taskId}：RCA ${rcas.length}，缺陷草稿 ${defects.length}，自愈建议 ${healing?.suggestions.length ?? 0}，获批并应用 ${applied.length} 条，重新执行 ${reexecuted?.total ?? 0} 条（恢复 ${recoveredCount}，仍失败 ${stillFailed.length}）`,
  };
}
