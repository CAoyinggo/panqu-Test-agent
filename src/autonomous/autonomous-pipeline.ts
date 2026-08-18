// Autonomous Pipeline：端到端自治测试流水线（Phase 23.5）
// 串联完整闭环：
//   Change → Impact → Portfolio → Exploration → Priority → Regression
//   → Execution → Observation → RePlan → Adaptive Stop → RCA → Defect
//   → Release Decision → Decision Trace → Report → run-summary.json
// Deterministic First：全链路由规则 / 统计 / 历史推导，LLM 仅作可解释性（本模块不调用 LLM）。
// 生产安全：Exploration / Self-Healing / Defect / DB Mutation / Billing 仍必须经过
// Permission + Approval；production → dangerous = DENY、risky = Approval，自治模式不改变安全策略。

import fs from 'node:fs';
import path from 'node:path';
import { generateRunId, type ChangeEvent } from '../regression/regression-schema.js';
import type { PortfolioCaseInput, PortfolioPolicy } from '../portfolio/portfolio-schema.js';
import {
  buildRegressionPlan,
  portfolioToAutonomousCases,
  type PortfolioRegressionPlan,
} from '../portfolio/portfolio-regression.js';
import {
  runExplorationPlan,
  type ExplorationConfig,
  type ExplorationPlan,
} from '../exploration/index.js';
import {
  runAutonomousRegression,
  renderAutonomousReportHtml,
  type AutonomousBudget,
  type AutonomousCase,
  type AutonomousMode,
  type AutonomousRunResult,
  type ReplanEvent,
} from './index.js';
import { DecisionRecorder, type DecisionTrace } from '../decisions/index.js';
import { classifyFailure } from '../agents/analysis/failure-classifier.js';
import {
  buildRootCause,
  type FailureCategory,
  type RootCauseAnalysis,
} from '../agents/analysis/root-cause-schema.js';
import {
  buildReleaseDecision,
  releaseExitCode,
  writeReleaseDecision,
  type ReleaseDecision,
  type ReleaseDecisionInput,
} from '../release-ci/index.js';

/** 外部测量信号（真实流水线注入 coverage / flaky / known-issues 等） */
export interface AutonomousPipelineSignals {
  coverage?: number;
  flakyCount?: number;
  knownIssues?: number;
  criticalDefects?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  environmentAbnormal?: boolean;
}

/** 探索接入配置 */
export interface AutonomousPipelineExplorationInput {
  coverageGaps?: string[];
  historicalFailures?: string[];
  parameterSpace?: Record<string, string[]>;
  config?: Partial<ExplorationConfig>;
  approveHighRisk?: boolean;
  approveProduction?: boolean;
  /** 探索候选在回归计划中的优先级（默认 P3：预算内最后执行；覆盖缺口关键时可用 P1 提前验证） */
  priority?: AutonomousCase['priority'];
}

/** 端到端流水线输入 */
export interface AutonomousPipelineInput {
  /** 变更事件 */
  change: ChangeEvent;
  /** 全部候选用例（如 100 个 TestCase） */
  cases: PortfolioCaseInput[];
  runId?: string;
  taskId?: string;
  feature?: string;
  /** 执行环境（production → 安全策略不变） */
  environment?: string;
  /** 离线模拟执行结果：caseId → passed（真实运行由执行器提供） */
  outcomes?: Record<string, boolean>;
  /** 失败原因（error 消息，RCA 证据） */
  failureReasons?: Record<string, string>;
  policy?: Partial<PortfolioPolicy>;
  fullRegression?: boolean;
  exploration?: AutonomousPipelineExplorationInput;
  budget?: Partial<AutonomousBudget>;
  mode?: AutonomousMode;
  clusterFailureTrigger?: number;
  signals?: AutonomousPipelineSignals;
  now?: string | number;
}

/** 缺陷（RCA 产出） */
export interface PipelineDefect {
  caseId: string;
  category: FailureCategory;
  severity: 'critical' | 'major' | 'minor';
  reason: string;
}

