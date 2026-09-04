// Execution Agent：规划用例执行顺序，并通过 Tool 调用现有 Execution Engine 执行
// 策略：确定性规划（按优先级排序）→ 经 ToolRegistry 调用 execution.run 执行
//      → 产出结构化 ExecutionOutcome。
// 遵循「Agent 必须经 Tool 调用执行能力」：实际执行只发生在 context.tools.call('execution.run')。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import { toLoadedCase } from '../test-design/testcase-schema.js';
import type { LoadedCase } from '../../cases/loader.js';
import type { TestCaseScenarioAdapterOptions } from '../../acceptance/test-case-scenario-adapter.js';
import type { DataSession } from '../../core/data-session.js';
import type { UsageMeter } from '../observability/usage-meter.js';
import {
  ExecutionOutcome,
  ExecutionPlan,
  ExecutionPolicy,
  computeOutcome,
} from './execution-schema.js';

/** 优先级排序权重 */
const PRIORITY_WEIGHT: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Execution Agent 输入 */
export interface ExecutionAgentInput {
  testCases: TestCase[];
  environment?: string;
  /** 执行选项（全部字段进入 ExecutionPlan 并由 Runner 真实执行） */
  options?: {
    autoSetup?: boolean;
    dryRun?: boolean;
    concurrency?: number;
    /** 外部数据会话（Data Agent 准备的数据直达 Runner，不再重复准备） */
    dataSession?: DataSession;
    /** 执行用例数上限（预算截断） */
    maxCases?: number;
    /** 并发硬顶（与 concurrency 取较小值） */
    maxConcurrency?: number;
    /** 整体执行时间预算毫秒（到点中止全部在途用例） */
    timeoutMs?: number;
    /** 执行策略（stopOnFailure / realExecution / realBilling） */
    policy?: ExecutionPolicy;
    /** 用量计量器（实时预算：maxCases/maxConcurrency/STOP 贯穿 Runner） */
    meter?: UsageMeter;
    /** Worker/调用方取消信号；必须贯穿 Tool → Runner → Engine → HTTP。 */
    signal?: AbortSignal;
    /** TEST_CASE_V2 的运行时 Processor/Observer/Hook 能力；由 Scenario Adapter 动态重算 Readiness。 */
    scenarioRunnerOptions?: TestCaseScenarioAdapterOptions;
    /**
     * Orchestrator 在 Policy Gate 前生成并审核的执行计划。
     * 提供后 ExecutionAgent 必须原样消费，禁止 Gate 后重新规划。
     */
    plan?: ExecutionPlan;
  };
}

/** Execution Agent */
export class ExecutionAgent extends BaseAgent<ExecutionAgentInput, ExecutionOutcome> {
  name = 'execution';
  version = '0.2.0';
  description = '规划执行顺序并调用执行引擎执行用例，产出结构化执行结果';

  /** 规划执行顺序：P0 → P1 → P2 → P3，保持稳定标签优先；控制参数全部写入 Plan（Runner 真实执行） */
  planExecution(testCases: TestCase[], concurrency = 1, config: {
    maxCases?: number;
    maxConcurrency?: number;
    dryRun?: boolean;
    timeoutMs?: number;
    policy?: ExecutionPolicy;
    enableRetry?: boolean;
  } = {}): ExecutionPlan {
    const ordered = [...testCases].sort((a, b) => {
      const w = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
      return w !== 0 ? w : a.id.localeCompare(b.id);
    });
    return {
      order: ordered.map((c) => c.id),
      concurrency,
      enableRetry: config.enableRetry ?? true,
      reason: '按优先级 P0→P3 排序，核心链路优先执行',
      maxCases: config.maxCases,
      maxConcurrency: config.maxConcurrency,
      dryRun: config.dryRun,
      timeoutMs: config.timeoutMs,
      policy: config.policy,
    };
  }

