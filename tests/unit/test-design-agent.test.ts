// 单元测试：Test Design Agent（Test DSL Schema / 适配器 / 确定性生成器 / LLM 全链路）
import { describe, it, expect } from 'vitest';
import {
  TestDesignAgent,
  generateTestCases,
  validateTestCase,
  normalizeTestCase,
  toTaskDef,
  toLoadedCase,
  TESTCASE_JSON_SCHEMA,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
  parseRequirement,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { AssertionRule } from '../../src/core/assertion-operators.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';

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

/** 构造一条合法 TestCase 的 JSON */
function validCaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tc-01',
    feature: 'wan3',
    name: '正常提交并成功',
    priority: 'P0',
    tags: ['smoke'],
    steps: [
      { action: 'submit', input: { prompt: '一个女孩在花园奔跑' } },
      { action: 'wait', until: 'SUCCESS' },
    ],
    assertions: [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P0' },
    ],
    ...overrides,
  };
}

/** v2 Agent 输出：设计态必须被保留，但 Runtime 能力只能由确定性 Preflight 绑定。 */
function validV2CaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'TEST_CASE_V2',
    id: 'tc-v2-01',
    feature: 'wan3',
    name: '用户查看视频任务状态',
    priority: 'P0',
    testType: 'FUNCTIONAL',
    testAspects: ['CORE_FUNCTION'],
    executionMode: 'EXECUTABLE',
    requirementStatus: 'CONFIRMED',
    source: {
      requirementId: 'REQ-wan3', testPointId: 'TP-001', acceptanceCriteriaIds: [],
      factIds: ['RF-001'], objectiveIds: ['OBJ-RF-001'], sourceType: 'REQUIREMENT', provenance: 'EXPLICIT',
    },
    businessScenario: {
      title: '用户查看视频任务状态', goal: '用户确认已提交任务的当前状态', kind: 'CORE_FLOW',
      actors: [{ id: 'user', relation: 'SUBJECT', provenance: 'EXPLICIT' }],
      resourceContext: { type: 'video-task', idRef: 'fixture.taskId', provenance: 'EXPLICIT' },
      ownership: { relation: 'SELF', ownerActorId: 'user', provenance: 'EXPLICIT' },
      state: { status: 'UNKNOWN', provenance: 'UNKNOWN' },
      permission: { decision: 'NOT_APPLICABLE', provenance: 'EXPLICIT' },
      flow: { id: 'FLOW-001', name: '查看任务状态', mode: 'SINGLE_OPERATION', steps: [{ id: 'FLOW-STEP-1', action: 'query', dependsOn: [] }] },
      dependencies: [], risks: [], expectedBusinessOutcome: '返回需求声明的任务状态',
      provenance: 'EXPLICIT', factIds: ['RF-001'], acceptanceCriteriaIds: [],
    },
    tags: ['core'],
    preconditions: [],
    preconditionPlan: [],
    data: {},
    testData: [],
    steps: [{
      id: 'STEP-001', channel: 'FUNCTIONAL', description: '查询任务状态', execution: 'EXECUTABLE',
      dependsOn: [], acceptanceCriteriaIds: [], factIds: ['RF-001'], action: 'query', input: {},
    }],
    assertions: [{
      id: 'AS-001', channel: 'STATE', type: 'DESIGN_EXPECTATION', description: '状态与需求声明一致',
      acceptanceCriteriaIds: [], factIds: ['RF-001'], objectiveIds: ['OBJ-RF-001'],
      evidenceRequirementIds: ['EV-001'], sourceType: 'REQUIREMENT', provenance: 'EXPLICIT',
    }],
    expected: { state: { expectation: 'UNKNOWN', description: '需求未声明具体状态值' } },
    evidenceRequirements: [{
      id: 'EV-001', channel: 'STATE_CHANGE', phase: 'AFTER', required: true,
      description: '任务状态观察证据', factIds: ['RF-001'], sourceStepId: 'STEP-001', assertionIds: ['AS-001'],
    }],
    oracle: { mode: 'ALL', deterministic: true, status: 'READY', assertionIds: ['AS-001'], evidenceRequirementIds: ['EV-001'] },
    prepare: [],
    cleanup: [],
    dependencies: [{
      id: 'DEP-EXECUTOR', kind: 'OBSERVER', ref: 'observer.task-state', description: '任务状态观察器',
      required: true, resolution: 'RUNTIME_REQUIRED',
    }],
    readiness: { status: 'READY', reasons: [], missingCapabilities: [] },
    executionContract: {
      executor: { kind: 'FUNCTIONAL', ref: 'runner.task-query', status: 'AVAILABLE', supports: ['query'] },
      observers: [{ channel: 'STATE_CHANGE', ref: 'observer.task-state', phase: 'AFTER', required: true, status: 'AVAILABLE' }],
      preflight: [], lifecycleHooks: [],
    },
    ...overrides,
  };
}