/** Trace 计划（Initial / RePlan / Final / Stop / Release） */
export interface PipelineTracePlan {
  initialPlan: string[];
  replans: ReplanEvent[];
  finalPlan: string[];
  pausedCaseIds: string[];
  stopDecision: { triggered: boolean; reason: string } | null;
  releaseDecision: ReleaseDecision['decision'];
  decisionTrace: DecisionTrace;
}

/** Run Summary（供 CI Gate 消费，输出 output/<date>/<feature>/run-summary.json） */
export interface RunSummary {
  runId: string;
  taskId: string;
  feature: string;
  change: ChangeEvent;
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  failed: number;
  p0: { total: number; passed: number };
  p1: { total: number; passed: number };
  coverage: number;
  criticalDefects: number;
  flakyCount: number;
  knownIssues: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  modelChange: boolean;
  environmentAbnormal: boolean;
  replans: number;
  /** RCA 数量（Dashboard/Report 消费） */
  rcaCount: number;
  /** 停止原因（停止时非空） */
  stopReason: string | null;
  /** Portfolio 执行率（组合选择比例） */
  portfolioRate: number;
  /** 探索计数（Dashboard/Report 消费） */
  explorationGenerated: number;
  explorationScreened: number;
  explorationRejected: number;
  decision: string;
  releaseDecision: ReleaseDecision['decision'];
  evidence: string[];
}

/** 端到端流水线结果 */
export interface AutonomousPipelineResult {
  runId: string;
  taskId: string;
  feature: string;
  environment: string;
  change: ChangeEvent;
  portfolio: PortfolioRegressionPlan;
  exploration: ExplorationPlan;
  autonomousCases: AutonomousCase[];
  regression: AutonomousRunResult;
  rca: RootCauseAnalysis[];
  defects: PipelineDefect[];
  knowledgeUpdates: string[];
  release: ReleaseDecision;
  releaseExitCode: number;
  trace: PipelineTracePlan;
  runSummary: RunSummary;
  createdAt: string;
}

