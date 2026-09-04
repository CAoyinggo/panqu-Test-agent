// Execution Run Tool：Agent 访问现有 Execution Engine 的唯一通道
// 封装核心引擎（Engine.runTask），供 Execution Agent 通过 Tool Registry 安全调用，
// 遵循「Agent 必须经 Tool 调用执行能力，禁止 AI 直接触碰 engine/pipeline」约束。
// runner 可注入：离线测试传 mock，CLI 模式使用真实引擎。

import type { AgentContext } from '../core/agent-context.js';
import type { AgentTool, ToolPermission } from '../tools/tool.js';
import type { LoadedCase } from '../../cases/loader.js';
import type { AppConfig } from '../../core/types.js';
import { Engine, registerScene } from '../../core/engine.js';
import { loadConfig } from '../../config/config.js';
import { getEnvFromEnv } from '../../config/env-loader.js';
import { autoLoadScenes } from '../../plugins/loader.js';
import { getDataFactory } from '../../core/data-factory.js';
import { logger } from '../../utils/logger.js';
import { computeOutcome, ExecutionOutcome, type CaseExecutionResult } from './execution-schema.js';
import type { RunTaskResult } from '../../core/engine.js';
import type { LoadedCase as RunnerLoadedCase } from '../../cases/loader.js';
import pLimit from 'p-limit';
import { abortReasonOf, ExecutionAbortError, abortForTimeout, linkAbortSignal } from '../../core/abort.js';
import type { DataSession } from '../../core/data-session.js';
import type { ExecutionPlan } from './execution-schema.js';
import type { UsageMeter } from '../observability/usage-meter.js';
import type { ContractResolver } from '../../contracts/resolver.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import {
  runTestCaseV2WithScenarioRunner,
  type TestCaseScenarioAdapterOptions,
} from '../../acceptance/test-case-scenario-adapter.js';

/** 执行选项 */
export interface ExecutionRunOptions {
  env?: string;
  func?: string;
  autoSetup?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  reporter?: string | null;
  /** 取消信号（Tool 层超时/取消贯穿至此 → Engine.runTask → Pipeline → HTTP fetch） */
  signal?: AbortSignal;
  /**
   * 外部数据会话（Data Agent 已 setup）：数据准备结果直达 Runner（Engine/Pipeline 只消费，
   * 不重复准备、不负责 teardown）。生命周期归编排层 —— 编排方必须 try/finally 调用
   * dataSession.teardown()（agent-pipeline 已按此约定执行）。
   */
  dataSession?: DataSession;
  /**
   * 执行计划（ExecutionPlan）：Runner 的真实控制契约 ——
   * order（执行顺序）/ maxCases（预算截断）/ maxConcurrency（并发硬顶）/
   * dryRun（零副作用）/ timeoutMs（整体时间预算，到点真实中止）/
   * policy.stopOnFailure（失败即停）/ enableRetry（重试开关）。
   */
  plan?: ExecutionPlan;
  /**
   * 用量计量器（实时预算）：每条用例执行前 beforeCase（maxCases 预算 + STOP 检查）、
   * 完成后 afterCase 实时扣减；budget.maxConcurrency 与 plan.maxConcurrency 取 min 参与执行。
   */
  meter?: UsageMeter;
  /** 与 TestDesign/Contract Gate 同一 scoped Resolver，禁止 Runner 重新解释依赖。 */
  contractResolver?: ContractResolver;
  /** canonical TEST_CASE_V2 的 Scenario Runner 运行时能力。 */
  scenarioRunnerOptions?: TestCaseScenarioAdapterOptions;
}

export interface ExecutionRunToolInput {
  /** canonical 路径：原样消费 Generator + Quality Gate 产出的 TEST_CASE_V2。 */
  testCases?: TestCase[];
  /** 旧独立调用方兼容路径；Agent Pipeline 不再使用。 */
  cases?: LoadedCase[];
  options?: ExecutionRunOptions;
}

/** 执行器签名（可注入 mock） */
export type ExecutionRunner = (
  cases: LoadedCase[],
  options: ExecutionRunOptions,
) => Promise<ExecutionOutcome>;

