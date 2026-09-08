// Agent Pipeline：统一串联 AI 测试流程（Phase 10-18 全链路增强）
// 核心阶段：Requirement → TestDesign → Risk/Policies → ExecutionPlan → PolicyGate →
//           DataPrepare → Execution → DeterministicOutcome → Analysis/RCA → Report/Memory
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
import { computeRiskSummary } from '../risk/risk-schema.js';
import type { DataPlan, DataPrepareResult } from '../data/data-schema.js';
import type { DataContext } from '../../core/types.js';
import { DataSession } from '../../core/data-session.js';
import { getDataFactory } from '../../core/data-factory.js';
import type { ExecutionOutcome, ExecutionPlan } from '../execution/execution-schema.js';
import {
  computeOutcome,
  effectiveCaseAssertions,
  executionPlanFingerprint,
  normalizeCaseExecutionResult,
} from '../execution/execution-schema.js';
import type { AnalysisReport } from '../analysis/analysis-schema.js';
import { RequirementAgent } from '../requirement/requirement-agent.js';
import { TestDesignAgent } from '../test-design/test-design-agent.js';
import { RiskAgent } from '../risk/risk-agent.js';
import { DataAgent } from '../data/data-agent.js';
import type { AgentRuntime, RuntimePolicySnapshot } from '../core/agent-runtime.js';
import { UsageMeter } from '../observability/usage-meter.js';
import { createRunIdentity } from '../../utils/run-id.js';
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
import {
  evaluateExecutionPolicy,
  type ExecutionApproval,
  type PolicyGateResult,
  type ProjectExecutionPolicy,
} from '../policy/policy-gate.js';
import { contractDependency } from '../../contracts/dependency-index.js';
import { preflightContracts, registerRequirementContract, type ContractPreflight } from '../../contracts/contract-gate.js';
import { createPhase1ContractResolver } from '../../contracts/seed-contracts.js';
import type { ContractResolver } from '../../contracts/resolver.js';
import type { TestCaseScenarioAdapterOptions } from '../../acceptance/test-case-scenario-adapter.js';

/** Pipeline 输入 */
export interface AgentPipelineInput {
  /** 自然语言测试需求 */
  requirementText: string;
  environment?: string;
  /** 三入口共享的 Contract Resolver；缺省使用 Phase 1 scoped registry。 */
  contractResolver?: ContractResolver;
  options?: {
    autoSetup?: boolean;
    dryRun?: boolean;
    concurrency?: number;
    /** 执行用例数上限（缺省回退 Selection 预算 maxCases） */
    maxCases?: number;
    /** 并发硬顶（缺省回退 Selection 预算 maxConcurrency） */
    maxConcurrency?: number;
    /** 整体执行时间预算毫秒（到点中止全部在途用例） */
    timeoutMs?: number;
    /** 上层 Worker/HTTP 取消信号，贯穿 Data Prepare 与 Execution Tool。 */
    signal?: AbortSignal;
    /** TEST_CASE_V2 的 Processor/Observer/Hook 能力，由 Adapter 动态计算 Runtime Readiness。 */
    scenarioRunnerOptions?: TestCaseScenarioAdapterOptions;
    /** 首个失败用例后停止调度后续（ExecutionPlan.policy.stopOnFailure） */
    stopOnFailure?: boolean;
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
    /** 项目级真实执行策略（显式 false 为不可由审批绕过的硬约束） */
    projectPolicy?: ProjectExecutionPolicy;
    /** 来自可信审批中心的执行批准；Policy Gate 不自行生成批准 */
    executionApproval?: ExecutionApproval;
    /** Platform Run 生命周期钩子；只用于记录真实 Gate/Execution 边界，不参与业务判定。 */
    lifecycle?: {
      onPolicyGateEvaluated?: (gate: PolicyGateResult) => void | Promise<void>;
      onExecutionStarting?: () => void | Promise<void>;
    };
  };
}

