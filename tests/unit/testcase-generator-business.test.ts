// 验收测试：Test Case Generator 业务识别与 DSL 可执行性
// 修复的旧问题：
//   1. 无法识别业务 → 静默兜底 wan3（parser 三元恒 wan3 / Prompt 明示用 wan3 / 生成器 || 'wan3'），
//      非视频业务被伪造 WAN3 视频用例并可能真实提交执行；
//   2. 空 Prompt / 非法分辨率等视频参数被无条件注入所有业务；
//   3. 产出用例未做 DSL 可执行性校验（缺 submit / 缺 expected 的断言可进入执行链路）。
// 契约：识别业务 → 对应 Generator；Unknown → UNKNOWN（不伪造）；全部产出 DSL 可执行。
import { describe, it, expect } from 'vitest';
import {
  generateTestCases,
  generateTestCasesWithBusiness,
  identifyBusiness,
  checkDslExecutable,
  filterDslExecutable,
  parseRequirement,
} from '../../src/agents/index.js';
import type { Requirement } from '../../src/agents/requirement/requirement-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import { TestDesignAgent } from '../../src/agents/test-design/test-design-agent.js';
import { createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';

function reqOf(partial: Partial<Requirement>): Requirement {
  return {
    feature: 'wan3', goal: 'g', version: 'v1',
    capabilities: [], requirements: [], businessRules: [], dependencies: [], constraints: [], risks: [],
    ...partial,
  } as Requirement;
}

/** 所有用例必须 DSL 可执行 */
function expectAllExecutable(cases: TestCase[]): void {
  for (const tc of cases) {
    const r = checkDslExecutable(tc);
    expect(r.executable, `${tc.id}：${r.problems.join('；')}`).toBe(true);
  }
}

describe('identifyBusiness：识别业务，Unknown → UNKNOWN', () => {
  it('wan3 / video 关键词 → 视频业务（有真实 Processor）', () => {
    expect(identifyBusiness('wan3')).toMatchObject({ kind: 'wan3', isVideo: true, processorScene: 'video' });
    expect(identifyBusiness('Video-Clone', ['text-to-video'])).toMatchObject({ kind: 'video', isVideo: true });
    expect(identifyBusiness('other', ['i2v'])).toMatchObject({ isVideo: true });
  });

  it('user / order / payment → 已知非视频业务（无视频 Processor）', () => {
    expect(identifyBusiness('user')).toMatchObject({ kind: 'user', isVideo: false, processorScene: null });
    expect(identifyBusiness('order')).toMatchObject({ kind: 'order' });
    expect(identifyBusiness('payment')).toMatchObject({ kind: 'payment' });
  });

  it('无法识别 → unknown（绝不回退 wan3）', () => {
    expect(identifyBusiness('')).toMatchObject({ kind: 'unknown' });
    expect(identifyBusiness('区块链存证')).toMatchObject({ kind: 'unknown', isVideo: false, processorScene: null });
  });
});

describe('确定性解析器：无法识别业务 → feature=unknown（旧兜底 wan3 已删除）', () => {
  it('与视频完全无关的需求不再被识别为 wan3', () => {
    const r = parseRequirement('测试区块链存证功能，上传哈希后可验证存证有效性');
    expect(r.feature).not.toBe('wan3'); // 旧实现：恒 'wan3'
  });

  it('视频需求仍正确识别为 wan3', () => {
    const r = parseRequirement('测试文生视频功能，支持 720P 分辨率');
    expect(r.feature).toBe('wan3');
  });
});

describe('生成器分发：按业务生成，产出全部 DSL 可执行', () => {
  it('wan3 → VideoGenerator：含视频失败注入（空 Prompt / 非法分辨率），全部可执行', () => {
    const g = generateTestCasesWithBusiness(reqOf({
      feature: 'wan3',
      requirements: [{ name: 'resolution', values: ['720P', '1080P'] }, { name: 'duration', values: [5, 10] }],
      businessRules: ['积分正确扣除'],
      dependencies: ['模型服务'],
      capabilities: ['text-to-video'],
    }));
    expect(g.business.kind).toBe('wan3');
    expect(g.generatorKind).toBe('wan3');
    expect(g.cases.length).toBeGreaterThan(5);
    expect(g.droppedInexecutable).toBe(0); // 门后零丢弃
    expectAllExecutable(g.cases);
    // 视频失败注入存在
    expect(g.cases.some((c) => c.name.includes('空提示词'))).toBe(true);
    expect(g.cases.some((c) => c.name.includes('非法分辨率'))).toBe(true);
    // 依赖异常用例：声明依赖 + 降级断言
    const dep = g.cases.find((c) => c.tags.includes('dependency'));
    expect(dep?.name).toContain('模型服务');
    expect(dep?.data?.dependencyUnderTest).toBe('模型服务');
    expectAllExecutable([dep!]);
  });

  it('并发规则 → 并发用例（business 声明才生成）', () => {
    const g = generateTestCasesWithBusiness(reqOf({ feature: 'wan3', businessRules: ['并发提交互不干扰'] }));
    const conc = g.cases.find((c) => c.tags.includes('concurrency'));
    expect(conc).toBeDefined();
    expect(conc?.data?.concurrency).toBe(5);
    expectAllExecutable([conc!]);
    // 未声明并发时不生成
    const no = generateTestCases(reqOf({ feature: 'wan3' }));
    expect(no.some((c) => c.tags.includes('concurrency'))).toBe(false);
  });

  it('user 业务 → 通用生成器：不注入任何视频参数（prompt/resolution）', () => {
    const g = generateTestCasesWithBusiness(reqOf({
      feature: 'user',
      requirements: [{ name: 'username', values: ['alice', 'bob'] }, { name: 'age', values: [18, 60] }],
      businessRules: ['未登录用户不能下单'],
    }));
    expect(g.business.kind).toBe('user');
    expect(g.cases.length).toBeGreaterThan(3);
    expectAllExecutable(g.cases);

    // 关键验收：非视频业务绝不出现视频参数（旧实现会注入空 prompt/INVALID_RES 分辨率）
    for (const c of g.cases) {
      const inputs = c.steps.map((s) => s.input ?? {});
      for (const input of inputs) {
        expect('prompt' in input).toBe(false);
        expect('resolution' in input).toBe(false);
      }
    }
    // 失败注入针对声明输入（username 为空 / age 类型非法），而非视频参数
    expect(g.cases.some((c) => c.name.includes('username') && c.name.includes('为空'))).toBe(true);
    expect(g.cases.some((c) => c.name.includes('age') && c.name.includes('类型非法'))).toBe(true);
  });

  it('unknown 业务 → 显式 UNKNOWN 占位，不伪造 WAN3/视频用例', () => {
    const g = generateTestCasesWithBusiness(reqOf({ feature: '区块链存证' }));
    expect(g.business.kind).toBe('unknown');
    // 不产出任何可提交的视频用例（占位用例显式标注 not-executable 且无 submit 步骤）
    expect(g.cases.every((c) => c.metadata?.business === 'unknown')).toBe(true);
    expect(g.cases.every((c) => !c.steps.some((s) => s.action === 'submit'))).toBe(true);
    expect(g.cases.every((c) => c.tags.includes('unknown-business'))).toBe(true);
  });
});

describe('checkDslExecutable：DSL 可执行性门', () => {
  const base = { id: 'tc-1', feature: 'wan3', name: 'n', priority: 'P0' as const, tags: [], steps: [{ action: 'submit', input: {} }], assertions: [] };

  it('合法用例通过', () => {
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'exists', target: 'submit', path: 'taskId' }] }).executable).toBe(true);
  });

  it('缺 submit / wait 缺 until / 断言缺 expected → 拦截', () => {
    expect(checkDslExecutable({ ...base, steps: [{ action: 'query' }] }).executable).toBe(false);
    expect(checkDslExecutable({ ...base, steps: [{ action: 'submit' }, { action: 'wait' }] }).executable).toBe(false);
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'equals', target: 'submit', path: 'status' }] }).executable).toBe(false);
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'gt', target: 'billing', path: 'n' }] }).executable).toBe(false);
    // exists/notExists 不需要 expected
    expect(checkDslExecutable({ ...base, assertions: [{ operator: 'notExists', target: 'submit', path: 'err' }] }).executable).toBe(true);
  });

  it('filterDslExecutable：不可执行用例被过滤并回调原因', () => {
    const drops: string[] = [];
    const valid = { ...base, assertions: [{ operator: 'exists' as const, target: 'submit' as const, path: 'taskId' }] };
    const kept = filterDslExecutable([
      valid as TestCase,
      { ...valid, id: 'tc-bad', steps: [] } as TestCase,
    ], (_tc, problems) => drops.push(...problems));
    expect(kept).toHaveLength(1);
    expect(drops.length).toBeGreaterThan(0);
  });
});