/** 将核心引擎结果转为 Agent CaseResult；执行状态采用 fail-closed 语义。 */
export function caseResultFromEngine(
  c: RunnerLoadedCase,
  result: RunTaskResult,
  durationMs: number,
) {
  const pass = result.executed && result.status === 'PASS' && result.passRate === 100 && !result.hasBlockingIssue;
  return {
    caseId: String(c.def.extra?.agentTestCaseId ?? c.def.name),
    name: c.name,
    feature: c.feature,
    scene: c.def.scene,
    processor: result.processor,
    processorInvoked: result.processorInvoked ?? result.executed,
    requestId: result.requestId,
    timestamp: new Date().toISOString(),
    priority: Array.isArray(c.def.tags) ? c.def.tags.find((t) => /^P[0-3]$/.test(t)) : undefined,
    tags: c.def.tags,
    executed: result.executed,
    status: result.status,
    pass,
    passRate: pass ? result.passRate : 0,
    timedOut: result.status === 'TIMEOUT',
    error: pass ? undefined : result.status === 'NOT_EXECUTED'
      ? 'NOT_EXECUTED：未完成真实 Processor 执行'
      : result.status === 'BLOCKED'
        ? 'BLOCKED：执行未完成或没有有效断言'
        : result.status === 'TIMEOUT'
          ? 'TIMEOUT：执行超时，底层任务已真实停止'
          : result.status === 'CANCELLED'
            ? 'CANCELLED：执行被取消，底层任务已真实停止'
            : result.status === 'FAIL'
              ? 'FAIL：断言未通过'
              : undefined,
    checks: result.checks.map((check) => ({
      name: check.name,
      pass: check.pass,
      detail: check.detail,
      level: check.level,
      kind: check.kind,
    })),
    durationMs,
  };
}

/** 真实执行器：调用现有 Engine 执行用例并聚合结果（p-limit 真实限制并发；信号贯穿中止） */
export const realEngineRunner: ExecutionRunner = async (cases, options) => {
  // dry-run / 策略禁止真实执行：零副作用——不加载配置、不加载处理器、不触引擎
  if (planRequiresDryRun(options.plan, options.dryRun)) {
    const reason = options.plan?.policy?.realExecution === false
      ? '策略禁止真实执行（policy.realExecution=false）'
      : 'dry-run 不加载配置、不调用引擎、不产生任何副作用';
    const results = cases.map((c) => ({
      caseId: String(c.def.extra?.agentTestCaseId ?? c.name),
      name: c.name,
      feature: c.feature,
      scene: c.def.scene,
      executed: false,
      status: 'NOT_EXECUTED' as const,
      pass: false,
      passRate: 0,
      error: `NOT_EXECUTED：${reason}`,
    }));
    logger.info(`execution.run dry-run（runner 级）：${results.length} 条用例仅校验输入，零副作用`);
    return computeOutcome(cases[0]?.feature ?? 'default', results, {
      executed: false,
      summary: `dry-run：${results.length} 条用例未执行（零副作用）`,
    });
  }

  const envName = options.env || getEnvFromEnv() || 'test';
  let cfg: AppConfig;
  try {
    cfg = loadConfig(envName);
  } catch (e) {
    throw new Error(`配置加载失败：${(e as Error).message}`);
  }

  // 自动扫描加载场景处理器
  const loadedScenes = await autoLoadScenes();
  for (const [name, handler] of Object.entries(loadedScenes)) {
    registerScene(name, handler);
  }

  const engine = new Engine({ contractResolver: options.contractResolver });
  const feature = options.func || cases[0]?.feature || 'default';
  return runCasesWithEngine(engine, cfg, cases, { ...options, env: envName, func: feature });
}

/** 用例的 Plan 匹配键（与结果归一一致：extra.agentTestCaseId 优先，回退用例名） */
function planKeyOf(c: LoadedCase): string {
  return String(c.def.extra?.agentTestCaseId ?? c.def.name);
}