describe('test-design - Test DSL Schema 校验', () => {
  it('合法 TestCase 校验通过并归一化', async () => {
    const tc = await validateTestCase(validCaseJson());
    expect(tc.id).toBe('tc-01');
    expect(tc.feature).toBe('wan3');
    expect(tc.priority).toBe('P0');
    expect(tc.steps).toHaveLength(2);
  });

  it('缺必填字段（id/feature/name/priority/steps）校验失败', async () => {
    await expect(validateTestCase({ feature: 'wan3' })).rejects.toThrow('TestCase 校验失败');
  });

  it('非法优先级校验失败', async () => {
    await expect(validateTestCase(validCaseJson({ priority: 'P9' }))).rejects.toThrow('TestCase 校验失败');
  });

  it('非法断言操作符校验失败', async () => {
    await expect(validateTestCase(
      validCaseJson({ assertions: [{ operator: 'notARealOperator' }] }),
    )).rejects.toThrow('TestCase 校验失败');
  });

  it('normalizeTestCase 补默认值并过滤非法断言', () => {
    const tc = normalizeTestCase({ id: 'x', feature: 'wan3', name: 'n', priority: 'P1', steps: [], assertions: [{ operator: 'bad' }, { operator: 'equals', target: 'submit' }] });
    expect(tc.tags).toEqual([]);
    expect(tc.assertions).toHaveLength(1);
    expect(tc.assertions[0].operator).toBe('equals');
  });

  it('Schema 定义必填字段与优先级枚举', () => {
    expect(TESTCASE_JSON_SCHEMA.required).toEqual(expect.arrayContaining(['id', 'feature', 'name', 'priority', 'steps']));
    expect((TESTCASE_JSON_SCHEMA.properties.priority as unknown as { enum: readonly string[] }).enum).toEqual(['P0', 'P1', 'P2', 'P3']);
  });
});

describe('test-design - 现有引擎适配器 toTaskDef / toLoadedCase', () => {
  it('toTaskDef 生成可被执行引擎消费的 TaskDef', async () => {
    const tc = await validateTestCase(validCaseJson());
    const def = toTaskDef(tc);
    expect(def.name).toBe('正常提交并成功');
    expect(def.scene).toBe('video'); // 由 submit 步骤推断
    expect(def.adapter).toBe('wan3'); // video 场景走 wan3 业务适配器
    expect(def.extra?.agentTestCaseId).toBe('tc-01');
    expect(def.extra?.prompt).toBe('一个女孩在花园奔跑'); // 步骤输入合并进 extra
    expect(def.assert?.mode).toBe('all');
    const rule = (def.assert!.rules[0] as AssertionRule);
    expect(rule.target).toBe('submit');
    expect(rule.operator).toBe('exists');
  });

  it('无 submit 步骤时按 feature 推断 scene', () => {
    const tc = normalizeTestCase({ id: 'y', feature: 'user', name: 'n', priority: 'P2', steps: [{ action: 'query' }], assertions: [] });
    const def = toTaskDef(tc);
    expect(def.scene).toBe('user');
    expect(def.adapter).toBe('default');
  });

  it('data 与步骤输入合并进 extra，data 在前步骤覆盖', () => {
    const tc = normalizeTestCase({
      id: 'z', feature: 'wan3', name: 'n', priority: 'P2',
      data: { prompt: 'data-prompt' },
      steps: [{ action: 'submit', input: { prompt: 'step-prompt', resolution: '1080P' } }],
      assertions: [],
    });
    const def = toTaskDef(tc);
    expect(def.extra?.prompt).toBe('step-prompt');
    expect(def.extra?.resolution).toBe('1080P');
  });

  it('toLoadedCase 产出与 loadCases 兼容的 LoadedCase', () => {
    const tc = normalizeTestCase(validCaseJson());
    const lc = toLoadedCase(tc);
    expect(lc.name).toBe('正常提交并成功');
    expect(lc.file).toBe('<agent:tc-01>');
    expect(lc.feature).toBe('wan3');
    expect(lc.def).toBeDefined();
    expect(lc.def.name).toBe('正常提交并成功');
  });
});