/** Pipeline 结果：各阶段产物 + 最终报告 + 退出码 + 增强产物 */
export interface AgentPipelineResult {
  /** 本次运行的唯一标识（ULID）：文件名 / Trace 键 —— 同需求并发运行互不覆盖 */
  runId: string;
  /** 任务稳定标识（需求内容哈希派生）：同一需求跨运行一致，供历史聚合 / 检索 */
  taskId: string;
  /** 需求内容 SHA-256（归一化后） */
  requirementsHash: string;
  /** 运行创建时间（ISO） */
  createdAt: string;
  requirement: Requirement;
  /** Requirement 与 Test Design 之间的 Contract 前置判定。 */
  contracts?: ContractPreflight;
  testCases: TestCase[];
  risk: RiskAssessment;
  /** Policy Gate 前已固定，Runner 必须消费同一控制面指纹的执行计划。 */
  executionPlan: ExecutionPlan;
  /** Orchestrator 汇总的六类策略快照（不含 Prompt 正文与审批人敏感信息）。 */
  policies: OrchestratorPolicyContext;
  /** 执行前策略门禁结论；只有 allowed=true 才能进入数据准备与执行 */
  policyGate: PolicyGateResult;
  dataPlan: DataPlan;
  /** Data Prepare 的确定性终态；needsSetup=true 时只有 READY 才能进入 Runner。 */
  dataPreparation: DataPrepareResult;
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

/** Orchestrator 的统一策略控制面。 */
export interface OrchestratorPolicyContext {
  risk: {
    overall: RiskAssessment['summary']['overall'];
    recommendedSkip: boolean;
    highRiskCount: number;
  };
  budget: {
    limits?: BudgetLimits;
    status?: BudgetStatus;
  };
  model: RuntimePolicySnapshot['models'];
  prompt: RuntimePolicySnapshot['prompts'];
  data: {
    needsSetup: boolean;
    factoryName: string;
    setupActionCount: number;
    teardownActionCount: number;
  };
  approval: {
    status?: ExecutionApproval['status'];
    evidencePresent: boolean;
  };
}

/** 阶段执行上下文（Trace + Budget 共享） */
interface StageCtx {
  /** 统一运行时（阶段执行 + Agent LLM 调用唯一链路；Pipeline 注入带 Tracer/Budget 的实例） */
  runtime: AgentRuntime;
  logger: AgentContext['logger'];
  tracer?: AgentTracer;
  budget?: AgentBudget;
}

function metadataObject<T>(value: unknown): T | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as T
    : undefined;
}

function nonExecutedOutcome(
  feature: string,
  testCases: TestCase[],
  status: 'BLOCKED' | 'NOT_EXECUTED',
  reason: string,
): ExecutionOutcome {
  return computeOutcome(
    feature,
    testCases.map((testCase) => ({
      caseId: testCase.id,
      name: testCase.name,
      feature: testCase.feature,
      scene: testCase.steps.find((step) => step.scene)?.scene,
      priority: testCase.priority,
      tags: testCase.tags,
      executed: false,
      status,
      pass: false,
      passRate: 0,
      error: `${status}：${reason}`,
    })),
    { executed: false, summary: `${status}：${reason}` },
  );
}

/**
 * Runner 输出的确定性收敛层：按 Execution Plan 重建结果全集与汇总，禁止信任外部 totals，
 * 禁止 PASS 缺少真实执行或有效断言，缺失用例统一补 NOT_EXECUTED。
 */