/** 用 Plan.order 重排用例（按计划顺序执行）；未出现在 order 中的保持输入顺序放在末尾 */
function orderCasesByPlan(cases: LoadedCase[], order: string[]): LoadedCase[] {
  if (!order.length) return cases;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...cases].sort((a, b) => {
    const ra = rank.get(planKeyOf(a));
    const rb = rank.get(planKeyOf(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1; // 在计划内的优先
    if (rb !== undefined) return 1;
    return 0; // 都不在计划内：保持稳定
  });
}

/** Plan 是否要求零副作用执行（dry-run 或策略禁止真实执行） */
export function planRequiresDryRun(plan: ExecutionPlan | undefined, optionsDryRun?: boolean): boolean {
  return optionsDryRun === true || plan?.dryRun === true || plan?.policy?.realExecution === false;
}

/** dry-run 结果映射：全部 NOT_EXECUTED（零副作用，计入结果统计） */
function dryRunOutcome(cases: LoadedCase[], feature: string, reason: string): ExecutionOutcome {
  const results: CaseExecutionResult[] = cases.map((c) => ({
    caseId: planKeyOf(c),
    name: c.name,
    feature: c.feature,
    scene: c.def.scene,
    executed: false,
    status: 'NOT_EXECUTED' as const,
    pass: false,
    passRate: 0,
    error: `NOT_EXECUTED：${reason}`,
  }));
  return computeOutcome(feature, results, {
    executed: false,
    summary: `dry-run：${results.length} 条用例未执行（${reason}）`,
  });
}

/**
 * 用指定 Engine 实例执行用例（realEngineRunner 的可注入内核，测试可传 stub engine）。
 *
 * ExecutionPlan 在此真实生效（Plan → Runner → 行为，而非仅写进报告）：
 * - order            → 按计划顺序执行（优先级 P0→P3）
 * - maxCases         → 超出预算的用例 NOT_EXECUTED（预算截断），计入结果不静默丢弃
 * - maxConcurrency   → 有效并发 = min(concurrency, maxConcurrency)，p-limit 硬顶
 * - timeoutMs        → 整体时间预算：到点 AbortSignal 中止全部在途用例，未启动的标 TIMEOUT
 * - policy.stopOnFailure → 首个失败后停止调度，剩余 NOT_EXECUTED
 * - enableRetry      → false 强制不重试；true 时按用例 extra.retries（上限 3）
 * - dryRun / realExecution=false → 零副作用路径（不触引擎）
 */
export async function runCasesWithEngine(
  engine: Engine,
  cfg: AppConfig,
  cases: LoadedCase[],
  options: ExecutionRunOptions & { func?: string },
): Promise<ExecutionOutcome> {
  const feature = options.func || cases[0]?.feature || 'default';
  const plan = options.plan;
  const results: CaseExecutionResult[] = [];
  const reports: string[] = [];

  // dry-run / 策略禁止真实执行：零副作用路径（不加载引擎状态、不触 runTask）
  if (planRequiresDryRun(plan, options.dryRun)) {
    return dryRunOutcome(cases, feature, plan?.policy?.realExecution === false
      ? '策略禁止真实执行（policy.realExecution=false）'
      : 'dry-run 不调用真实 Runner');
  }

  // ── Plan.order：按计划顺序执行 ──
  const ordered = orderCasesByPlan(cases, plan?.order ?? []);

  // ── Plan.maxCases：预算截断（被截断的用例计入 NOT_EXECUTED，不静默消失）──
  let executable = ordered;
  if (plan?.maxCases !== undefined && plan.maxCases >= 0 && ordered.length > plan.maxCases) {
    const dropped = ordered.slice(plan.maxCases);
    executable = ordered.slice(0, plan.maxCases);
    for (const c of dropped) {
      results.push({
        caseId: planKeyOf(c), name: c.name, feature: c.feature, scene: c.def.scene,
        executed: false, status: 'NOT_EXECUTED', pass: false, passRate: 0,
        error: `NOT_EXECUTED：maxCases 预算截断（plan.maxCases=${plan.maxCases}，按 order 截断）`,
      });
    }
    logger.info(`执行计划预算截断：${ordered.length} → ${executable.length} 条（maxCases=${plan.maxCases}）`);
  }

  // ── 有效并发：min(options.concurrency ?? plan.concurrency, plan.maxConcurrency, 预算 maxConcurrency) ──
  const clamps = [options.concurrency ?? plan?.concurrency ?? 1];
  if (plan?.maxConcurrency !== undefined) clamps.push(plan.maxConcurrency);
  if (options.meter?.maxConcurrencyClamp !== undefined) clamps.push(options.meter.maxConcurrencyClamp);
  const concurrency = Math.max(1, Math.floor(Math.min(...clamps)));
  const limit = pLimit(concurrency);

  // ── Plan.timeoutMs：整体时间预算（到点中止在途用例；与外部取消信号级联）──
  const runAbort = new AbortController();
  const unlinkExternal = linkAbortSignal(runAbort, options.signal);
  let timeoutTimer: NodeJS.Timeout | undefined;
  if (plan?.timeoutMs !== undefined && plan.timeoutMs > 0) {
    timeoutTimer = setTimeout(
      () => abortForTimeout(runAbort, `执行计划超时（${plan.timeoutMs}ms）：中止全部在途用例`),
      plan.timeoutMs,
    );
  }

  // ── Plan.policy.stopOnFailure：失败即停（已启动的允许完成，未启动的 NOT_EXECUTED）──
  let stopped = false;
  // ── 实时预算 STOP：预算耗尽后停止调度剩余用例（与 stopOnFailure 同语义）──
  let budgetStopped = false;
  const meter = options.meter;

  const notExecutedResult = (c: LoadedCase, reason: string): CaseExecutionResult => ({
    caseId: planKeyOf(c), name: c.name, feature: c.feature, scene: c.def.scene,
    executed: false, status: 'NOT_EXECUTED', pass: false, passRate: 0, error: `NOT_EXECUTED：${reason}`,
  });

  const runCase = async (c: LoadedCase): Promise<void> => {
    const finalizeCase = (): void => {
      // 实时扣减用例计数（超限即 STOP 后续调度）
      try {
        meter?.afterCase();
      } catch { /* afterCase 不抛（STOP 状态记录在 meter） */ }
    };
    // 实时预算已 STOP：剩余用例不再调度（NOT_EXECUTED 计入结果）
    if (budgetStopped || meter?.isStopped) {
      budgetStopped = true;
      results.push(notExecutedResult(c, `预算超限（STOP）：${meter?.reasons.join('，') ?? '预算耗尽'}，停止调度后续用例`));
      return;
    }
    // maxCases 预算：超出用例数预算 → STOP 后续调度（beforeCase 抛 BudgetExceededError）
    if (meter) {
      try {
        meter.beforeCase();
      } catch {
        budgetStopped = true;
        results.push(notExecutedResult(c, 'maxCases 预算截断（budget.maxCases），停止调度后续用例'));
        return;
      }
    }

    // 整体超时已触发：未启动的用例标 TIMEOUT（预算耗尽，不再调度）
    if (runAbort.signal.aborted) {
      const reason = runAbort.signal.reason;
      results.push({
        ...notExecutedResult(c, reason instanceof Error ? reason.message : '执行预算耗尽'),
        status: 'TIMEOUT', timedOut: true,
      });
      return;
    }
    // stopOnFailure 已触发：停止调度
    if (stopped) {
      results.push(notExecutedResult(c, 'policy.stopOnFailure：前置用例失败，停止调度'));
      return;
    }

    const t0 = Date.now();
    const caseId = concurrency > 1
      ? `${c.feature || 'default'}-${Date.now()}-${c.name.replace(/[\s\\/:*?"<>|]/g, '_').slice(0, 30)}`
      : undefined;

    // 用例级重试：enableRetry=false 强制 0 次；否则按 extra.retries（上限 3）；取消不重试
    const retriesFromDef = typeof c.def.extra?.retries === 'number' ? c.def.extra.retries : 0;
    const maxRetries = plan?.enableRetry === false ? 0 : Math.min(3, Math.max(0, retriesFromDef));

    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * attempt)); // 轻量退避
      }
      try {
        const engineResult = await engine.runTask(
          cfg,
          c.def,
          options.env || 'test',
          feature,
          options.reporter ?? null,
          false,
          caseId,
          options.autoSetup === true,
          undefined,
          undefined,
          runAbort.signal,
          // 外部数据会话：已由编排层 setup，Pipeline 只消费（不重复准备）
          options.dataSession,
        );
        reports.push(...engineResult.files);
        const r = caseResultFromEngine(c, engineResult, Date.now() - t0);
        results.push(r);
        finalizeCase();
        // stopOnFailure：失败（含 TIMEOUT/CANCELLED）即停止调度后续
        if (!r.pass && plan?.policy?.stopOnFailure) stopped = true;
        return;
      } catch (e: any) {
        const reason = abortReasonOf(e);
        // 取消（CANCELLED）/ 超时（TIMEOUT，预算已耗尽）不重试
        if (reason !== null || attempt >= maxRetries) {
          results.push({
            caseId: planKeyOf(c), name: c.name, feature: c.feature, scene: c.def.scene,
            executed: false, status: reason ?? 'BLOCKED', timedOut: reason === 'TIMEOUT',
            pass: false, passRate: 0,
            error: reason ? `${reason}：${e.message}（底层任务已真实停止）` : e.message,
            durationMs: Date.now() - t0,
          });
          if (plan?.policy?.stopOnFailure) stopped = true;
          finalizeCase();
          return;
        }
        // 可重试失败：进入下一次尝试
      }
    }
  };

  try {
    await Promise.all(executable.map((c) => limit(() => runCase(c))));
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    unlinkExternal();
  }

  const allExecuted = results.length > 0 && results.every((result) => result.executed !== false && result.status !== 'NOT_EXECUTED');
  const outcome = computeOutcome(feature, results, { reports, executed: allExecuted });
  logger.info(`执行引擎完成：${outcome.summary}`);
  return outcome;
}

