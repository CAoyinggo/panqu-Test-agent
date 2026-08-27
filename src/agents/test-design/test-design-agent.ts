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
import { generateTestCasesWithBusiness } from './testcase-generator.js';
import { identifyBusiness } from './business.js';
import { contractDependency } from '../../contracts/dependency-index.js';
import type { Contract } from '../../contracts/types.js';
import { promptRegistry } from '../prompts/registry.js';

/** 历史 Prompt，保留用于既有运行回放。 */
export const TEST_DESIGN_SYSTEM_PROMPT_V1 = `你是测试设计工程师。根据结构化测试需求生成测试用例列表。
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

/** 开发验收 Prompt v2：风险驱动、证据优先，不追求固定 Case 数量。 */
export const TEST_DESIGN_SYSTEM_PROMPT = `你是开发完成后、提测前的资深测试设计工程师。根据结构化 Requirement 和已解析 Contract 生成高价值 TestCase。
输出必须严格符合如下 JSON Schema（输出为 TestCase 数组，只输出 JSON，不要解释或 Markdown 围栏）：
{"type":"array","items":${JSON.stringify(TESTCASE_JSON_SCHEMA, null, 2)}}

主链必须可追溯：Requirement Fact / AC → Business Scenario → Test Dimension → Executable Step → Deterministic Oracle → Evidence Requirement。

设计规则（强制）：
- 新生成用例使用 schemaVersion="TEST_CASE_V2"；source.requirementId、factIds、objectiveIds 不得为空；仅当原需求提供 AC ID 时填写 acceptanceCriteriaIds，禁止编造 ID。
- 五维逐项判断适用性：FUNCTIONAL、API、PARAMETER、AUTH/PERMISSION/DATA_ISOLATION、UI。只生成 Requirement/Contract/Risk 有触发信号的维度，不为凑类型或数量生成占位 Case。
- 正向主流程、关键业务规则、高风险 Negative 和边界合理平衡；相同 Actor/Input/Operation/Oracle/Evidence 的重复 Case 必须合并。
- 每条 Case 只承担一个可判定的业务证明义务。一次拒绝写入的证明可以同时需要“响应被拒绝 + 状态未改变/无副作用”断言，但不得混入无关结论。
- businessScenario.goal 必须描述 Actor 对真实业务资源的目标，禁止“接口正常”“功能符合预期”等技术空话。
- steps 必须是执行器可消费的精确动作；API 使用 method/url/path/query/body/actor，UI/Data 使用对应 channel 和能力引用。禁止统一伪造 submit 步骤或视频参数。
- expected 必须分别给出可判断的 response/state/sideEffects；未知值保持 UNKNOWN，不得补常见状态码、字段、状态机或权限规则。
- assertions 必须是确定性断言并回链 Fact/Evidence。LLM 只能设计与解释，不能作为 PASS/FAIL Oracle。
- evidenceRequirements 必须声明 API request/response、UI 状态/截图、数据库状态、日志、状态变化或前后差异中实际需要的证据，并回链 sourceStepId/assertionIds/factIds。
- 对状态变更操作的 400/403 拒绝场景，必须同时设计 BEFORE/AFTER 或 DATA_DIFF 证据和 UNCHANGED/无副作用断言；只读请求明确标记 Non-Mutation=N/A。只有返回码不能证明通过。
- 无明确规则时 requirementStatus=UNKNOWN/NEED_CONFIRMATION、oracle/readiness=NEED_CONFIRMATION、executionMode=DESIGNED_ONLY；明确写出缺失能力，禁止伪装 EXECUTABLE。
- EXECUTABLE 只在 Executor、required Observer、Preflight、可检查 Preconditions、Oracle 和 Evidence Plan 全部 READY/AVAILABLE 时使用。
- 推导 Contract 必须保留 source.provenance=CONTRACT/INFERRED 与版本/指纹；实测不符时先标记 Contract 复核，不直接创造产品 Bug。
- 用例数量由独立证明义务与风险决定，不设最低条数；优先 P0/P1 高价值路径。`;

function resolveSystemPrompt(): string {
  return promptRegistry.getVersion('test-design')?.system ?? TEST_DESIGN_SYSTEM_PROMPT;
}

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
      constraints: req.constraints,
      risks: req.risks,
      understanding: req.understanding,
      resolvedContracts: contracts.map((contract) => ({
        id: contract.id,
        version: contract.version,
        fingerprint: contract.fingerprint,
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
        system: resolveSystemPrompt(),
        user: userContent,
        temperature: 0,
        jsonMode: true,
      });

    const parsed = parseLLMJson(resp); // 非法 JSON 抛错 → 回退
    if (!Array.isArray(parsed)) throw new Error('LLM 输出不是 TestCase 数组');
    if (parsed.length === 0) throw new Error('LLM 输出为空数组');

    // v2 设计产物全部保留；真正可执行子集由 Runtime/Preflight 在下一阶段确定。
    // 设计模型无权声明本机 Executor/Observer 已存在，因此这里统一收回其 AVAILABLE 声明。
    const cases: TestCase[] = [];
    const knownFactIds = new Set(req.understanding?.facts.map((fact) => fact.id) ?? []);
    for (const item of parsed.slice(0, 50)) {
      const testCase = await validateTestCase(item);
      if (testCase.schemaVersion !== 'TEST_CASE_V2') {
        throw new Error(`LLM 用例 ${testCase.id} 未使用 TEST_CASE_V2，拒绝 legacy 输出进入 v2 链路`);
      }
      const factIds = testCase.source?.factIds ?? [];
      if (!knownFactIds.size || factIds.some((factId) => !knownFactIds.has(factId))) {
        throw new Error(`LLM 用例 ${testCase.id} 引用了 Requirement 中不存在的 Fact ID`);
      }
      cases.push(revokeModelRuntimeClaims(testCase));
    }
    if (!cases.length) throw new Error('LLM 输出无合法 TEST_CASE_V2');
    return cases;
  }
}

function revokeModelRuntimeClaims(testCase: TestCase): TestCase {
  const reason = 'RUNTIME_CAPABILITIES_NOT_VERIFIED：Test Design 模型不能声明 Executor/Observer 可用，等待确定性 Preflight 绑定';
  testCase.executionMode = 'DESIGNED_ONLY';
  testCase.steps = testCase.steps.map((step) => ({ ...step, execution: 'PLANNED' }));
  if (testCase.oracle?.status === 'READY') testCase.oracle = { ...testCase.oracle, status: 'BLOCKED', reason };
  testCase.readiness = {
    status: testCase.requirementStatus === 'CONFIRMED' ? 'BLOCKED' : 'NEED_CONFIRMATION',
    reasons: [...new Set([...(testCase.readiness?.reasons ?? []), reason])],
    missingCapabilities: [...new Set([
      ...(testCase.readiness?.missingCapabilities ?? []),
      testCase.executionContract?.executor.ref ?? 'runtime.executor',
      ...(testCase.executionContract?.observers.filter((observer) => observer.required).map((observer) => observer.ref) ?? []),
    ])],
  };
  if (testCase.executionContract) {
    testCase.executionContract = {
      ...testCase.executionContract,
      executor: {
        ...testCase.executionContract.executor,
        status: testCase.executionContract.executor.kind === 'NONE' ? 'UNAVAILABLE' : 'RUNTIME_REQUIRED',
      },
      observers: testCase.executionContract.observers.map((observer) => ({
        ...observer,
        status: observer.required ? 'RUNTIME_REQUIRED' : observer.status,
      })),
    };
  }
  return testCase;
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
