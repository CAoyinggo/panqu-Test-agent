// Data Agent：分析测试数据需求，产出结构化 DataPlan，并经 Tool 实际准备测试数据
// 策略：LLM 规划（System Prompt 内嵌 DataPlan JSON Schema）→ 校验
//      → 失败回退到确定性分析器。
// 数据准备遵循「Agent 必须经 Tool 调用执行能力」约束：prepareData 通过 context.tools.call('data.prepare') 执行。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { DataContext } from '../../core/types.js';
import {
  DataPlan,
  DATA_PLAN_JSON_SCHEMA,
  isDataPlanLike,
  validateDataPlan,
} from './data-schema.js';
import { analyzeDataPlan } from './data-analyzer.js';

/** 系统提示词：要求 LLM 严格按 Schema 输出 DataPlan */
const SYSTEM_PROMPT = `你是测试数据准备规划师。根据测试需求与用例规划数据准备方案。
输出必须严格符合如下 JSON Schema（只输出 JSON，不要任何解释或 Markdown 围栏）：
${JSON.stringify(DATA_PLAN_JSON_SCHEMA, null, 2)}

规则：
- needsSetup 为是否有数据准备动作；factoryName 为推荐数据工厂名（如 wan3 / user / order / default）
- setupActions 为执行前准备动作（type: account/balance/assets/tasks/cleanup），teardownActions 为执行后清理动作
- caseAssignments 为每条用例的工厂分配（caseId/factoryName/needsSetup）
- generateParams 为参数化生成参数（如 {"resolution":["720P","1080P"],"duration":[5,10]}）
- 计费断言用例需 balance 动作；并发用例需 tasks 动作；视频生成需 assets 动作；异常用例需 cleanup 动作
- 不要编造需求中不存在的动作`;

/** Data Agent 输入 */
export interface DataAgentInput {
  requirement: Requirement;
  testCases?: TestCase[];
  environment?: string;
}

/** Data Agent */
export class DataAgent extends BaseAgent<DataAgentInput, DataPlan> {
  name = 'data';
  version = '0.2.0';
  description = '规划并准备测试数据，产出结构化 DataPlan（LLM 优先，确定性分析器兜底）';

  async execute(input: DataAgentInput, context: AgentContext): Promise<DataPlan> {
    if (!input || !input.requirement) {
      throw new Error('数据规划输入为空：请提供 Requirement');
    }

    // 1. 尝试 LLM 规划（含 Mock，失败则回退）
    try {
      const plan = await this.planWithLLM(input, context);
      context.logger.info(`数据规划完成（LLM，needsSetup=${plan.needsSetup}，factory=${plan.factoryName}）`);
      return plan;
    } catch (e) {
      context.logger.warn(`LLM 规划数据失败，回退确定性分析器：${(e as Error).message}`);
    }

    // 2. 确定性分析器兜底（永远可用，不依赖 LLM）
    const plan = analyzeDataPlan(input);
    context.logger.info(`数据规划完成（确定性分析器，needsSetup=${plan.needsSetup}，factory=${plan.factoryName}）`);
    return plan;
  }

  /**
   * 经 Tool Registry 实际准备测试数据。
   * 若未注册 data.prepare Tool，返回空 DataContext（计划本身不受影响）。
   */
  async prepareData(plan: DataPlan, context: AgentContext): Promise<DataContext> {
    if (!plan.needsSetup) return {};
    if (!context.tools.has('data.prepare')) {
      context.logger.warn('未注册 data.prepare Tool，跳过实际数据准备（可注册 DataPrepareTool）');
      return {};
    }
    const result = await context.tools.call<{ factoryName: string; params?: Record<string, unknown> }, DataContext>(
      'data.prepare',
      { factoryName: plan.factoryName, params: plan.generateParams },
      context,
    );
    if (!result.ok) {
      context.logger.warn(`数据准备失败：${result.error}`);
      return {};
    }
    const data = result.data ?? {};
    plan.dataContext = data;
    return data;
  }

  /** LLM 规划：构造提示 → 解析 JSON → 校验 → 归一化 */
  private async planWithLLM(input: DataAgentInput, context: AgentContext): Promise<DataPlan> {
    const { requirement, testCases = [], environment } = input;
    const userContent = `功能模块：${requirement.feature}
执行环境：${environment ?? 'test'}
能力：[${requirement.capabilities.join(', ')}]
参数取值：${JSON.stringify(requirement.requirements)}
测试用例（${testCases.length} 条）：
${testCases
    .slice(0, 30)
    .map((c) => `- ${c.id} [${c.priority}] ${c.name}（tags: ${c.tags.join(',')}，断言: ${c.assertions.map((a) => a.target ?? 'submit').join(',')}）`)
    .join('\n')}`;

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!isDataPlanLike(parsed)) {
      throw new Error('LLM 输出缺少 feature 字段');
    }
    const plan = await validateDataPlan(parsed);
    plan.source = requirement.source;
    plan.confidence = Math.max(plan.confidence ?? 0, 0.85);
    return plan;
  }
}

/** 便捷工厂：创建 Data Agent 实例 */
export function createDataAgent(): DataAgent {
  return new DataAgent();
}

// 重导出 schema / analyzer / tool 便于外部消费
export { DataPlan, DataAction, CaseDataAssignment, DataNeedType } from './data-schema.js';
export { DATA_PLAN_JSON_SCHEMA, normalizeDataPlan, validateDataPlan } from './data-schema.js';
export { analyzeDataPlan, DataAnalyzerInput } from './data-analyzer.js';
export { DataPrepareTool, createDataPrepareTool, DataPrepareInput } from './data-prepare-tool.js';