function scenarioCaseResult(
  testCase: TestCase,
  execution: Awaited<ReturnType<typeof runTestCaseV2WithScenarioRunner>>,
): CaseExecutionResult {
  const result = execution.outcome.result;
  const assertionEvidence = new Map(result.evidence
    .filter((item) => item.assertionId)
    .map((item) => [item.assertionId!, item]));
  const checks = execution.adapted.scenario.assertions.flatMap((assertion) => {
    const evidence = assertionEvidence.get(assertion.id);
    const data = evidence?.data && typeof evidence.data === 'object' && !Array.isArray(evidence.data)
      ? evidence.data as Record<string, unknown> : undefined;
    if (!data || typeof data.pass !== 'boolean') return [];
    return [{
      name: assertion.description ?? assertion.id,
      pass: data.pass,
      detail: `${assertion.operator} ${assertion.target}：actual=${JSON.stringify(data.actual)} expected=${JSON.stringify(data.expected)}`,
      level: assertion.severity,
      kind: 'BUSINESS' as const,
    }];
  });
  const status = result.status === 'PASS' || result.status === 'FAIL'
    || result.status === 'BLOCKED' || result.status === 'NOT_EXECUTED'
    || result.status === 'TIMEOUT' || result.status === 'CANCELLED'
    ? result.status : 'BLOCKED';
  return {
    caseId: testCase.id,
    name: testCase.name,
    feature: testCase.feature,
    scene: 'scenario',
    priority: testCase.priority,
    tags: testCase.tags,
    processor: result.processors.length ? result.processors.join(',') : undefined,
    processorInvoked: result.processorInvoked,
    requestId: result.runId,
    timestamp: result.finishedAt,
    executed: result.executed,
    status,
    pass: status === 'PASS',
    passRate: status === 'PASS' ? 100 : 0,
    blockedReason: result.blockedReasons,
    evidence: result.evidence,
    error: status === 'PASS' ? undefined : result.summary,
    timedOut: status === 'TIMEOUT',
    durationMs: result.durationMs,
    checks,
  };
}