export function deterministicExecutionOutcome(
  feature: string,
  testCases: TestCase[],
  raw: ExecutionOutcome,
  plan: ExecutionPlan,
): ExecutionOutcome {
  const casesById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const rawById = new Map(raw.results.map((result) => [result.caseId, result]));
  const results = plan.order.map((caseId) => {
    const testCase = casesById.get(caseId);
    const source = rawById.get(caseId);
    if (!source) {
      return {
        caseId,
        name: testCase?.name ?? caseId,
        feature: testCase?.feature ?? feature,
        scene: testCase?.steps.find((step) => step.scene)?.scene,
        priority: testCase?.priority,
        tags: testCase?.tags,
        executed: false,
        status: 'NOT_EXECUTED' as const,
        pass: false,
        passRate: 0,
        error: 'NOT_EXECUTED：Runner 未返回该计划用例的执行结果',
      };
    }
    const normalized = normalizeCaseExecutionResult(source as unknown as Record<string, unknown>);
    if (normalized.status === 'PASS'
      && (normalized.executed !== true || effectiveCaseAssertions(normalized).length === 0)) {
      return {
        ...normalized,
        executed: normalized.executed === true,
        status: 'BLOCKED' as const,
        pass: false,
        passRate: 0,
        error: 'BLOCKED：PASS 缺少真实执行或有效断言证据',
      };
    }
    return normalized;
  });
  return computeOutcome(feature, results, {
    reports: raw.reports,
    plan,
  });
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
  const { logger } = ctx;
  // 阶段执行委托统一运行时（与 Orchestrator 同一机制：预算检查 → Tracer span → 执行；
  // 超时/重试策略由 Runtime 统一治理，Pipeline 只保留 essential 语义）
  const r = await ctx.runtime.runStage({ agent: agentName, stage: stageName, essential }, fn);
  if (r.ok) {
    stages[stageName] = true;
    return r.value;
  }
  stages[stageName] = false;
  if (r.error.startsWith('预算超限跳过')) {
    logger.warn(`[Pipeline] ${stageName} 因预算超限跳过`);
    return undefined;
  }
  logger.error(`[Pipeline] ${stageName} 失败：${r.error}`);
  if (essential) throw r.cause instanceof Error ? r.cause : new Error(r.error);
  return undefined;
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
  // 运行标识三件套：runId（ULID，本次运行唯一）+ taskId（需求哈希派生，跨运行稳定）+ createdAt。
  // 旧实现 taskId = 需求前 20 字符：同需求并发运行同 ID → 记录互相覆盖 / Trace 混流。
  const { runId, taskId, requirementsHash, createdAt } = createRunIdentity(input.requirementText, t0);
  const stages: Record<string, boolean> = {};
  const memory: TestMemory = context.memory ?? new NoopMemory();
  const env = input.environment;
  const opts = input.options ?? {};

  // 可观测 + 预算
  const tracer = opts.runTrace === false ? undefined : new AgentTracer(runId, { feature: undefined, environment: env });
  const budget = opts.budget ? new AgentBudget(opts.budget) : undefined;
  // 实时计费：UsageMeter（LLM/Tool/Case 装饰器 → 实时扣减 → 超限立即 STOP），
  // 替代旧「流程结束 importTrace 事后统计」。budget 缺省时仅计量不限额。
  const meter = new UsageMeter({ budget });
  // 统一运行时：Pipeline 与全部 Agent 共用（LLM 唯一链路 + 阶段执行机制），
  // 带 Tracer/Meter 注入 —— Agent LLM 调用实时扣预算；预算 STOP 后阶段立即停止。
  const runtime = context.runtime.fork({ tracer, budget, meter, logger: context.logger });
  context.runtime = runtime;
  // Tool Decorator：ToolRegistry 调用实时计量（次数/成本 → 超限 STOP）
  context.tools.setMeter(meter);
  const sctx: StageCtx = { logger: context.logger, tracer, budget, runtime };

  // 1. Requirement
  const requirementAgent = new RequirementAgent();
  const requirement = (await runStage(
    sctx, 'requirement', 'requirement', true,
    () => requirementAgent.execute(input.requirementText, context),
    stages,
  )) as Requirement;
  context.logger.info(`[Pipeline] Requirement：${requirement.feature}（confidence=${requirement.confidence}）`);

  // 1.5 Contract Resolution：任何设计参数产生前先固定事实来源、版本与指纹。
  const contractResolver = input.contractResolver ?? createPhase1ContractResolver();
  const dependencies = [registerRequirementContract(
    requirement,
    contractResolver,
    `agent:${taskId}:requirement`,
  )];
  const featureContracts = contractResolver.registry.candidates({ id: `model.${requirement.feature}` });
  if (featureContracts.length) {
    const resolution = contractResolver.resolve({ id: `model.${requirement.feature}` });
    const contract = resolution.contract ?? featureContracts.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    dependencies.push(contractDependency(contract));
  }
  const contractPreflight = preflightContracts(contractResolver, dependencies);
  stages.contractResolution = contractPreflight.validation.status === 'VALID';
  context.metadata.contractPreflight = contractPreflight;
  context.metadata.contractResolver = contractResolver;
  if (contractPreflight.validation.status !== 'VALID') {
    throw new Error(`CONTRACT_GATE_${contractPreflight.validation.status}：${contractPreflight.validation.reasons.join('；')}`);
  }
  const resolvedContracts = contractPreflight.resolutions.flatMap((resolution) => resolution.contract ? [resolution.contract] : []);
  context.logger.info(`[Pipeline] Contract Resolution：${resolvedContracts.map((contract) => `${contract.id}@${contract.version}`).join('，')}`);

  // 2. Test Design
  const testDesignAgent = new TestDesignAgent();
  const testCases = (await runStage(
    sctx, 'test-design', 'testDesign', true,
    () => testDesignAgent.execute({
      requirement,
      contracts: resolvedContracts,
    }, context),
    stages,
  )) as TestCase[];
  if (testCases.some((testCase) => testCase.schemaVersion !== 'TEST_CASE_V2')) {
    throw new Error('AGENT_PIPELINE_V2_REQUIRED：Test Design 只能向 Scenario Adapter 提交 TEST_CASE_V2');
  }
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
    const mergedRisks = [...risk.risks, ...historicalRisks];
    risk = {
      ...risk,
      risks: mergedRisks,
      summary: computeRiskSummary(mergedRisks),
      issues: [...risk.issues, ...historicalRisks.map((r) => ({ level: (r.level === 'high' ? '阻塞' : '数据异常') as '阻塞' | '数据异常', title: r.title, desc: r.desc }))],
    };
    context.logger.info(`[Pipeline] 记忆补充 ${historicalRisks.length} 项历史风险`);
  }

  // 3.5 Selection（规划策略：默认只记录建议；useSelection=true 时进入 Execution Plan）
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

  // 4. 确定待执行用例（Selection 是计划输入，不直接触发执行）
  const execCases =
    opts.useSelection && selection && selection.selectedCases.length
      ? testCases.filter((c) => selection.selectedCases.includes(c.id))
      : testCases;
  if (execCases.length === 0 && testCases.length > 0) {
    context.logger.warn('[Pipeline] 选中用例集为空，回退全量执行');
  }

  // 5. Data Policy：只生成纯 Data Plan；任何 prepare 副作用仍严格位于 Policy Gate 之后。
  const dataAgent = new DataAgent();
  const dataPlan = (await runStage(
    sctx, 'data', 'data', true,
    () => dataAgent.execute({ requirement, testCases: execCases, environment: env }, context),
    stages,
  )) as DataPlan;
  context.logger.info(`[Pipeline] Data Plan：needsSetup=${dataPlan.needsSetup}，factory=${dataPlan.factoryName}`);

  // 6. Execution Plan：在 Gate 前固定顺序、并发、预算与超时；Runner 后续不得重新规划。
  const executionAgent = new ExecutionAgent();
  const maxCases = opts.maxCases ?? selection?.budget?.maxCases ?? budget?.limits.maxCases;
  const maxConcurrency = opts.maxConcurrency ?? selection?.budget?.maxConcurrency ?? budget?.limits.maxConcurrency;
  const executionPlan = executionAgent.planExecution(execCases, opts.concurrency ?? 1, {
    maxCases,
    maxConcurrency,
    dryRun: opts.dryRun,
    timeoutMs: opts.timeoutMs,
    policy: {
      stopOnFailure: opts.stopOnFailure,
      realExecution: opts.skipExecution !== true && opts.dryRun !== true,
    },
  });
  const planFingerprint = executionPlanFingerprint(executionPlan);
  stages.executionPlan = true;
  context.logger.info(`[Pipeline] Execution Plan：${executionPlan.order.length} 条，fingerprint=${planFingerprint.slice(0, 12)}`);

  // 7. Policy Gate：Risk / Budget / Model / Prompt / Data / Approval 汇总后统一放行。
  const projectPolicy = opts.projectPolicy
    ?? metadataObject<ProjectExecutionPolicy>(context.metadata.projectExecutionPolicy);
  const executionApproval = opts.executionApproval
    ?? metadataObject<ExecutionApproval>(context.metadata.executionApproval);
  let gateBudgetStatus: BudgetStatus | undefined;
  const policyGate = (await runStage(
    sctx, 'policy-gate', 'policyGate', true,
    async () => {
      gateBudgetStatus = budget?.status();
      return evaluateExecutionPolicy({
        requirement,
        risk,
        testCases: execCases,
        environment: env ?? context.environment,
        dryRun: opts.dryRun,
        skipExecution: opts.skipExecution,
        projectPolicy,
        approval: executionApproval,
        executionPlan,
        dataPlan,
        budgetStatus: gateBudgetStatus,
      });
    },
    stages,
  )) as PolicyGateResult;
  // Gate 只补充执行约束，不改变计划控制面；指纹必须保持一致。
  executionPlan.policy = {
    ...executionPlan.policy,
    realExecution: policyGate.realExecution,
    realBilling: policyGate.realBilling,
  };
  if (policyGate.executionPlanFingerprint !== executionPlanFingerprint(executionPlan)) {
    throw new Error('Policy Gate 审核计划与待执行计划不一致，拒绝执行');
  }

  const runtimePolicies = runtime.policySnapshot([
    'requirement', 'test-design', 'risk', 'test-selection', 'coverage',
    'data', 'analysis', 'rca', 'defect', 'healing',
  ]);
  const policies: OrchestratorPolicyContext = {
    risk: {
      overall: risk.summary.overall,
      recommendedSkip: risk.summary.recommendedSkip,
      highRiskCount: risk.risks.filter((item) => item.level === 'high').length,
    },
    budget: { limits: opts.budget, status: gateBudgetStatus },
    model: runtimePolicies.models,
    prompt: runtimePolicies.prompts,
    data: {
      needsSetup: dataPlan.needsSetup,
      factoryName: dataPlan.factoryName,
      setupActionCount: dataPlan.setupActions.length,
      teardownActionCount: dataPlan.teardownActions.length,
    },
    approval: {
      status: executionApproval?.status,
      evidencePresent: Boolean(executionApproval?.id?.trim() && executionApproval?.approvedBy?.trim()),
    },
  };
  context.metadata.policyGate = policyGate;
  context.metadata.orchestratorPolicies = policies;
  context.metadata.executionPlanFingerprint = planFingerprint;
  if (policyGate.allowed) {
    context.logger.info(`[Pipeline] Policy Gate：ALLOW（action=${policyGate.actionLevel}）`);
  } else {
    context.logger.warn(`[Pipeline] Policy Gate：${policyGate.verdict} - ${policyGate.reasons.join('；')}`);
  }
  await opts.lifecycle?.onPolicyGateEvaluated?.(policyGate);

  // 8. Data Prepare：Gate 放行后才允许产生副作用。
  let dataContext: DataContext = {};
  let dataPreparation: DataPrepareResult;
  if (!policyGate.allowed) {
    stages.dataPrepare = false;
    dataPreparation = { status: 'BLOCKED', context: {}, error: `Policy Gate ${policyGate.verdict}` };
    context.logger.warn('[Pipeline] Policy Gate 未放行，跳过 Data Prepare');
  } else if (opts.skipExecution || opts.dryRun) {
    stages.dataPrepare = false;
    dataPreparation = { status: 'NOT_REQUIRED', context: {} };
    context.logger.info('[Pipeline] 计划模式：跳过 Data Prepare');
  } else {
    await opts.lifecycle?.onExecutionStarting?.();
    dataPreparation = await dataAgent.prepareDataResult(dataPlan, context, opts.signal);
    dataContext = dataPreparation.context;
    stages.dataPrepare = dataPreparation.status === 'READY' || dataPreparation.status === 'NOT_REQUIRED';
  }

  // ── 数据会话（DataContext 生命周期统一）──
  // Data Agent 准备的数据 adopt 成 DataSession 直达 Runner（不重复准备）；
  // 生命周期归本编排层：setup（prepareData 已完成）→ execution.run(dataSession) → finally teardown（必达）。
  const hasPreparedData = policyGate.allowed && !(opts.skipExecution || opts.dryRun)
    && dataPlan.needsSetup && dataPreparation.status === 'READY';
  const dataSession = hasPreparedData
    ? DataSession.adopt(dataContext, dataPreparation.factory ?? getDataFactory(dataPlan.factoryName), dataPlan.factoryName)
    : undefined;

  let outcome: ExecutionOutcome;
  try {
    if (!policyGate.allowed) {
      outcome = nonExecutedOutcome(
        requirement.feature,
        execCases.length ? execCases : testCases,
        'BLOCKED',
        `Policy Gate ${policyGate.verdict}：${policyGate.reasons.join('；')}`,
      );
      context.logger.warn('[Pipeline] 执行已在 execution.run 之前被 Policy Gate 阻断');
    } else if (opts.skipExecution) {
      outcome = nonExecutedOutcome(requirement.feature, execCases, 'NOT_EXECUTED', 'skipExecution');
      context.logger.info('[Pipeline] 跳过执行（skipExecution）');
    } else if (opts.dryRun) {
      outcome = nonExecutedOutcome(requirement.feature, execCases, 'NOT_EXECUTED', 'dry-run 不调用真实 Runner');
      context.logger.info('[Pipeline] dry-run：未调用 execution.run');
    } else if (execCases.length === 0) {
      outcome = nonExecutedOutcome(
        requirement.feature,
        testCases,
        'BLOCKED',
        'NO_TEST_CASE：Generator / Quality Gate 未产出可执行或可设计 Case，禁止调用 Runner',
      );
      context.logger.warn('[Pipeline] Generator / Quality Gate 未产出 Case，按 BLOCKED 关闭执行，不调用 Runner');
    } else if (dataPlan.needsSetup && dataPreparation.status !== 'READY') {
      outcome = nonExecutedOutcome(
        requirement.feature,
        execCases,
        'BLOCKED',
        `Data Prepare ${dataPreparation.status}：${dataPreparation.error ?? '前置数据未就绪'}`,
      );
      context.logger.warn(`[Pipeline] Data Prepare ${dataPreparation.status}，执行已在 Runner 前阻断`);
    } else {
      // Runner 只消费 Gate 前已固定并通过指纹校验的同一份计划。
      outcome = (await runStage(
        sctx, 'execution', 'execution', true,
        () => executionAgent.execute(
          {
            testCases: execCases,
            environment: env,
            options: {
              autoSetup: opts.autoSetup,
              dataSession,
              meter,
              signal: opts.signal,
              plan: executionPlan,
              scenarioRunnerOptions: opts.scenarioRunnerOptions,
            },
          },
          context,
        ),
        stages,
      )) as ExecutionOutcome;
      if (!outcome.results.some((result) => result.executed && result.processorInvoked)) {
        context.logger.warn('[Pipeline] 没有 Case 完成真实 Processor 执行，产出仅包含阻断/设计结果');
      }
    }
  } finally {
    // teardown 必须执行：执行成功/失败/抛错（含 Policy 阻断外的任何异常）都清理测试数据
    if (dataSession) {
      context.logger.info('[Pipeline] 数据会话 teardown（编排层所有，必达）');
      await dataSession.teardown();
    }
  }
  // 9. Deterministic Outcome：按 Plan 重新计算，不信任 Runner 自报 totals/passRate。
  outcome = deterministicExecutionOutcome(requirement.feature, execCases, outcome, executionPlan);
  stages.deterministicOutcome = true;
  const hasActualExecution = outcome.results.some((result) => result.executed === true
    && result.processorInvoked === true && Boolean(result.processor));
  stages.execution = hasActualExecution;

  // 10. Analysis（含记忆 flaky 标记）
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

  // 11. RCA（增强：对失败用例逐条证据链根因分析）
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

  // 12. Defect（增强：仅 DRAFT 草稿，绝不提交）
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

  // 13. Healing（增强：仅 SUGGESTED 建议，不自动改码）
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

  // 14. Approval（增强：分级审批 + 审计日志）
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

  // 15. Memory 写入（执行摘要 + 失败记录）
  if (hasActualExecution) {
    const stats = await storeAnalysisToMemory(memory, report, outcome);
    context.logger.info(`[Pipeline] Memory：写入 ${stats.saved} 条（${stats.types.join(', ')}）`);
  }

  // 16. Trace / Budget 汇总
  let trace: AgentTrace | undefined;
  if (tracer) {
    trace = tracer.toTrace();
    // 预算已是实时扣减（UsageMeter：LLM/Tool/Case 发生时即计量），无需流程末覆盖式统计
  }
  const budgetStatus = budget?.status();

  return {
    runId,
    taskId,
    requirementsHash,
    createdAt,
    requirement,
    contracts: contractPreflight,
    testCases,
    risk,
    executionPlan,
    policies,
    policyGate,
    dataPlan,
    dataPreparation,
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