describe('TestDesignAgent：unknown 业务 fail-fast（不伪造）', () => {
  function makeContext(llm: MockLLMProvider) {
    const tools = new ToolRegistry();
    return createAgentContext({
      taskId: 't-gen', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm,
    });
  }

  it('LLM 失败 + 业务未识别 → 显式抛错（绝不回退 WAN3 模板）', async () => {
    const llm = new MockLLMProvider({ scripted: ['不是 JSON'] }); // LLM 失败 → 走确定性
    const agent = new TestDesignAgent();
    await expect(
      agent.execute({ requirement: reqOf({ feature: '区块链存证' }) }, makeContext(llm)),
    ).rejects.toThrow(/无法识别业务/);
  });

  it('LLM 识别出业务（输出合法用例）→ 通过 DSL 门后采纳', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify([{
        id: 'tc-01', feature: 'wan3', name: '正常提交', priority: 'P0', tags: [],
        steps: [{ action: 'submit', input: { prompt: 'x' } }, { action: 'wait', until: 'SUCCESS' }],
        assertions: [{ target: 'submit', path: 'taskId', operator: 'exists' }],
      }])],
    });
    const agent = new TestDesignAgent();
    const cases = await agent.execute({ requirement: reqOf({ feature: 'wan3' }) }, makeContext(llm));
    expect(cases).toHaveLength(1);
    expectAllExecutable(cases);
  });

  it('LLM 输出不可执行用例（缺 submit）→ 被 DSL 门丢弃，无有效用例则回退确定性生成器', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify([{
        id: 'tc-bad', feature: 'wan3', name: '无提交步骤', priority: 'P2', tags: [],
        steps: [{ action: 'query' }],
        assertions: [],
      }])],
    });
    const agent = new TestDesignAgent();
    const cases = await agent.execute({ requirement: reqOf({ feature: 'wan3' }) }, makeContext(llm));
    // 不可执行用例被丢弃 → 回退确定性生成器（可执行用例）
    expect(cases.length).toBeGreaterThan(0);
    expectAllExecutable(cases);
    expect(cases.every((c) => !c.steps.every((s) => s.action === 'query'))).toBe(true);
  });
});