async function runTestCaseV2Cases(
  testCases: TestCase[],
  options: ExecutionRunOptions,
  context: AgentContext,
  signal?: AbortSignal,
): Promise<ExecutionOutcome> {
  const plan = options.plan;
  const byId = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const ordered = (plan?.order ?? testCases.map((testCase) => testCase.id))
    .flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  const limit = Math.min(
    ordered.length,
    plan?.maxCases ?? Number.POSITIVE_INFINITY,
    options.meter?.maxCasesClamp ?? Number.POSITIVE_INFINITY,
  );
  const selected = ordered.slice(0, limit);
  const deferred = ordered.slice(limit);
  const configured = options.scenarioRunnerOptions;
  const runtime: TestCaseScenarioAdapterOptions = {
    ...(configured ?? {}),
    processors: configured?.processors ?? [],
    environmentAvailable: configured?.environmentAvailable === true,
    policyAllowed: configured?.policyAllowed === true && plan?.policy?.realExecution !== false,
    variables: {
      ...(options.dataSession?.context ?? {}),
      ...(configured?.variables ?? {}),
    },
    contractResolver: options.contractResolver ?? configured?.contractResolver,
    signal,
  };
  const results: CaseExecutionResult[] = [];
  for (const testCase of selected) {
    if (signal?.aborted) {
      results.push({
        caseId: testCase.id, name: testCase.name, feature: testCase.feature,
        executed: false, status: 'CANCELLED', pass: false, passRate: 0,
        error: 'CANCELLED：Scenario 执行被取消',
      });
      continue;
    }
    try {
      options.meter?.beforeCase();
      const execution = await runTestCaseV2WithScenarioRunner(testCase, {
        ...runtime,
        runId: `${runtime.runId ?? context.taskId}:${testCase.id}`,
      });
      const caseResult = scenarioCaseResult(testCase, execution);
      results.push(caseResult);
      options.meter?.afterCase();
      if (plan?.policy?.stopOnFailure && caseResult.status === 'FAIL') break;
    } catch (error) {
      results.push({
        caseId: testCase.id, name: testCase.name, feature: testCase.feature,
        executed: false, status: 'BLOCKED', pass: false, passRate: 0,
        error: `BLOCKED：${(error as Error).message}`,
      });
      if (plan?.policy?.stopOnFailure) break;
    }
  }
  const returned = new Set(results.map((result) => result.caseId));
  for (const testCase of [...deferred, ...selected.filter((item) => !returned.has(item.id))]) {
    if (returned.has(testCase.id)) continue;
    results.push({
      caseId: testCase.id, name: testCase.name, feature: testCase.feature,
      executed: false, status: 'NOT_EXECUTED', pass: false, passRate: 0,
      error: deferred.includes(testCase)
        ? 'NOT_EXECUTED：Execution Plan / Budget 截断'
        : 'NOT_EXECUTED：stopOnFailure 停止后续调度',
    });
  }
  const outcome = computeOutcome(testCases[0]?.feature ?? 'default', results, {
    executed: results.length > 0 && results.every((item) => item.executed === true),
    plan,
  });
  context.logger.info(`execution.run Scenario Adapter 完成：${outcome.summary}`);
  return outcome;
}