describe('test-design - 确定性生成器', () => {
  const req = parseRequirement(DEMO_REQ);

  it('生成 P0 正常路径用例', () => {
    const cases = generateTestCases(req);
    const happy = cases.find((c) => c.tags.includes('happy-path'));
    expect(happy).toBeDefined();
    expect(happy!.priority).toBe('P0');
    expect(happy!.steps[0].action).toBe('submit');
  });

  it('业务规则生成对应用例（积分/并发）', () => {
    const cases = generateTestCases(req);
    expect(cases.some((c) => c.assertions.some((a) => a.target === 'billing'))).toBe(true);
    expect(cases.some((c) => c.tags.includes('concurrency'))).toBe(true);
  });

  it('参数取值组合与边界值用例', () => {
    const cases = generateTestCases(req);
    expect(cases.some((c) => c.name.includes('resolution'))).toBe(true);
    expect(cases.some((c) => c.tags.includes('boundary'))).toBe(true);
  });

  it('异常输入用例（空提示词/非法分辨率）', () => {
    const cases = generateTestCases(req);
    expect(cases.some((c) => c.name.includes('空提示词'))).toBe(true);
    expect(cases.some((c) => c.name.includes('非法分辨率'))).toBe(true);
  });

  it('确定性：同输入产生相同输出', () => {
    expect(JSON.stringify(generateTestCases(req))).toBe(JSON.stringify(generateTestCases(req)));
  });

  it('maxCases 限制条数', () => {
    const cases = generateTestCases(req, { maxCases: 3 });
    expect(cases.length).toBeLessThanOrEqual(3);
  });

  it('全部用例可通过 Schema 校验', async () => {
    const cases = generateTestCases(req);
    for (const c of cases) {
      const validated = await validateTestCase(c);
      expect(validated.feature).toBe('wan3');
    }
  });

  it('生成用例可全部转为 TaskDef 接入执行引擎', () => {
    const cases = generateTestCases(req);
    for (const c of cases) {
      const def = toTaskDef(c);
      expect(def.name).toBeTruthy();
      expect(def.scene).toBeTruthy();
      expect(def.extra?.agentTestCaseId).toBeTruthy();
    }
  });
});

describe('test-design - TestDesignAgent 全链路', () => {
  const req = parseRequirement(DEMO_REQ);

  it('LLM 返回合法数组 → 走 LLM 生成', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify([validV2CaseJson(), validV2CaseJson({ id: 'tc-v2-02', name: '边界用例' })])],
    });
    const agent = new TestDesignAgent();
    const cases = await agent.execute({ requirement: req }, makeContext(llm));
    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe('tc-v2-01');
    expect(cases[0]).toEqual(expect.objectContaining({ executionMode: 'DESIGNED_ONLY', readiness: expect.objectContaining({ status: 'BLOCKED' }) }));
    expect(cases[0].executionContract?.executor.status).toBe('RUNTIME_REQUIRED');
    expect(llm.getCallCount()).toBe(1);
  });

  it('直接传 Requirement 对象同样可用', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify([validV2CaseJson()])] });
    const cases = await new TestDesignAgent().execute(req, makeContext(llm));
    expect(cases).toHaveLength(1);
  });

  it('LLM 输出被 ```json 围栏包裹也能解析', async () => {
    const llm = new MockLLMProvider({ scripted: [`\`\`\`json\n${JSON.stringify([validV2CaseJson()])}\n\`\`\``] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases).toHaveLength(1);
  });

  it('LLM 返回非法 JSON → 回退确定性生成器', async () => {
    const llm = new MockLLMProvider({ scripted: ['这不是 JSON {{'] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0].metadata?.source).toBe('deterministic-generator');
  });

  it('LLM 空响应 → 回退生成器', async () => {
    const llm = new MockLLMProvider({ scripted: [''] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
  });

  it('LLM 返回非数组对象 → 回退生成器', async () => {
    const llm = new MockLLMProvider({ scripted: ['{"feature":"wan3"}'] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
  });

  it('LLM 返回空数组 → 回退生成器', async () => {
    const llm = new MockLLMProvider({ scripted: ['[]'] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
  });

  it('LLM 数组含非法项 → 回退生成器', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify([{ id: 'bad' }])] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0].metadata?.source).toBe('deterministic-generator');
  });

  it('LLM 抛错 → 回退生成器', async () => {
    const llm = new MockLLMProvider({ scripted: [], failureMode: { type: 'error', message: '网络中断' } });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases.length).toBeGreaterThan(0);
  });

  it('空输入抛错', async () => {
    const agent = new TestDesignAgent();
    await expect(agent.execute({ requirement: '' }, makeContext(new MockLLMProvider()))).rejects.toThrow('测试设计输入为空');
  });

  it('LLM 自报 AVAILABLE 不能让用例进入执行链', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify([validV2CaseJson()])] });
    const cases = await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    expect(cases[0].executionMode).toBe('DESIGNED_ONLY');
    expect(cases[0].steps.every((step) => step.execution === 'PLANNED')).toBe(true);
    expect(cases[0].oracle?.status).toBe('BLOCKED');
    expect(cases[0].readiness?.reasons.join(' ')).toContain('RUNTIME_CAPABILITIES_NOT_VERIFIED');
  });

  it('LLM 提示词包含 Requirement 结构化描述', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify([validV2CaseJson()])] });
    await new TestDesignAgent().execute({ requirement: req }, makeContext(llm));
    const last = llm.getLastCall()!;
    expect(last.messages[0].content).toContain('JSON Schema');
    expect(last.messages[0].content).toContain('"priority"');
    expect(last.messages[0].content).toContain('五维逐项判断适用性');
    expect(last.messages[0].content).toContain('禁止统一伪造 submit 步骤');
    expect(last.messages[0].content).toContain('不设最低条数');
    expect(last.messages[1].content).toContain('功能模块：wan3');
    expect(last.temperature).toBe(0);
    expect(last.jsonMode).toBe(true);
  });
});
