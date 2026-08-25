// 单元测试：Data Agent（DataPlan Schema / 确定性分析器 / LLM 全链路 / DataPrepareTool）
import { describe, it, expect } from 'vitest';
import {
  DataAgent,
  analyzeDataPlan,
  validateDataPlan,
  normalizeDataPlan,
  DATA_PLAN_JSON_SCHEMA,
  DataPrepareTool,
  createDataPrepareTool,
  parseRequirement,
  generateTestCases,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { DataFactory, DataContext } from '../../src/core/types.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';

const req = parseRequirement(DEMO_REQ);
const cases = generateTestCases(req);

function makeContext(llm: MockLLMProvider, tools?: ToolRegistry): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment: 'test',
    tools: tools ?? new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

/** 构造合法 DataPlan JSON */
function validPlanJson(): Record<string, unknown> {
  return {
    feature: 'wan3',
    needsSetup: true,
    factoryName: 'wan3',
    setupActions: [
      { type: 'balance', desc: '准备积分快照', targetCases: ['tc-02'] },
      { type: 'assets', desc: '上传素材' },
    ],
    teardownActions: [{ type: 'cleanup', desc: '清理脏数据', targetCases: ['tc-12'] }],
    caseAssignments: [{ caseId: 'tc-01', factoryName: 'wan3', needsSetup: false }],
    generateParams: { resolution: ['720P', '1080P'], duration: [5, 10] },
  };
}

describe('data - DataPlan Schema 校验与归一化', () => {
  it('合法数据校验通过并归一化', async () => {
    const p = await validateDataPlan(validPlanJson());
    expect(p.feature).toBe('wan3');
    expect(p.needsSetup).toBe(true);
    expect(p.factoryName).toBe('wan3');
    expect(p.setupActions).toHaveLength(2);
    expect(p.generateParams.resolution).toEqual(['720P', '1080P']);
  });

  it('缺 feature 校验失败', async () => {
    await expect(validateDataPlan({ needsSetup: true, factoryName: 'wan3' })).rejects.toThrow('缺少 feature');
  });

  it('非法动作类型被过滤', () => {
    const p = normalizeDataPlan({
      feature: 'wan3',
      needsSetup: true,
      factoryName: 'wan3',
      setupActions: [{ type: 'bogus', desc: 'bad' }, { type: 'balance', desc: 'ok' }],
    });
    expect(p.setupActions).toHaveLength(1);
    expect(p.setupActions[0].type).toBe('balance');
  });

  it('needsSetup 由动作存在与否推导', () => {
    const p = normalizeDataPlan({ feature: 'wan3', factoryName: 'wan3', setupActions: [] });
    expect(p.needsSetup).toBe(false);
    const q = normalizeDataPlan({ feature: 'wan3', needsSetup: false, factoryName: 'wan3', setupActions: [{ type: 'tasks', desc: 'x' }] });
    expect(q.needsSetup).toBe(true);
  });

  it('Schema 定义必填字段', () => {
    expect(DATA_PLAN_JSON_SCHEMA.required).toEqual(expect.arrayContaining(['feature', 'needsSetup', 'factoryName']));
  });
});

describe('data - 确定性分析器', () => {
  it('计费用例产出 balance 动作', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.setupActions.some((a) => a.type === 'balance')).toBe(true);
  });

  it('视频能力产出 assets 动作', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.setupActions.some((a) => a.type === 'assets')).toBe(true);
  });

  it('并发用例产出 tasks 动作', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.setupActions.some((a) => a.type === 'tasks')).toBe(true);
  });

  it('异常用例产出 cleanup 清理动作', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.teardownActions.some((a) => a.type === 'cleanup')).toBe(true);
  });

  it('推荐工厂按 feature 映射', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.factoryName).toBe('wan3');
    const user = analyzeDataPlan({ requirement: { ...req, feature: 'user' }, testCases: [] });
    expect(user.factoryName).toBe('user');
  });

  it('generateParams 取自需求参数取值并含环境', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases, environment: 'preonline' });
    expect(p.generateParams.resolution).toEqual(expect.arrayContaining(['720P', '1080P']));
    expect(p.generateParams.duration).toEqual(expect.arrayContaining([5, 10]));
    expect(p.generateParams.env).toBe('preonline');
  });

  it('caseAssignments 为每条用例分配工厂', () => {
    const p = analyzeDataPlan({ requirement: req, testCases: cases });
    expect(p.caseAssignments).toHaveLength(cases.length);
    expect(p.caseAssignments[0].factoryName).toBe('wan3');
  });

  it('确定性：同输入产生相同输出', () => {
    expect(JSON.stringify(analyzeDataPlan({ requirement: req, testCases: cases })))
      .toBe(JSON.stringify(analyzeDataPlan({ requirement: req, testCases: cases })));
  });
});