/** Execution Run Tool 实现 */
export class ExecutionRunTool implements AgentTool<ExecutionRunToolInput, ExecutionOutcome> {
  name = 'execution.run';
  description = '通过现有执行引擎执行测试用例，返回结构化执行结果';
  permission: ToolPermission = 'risky';
  inputSchema = {
    type: 'object',
    properties: {
      testCases: { type: 'array' },
      cases: { type: 'array' },
      options: { type: 'object' },
    },
    anyOf: [{ required: ['testCases'] }, { required: ['cases'] }],
  };
  outputSchema = { type: 'object' };
  timeoutMs = 600_000;

  constructor(private runner: ExecutionRunner = realEngineRunner) {}

  async execute(input: ExecutionRunToolInput, context: AgentContext, signal?: AbortSignal): Promise<ExecutionOutcome> {
    const testCases = input?.testCases ?? [];
    const cases = input?.cases ?? [];
    if (!testCases.length && !cases.length) {
      context.logger.warn('execution.run 无输入用例，返回空结果');
      return computeOutcome('default', [], { executed: false });
    }
    if (testCases.length && cases.length) throw new Error('execution.run 不允许同时传入 TEST_CASE_V2 与 LoadedCase');
    if (planRequiresDryRun(input.options?.plan, input.options?.dryRun)) {
      // dry-run / 策略禁止真实执行：零副作用——不触 runner、不发请求、不写数据
      const reason = input.options?.plan?.policy?.realExecution === false
        ? '策略禁止真实执行（policy.realExecution=false）'
        : 'dry-run 不调用真实 Runner';
      const results = testCases.length ? testCases.map((testCase) => ({
        caseId: testCase.id,
        name: testCase.name,
        feature: testCase.feature,
        scene: 'scenario',
        executed: false,
        status: 'NOT_EXECUTED' as const,
        pass: false,
        passRate: 0,
        error: `NOT_EXECUTED：${reason}`,
      })) : cases.map((testCase) => ({
        caseId: String(testCase.def.extra?.agentTestCaseId ?? testCase.name),
        name: testCase.name,
        feature: testCase.feature,
        scene: testCase.def.scene,
        executed: false,
        status: 'NOT_EXECUTED' as const,
        pass: false,
        passRate: 0,
        error: `NOT_EXECUTED：${reason}`,
      }));
      context.logger.info(`execution.run dry-run：仅校验输入（${reason}）`);
      return computeOutcome(testCases[0]?.feature ?? cases[0]?.feature ?? 'default', results, {
        executed: false,
        summary: `dry-run：${results.length} 条用例未执行`,
      });
    }
    if (testCases.length) return runTestCaseV2Cases(testCases, input.options ?? {}, context, signal);
    // 取消信号贯穿：Tool 层超时/取消 → runner → Engine.runTask → Pipeline → HTTP fetch
    const outcome = await this.runner(cases, { ...input.options, signal });
    context.logger.info(`execution.run 完成：${outcome.summary}`);
    return outcome;
  }
}

/** 便捷工厂：创建 Execution Run Tool（可注入自定义执行器便于测试） */
export function createExecutionRunTool(runner?: ExecutionRunner): ExecutionRunTool {
  return new ExecutionRunTool(runner);
}

/** 内部工具：注册的数据工厂解析（供 --auto-setup 透传） */
export { getDataFactory };
