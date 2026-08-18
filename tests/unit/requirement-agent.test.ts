// 单元测试：Requirement Agent（LLM 解析 / 规则兜底 / Schema 校验）
import { describe, it, expect } from 'vitest';
import {
  RequirementAgent,
  parseRequirement,
  validateRequirement,
  normalizeRequirement,
  REQUIREMENT_JSON_SCHEMA,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除。';

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

describe('requirement - 规则解析器（确定性兜底）', () => {
  it('解析功能模块/能力/输入', () => {
    const r = parseRequirement(DEMO_REQ);
    expect(r.feature).toBe('wan3');
    expect(r.capabilities).toContain('text-to-video');
    expect(r.inputs).toEqual(expect.arrayContaining(['prompt', 'resolution', 'duration']));
  });

  it('提取分辨率与时长取值', () => {
    const r = parseRequirement(DEMO_REQ);
    const res = r.requirements.find((x) => x.name === 'resolution');
    expect(res?.values).toEqual(expect.arrayContaining(['720P', '1080P']));
    const dur = r.requirements.find((x) => x.name === 'duration');
    expect(dur?.values).toEqual(expect.arrayContaining([5, 10]));
  });

  it('提取业务规则与依赖', () => {
    const r = parseRequirement(DEMO_REQ);
    expect(r.businessRules).toContain('积分正确扣除');
    expect(r.businessRules).toContain('任务提交成功');
    expect(r.dependencies).toContain('模型服务');
    expect(r.dependencies).toContain('积分服务');
  });

  it('空文本抛错', () => {
    expect(() => parseRequirement('   ')).toThrow('需求文本为空');
  });

  it('生成确定性结果且带置信度', () => {
    const r1 = parseRequirement(DEMO_REQ);
    const r2 = parseRequirement(DEMO_REQ);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.confidence).toBeGreaterThan(0);
    expect(r1.confidence).toBeLessThanOrEqual(1);
  });
});

describe('requirement - Schema 校验与归一化', () => {
  it('合法数据校验通过', async () => {
    const r = await validateRequirement({
      feature: 'wan3',
      capabilities: ['text-to-video'],
      requirements: [{ name: 'resolution', values: ['720P'] }],
    });
    expect(r.feature).toBe('wan3');
    expect(r.capabilities).toEqual(['text-to-video']);
  });

  it('缺 feature 校验失败', async () => {
    await expect(validateRequirement({ capabilities: [] })).rejects.toThrow('缺少 feature');
  });

  it('非对象输入校验失败', async () => {
    await expect(validateRequirement(null)).rejects.toThrow();
  });

  it('归一化 requirements 对象形态', () => {
    const r = normalizeRequirement({ feature: 'wan3', requirements: { resolution: { values: ['4K'] } } });
    expect(r.requirements).toEqual([{ name: 'resolution', values: ['4K'] }]);
  });

  it('归一化数组形态并过滤空名', () => {
    const r = normalizeRequirement({
      feature: 'wan3',
      requirements: [{ name: 'duration', values: [5, 10] }, { name: '', values: [1] }],
    });
    expect(r.requirements).toHaveLength(1);
    expect(r.requirements[0].name).toBe('duration');
  });

  it('Schema 定义包含 feature 必填', () => {
    expect(REQUIREMENT_JSON_SCHEMA.required).toContain('feature');
  });
});

describe('requirement - RequirementAgent 全链路', () => {
  it('LLM 返回合法 JSON → 走 LLM 解析', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify({
        feature: 'wan3',
        capabilities: ['text-to-video'],
        inputs: ['prompt', 'resolution', 'duration'],
        requirements: [{ name: 'resolution', values: ['720P', '1080P'] }],
        businessRules: ['积分正确扣除'],
        dependencies: ['模型服务', '积分服务'],
      })],
    });
    const agent = new RequirementAgent();
    const r = await agent.execute(DEMO_REQ, makeContext(llm));
    expect(r.feature).toBe('wan3');
    expect(r.requirements[0].values).toEqual(['720P', '1080P']);
    expect(r.businessRules).toContain('积分正确扣除');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(llm.getCallCount()).toBe(1);
  });

  it('LLM 输出被 ```json 围栏包裹也能解析', async () => {
    const llm = new MockLLMProvider({
      scripted: ['```json\n{"feature":"wan3","inputs":["prompt"]}\n```'],
    });
    const r = await new RequirementAgent().execute('测试文生视频', makeContext(llm));
    expect(r.feature).toBe('wan3');
    expect(r.inputs).toContain('prompt');
  });

  it('LLM 返回非法 JSON → 回退规则解析', async () => {
    const llm = new MockLLMProvider({ scripted: ['这不是 JSON {{'] });
    const agent = new RequirementAgent();
    const r = await agent.execute(DEMO_REQ, makeContext(llm));
    // 规则解析兜底仍能得到结构化结果
    expect(r.feature).toBe('wan3');
    expect(r.businessRules).toContain('积分正确扣除');
  });

  it('LLM 空响应 → 回退规则解析', async () => {
    const llm = new MockLLMProvider({ scripted: [''] });
    const r = await new RequirementAgent().execute(DEMO_REQ, makeContext(llm));
    expect(r.feature).toBe('wan3');
  });

  it('LLM 返回缺 feature 的 JSON → 回退规则解析', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({ capabilities: ['x'] })] });
    const r = await new RequirementAgent().execute(DEMO_REQ, makeContext(llm));
    expect(r.feature).toBe('wan3');
  });

  it('LLM 抛错 → 回退规则解析', async () => {
    const llm = new MockLLMProvider({ scripted: [], failureMode: { type: 'error', message: '网络中断' } });
    const r = await new RequirementAgent().execute(DEMO_REQ, makeContext(llm));
    expect(r.feature).toBe('wan3');
  });

  it('LLM 返回的对象形态 requirements 被归一化', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify({ feature: 'wan3', requirements: { duration: { values: [5, 10] } } })],
    });
    const r = await new RequirementAgent().execute('支持 5 秒和 10 秒视频', makeContext(llm));
    expect(r.requirements).toContainEqual({ name: 'duration', values: [5, 10] });
  });

  it('空输入抛错', async () => {
    const agent = new RequirementAgent();
    await expect(agent.execute('   ', makeContext(new MockLLMProvider()))).rejects.toThrow('需求文本为空');
  });

  it('支持 hintFeature 提示', async () => {
    const llm = new MockLLMProvider({ scripted: ['{"feature":"user","inputs":["prompt"]}'] });
    const r = await new RequirementAgent().execute({ text: '测试登录流程', hintFeature: 'user' }, makeContext(llm));
    expect(r.feature).toBe('user');
    expect(llm.getLastCall()!.messages[1].content).toContain('user');
  });
});
