// Execution Agent：规划用例执行顺序，并通过 Tool 调用现有 Execution Engine 执行
// 策略：确定性规划（按优先级排序）→ 经 ToolRegistry 调用 execution.run 执行
//      → 产出结构化 ExecutionOutcome。
// 遵循「Agent 必须经 Tool 调用执行能力」：实际执行只发生在 context.tools.call('execution.run')。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import { toLoadedCase } from '../test-design/testcase-schema.js';
import type { LoadedCase } from '../../cases/loader.js';
import {
  ExecutionOutcome,
  ExecutionPlan,
  computeOutcome,
} from './execution-schema.js';

/** 优先级排序权重 */
const PRIORITY_WEIGHT: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 执行 Agent 输入 */
export interface ExecutionAgentInput {
  testCases: TestCase[];
  environment?: string;
  /** 执行选项 */
  options?: {
    autoSetup?: boolean;
    dryRun?: boolean;
    concurrency?: number;
  };
}

/** Execution Agent */
export class ExecutionAgent extends BaseAgent<ExecutionAgentInput, ExecutionOutcome> {
  name = 'execution';
  version = '0.2.0';
  description = '规划执行顺序并调用执行引擎执行用例，产出结构化执行结果';

  /** 规划执行顺序：P0 → P1 → P2 → P3，保持稳定标签优先 */
  planExecution(testCases: TestCase[], concurrency = 1): ExecutionPlan {
    const ordered = [...testCases].sort((a, b) => {
      const w = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9);
      return w !== 0 ? w : a.id.localeCompare(b.id);
    });
    return {
      order: ordered.map((c) => c.id),
      concurrency,
      enableRetry: true,
      reason: '按优先级 P0→P3 排序，核心链路优先执行',
    };
  }

  async execute(input: ExecutionAgentInput, context: AgentContext): Promise<ExecutionOutcome> {
    if (!input?.testCases?.length) {
      throw new Error('执行输入为空：请提供 TestCase 列表');
    }
    const feature = input.testCases[0]?.feature || 'default';

    // 1. 规划执行顺序（确定性）
    const concurrency = input.options?.concurrency ?? 1;
    const plan = this.planExecution(input.testCases, concurrency);
    context.logger.info(`执行规划：${plan.order.length} 条用例（并发 ${concurrency}，${plan.reason}）`);

    // 2. 转 LoadedCase，接入现有执行链路
    const loaded: LoadedCase[] = input.testCases.map(toLoadedCase);

    // 3. 经 Tool 执行（未注册 Tool 时仅产出计划，标记未执行）
    if (!context.tools.has('execution.run')) {
      context.logger.warn('未注册 execution.run Tool，跳过实际执行（仅产出执行计划）');
      return computeOutcome(feature, [], {
        executed: false,
        plan,
        summary: '未执行（execution.run Tool 未注册）',
      });
    }

    const result = await context.tools.call<{ cases: LoadedCase[]; options?: unknown }, ExecutionOutcome>(
      'execution.run',
      {
        cases: loaded,
        options: {
          env: input.environment,
          autoSetup: input.options?.autoSetup === true,
          dryRun: input.options?.dryRun === true,
          concurrency,
        },
      },
      context,
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

/** 便捷工厂：创建 Execution Agent 实例 */
export function createExecutionAgent(): ExecutionAgent {
  return new ExecutionAgent();
}

// 重导出 schema / tool 便于外部消费
export { ExecutionOutcome, CaseExecutionResult, ExecutionPlan } from './execution-schema.js';
export { computeOutcome, normalizeOutcome, normalizeCaseExecutionResult, checksFromResults } from './execution-schema.js';
export { ExecutionRunTool, createExecutionRunTool, ExecutionRunner, ExecutionRunOptions, realEngineRunner } from './execution-run-tool.js';