describe('data - DataAgent 全链路', () => {
  it('LLM 返回合法 JSON → 走 LLM 规划', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify(validPlanJson())] });
    const agent = new DataAgent();
    const p = await agent.execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.feature).toBe('wan3');
    expect(p.needsSetup).toBe(true);
    expect(llm.getCallCount()).toBe(1);
  });

  it('LLM 输出被 ```json 围栏包裹也能解析', async () => {
    const llm = new MockLLMProvider({ scripted: [`\`\`\`json\n${JSON.stringify(validPlanJson())}\n\`\`\``] });
    const p = await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.factoryName).toBe('wan3');
  });

  it('LLM 返回非法 JSON → 回退确定性分析器', async () => {
    const llm = new MockLLMProvider({ scripted: ['这不是 JSON {{'] });
    const p = await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.factoryName).toBe('wan3');
    expect(p.setupActions.some((a) => a.type === 'assets')).toBe(true);
  });

  it('LLM 空响应 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [''] });
    const p = await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.needsSetup).toBe(true);
  });

  it('LLM 缺 feature → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({ needsSetup: true, factoryName: 'x' })] });
    const p = await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.feature).toBe('wan3');
  });

  it('LLM 抛错 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [], failureMode: { type: 'error', message: '网络中断' } });
    const p = await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(p.factoryName).toBe('wan3');
  });

  it('空输入抛错', async () => {
    const agent = new DataAgent();
    await expect(agent.execute({} as never, makeContext(new MockLLMProvider()))).rejects.toThrow('数据规划输入为空');
  });

  it('LLM 提示词包含需求与用例摘要', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify(validPlanJson())] });
    await new DataAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    const last = llm.getLastCall()!;
    expect(last.messages[0].content).toContain('JSON Schema');
    expect(last.messages[1].content).toContain('功能模块：wan3');
    expect(last.messages[1].content).toContain('测试用例（');
    expect(last.temperature).toBe(0);
    expect(last.jsonMode).toBe(true);
  });
});

describe('data - DataPrepareTool（经 Tool 准备数据）', () => {
  it('经注册的数据工厂生成 DataContext', async () => {
    const fakeFactory: DataFactory = {
      setup: async () => ({}),
      teardown: async () => {},
      generate: async (params: Record<string, unknown>): Promise<DataContext> => ({
        account: { id: 'acct-1', nickname: 'tester', project_id: 1 },
        balance: { initial: 100, consumed: 10, remaining: 90 },
        taskIds: params.count ? ['t1', 't2'] : ['t1'],
        extra: { from: params.resolution ? 'generate' : undefined },
      }),
    };
    const tool = createDataPrepareTool(() => fakeFactory);
    const ctx = makeContext(new MockLLMProvider());
    const data = await tool.execute({ factoryName: 'wan3', params: { count: 2 } }, ctx);
    expect(data.account?.id).toBe('acct-1');
    expect(data.taskIds).toEqual(['t1', 't2']);
  });

  it('未注册工厂返回空 DataContext 且不抛错', async () => {
    const tool = new DataPrepareTool(); // 使用真实注册表（默认无注册）
    const ctx = makeContext(new MockLLMProvider());
    const data = await tool.execute({ factoryName: 'wan3' }, ctx);
    expect(data).toEqual({});
  });

  it('prepareData 经 ToolRegistry 调用并回填 plan.dataContext', async () => {
    const fakeFactory: DataFactory = {
      setup: async () => ({}),
      teardown: async () => {},
      generate: async (): Promise<DataContext> => ({ account: { id: 'acct-2', nickname: 'n', project_id: 2 } }),
    };
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool(() => fakeFactory));
    const agent = new DataAgent();
    const plan = analyzeDataPlan({ requirement: req, testCases: cases });
    const data = await agent.prepareData(plan, makeContext(new MockLLMProvider(), tools));
    expect(data.account?.id).toBe('acct-2');
    expect(plan.dataContext.account?.id).toBe('acct-2');
  });

  it('未注册 data.prepare Tool 时 prepareData 安全跳过', async () => {
    const agent = new DataAgent();
    const plan = analyzeDataPlan({ requirement: req, testCases: cases });
    const data = await agent.prepareData(plan, makeContext(new MockLLMProvider()));
    expect(data).toEqual({});
  });

  it('prepareDataResult 对缺失 Tool 返回 BLOCKED', async () => {
    const agent = new DataAgent();
    const plan = analyzeDataPlan({ requirement: req, testCases: cases });
    const result = await agent.prepareDataResult(plan, makeContext(new MockLLMProvider()));
    expect(result).toMatchObject({ status: 'BLOCKED', context: {} });
  });

  it('needsSetup=false 时 prepareData 直接返回空', async () => {
    const agent = new DataAgent();
    const plan = normalizeDataPlan({ feature: 'wan3', factoryName: 'wan3', needsSetup: false });
    const data = await agent.prepareData(plan, makeContext(new MockLLMProvider()));
    expect(data).toEqual({});
  });
});