/** 按 changeTags 推导失败类别（无 error 消息时的确定性兜底） */
function categoryFromTags(tags: string[] | undefined): FailureCategory | null {
  const t = (tags ?? []).map((x) => x.toLowerCase()).join(' ');
  if (/model|llm|inference|video|text/.test(t)) return 'MODEL_ERROR';
  if (/billing|积分|扣费|charge/.test(t)) return 'BILLING_ERROR';
  if (/auth|权限|鉴权/.test(t)) return 'AUTH_ERROR';
  if (/network|网络/.test(t)) return 'NETWORK_ERROR';
  if (/concurr|并发|lock/.test(t)) return 'CONCURRENCY_ERROR';
  if (/env|环境/.test(t)) return 'ENVIRONMENT_ERROR';
  return null;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** 执行端到端自治测试流水线（纯确定性、离线可复现） */
export function runAutonomousPipeline(input: AutonomousPipelineInput): AutonomousPipelineResult {
  const change: ChangeEvent = input.change;
  const runId = input.runId ?? generateRunId();
  const taskId = input.taskId ?? `task-${runId}`;
  const feature = input.feature ?? (change.target.split('/')[0] || 'default');
  const environment = input.environment ?? 'test';
  const nowIso = input.now ? new Date(input.now).toISOString() : new Date().toISOString();
  const recorder = new DecisionRecorder(taskId);
  const evidence: string[] = [];
  const knowledgeUpdates: string[] = [];
  const modelChange = change.type === 'model';

  // ── 1) Requirement：解析变更需求 ──
  recorder.record({
    kind: 'requirement',
    decision: `变更 ${change.type}:${change.target}`,
    reason: `解析变更：类型 ${change.type}，目标 ${change.target}${change.from || change.to ? `，范围 ${change.from ?? ''} → ${change.to ?? ''}` : ''}，环境 ${environment}`,
    evidence: ['变更事件归一化完成', `environment=${environment}`],
    inputs: { change, environment },
  });
  evidence.push(`需求：变更 ${change.type}:${change.target}（环境 ${environment}${modelChange ? '，模型变更 → 高风险' : ''}）`);

  // ── 2) Impact + Portfolio：变更影响 → 组合选择 → Regression Plan ──
  const portfolio = buildRegressionPlan({
    change,
    cases: input.cases,
    policy: input.policy,
    fullRegression: input.fullRegression,
    runId,
  });
  recorder.record({
    kind: 'selection',
    decision: `选择 ${portfolio.selectedCaseIds.length}/${portfolio.totalCases}`,
    score: portfolio.executionRate,
    reason: `受影响 ${portfolio.affectedCount} 个 + Portfolio 组合策略，执行率 ${(portfolio.executionRate * 100).toFixed(0)}%`,
    evidence: portfolio.evidence,
    inputs: { change: change.target, totalCases: portfolio.totalCases, policy: portfolio.policy },
    outputs: { selectedCaseIds: portfolio.selectedCaseIds, skipped: portfolio.skipped },
  });
  evidence.push(`影响：受影响用例 ${portfolio.affectedCount}/${portfolio.totalCases}，组合选择 ${portfolio.selectedCaseIds.length} 个`);

  // ── 3) Exploration：覆盖缺口 → 候选 → 三进门禁（Risk/Budget/Permission）──
  const exploration = runExplorationPlan({
    coverageGaps: input.exploration?.coverageGaps,
    historicalFailures: input.exploration?.historicalFailures,
    parameterSpace: input.exploration?.parameterSpace,
    existingCaseIds: portfolio.selectedCaseIds,
    environment,
    approveHighRisk: input.exploration?.approveHighRisk ?? false,
    approveProduction: input.exploration?.approveProduction ?? false,
    config: input.exploration?.config,
  });
  recorder.record({
    kind: 'risk',
    decision: exploration.canAddToRegression ? `探索 ${exploration.screened.length} 个候选` : '无探索候选进入回归',
    reason: exploration.evidence.join('；') || '覆盖缺口无新增探索候选',
    evidence: exploration.evidence,
    inputs: { environment },
    outputs: { screened: exploration.screened.map((c) => c.id), rejected: exploration.rejected.length },
  });
  evidence.push(
    exploration.canAddToRegression
      ? `探索：生成 ${exploration.generated.length}，通过三进门禁 ${exploration.screened.length} 个，拒绝 ${exploration.rejected.length} 个`
      : `探索：覆盖缺口无新增可执行候选（拒绝 ${exploration.rejected.length} 个）`,
  );

  // ── 4) 组装自治用例 = Portfolio 选中 + 探索通过候选 ──
  // 探索候选默认 P3（预算内最后执行）；覆盖缺口关键时可配置更高优先级（Scenario 3 用 P1 提前验证）
  const explorationPriority = input.exploration?.priority ?? 'P3';
  const explorationCaseIds = new Set(exploration.screened.map((c) => c.id));
  const autonomousCases: AutonomousCase[] = [
    ...portfolioToAutonomousCases(portfolio, input.cases),
    ...exploration.screened.map(
      (c): AutonomousCase => ({
        caseId: c.id,
        priority: explorationPriority,
        changeTags: c.tags,
        riskScore: c.riskScore,
        modelRisk: c.riskScore && c.riskScore >= 0.6 ? 0.6 : undefined,
        estimatedCost: 0.1,
        estimatedDurationMs: 20000,
      }),
    ),
  ];

  // ── 5) Priority：初始执行计划 ──
  // 由 runAutonomousRegression 内部的失败预测 + 优先级排序产生 initialOrder
  const regression = runAutonomousRegression({
    cases: autonomousCases,
    outcomes: input.outcomes,
    budget: input.budget,
    mode: input.mode,
    now: input.now,
    clusterFailureTrigger: input.clusterFailureTrigger,
  });
  recorder.record({
    kind: 'priority',
    decision: `初始执行顺序：${regression.initialOrder.join(' → ') || '（空）'}`,
    reason: `失败预测 + 优先级（${regression.predictions.length} 个预测），高失败概率优先`,
    evidence: regression.predictions.slice(0, 10).map((p) => `预测 ${p.caseId} ${(p.failureProbability * 100).toFixed(0)}%`),
    inputs: { mode: regression.mode },
    outputs: { initialPlan: regression.initialOrder },
  });

  // ── 6) RePlan：记录每次重新规划 ──
  for (const rp of regression.replans) {
    recorder.record({
      kind: 'replanning',
      decision: `RePlan：${rp.failedCase} 失败 → ${rp.action}`,
      reason: rp.cause,
      evidence: [`失败用例 ${rp.failedCase}`, `提升 ${rp.boostedCases.join('、') || '无'}`],
      caseId: rp.failedCase,
      inputs: { action: rp.action },
      outputs: { boostedCases: rp.boostedCases },
    });
  }
  if (regression.replans.length) evidence.push(`重规划：共 ${regression.replans.length} 次（${regression.replans.map((r) => r.action).join('；')}）`);

  // ── 7) Adaptive Stop / 暂停低优先级 ──
  const executedIds = new Set(regression.executed.map((e) => e.caseId));
  const pausedCaseIds = regression.initialOrder.filter(
    (id) => !executedIds.has(id) && !regression.remaining.includes(id),
  );
  let stopDecision: PipelineTracePlan['stopDecision'] = null;
  if (regression.stopping?.stop) {
    stopDecision = { triggered: true, reason: `自适应停止：${regression.stopping.reason}` };
  } else if (regression.decision === 'BUDGET_EXHAUSTED') {
    stopDecision = { triggered: true, reason: `AUTONOMOUS STOP：${regression.reason}` };
  } else if (pausedCaseIds.length > 0) {
    stopDecision = { triggered: true, reason: `暂停低优先级用例 ${pausedCaseIds.length} 个（${pausedCaseIds.join('、')}）` };
  }
  recorder.record({
    kind: 'stopping',
    decision: stopDecision ? `停止：${stopDecision.reason}` : '继续执行',
    reason: regression.reason,
    evidence: [`决策 ${regression.decision}`, `暂停 ${pausedCaseIds.length} 个`, `剩余 ${regression.remaining.length} 个`],
    outputs: { decision: regression.decision, paused: pausedCaseIds, remaining: regression.remaining },
  });
  if (stopDecision) evidence.push(`停止：${stopDecision.reason}`);

  // ── 8) Observation → RCA：对失败用例做根因分析 ──
  const failed = regression.executed.filter((e) => !e.passed);
  const rca: RootCauseAnalysis[] = failed.map((e) => {
    const ac = autonomousCases.find((c) => c.caseId === e.caseId);
    const tags = ac?.changeTags ?? [];
    const error = input.failureReasons?.[e.caseId];
    const cls = classifyFailure({ caseId: e.caseId, error, tags, environment });
    const category: FailureCategory = error
      ? cls.category
      : (categoryFromTags(tags) ?? (cls.category !== 'UNKNOWN' ? cls.category : 'UNKNOWN'));
    const rootCause =
      category === 'MODEL_ERROR'
        ? `模型变更 ${change.target} 相关行为异常（${tags.join('、') || '模型链路'}）`
        : category === 'BILLING_ERROR'
          ? '计费/积分链路异常'
          : error
            ? `失败：${error}`
            : '执行失败，根因待确认';
    const evidenceItems = [
      { type: 'recent-changes', detail: `变更 ${change.type}:${change.target}`, certainty: 'fact' as const },
      { type: 'execution-history', detail: `用例 ${e.caseId} 失败，标签 ${tags.join('、') || '无'}`, certainty: 'fact' as const },
    ];
    return buildRootCause({
      caseId: e.caseId,
      category,
      confidence: cls.confidence,
      rootCause,
      evidence: [`变更关联：${change.type}:${change.target}`, `失败分类：${category}`, `建议：${rootCause}`],
      evidenceItems,
      recommendedAction:
        category === 'MODEL_ERROR'
          ? '修复模型链路相关代码并补充回归，评估影响面'
          : category === 'BILLING_ERROR'
            ? '核对计费逻辑，防止生产扣费异常'
            : '定位失败根因，修复后重跑',
      source: 'autonomous-pipeline',
    });
  });
  if (rca.length) evidence.push(`RCA：对 ${rca.length} 个失败用例完成根因分析（${rca.map((r) => r.category).join('、')}）`);

  // ── 9) Defect + Knowledge（RCA → 缺陷/知识更新）──
  // 探索来源的失败 = 新发现的已知问题（Release REVIEW 软信号），纳入知识更新
  const discoveredFailures = regression.executed.filter((e) => !e.passed && explorationCaseIds.has(e.caseId));
  const defects: PipelineDefect[] = rca.map((r) => {
    const ac = autonomousCases.find((c) => c.caseId === r.caseId);
    const severity: PipelineDefect['severity'] =
      (modelChange && r.category === 'MODEL_ERROR') || ac?.priority === 'P0'
        ? 'critical'
        : ac?.priority === 'P1' || r.category === 'BILLING_ERROR'
          ? 'major'
          : 'minor';
    return { caseId: r.caseId, category: r.category, severity, reason: r.rootCause };
  });
  for (const d of defects) {
    if (d.severity === 'critical') {
      knowledgeUpdates.push(`知识更新：模型变更 ${change.target} 相关 ${d.caseId} 失败（${d.category}，critical）→ 高风险持久化，后续回归优先`);
    } else {
      knowledgeUpdates.push(`知识更新：${d.caseId} 失败（${d.category}，${d.severity}）→ 已记录根因与复现建议`);
    }
  }
  if (discoveredFailures.length) {
    knowledgeUpdates.push(
      `知识更新：探索发现新失败 ${discoveredFailures.map((d) => d.caseId).join('、')} → 已登记为新已知问题，Release 需 REVIEW`,
    );
  }

  // ── 10) Release Decision（规则引擎 + 统一契约）──
  const statsFor = (prio: 'P0' | 'P1'): { total: number; passed: number } => {
    const list = regression.executed.filter((e) => autonomousCases.find((c) => c.caseId === e.caseId)?.priority === prio);
    return { total: list.length, passed: list.filter((e) => e.passed).length };
  };
  const executedCount = regression.executed.length;
  const total = autonomousCases.length;
  const skipped = total - executedCount;
  const passed = regression.executed.filter((e) => e.passed).length;
  const failedCount = executedCount - passed;
  const criticalDefects =
    input.signals?.criticalDefects ?? defects.filter((d) => d.severity === 'critical').length;
  const coverage =
    input.signals?.coverage ??
    clamp01(total > 0 ? executedCount / total : 0);
  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    input.signals?.riskLevel ??
    (regression.releaseBlocked || criticalDefects > 0 ? 'HIGH' : failedCount > 0 ? 'MEDIUM' : 'LOW');
  const execProbs = regression.executed
    .map((e) => regression.predictions.find((p) => p.caseId === e.caseId)?.failureProbability ?? 0);
  const failurePrediction = execProbs.length
    ? clamp01(execProbs.reduce((s, p) => s + p, 0) / execProbs.length)
    : 0;
  const releaseInput: ReleaseDecisionInput = {
    p0: statsFor('P0'),
    p1: statsFor('P1'),
    coverage,
    criticalDefects,
    riskLevel,
    failurePrediction,
    modelChange,
    environmentAbnormal: input.signals?.environmentAbnormal ?? false,
    flakyCount: input.signals?.flakyCount ?? 0,
    knownIssues: input.signals?.knownIssues ?? regression.knownIssueReappeared.length + discoveredFailures.length,
  };
  const release = buildReleaseDecision({ runId, feature, traceId: `trace-${runId}`, decisionInput: releaseInput });
  const releaseExit = releaseExitCode(release.decision);
  const releaseReason = release.blockReasons.length ? release.blockReasons.join('；') : release.recommendations.join('；');
  recorder.record({
    kind: 'release',
    decision: release.decision,
    score: release.confidence,
    reason: releaseReason,
    evidence: release.evidence.map((e) => `${e.type}:${e.value}`),
    confidence: release.confidence,
    inputs: { ...releaseInput } as Record<string, unknown>,
    outputs: { exitCode: releaseExit, blockReasons: release.blockReasons, recommendations: release.recommendations },
  });
  evidence.push(`发布决策：${release.decision}（exit ${releaseExit}，confidence ${release.confidence}）`);

  // ── 11) Trace 汇总 ──
  const decisionTrace = recorder.toTrace();
  const trace: PipelineTracePlan = {
    initialPlan: regression.initialOrder,
    replans: regression.replans,
    finalPlan: regression.remaining,
    pausedCaseIds,
    stopDecision,
    releaseDecision: release.decision,
    decisionTrace,
  };

  // ── 12) Run Summary（CI Gate 消费）──
  const runSummary: RunSummary = {
    runId,
    taskId,
    feature,
    change,
    total,
    executed: executedCount,
    skipped,
    passed,
    failed: failedCount,
    p0: statsFor('P0'),
    p1: statsFor('P1'),
    coverage,
    criticalDefects,
    flakyCount: input.signals?.flakyCount ?? 0,
    knownIssues: input.signals?.knownIssues ?? regression.knownIssueReappeared.length + discoveredFailures.length,
    riskLevel,
    modelChange,
    environmentAbnormal: input.signals?.environmentAbnormal ?? false,
    replans: regression.replans.length,
    rcaCount: rca.length,
    stopReason: stopDecision?.reason ?? null,
    portfolioRate: portfolio.executionRate,
    explorationGenerated: exploration.generated.length,
    explorationScreened: exploration.screened.length,
    explorationRejected: exploration.rejected.length,
    decision: regression.decision,
    releaseDecision: release.decision,
    evidence,
  };

  return {
    runId,
    taskId,
    feature,
    environment,
    change,
    portfolio,
    exploration,
    autonomousCases,
    regression,
    rca,
    defects,
    knowledgeUpdates,
    release,
    releaseExitCode: releaseExit,
    trace,
    runSummary,
    createdAt: nowIso,
  };
}

/**
 * 写入流水线产物：output/<date>/<feature>/{run-summary.json, autonomous-pipeline.json, release-decision.json, autonomous-report.html}
 * opts.subdir：多场景批量运行时按场景写入独立子目录（output/<date>/<feature>/<subdir>/），
 * 避免同一 feature 的多个自治运行互相覆盖（Dashboard 可区分全部运行）。
 * 无 subdir 时保持契约路径（release-decision.json 位于 output/<date>/<feature>/）。
 */
export function writeAutonomousOutputs(
  result: AutonomousPipelineResult,
  baseDir = 'output',
  opts: { subdir?: string } = {},
): { summary: string; pipeline: string; release: string; report: string } {
  const rel = path.join(result.createdAt.slice(0, 10), result.feature);
  const dir = path.join(baseDir, opts.subdir ? path.join(rel, opts.subdir) : rel);
  fs.mkdirSync(dir, { recursive: true });
  const summaryFile = path.join(dir, 'run-summary.json');
  fs.writeFileSync(summaryFile, `${JSON.stringify(result.runSummary, null, 2)}\n`);
  const pipelineFile = path.join(dir, 'autonomous-pipeline.json');
  fs.writeFileSync(pipelineFile, `${JSON.stringify(result, null, 2)}\n`);
  const releaseFile = opts.subdir
    ? path.join(dir, 'release-decision.json')
    : writeReleaseDecision(result.release, { baseDir });
  if (opts.subdir) fs.writeFileSync(releaseFile, `${JSON.stringify(result.release, null, 2)}\n`);
  const reportFile = path.join(dir, 'autonomous-report.html');
  fs.writeFileSync(reportFile, renderAutonomousReportHtml(result), 'utf-8');
  return { summary: summaryFile, pipeline: pipelineFile, release: releaseFile, report: reportFile };
}
