// 内置 Prompt 统一注册：全部 Agent 的系统提示词进入 PromptRegistry（版本化 / 可覆盖 / 可 A/B）。
// 各 Agent 内置常量仅作回退（PromptRegistry 未命中时），保证注册表是提示词治理的唯一入口。
// prompt name 与 ModelRouter TaskKind 一致（runtime.generate 按 task 名查询）。
import type { PromptDefinition } from './registry.js';
import { promptRegistry } from './registry.js';
import { REQUIREMENT_PROMPT_V1 } from './requirement.js';
import { TEST_DESIGN_SYSTEM_PROMPT } from '../test-design/test-design-agent.js';
import { DATA_SYSTEM_PROMPT } from '../data/data-agent.js';
import { RISK_SYSTEM_PROMPT } from '../risk/risk-agent.js';
import { TEST_SELECTION_SYSTEM_PROMPT } from '../test-selection/test-selection-agent.js';
import { COVERAGE_SYSTEM_PROMPT } from '../coverage/coverage-agent.js';
import { ANALYSIS_SYSTEM_PROMPT } from '../analysis/analysis-agent.js';
import { ROOT_CAUSE_SYSTEM_PROMPT } from '../analysis/root-cause-agent.js';
import { DEFECT_SYSTEM_PROMPT } from '../defect/defect-agent.js';
import { HEALING_SYSTEM_PROMPT } from '../self-healing/self-healing-agent.js';
import { FLAKY_SYSTEM_PROMPT } from '../flaky/flaky-agent.js';
import { TESTCASE_JSON_SCHEMA } from '../test-design/testcase-schema.js';
import { DATA_PLAN_JSON_SCHEMA } from '../data/data-schema.js';
import { RISK_JSON_SCHEMA } from '../risk/risk-schema.js';
import { SELECTION_JSON_SCHEMA } from '../test-selection/selection-schema.js';
import { COVERAGE_JSON_SCHEMA } from '../coverage/coverage-schema.js';
import { ROOT_CAUSE_JSON_SCHEMA } from '../analysis/root-cause-schema.js';
import { DEFECT_JSON_SCHEMA } from '../defect/defect-schema.js';
import { HEALING_JSON_SCHEMA } from '../self-healing/healing-schema.js';

/** 简易 v1 定义（schema 未独立导出的任务用通用 object schema） */
function v1(name: string, purpose: string, system: string, outputSchema: unknown, model: string, temperature = 0): PromptDefinition {
  return {
    key: `${name}.v1`,
    name,
    version: 'v1',
    purpose,
    inputSchema: { type: 'object' },
    outputSchema,
    model,
    temperature,
    system,
  };
}

/** 全部内置 Prompt（requirement.v1 已由 prompts/requirement.ts 提供） */
const BUILTIN_PROMPTS: PromptDefinition[] = [
  REQUIREMENT_PROMPT_V1,
  v1('test-design', '根据结构化需求生成测试用例', TEST_DESIGN_SYSTEM_PROMPT, TESTCASE_JSON_SCHEMA, 'medium', 0),
  v1('data', '规划测试数据准备方案', DATA_SYSTEM_PROMPT, DATA_PLAN_JSON_SCHEMA, 'medium'),
  v1('risk', '评估执行风险', RISK_SYSTEM_PROMPT, RISK_JSON_SCHEMA, 'small'),
  v1('test-selection', '智能选择本次执行的测试集', TEST_SELECTION_SYSTEM_PROMPT, SELECTION_JSON_SCHEMA, 'small'),
  v1('coverage', '分析覆盖缺口', COVERAGE_SYSTEM_PROMPT, COVERAGE_JSON_SCHEMA, 'small'),
  v1('analysis', '汇总分析测试结果', ANALYSIS_SYSTEM_PROMPT, { type: 'object' }, 'high'),
  v1('rca', '失败根因分析（证据链推断）', ROOT_CAUSE_SYSTEM_PROMPT, ROOT_CAUSE_JSON_SCHEMA, 'high'),
  v1('defect', '生成缺陷草稿', DEFECT_SYSTEM_PROMPT, DEFECT_JSON_SCHEMA, 'high'),
  v1('healing', '自愈建议分析', HEALING_SYSTEM_PROMPT, HEALING_JSON_SCHEMA, 'medium'),
  v1('flaky', 'Flaky 用例分析', FLAKY_SYSTEM_PROMPT, { type: 'object' }, 'small'),
];

/** 注册全部内置 Prompt（幂等；仅注册缺失项，允许运行时覆盖内置版本） */
export function registerBuiltinPrompts(registry = promptRegistry): number {
  let added = 0;
  for (const p of BUILTIN_PROMPTS) {
    if (!registry.get(p.key)) {
      registry.register(p);
      added++;
    }
  }
  return added;
}

// 模块加载时注册（runtime / 任意 Agent 使用 Registry 前保证内置提示词就位）
registerBuiltinPrompts();
