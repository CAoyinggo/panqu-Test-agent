// Agent Pipeline：统一串联 AI 测试流程（Phase 10-18 全链路增强）
// 核心阶段：Requirement → TestDesign → Risk → Data → Execution → Analysis → Memory
// 增强阶段：Selection（智能选择）→ Coverage（覆盖缺口）→ RCA（根因）→ Defect（草稿）→
//           Healing（自愈建议）→ Approval（分级审批）；集成 Trace（可观测）与 Budget（预算控制）。
// 确定性优先：增强阶段 LLM 失败自动回退规则；缺陷仅 DRAFT、自愈仅 SUGGESTED；
//            审批按 环境×严重度×操作 分级（生产危险操作 DENY）；
//            增强阶段失败不中断主流程，核心阶段失败向上抛出。
// 依赖注入：所有 Agent 与 Tool 从 AgentContext（llm/tools/memory/logger）解析，便于离线测试与 CLI 复用。

import type { AgentContext } from '../core/agent-context.js';
import type { TestMemory } from '../memory/memory-store.js';
import { NoopMemory } from '../memory/memory-store.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { RiskAssessment } from '../risk/risk-schema.js';
import type { DataPlan } from '../data/data-schema.js';
import type { DataContext } from '../../core/types.js';
import type { ExecutionOutcome } from '../execution/execution-schema.js';
import type { AnalysisReport } from '../analysis/analysis-schema.js';
import { RequirementAgent } from '../requirement/requirement-agent.js';
import { TestDesignAgent } from '../test-design/test-design-agent.js';
import { RiskAgent } from '../risk/risk-agent.js';
import { DataAgent } from '../data/data-agent.js';
import { ExecutionAgent } from '../execution/execution-agent.js';
import { AnalysisAgent } from '../analysis/analysis-agent.js';
import { storeAnalysisToMemory, buildHistoricalRiskItems } from '../memory/memory-bridge.js';
import type { TestSelection } from '../test-selection/selection-schema.js';
import { TestSelectionAgent } from '../test-selection/test-selection-agent.js';
import type { CoverageAnalysis } from '../coverage/coverage-schema.js';
import { CoverageAgent } from '../coverage/coverage-agent.js';
import type { RootCauseAnalysis } from '../analysis/root-cause-schema.js';
import { RootCauseAgent } from '../analysis/root-cause-agent.js';
import type { DefectDraft } from '../defect/defect-schema.js';
import { DefectAgent } from '../defect/defect-agent.js';
import type { HealingAnalysis } from '../self-healing/healing-schema.js';
import { SelfHealingAgent } from '../self-healing/self-healing-agent.js';
import type { ApprovalRequest, ApprovalResult } from '../approval/approval-schema.js';
import { evaluateApproval } from '../approval/approval-policy.js';
import { ApprovalAuditLog } from '../approval/approval-audit.js';
import type { AuditEntry } from '../approval/approval-audit.js';
import type { AgentTrace } from '../observability/observability-schema.js';
import { AgentTracer } from '../observability/tracer.js';
import type { BudgetLimits, BudgetStatus } from '../observability/budget.js';
import { AgentBudget } from '../observability/budget.js';

/** Pipeline 输入 */
export interface AgentPipelineInput {
  /** 自然语言测试需求 */
  requirementText: string;
  environment?: string;
  options?: {
    autoSetup?: boolean;
    dryRun?: boolean;
    concurrency?: number;
    /** 跳过实际执行（仅产出计划与预分析） */
    skipExecution?: boolean;
    // —— Phase 10-18 增强开关（默认开启） ——
    /** 智能测试选择（Selection） */
    runSelection?: boolean;
    /** 覆盖缺口分析（Coverage） */
    runCoverage?: boolean;
    /** 失败用例根因分析（RCA） */
    runRca?: boolean;
    /** 缺陷草稿（Defect，仅 DRAFT） */
    runDefect?: boolean;
    /** 自愈建议（Healing，仅 SUGGESTED） */
    runHealing?: boolean;
    /** 分级审批（Approval） */
    runApproval?: boolean;
    /** Agent Trace（可观测性） */
    runTrace?: boolean;
    /** 用选中用例集执行（默认 false：保持全量执行，Selection 仅记录建议） */
    useSelection?: boolean;
    /** 自动批准 REVIEW 级审批（默认 false：REVIEW/MANUAL 保持 pending） */
    autoApprove?: boolean;
    /** RCA 失败用例上限（默认 10） */
    maxRca?: number;
    /** 缺陷草稿上限（默认 10） */
    maxDefects?: number;
    /** 预算上限（不传则不限制） */
    budget?: BudgetLimits;
  };
}

