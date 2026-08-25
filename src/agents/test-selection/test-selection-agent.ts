// Test Selection Agent：智能测试选择（LLM 优先，确定性回退）
// 目标：Phase 11 —— 回答「到底哪些测试应该执行」，并保留「为什么执行 / 为什么跳过 / 为什么提优」。
// 输入：Requirement + TestCase[] + RiskAssessment + 历史失败（来自 Memory）+ 执行预算。
// 输出：TestSelection（selectedCases / skippedCases / priorityOrder / reasons / statistics）。
// 历史知识：优先从 AgentContext.history / memory 检索失败与 flaky 用例，喂给选择决策。
import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import {
  TestSelection,
  SELECTION_JSON_SCHEMA,
  isSelectionLike,
  validateSelection,
  buildSelection,
} from './selection-schema.js';
import { selectTestCases, SelectionHistory, TestSelectionInput } from './selection-analyzer.js';

/** 系统提示词（默认内置，可被 Prompt Registry 覆盖） */
export const TEST_SELECTION_SYSTEM_PROMPT = `你是测试选择专家。根据需求、测试用例、风险评估与历史执行情况，决定本次要执行的测试集。
输出必须严格符合如下 JSON Schema（只输出 JSON）：
${JSON.stringify(SELECTION_JSON_SCHEMA, null, 2)}

选择原则：
- P0/P1 核心用例全量执行
- 命中风险维度（affectedCases / 高风险标签）的用例必须选择并提高优先级
- 历史失败用例必须选择并优先回归
- P2/P3 按参数覆盖与风险命中抽样
- 每条 selectedCases / skippedCases 必须在 reasons 中说明理由（为什么选 / 为什么跳 / 为什么提优）`;

/** 从 Context 汇总历史失败/flaky（memory 优先，其次 context.history） */
async function gatherHistory(context: AgentContext): Promise<SelectionHistory> {
  const history: SelectionHistory = {};
  const h = context.history as { failedCases?: unknown[]; flakyCases?: unknown[] } | undefined;
  if (h?.failedCases) {
    history.failedCaseIds = h.failedCases.map((c) => {
      const id = (c as { caseId?: string; id?: string }).caseId ?? (c as { id?: string }).id;
      return id ? String(id) : '';
    }).filter(Boolean);
  }
  // memory 检索失败记录（type=failure）补充
  try {
    const records = await context.memory.query({ type: 'failure', limit: 50 });
    const failed = records
      .map((r) => String((r.data as { caseId?: string })?.caseId ?? ''))
      .filter(Boolean);
    if (failed.length) history.failedCaseIds = [...new Set([...(history.failedCaseIds ?? []), ...failed])];
    const flaky = records
      .filter((r) => r.type === 'flaky')
      .map((r) => String((r.data as { caseId?: string })?.caseId ?? ''))
      .filter(Boolean);
    if (flaky.length) history.flakyCaseIds = [...new Set([...(history.flakyCaseIds ?? []), ...flaky])];
  } catch {
    // memory 不可用时静默忽略
  }
  return history;
}

/** Test Selection Agent */
export class TestSelectionAgent extends BaseAgent<TestSelectionInput, TestSelection> {
  name = 'test-selection';
  version = '0.1.0';
  description = '根据需求/风险/历史失败/预算智能选择测试集（LLM 优先，规则兜底）';

  async execute(input: TestSelectionInput, context: AgentContext): Promise<TestSelection> {
    if (!input?.testCases?.length) {
      throw new Error('选择输入为空：缺少 testCases');
    }
    const history = { ...(input.history ?? {}), ...(await gatherHistory(context)) };

    // 1. LLM 优先（失败/非法/校验不通过 → 回退确定性）
    try {
      const selection = await this.parseWithLLM(input, history, context);
      context.logger.info(
        `测试选择完成（LLM）：选中 ${selection.selectedCases.length}/${selection.statistics?.total ?? input.testCases.length} 条`,
      );
      return selection;
    } catch (e) {
      context.logger.warn(`LLM 测试选择失败，回退规则选择：${(e as Error).message}`);
    }

    // 2. 确定性选择兜底
    const selection = selectTestCases({ ...input, history });
    context.logger.info(
      `测试选择完成（规则）：选中 ${selection.selectedCases.length}/${selection.statistics.total} 条，跳过 ${selection.skippedCases.length} 条`,
    );
    return selection;
  }

  /** LLM 选择：构造提示 → 解析 JSON → ajv 校验 → 归一化 */
  private async parseWithLLM(
    input: TestSelectionInput,
    history: SelectionHistory,
    context: AgentContext,
  ): Promise<TestSelection> {
    const userContent = JSON.stringify(
      {
        requirement: input.requirement,
        testCases: input.testCases.map((c) => ({
          id: c.id, name: c.name, priority: c.priority, tags: c.tags,
        })),
        riskAssessment: input.riskAssessment,
        history,
        options: input.options ?? {},
      },
      null,
      2,
    );
    const resp = await context.runtime.generate({
        task: 'test-selection',
        agent: this.name,
        system: TEST_SELECTION_SYSTEM_PROMPT,
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });

    const parsed = parseLLMJson(resp);
    if (!isSelectionLike(parsed)) {
      throw new Error('LLM 输出缺少 selection 结构');
    }
    const validated = await validateSelection(parsed);
    const result = normalizeLlmSelection(validated, input);
    return result;
  }
}

/** 归一化 LLM 选择结果：去重 + 只保留输入中真实存在的用例 + 统计对齐 */
function normalizeLlmSelection(raw: Record<string, unknown>, input: TestSelectionInput): TestSelection {
  const validIds = new Set(input.testCases.map((c) => c.id));
  const selected = [...new Set(toStringList(raw.selectedCases).filter((id) => validIds.has(id)))];
  const skipped = [...new Set(toStringList(raw.skippedCases).filter((id) => validIds.has(id)))];
  const priorityOrder = [...new Set(toStringList(raw.priorityCases ?? raw.priorityOrder).filter((id) => validIds.has(id)))];
  const reasons = Object.fromEntries(
    Object.entries((raw.reasons as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]),
  );

  return buildSelection({
    feature: input.requirement.feature,
    selectedCases: priorityOrder.length ? priorityOrder : selected,
    skippedCases: skipped,
    priorityOrder: priorityOrder.length ? priorityOrder : selected,
    reasons,
    statistics: {
      total: input.testCases.length,
      selected: (priorityOrder.length ? priorityOrder : selected).length,
      skipped: skipped.length,
      riskAffected: 0,
      historyBoosted: 0,
      flakyMarked: 0,
      budgetTrimmed: 0,
    },
    budget: input.options?.maxCases !== undefined ? { maxCases: input.options.maxCases } : undefined,
    confidence: 0.9,
  });
}

function toStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** 便捷工厂 */
export function createTestSelectionAgent(): TestSelectionAgent {
  return new TestSelectionAgent();
}

// 重导出便于外部消费
export { TestSelection, buildSelection } from './selection-schema.js';
export { SELECTION_JSON_SCHEMA } from './selection-schema.js';
export { selectTestCases, SelectionHistory } from './selection-analyzer.js';
