// Test Design Agent：根据结构化 Requirement 生成 Test DSL 用例
// 策略：LLM 生成（System Prompt 内嵌 Test DSL JSON Schema，输出 TestCase 数组）
//      → 逐个校验 → 失败回退到确定性生成器。
// 输出 TestCase[] 可通过 toTaskDef/toLoadedCase 无缝接入现有 Execution Engine。

import { BaseAgent } from '../core/agent.js';
import type { AgentContext } from '../core/agent-context.js';
import { parseLLMJson } from '../../llm/index.js';
import type { Requirement } from '../requirement/requirement-schema.js';
import { parseRequirement } from '../requirement/requirement-parser.js';
import {
  TestCase,
  TESTCASE_JSON_SCHEMA,
  normalizeTestCase,
  validateTestCase,
} from './testcase-schema.js';
import { generateTestCases } from './testcase-generator.js';

/** 系统提示词：要求 LLM 严格按 Schema 输出 TestCase 数组 */
const SYSTEM_PROMPT = `你是测试设计工程师。根据结构化测试需求生成测试用例列表。
输出必须严格符合如下 JSON Schema（输出为 TestCase 数组，只输出 JSON，不要任何解释或 Markdown 围栏）：
{"type":"array","items":${JSON.stringify(TESTCASE_JSON_SCHEMA, null, 2)}}

规则：
- 每个用例必须有 id（如 tc-01）、feature、name、priority（P0/P1/P2/P3）、steps
- steps 至少包含一个 action="submit" 的步骤，input 里给出参数（prompt/resolution/duration 等）
- 需要等待最终状态时追加 {"action":"wait","until":"SUCCESS"}
- assertions 复用现有断言操作符（equals/contains/exists/gt/gte/in/notIn/regex/type 等），
  target 可选值：submit / response / billing / headers / env / metrics / custom
- 覆盖：正常路径（P0）、参数组合（P1）、边界值（P1）、异常输入（P2）、依赖异常（P2）、并发（P3）
- 生成 8~20 条用例，不要编造需求中不存在的参数取值`;

/** Test Design Agent 输入（支持对象 / Requirement / 自然语言字符串） */
export type TestDesignAgentInput =
  | { requirement: Requirement | string }
  | string;

/** Test Design Agent */
export class TestDesignAgent extends BaseAgent<TestDesignAgentInput | Requirement, TestCase[]> {
  name = 'test-design';
  version = '0.2.0';
  description = '根据需求生成 Test DSL 测试用例（LLM 优先，确定性生成器兜底）';

  async execute(input: TestDesignAgentInput | Requirement, context: AgentContext): Promise<TestCase[]> {
    // 归一化为 Requirement：{ requirement } 对象 / Requirement 本身 / 自然语言字符串
    let req: Requirement;
    if (typeof input === 'string') {
      if (!input.trim()) throw new Error('测试设计输入为空：请提供 Requirement 或需求文本');
      req = parseRequirement(input);
    } else if (input && typeof input === 'object' && 'requirement' in input) {
      const inner = (input as { requirement?: Requirement | string }).requirement;
      if (inner === undefined || inner === null) throw new Error('测试设计输入为空：请提供 Requirement 或需求文本');
      if (typeof inner === 'string') {
        if (!inner.trim()) throw new Error('测试设计输入为空：请提供 Requirement 或需求文本');
        req = parseRequirement(inner);
      } else {
        req = inner;
      }
    } else if (isRequirementObject(input)) {
      req = input;
    } else {
      throw new Error('测试设计输入为空：请提供 Requirement 或需求文本');
    }

    // 1. 尝试 LLM 生成（含 Mock，失败则回退）
    try {
      const cases = await this.generateWithLLM(req, context);
      context.logger.info(`测试设计完成（LLM，${cases.length} 条用例）`);
      return cases;
    } catch (e) {
      context.logger.warn(`LLM 生成测试用例失败，回退确定性生成器：${(e as Error).message}`);
    }

    // 2. 确定性生成器兜底（永远可用，不依赖 LLM）
    const cases = generateTestCases(req);
    context.logger.info(`测试设计完成（确定性生成器，${cases.length} 条用例）`);
    return cases;
  }

  /** LLM 生成：构造提示 → 解析 JSON 数组 → 逐条校验 → 归一化 */
  private async generateWithLLM(req: Requirement, context: AgentContext): Promise<TestCase[]> {
    const userContent = `功能模块：${req.feature}
需求结构化描述：
${JSON.stringify(
    {
      feature: req.feature,
      capabilities: req.capabilities,
      inputs: req.inputs,
      requirements: req.requirements,
      businessRules: req.businessRules,
      dependencies: req.dependencies,
    },
    null,
    2,
  )}`;

    const resp = await context.llm.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      jsonMode: true,
    });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!Array.isArray(parsed)) throw new Error('LLM 输出不是 TestCase 数组');
    if (parsed.length === 0) throw new Error('LLM 输出为空数组');

    // 逐条校验 + 归一化
    const cases: TestCase[] = [];
    for (const item of parsed.slice(0, 50)) {
      cases.push(await validateTestCase(item));
    }
    if (!cases.length) throw new Error('LLM 输出无有效 TestCase');
    return cases;
  }
}

function isRequirementObject(input: object): input is Requirement {
  return 'feature' in input && typeof (input as { feature?: unknown }).feature === 'string';
}

/** 便捷工厂：创建 Test Design Agent 实例 */
export function createTestDesignAgent(): TestDesignAgent {
  return new TestDesignAgent();
}

// 重导出 schema / generator 便于外部消费
export { TestCase, TestPriority, TestStep, AssertionDefinition, TESTCASE_JSON_SCHEMA } from './testcase-schema.js';
export {
  validateTestCase,
  normalizeTestCase,
  toTaskDef,
  toLoadedCase,
  VALID_OPERATORS,
} from './testcase-schema.js';
export { generateTestCases, TestCaseGeneratorOptions } from './testcase-generator.js';