/** Pipeline 结果：各阶段产物 + 最终报告 + 退出码 + 增强产物 */
export interface AgentPipelineResult {
  taskId: string;
  requirement: Requirement;
  testCases: TestCase[];
  risk: RiskAssessment;
  dataPlan: DataPlan;
  dataContext: DataContext;
  outcome: ExecutionOutcome;
  report: AnalysisReport;
  /** 各阶段是否成功 */
  stages: Record<string, boolean>;
  durationMs: number;
  /** 退出码：0 全过 / 1 有失败 / 3 超时 */
  exitCode: number;
  // —— Phase 10-18 增强产物（可选） ——
  /** 智能测试选择（选中/跳过/理由） */
  selection?: TestSelection;
  /** 覆盖缺口分析 */
  coverage?: CoverageAnalysis;
  /** 失败用例根因分析 */
  rcas?: RootCauseAnalysis[];
  /** 缺陷草稿（仅 DRAFT，未提交） */
  defects?: DefectDraft[];
  /** 自愈建议（仅 SUGGESTED，未应用） */
  healing?: HealingAnalysis;
  /** 审批请求 */
  approvals?: ApprovalRequest[];
  /** 审批结论 */
  approvalResults?: ApprovalResult[];
  /** 审批审计日志 */
  audit?: AuditEntry[];
  /** Agent Trace（观测汇总） */
  trace?: AgentTrace;
  /** 预算使用状态 */
  budgetStatus?: BudgetStatus;
}

/** 阶段执行上下文（Trace + Budget 共享） */
interface StageCtx {
  logger: AgentContext['logger'];
  tracer?: AgentTracer;
  budget?: AgentBudget;
}

/**
 * 执行一个阶段：预算检查 → Trace span → 执行 → 记录结果。
 * essential=true：预算超限仅告警继续，失败向上抛出（核心阶段）。
 * essential=false：预算超限或失败则跳过该阶段（增强阶段，不中断主流程）。
 */
async function runStage<T>(
  ctx: StageCtx,
  agentName: string,
  stageName: string,
  essential: boolean,
  fn: () => Promise<T>,
  stages: Record<string, boolean>,
): Promise<T | undefined> {
  const { logger, tracer, budget } = ctx;
  if (budget) {
    budget.addAgentCall();
    const b = budget.check();
    if (!b.ok) {
      if (!essential) {
        logger.warn(`[Pipeline] ${stageName} 因预算超限跳过（${b.exceeded.join('，')}）`);
        stages[stageName] = false;
        return undefined;
      }
      logger.warn(`[Pipeline] ${stageName} 预算超限但为关键阶段继续（${b.exceeded.join('，')}）`);
    }
  }
  const spanId = tracer?.startSpan(agentName, stageName);
  try {
    const value = await fn();
    if (spanId) tracer?.endSpan(spanId, { success: true, status: 'ok' });
    stages[stageName] = true;
    return value;
  } catch (e) {
    const msg = (e as Error).message;
    if (spanId) tracer?.endSpan(spanId, { success: false, status: 'error', error: msg });
    logger.error(`[Pipeline] ${stageName} 失败：${msg}`);
    stages[stageName] = false;
    if (essential) throw e;
    return undefined;
  }
}