  async execute(input: ExecutionAgentInput, context: AgentContext): Promise<ExecutionOutcome> {
    if (!input?.testCases?.length) {
      throw new Error('执行输入为空：请提供 TestCase 列表');
    }
    const feature = input.testCases[0]?.feature || 'default';

    // 1. 优先消费 Orchestrator 在 Policy Gate 前确定的计划；仅独立调用时本地规划。
    const concurrency = input.options?.concurrency ?? 1;
    const plan = input.options?.plan ?? this.planExecution(input.testCases, concurrency, {
      maxCases: input.options?.maxCases,
      maxConcurrency: input.options?.maxConcurrency,
      dryRun: input.options?.dryRun,
      timeoutMs: input.options?.timeoutMs,
      policy: input.options?.policy,
    });
    assertPlanMatchesCases(plan, input.testCases);
    context.logger.info(`执行计划：${plan.order.length} 条用例（并发 ${plan.concurrency}${plan.maxConcurrency ? `（硬顶 ${plan.maxConcurrency}）` : ''}，${plan.reason}）`);

    // 2. 经 Tool 执行（未注册 Tool 时仅产出计划，标记未执行）。canonical V2 Case
    // 原样进入 Scenario Adapter；只有显式的旧 Test DSL 调用方才保留 LoadedCase 兼容路径。
    if (!context.tools.has('execution.run')) {
      context.logger.warn('未注册 execution.run Tool，跳过实际执行（仅产出执行计划）');
      return computeOutcome(feature, [], {
        executed: false,
        plan,
        summary: '未执行（execution.run Tool 未注册）',
      });
    }

    const allV2 = input.testCases.every((testCase) => testCase.schemaVersion === 'TEST_CASE_V2');
    if (!allV2 && input.testCases.some((testCase) => testCase.schemaVersion === 'TEST_CASE_V2')) {
      throw new Error('拒绝混合执行 TEST_CASE_V2 与旧 Test DSL；请在调用边界完成资产迁移');
    }
    const payload = allV2
      ? { testCases: input.testCases }
      : { cases: input.testCases.map(toLoadedCase) as LoadedCase[] };
    const result = await context.tools.call<{
      testCases?: TestCase[];
      cases?: LoadedCase[];
      options?: unknown;
    }, ExecutionOutcome>(
      'execution.run',
      {
        ...payload,
        options: {
          env: input.environment,
          autoSetup: input.options?.autoSetup === true,
          dryRun: plan.dryRun === true,
          concurrency: plan.concurrency,
          dataSession: input.options?.dataSession,
          meter: input.options?.meter,
          contractResolver: context.metadata.contractResolver,
          scenarioRunnerOptions: input.options?.scenarioRunnerOptions
            ?? context.metadata.scenarioRunnerOptions,
          // ExecutionPlan 即控制契约：Runner 按 plan（order/maxCases/maxConcurrency/
          // dryRun/timeoutMs/policy/enableRetry）真实执行
          plan,
        },
      },
      context,
      { signal: input.options?.signal },
    );

    if (!result.ok) {
      context.logger.error(`执行失败：${result.error}`);
      return computeOutcome(feature, [], {
        executed: false,
        plan,
        summary: `执行失败：${result.error}`,
      });
    }

    const outcome = result.data ?? computeOutcome(feature, [], { executed: true, plan });
    outcome.plan = plan;
    context.logger.info(`执行完成：${outcome.summary}`);
    return outcome;
  }
}

/** Gate 后防篡改：计划必须完整且只包含本次待执行用例。 */
function assertPlanMatchesCases(plan: ExecutionPlan, testCases: TestCase[]): void {
  const caseIds = testCases.map((testCase) => testCase.id);
  const planned = new Set(plan.order);
  if (plan.order.length !== caseIds.length || planned.size !== caseIds.length
    || caseIds.some((caseId) => !planned.has(caseId))) {
    throw new Error('Execution Plan 与待执行用例不一致，拒绝执行');
  }
  if (!Number.isInteger(plan.concurrency) || plan.concurrency < 1) {
    throw new Error('Execution Plan concurrency 必须为正整数');
  }
}

/** 便捷工厂：创建 Execution Agent 实例 */
export function createExecutionAgent(): ExecutionAgent {
  return new ExecutionAgent();
}

// 重导出 schema / tool 便于外部消费
export { ExecutionOutcome, CaseExecutionResult, ExecutionPlan } from './execution-schema.js';
export { computeOutcome, normalizeOutcome, normalizeCaseExecutionResult, checksFromResults } from './execution-schema.js';
export { ExecutionRunTool, createExecutionRunTool, ExecutionRunner, ExecutionRunOptions, realEngineRunner } from './execution-run-tool.js';
