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
  filterDslExecutable,
} from './testcase-schema.js';
import { generateTestCasesWithBusiness } from './testcase-generator.js';
import { identifyBusiness } from './business.js';
import { contractDependency } from '../../contracts/dependency-index.js';
import type { Contract } from '../../contracts/types.js';

/** 系统提示词：要求 LLM 严格按 Schema 输出 TestCase 数组 */
export const TEST_DESIGN_SYSTEM_PROMPT = `你是测试设计工程师。根据结构化测试需求生成测试用例列表。
输出必须严格符合如下 JSON Schema（输出为 TestCase 数组，只输出 JSON，不要任何解释或 Markdown 围栏）：
{"type":"array","items":${JSON.stringify(TESTCASE_JSON_SCHEMA, null, 2)}}

规则：
- 每个用例必须有 id（如 tc-01）、feature、name、priority（P0/P1/P2/P3）、steps
- feature 必须如实反映识别到的业务；无法识别业务时输出 feature="unknown"，
  禁止猜测为 wan3 或编造视频参数（prompt/resolution 等）——伪造业务会用例不可执行
- steps 至少包含一个 action="submit" 的步骤，input 里给出参数（prompt/resolution/duration 等）
- 需要等待最终状态时追加 {"action":"wait","until":"SUCCESS"}
- assertions 复用现有断言操作符（equals/contains/exists/gt/gte/in/notIn/regex/type 等），
  target 可选值：submit / response / billing / headers / env / metrics / custom
- 覆盖：正常路径（P0）、参数组合（P1）、边界值（P1）、异常输入（P2）、依赖异常（P2）、并发（P3）
- 生成 8~20 条用例，不要编造需求中不存在的参数取值`;

/** Test Design Agent 输入（支持对象 / Requirement / 自然语言字符串） */
export type TestDesignAgentInput =
  | { requirement: Requirement | string; contracts?: Contract[] }
  | string;

/** Test Design Agent */
export class TestDesignAgent extends BaseAgent<TestDesignAgentInput | Requirement, TestCase[]> {
  name = 'test-design';
  version = '0.2.0';
  description = '根据需求生成 Test DSL 测试用例（LLM 优先，确定性生成器兜底）';

  async execute(input: TestDesignAgentInput | Requirement, context: AgentContext): Promise<TestCase[]> {
    // 归一化为 Requirement：{ requirement } 对象 / Requirement 本身 / 自然语言字符串
    let req: Requirement;
    const contracts = typeof input === 'object' && input !== null && 'contracts' in input && Array.isArray(input.contracts)
      ? input.contracts : [];
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
      const cases = enrichWithContracts(await this.generateWithLLM(req, contracts, context), contracts);
      context.logger.info(`测试设计完成（LLM，${cases.length} 条用例）`);
      return cases;
    } catch (e) {
      context.logger.warn(`LLM 生成测试用例失败，回退确定性生成器：${(e as Error).message}`);
    }

    // 2. 确定性生成器兜底（业务识别分发：wan3/video → 视频生成器；已知业务 → 通用生成器；
    //    unknown → 不伪造任何业务用例）
    const generated = generateTestCasesWithBusiness(req);
    if (generated.business.kind === 'unknown') {
      // 业务未识别：显式失败（fail-fast），绝不以 WAN3 模板伪造可提交用例
      throw new Error(
        `无法识别业务（feature="${req.feature}"）：请显式声明 feature（如 wan3/user/order/payment）或注册对应业务生成器`,
      );
    }
    context.logger.info(
      `测试设计完成（确定性生成器，业务=${generated.business.kind}${generated.droppedInexecutable ? `，过滤不可执行 ${generated.droppedInexecutable} 条` : ''}，${generated.cases.length} 条用例）`,
    );
    return enrichWithContracts(generated.cases, contracts);
  }

  /** LLM 生成：构造提示 → 解析 JSON 数组 → 逐条校验 → 归一化 */
  private async generateWithLLM(req: Requirement, contracts: readonly Contract[], context: AgentContext): Promise<TestCase[]> {
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
      resolvedContracts: contracts.map((contract) => ({
        id: contract.id,
        version: contract.version,
        value: contract.value,
        sources: contract.sources.map((source) => ({ type: source.type, ref: source.ref, observedAt: source.observedAt })),
      })),
    },
    null,
    2,
  )}`;

    const resp = await context.runtime.generate({
        task: 'test-design',
        agent: this.name,
        system: TEST_DESIGN_SYSTEM_PROMPT,
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!Array.isArray(parsed)) throw new Error('LLM 输出不是 TestCase 数组');
    if (parsed.length === 0) throw new Error('LLM 输出为空数组');

    // 逐条校验 + 归一化 + DSL 可执行性门（不可执行的用例直接丢弃并记录）
    const cases: TestCase[] = [];
    for (const item of parsed.slice(0, 50)) {
      cases.push(await validateTestCase(item));
    }
    const executable = filterDslExecutable(cases, (tc, problems) => {
      context.logger.warn(`LLM 用例 ${tc.id} 不可执行，已丢弃：${problems.join('；')}`);
    });
    if (!executable.length) throw new Error('LLM 输出无 DSL 可执行 TestCase');
    return executable;
  }
}

function enrichWithContracts(cases: TestCase[], contracts: readonly Contract[]): TestCase[] {
  if (!contracts.length) return cases;
  const values = Object.assign({}, ...contracts.flatMap((contract) => (
    contract.kind !== 'resource' && contract.value && typeof contract.value === 'object' && !Array.isArray(contract.value)
      ? [contract.value as Record<string, unknown>] : []
  )));
  const dependencies = contracts.map(contractDependency);
  for (const testCase of cases) {
    for (const step of testCase.steps) {
      const input = step.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
      for (const [key, proposed] of Object.entries(input)) {
        if (!(key in values) || Object.is(values[key], proposed)) continue;
        throw new Error(`CONTRACT_PROPOSAL_CONFLICT：${key} proposal=${JSON.stringify(proposed)} contract=${JSON.stringify(values[key])}`);
      }
    }
    testCase.contractDependencies = dependencies.map((dependency) => ({ ...dependency }));
    testCase.metadata = {
      ...(testCase.metadata ?? {}),
      resolvedContractValue: values,
      contractIds: dependencies.map((dependency) => dependency.contractId),
    };
  }
  return cases;
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
export { generateTestCases, generateTestCasesWithBusiness, TestCaseGeneratorOptions } from './testcase-generator.js';
export { identifyBusiness, registerBusinessGenerator, listBusinessKinds, type BusinessProfile, type BusinessTestCaseGenerator } from './business.js';
export { checkDslExecutable, filterDslExecutable } from './testcase-schema.js';