/** 由缺陷草稿与自愈建议生成分级审批请求（决策一律按 环境×严重度×操作 规则判定） */
export function buildApprovalRequests(
  env: string,
  defects: DefectDraft[],
  healing: HealingAnalysis | undefined,
  autoApprove: boolean,
): { requests: ApprovalRequest[]; results: ApprovalResult[]; audit: AuditEntry[] } {
  const auditLog = new ApprovalAuditLog();
  const requests: ApprovalRequest[] = [];
  const results: ApprovalResult[] = [];
  const now = () => new Date().toISOString();

  const push = (req: ApprovalRequest): void => {
    requests.push(req);
    // 决策 → 结论：DENY 拒绝；AUTO 通过；REVIEW/MANUAL 依 autoApprove（默认 pending 等人工）
    let verdict: ApprovalResult['verdict'];
    if (req.decision === 'DENY') verdict = 'rejected';
    else if (req.decision === 'AUTO') verdict = 'approved';
    else verdict = autoApprove ? 'approved' : 'pending';
    results.push({ requestId: req.id, verdict, decision: req.decision, at: now() });
    auditLog.record(req, verdict, req.decision === 'AUTO' || autoApprove ? 'system' : 'user', req.reason);
  };

  // 缺陷草稿 → create-defect（即使测试环境 P2/P3 也需人工确认，不自动创建正式缺陷）
  for (const d of defects) {
    const ev = evaluateApproval({ environment: env, severity: d.severity, operation: 'create-defect' });
    push({
      id: `apr-def-${d.id}`,
      operation: 'create-defect',
      target: `${d.title}（关联用例 ${d.relatedCases?.[0] ?? '-'}）`,
      environment: env,
      severity: d.severity,
      decision: ev.decision,
      reason: ev.reason,
      payload: d,
      createdAt: d.createdAt,
    });
  }

  // 自愈建议 → apply-healing（不自动改码，风险映射严重度）
  for (const s of healing?.suggestions ?? []) {
    const severity = s.risk === 'high' ? 'P1' : s.risk === 'medium' ? 'P2' : 'P3';
    const ev = evaluateApproval({ environment: env, severity, operation: 'apply-healing' });
    push({
      id: `apr-heal-${s.id}`,
      operation: 'apply-healing',
      target: `${s.oldPath} → ${s.newPath ?? '（重构/移除）'}（用例 ${s.caseId}）`,
      environment: env,
      severity,
      decision: ev.decision,
      reason: ev.reason,
      payload: s,
      createdAt: s.createdAt,
    });
  }

  return { requests, results, audit: auditLog.list() };
}

/**
 * 一键运行 AI 测试流程。
 * 阶段产物在 AgentContext 中流转；Memory 用于：
 *   - 执行前：历史失败 → 补充风险项 / 标记 flaky 用例
 *   - 执行后：失败与执行摘要 → 写入记忆
 * 增强阶段（selection/coverage/rca/defect/healing/approval）失败自动跳过，不中断主流程。
 */
export async function runAgentPipeline(input: AgentPipelineInput, context: AgentContext): Promise<AgentPipelineResult> {
  const t0 = Date.now();
  const taskId = input.requirementText.trim().slice(0, 20).replace(/\s+/g, '-') || `task-${Date.now()}`;
  const stages: Record<string, boolean> = {};
  const memory: TestMemory = context.memory ?? new NoopMemory();
  const env = input.environment;
  const opts = input.options ?? {};

  // 可观测 + 预算
  const tracer = opts.runTrace === false ? undefined : new AgentTracer(taskId, { feature: undefined, environment: env });
  const budget = opts.budget ? new AgentBudget(opts.budget) : undefined;
  const sctx: StageCtx = { logger: context.logger, tracer, budget };

  // 1. Requirement
  const requirementAgent = new RequirementAgent();
  const requirement = (await runStage(
    sctx, 'requirement', 'requirement', true,
    () => requirementAgent.execute(input.requirementText, context),
    stages,
  )) as Requirement;
  context.logger.info(`[Pipeline] Requirement：${requirement.feature}（confidence=${requirement.confidence}）`);

  // 2. Test Design
  const testDesignAgent = new TestDesignAgent();
  const testCases = (await runStage(
    sctx, 'test-design', 'testDesign', true,
    () => testDesignAgent.execute({ requirement }, context),
    stages,
  )) as TestCase[];
  context.logger.info(`[Pipeline] Test Design：${testCases.length} 条用例`);

  // 3. Risk（含历史失败补充）
  const riskAgent = new RiskAgent();
  let risk = (await runStage(
    sctx, 'risk', 'risk', true,
    () => riskAgent.execute({ requirement, testCases, environment: env }, context),
    stages,
  )) as RiskAssessment;
  const historicalRisks = await buildHistoricalRiskItems(memory, requirement.feature);
  if (historicalRisks.length) {
    risk = {
      ...risk,
      risks: [...risk.risks, ...historicalRisks],
      summary: { ...risk.summary },
      issues: [...risk.issues, ...historicalRisks.map((r) => ({ level: (r.level === 'high' ? '阻塞' : '数据异常') as '阻塞' | '数据异常', title: r.title, desc: r.desc }))],
    };
    context.logger.info(`[Pipeline] 记忆补充 ${historicalRisks.length} 项历史风险`);
  }

  // 3.5 Selection（增强：智能选择测试集，默认仅记录建议，不改执行集）
  let selection: TestSelection | undefined;
  if (opts.runSelection !== false) {
    selection = await runStage(
      sctx, 'test-selection', 'selection', false,
      async () => {
        const agent = new TestSelectionAgent();
        return agent.execute({ requirement, testCases, riskAssessment: risk }, context);
      },
      stages,
    );
    if (selection) {
      context.logger.info(
        `[Pipeline] Selection：选中 ${selection.statistics?.selected ?? selection.selectedCases.length}/${selection.statistics?.total ?? testCases.length} 条，跳过 ${selection.skippedCases.length} 条`,
      );
    }
  }

  // 3.75 Coverage（增强：覆盖缺口分析，基于全量用例）
  let coverage: CoverageAnalysis | undefined;
  if (opts.runCoverage !== false) {
    coverage = await runStage(
      sctx, 'coverage', 'coverage', false,
      async () => {
        const agent = new CoverageAgent();
        return agent.execute({ requirement, testCases }, context);
      },
      stages,
    );
    if (coverage) {
      context.logger.info(
        `[Pipeline] Coverage：${coverage.dimensions.map((d) => `${d.name}=${d.rate}%`).join('，')}`,
      );
    }
  }

  // 4. Data（规划 + 准备）
  const dataAgent = new DataAgent();
  const dataPlan = (await runStage(
    sctx, 'data', 'data', true,
    () => dataAgent.execute({ requirement, testCases, environment: env }, context),
    stages,
  )) as DataPlan;
  const dataContext = input.options?.skipExecution
    ? {}
    : await dataAgent.prepareData(dataPlan, context);
  context.logger.info(`[Pipeline] Data：needsSetup=${dataPlan.needsSetup}，factory=${dataPlan.factoryName}`);

  // 5. Execution（默认全量执行；useSelection 时按选中集执行）
  const execCases =
    opts.useSelection && selection && selection.selectedCases.length
      ? testCases.filter((c) => selection.selectedCases.includes(c.id))
      : testCases;
  if (execCases.length === 0 && testCases.length > 0) {
    context.logger.warn('[Pipeline] 选中用例集为空，回退全量执行');
  }
  const executionAgent = new ExecutionAgent();
  let outcome: ExecutionOutcome;
  if (input.options?.skipExecution) {
    outcome = {
      feature: requirement.feature,
      total: testCases.length,
      passed: 0,
      failed: 0,
      timedOut: 0,
      passRate: 0,
      results: [],
      reports: [],
      executed: false,
      summary: '已跳过执行（skipExecution）',
    };
    context.logger.info('[Pipeline] 跳过执行（skipExecution）');
  } else {
    outcome = (await runStage(
      sctx, 'execution', 'execution', true,
      () => executionAgent.execute(
        {
          testCases: execCases,
          environment: env,
          options: {
            autoSetup: input.options?.autoSetup,
            dryRun: input.options?.dryRun,
            concurrency: input.options?.concurrency,
          },
        },
        context,
      ),
      stages,
    )) as ExecutionOutcome;
    if (!outcome.executed) {
      context.logger.warn('[Pipeline] 执行未真正运行（execution.run Tool 未注册），产出基于执行计划');
    }
  }
  stages.execution = outcome.executed;

  // 6. Analysis（含记忆 flaky 标记）
  const flakyCaseIds = historicalRisks
    .filter((r) => r.category === 'compatibility')
    .flatMap((r) => r.affectedCases ?? []);
  const analysisAgent = new AnalysisAgent();
  const report = (await runStage(
    sctx, 'analysis', 'analysis', true,
    () => analysisAgent.execute(
      { requirement, testCases, outcome, risk, flakyCaseIds },
      context,
    ),
    stages,
  )) as AnalysisReport;
  context.logger.info(`[Pipeline] Analysis：${report.findings.length} 项结论，overall=${report.summary.overall}`);

  // 7. RCA（增强：对失败用例逐条证据链根因分析）
  const maxRca = opts.maxRca ?? 10;
  const rcas: RootCauseAnalysis[] = [];
  if (opts.runRca !== false && report.failedCases.length) {
    const found = await runStage(
      sctx, 'root-cause', 'rca', false,
      async () => {
        const agent = new RootCauseAgent();
        const out: RootCauseAnalysis[] = [];
        for (const fc of report.failedCases.slice(0, maxRca)) {
          const rca = await agent.execute({ executionResult: fc, outcome, environment: env }, context);
          out.push(rca);
        }
        return out;
      },
      stages,
    );
    if (found?.length) {
      rcas.push(...found);
      context.logger.info(`[Pipeline] RCA：${found.length} 条根因分析（${found.map((r) => `${r.caseId}=${r.category}`).join('，')}）`);
    }
  }

  // 8. Defect（增强：仅 DRAFT 草稿，绝不提交）
  const maxDefects = opts.maxDefects ?? 10;
  const defects: DefectDraft[] = [];
  if (opts.runDefect !== false && report.failedCases.length) {
    const found = await runStage(
      sctx, 'defect', 'defect', false,
      async () => {
        const agent = new DefectAgent();
        return agent.execute(
          {
            feature: requirement.feature,
            environment: env ?? 'test',
            failedCases: report.failedCases.slice(0, maxDefects),
            rcas,
            outcome,
          },
          context,
        );
      },
      stages,
    );
    if (found?.length) {
      defects.push(...found);
      context.logger.info(`[Pipeline] Defect：生成 ${found.length} 条草稿（均 DRAFT，未提交）`);
    }
  }

  // 9. Healing（增强：仅 SUGGESTED 建议，不自动改码）
  let healing: HealingAnalysis | undefined;
  if (opts.runHealing !== false && report.failedCases.length) {
    healing = await runStage(
      sctx, 'self-healing', 'healing', false,
      async () => {
        const agent = new SelfHealingAgent();
        return agent.execute({ feature: requirement.feature, failedCases: report.failedCases }, context);
      },
      stages,
    );
    if (healing) {
      context.logger.info(`[Pipeline] Healing：${healing.suggestions.length} 条自愈建议（均 SUGGESTED，未应用）`);
    }
  }

  // 10. Approval（增强：分级审批 + 审计日志）
  let approvals: ApprovalRequest[] = [];
  let approvalResults: ApprovalResult[] = [];
  let audit: AuditEntry[] = [];
  if (opts.runApproval !== false && (defects.length || (healing?.suggestions.length ?? 0) > 0)) {
    const built = await runStage(
      sctx, 'approval', 'approval', false,
      async () => buildApprovalRequests(env ?? 'test', defects, healing, opts.autoApprove ?? false),
      stages,
    );
    if (built) {
      approvals = built.requests;
      approvalResults = built.results;
      audit = built.audit;
      context.logger.info(
        `[Pipeline] Approval：${approvals.length} 条请求（DENY ${approvalResults.filter((r) => r.verdict === 'rejected').length} / pending ${approvalResults.filter((r) => r.verdict === 'pending').length} / approved ${approvalResults.filter((r) => r.verdict === 'approved').length}）`,
      );
    }
  }

  // 11. Memory 写入（执行摘要 + 失败记录）
  if (outcome.executed) {
    const stats = await storeAnalysisToMemory(memory, report, outcome);
    context.logger.info(`[Pipeline] Memory：写入 ${stats.saved} 条（${stats.types.join(', ')}）`);
  }

  // 12. Trace / Budget 汇总
  let trace: AgentTrace | undefined;
  if (tracer) {
    trace = tracer.toTrace();
    if (budget) budget.importTrace(trace);
  }
  const budgetStatus = budget?.status();

  return {
    taskId,
    requirement,
    testCases,
    risk,
    dataPlan,
    dataContext,
    outcome,
    report,
    stages,
    durationMs: Date.now() - t0,
    exitCode: report.summary.exitCode,
    ...(selection ? { selection } : {}),
    ...(coverage ? { coverage } : {}),
    ...(rcas.length ? { rcas } : {}),
    ...(defects.length ? { defects } : {}),
    ...(healing ? { healing } : {}),
    ...(approvals.length ? { approvals, approvalResults } : {}),
    ...(audit.length ? { audit } : {}),
    ...(trace ? { trace } : {}),
    ...(budgetStatus ? { budgetStatus } : {}),
  };
}
