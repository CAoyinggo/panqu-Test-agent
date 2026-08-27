// 单元测试：Risk Agent（Risk Schema / 确定性分析器 / LLM 全链路）
import { describe, it, expect } from 'vitest';
import {
  RiskAgent,
  analyzeRisks,
  validateRiskAssessment,
  normalizeRiskAssessment,
  computeRiskSummary,
  toIssueItem,
  RISK_JSON_SCHEMA,
  parseRequirement,
  generateTestCases,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { RiskItem } from '../../src/agents/risk/risk-schema.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';

const req = parseRequirement(DEMO_REQ);
const cases = generateTestCases(req);

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

/** 构造合法 RiskAssessment JSON */
function validRiskJson(): Record<string, unknown> {
  return {
    feature: 'wan3',
    risks: [
      { category: 'billing', level: 'high', title: '计费风险', desc: '积分扣减', mitigation: '人工复核' },
      { category: 'dependency', level: 'medium', title: '依赖风险', desc: '模型服务', mitigation: '确认可用性' },
    ],
  };
}

describe('risk - Risk Schema 校验与归一化', () => {
  it('合法数据校验通过并归一化（自动补 id、重算汇总）', async () => {
    const r = await validateRiskAssessment(validRiskJson());
    expect(r.feature).toBe('wan3');
    expect(r.risks).toHaveLength(2);
    expect(r.risks[0].id).toBeTruthy();
    expect(r.summary.high).toBe(1);
    expect(r.summary.medium).toBe(1);
    expect(r.summary.overall).toBe('high');
  });

  it('缺 feature 校验失败', async () => {
    await expect(validateRiskAssessment({ risks: [] })).rejects.toThrow('缺少 feature');
  });

  it('非法风险级别/维度被过滤', () => {
    const r = normalizeRiskAssessment({
      feature: 'wan3',
      risks: [
        { category: 'billing', level: 'high', title: 'ok', desc: 'd', mitigation: 'm' },
        { category: 'unknown', level: 'extreme', title: 'bad', desc: 'd', mitigation: 'm' },
      ],
    });
    expect(r.risks).toHaveLength(1);
    expect(r.risks[0].category).toBe('billing');
  });

  it('computeRiskSummary 计数与整体等级', () => {
    const items: RiskItem[] = [
      { id: 'r1', category: 'billing', level: 'high', title: 'a', desc: 'd', mitigation: 'm' },
      { id: 'r2', category: 'data', level: 'medium', title: 'b', desc: 'd', mitigation: 'm' },
      { id: 'r3', category: 'data', level: 'low', title: 'c', desc: 'd', mitigation: 'm' },
    ];
    const s = computeRiskSummary(items);
    expect(s.high).toBe(1);
    expect(s.medium).toBe(1);
    expect(s.low).toBe(1);
    expect(s.overall).toBe('high');
    expect(s.recommendedSkip).toBe(true); // 计费高风险
  });

  it('toIssueItem 映射现有 IssueItem 级别', () => {
    expect(toIssueItem({ id: 'r', category: 'billing', level: 'high', title: 'a', desc: 'd', mitigation: 'm' }).level).toBe('阻塞');
    expect(toIssueItem({ id: 'r', category: 'data', level: 'medium', title: 'a', desc: 'd', mitigation: 'm' }).level).toBe('数据异常');
    expect(toIssueItem({ id: 'r', category: 'retry', level: 'low', title: 'a', desc: 'd', mitigation: 'm' }).level).toBe('待人工');
  });

  it('Schema 定义必填字段', () => {
    expect(RISK_JSON_SCHEMA.required).toContain('feature');
    expect(RISK_JSON_SCHEMA.required).toContain('risks');
  });
});

describe('risk - 确定性分析器', () => {
  it('依赖服务产出依赖风险', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    expect(r.risks.some((x) => x.category === 'dependency')).toBe(true);
  });

  it('计费用例产出计费高风险', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    const billing = r.risks.find((x) => x.category === 'billing');
    expect(billing).toBeDefined();
    expect(billing!.level).toBe('high');
  });

  it('Requirement 已明确声明计费风险时，无用例或依赖线索也不得漏报', () => {
    const r = analyzeRisks({
      requirement: { ...req, dependencies: [], risks: ['billing'] },
      testCases: [],
    });
    expect(r.risks.find((risk) => risk.category === 'billing')).toMatchObject({ level: 'high' });
  });

  it('并发用例产出并发高风险', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    const concurrency = r.risks.find((x) => x.category === 'concurrency');
    expect(concurrency).toBeDefined();
    expect(concurrency!.level).toBe('high');
  });

  it('边界与异常输入用例产出数据性风险', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    expect(r.risks.some((x) => x.category === 'boundary')).toBe(true);
    expect(r.risks.some((x) => x.category === 'data')).toBe(true);
  });

  it('prod 环境产出环境高风险', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases, environment: 'prod' });
    const env = r.risks.find((x) => x.category === 'environment');
    expect(env).toBeDefined();
    expect(env!.level).toBe('high');
  });

  it('未声明依赖产出低风险提示', () => {
    const r = analyzeRisks({ requirement: { ...req, dependencies: [] }, testCases: [] });
    expect(r.risks.some((x) => x.level === 'low' && x.category === 'dependency')).toBe(true);
  });

  it('security 标签用例产出安全高风险', () => {
    const withSecurity = cases.map((c, i) =>
      i === 0 ? { ...c, tags: [...c.tags, 'security'] } : c,
    );
    const r = analyzeRisks({ requirement: req, testCases: withSecurity });
    const security = r.risks.find((x) => x.category === 'security');
    expect(security).toBeDefined();
    expect(security!.level).toBe('high');
  });

  it('超时/重试业务规则产出对应维度风险', () => {
    const timeoutReq = { ...req, businessRules: [...req.businessRules, '超时处理正常', '重试机制正常'] };
    const r = analyzeRisks({ requirement: timeoutReq, testCases: cases });
    expect(r.risks.some((x) => x.category === 'timeout')).toBe(true);
    expect(r.risks.some((x) => x.category === 'retry')).toBe(true);
  });

  it('确定性：同输入产生相同输出', () => {
    expect(JSON.stringify(analyzeRisks({ requirement: req, testCases: cases })))
      .toBe(JSON.stringify(analyzeRisks({ requirement: req, testCases: cases })));
  });

  it('issues 字段可被现有报告消费（IssueItem 结构）', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    expect(Array.isArray(r.issues)).toBe(true);
    expect(r.issues.length).toBeGreaterThan(0);
    for (const i of r.issues) {
      expect(['阻塞', '数据异常', '待接入', '待人工']).toContain(i.level);
      expect(typeof i.title).toBe('string');
    }
  });

  it('recommendedSkip 由高风险决定', () => {
    const r = analyzeRisks({ requirement: req, testCases: cases });
    expect(r.summary.recommendedSkip).toBe(true); // 计费+并发至少两条高风险
  });
});

describe('risk - RiskAgent 全链路', () => {
  it('LLM 返回合法 JSON → 走 LLM 评估', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify(validRiskJson())] });
    const agent = new RiskAgent();
    const r = await agent.execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.feature).toBe('wan3');
    expect(r.risks).toHaveLength(2);
    expect(llm.getCallCount()).toBe(1);
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('LLM 输出被 ```json 围栏包裹也能解析', async () => {
    const llm = new MockLLMProvider({ scripted: [`\`\`\`json\n${JSON.stringify(validRiskJson())}\n\`\`\``] });
    const r = await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.risks).toHaveLength(2);
  });

  it('LLM 返回非法 JSON → 回退确定性分析器', async () => {
    const llm = new MockLLMProvider({ scripted: ['这不是 JSON {{'] });
    const r = await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.risks.length).toBeGreaterThan(0);
    expect(r.risks.some((x) => x.category === 'billing')).toBe(true);
  });

  it('LLM 空响应 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [''] });
    const r = await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.risks.length).toBeGreaterThan(0);
  });

  it('LLM 缺 feature → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({ risks: [] })] });
    const r = await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.feature).toBe('wan3');
  });

  it('LLM 抛错 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [], failureMode: { type: 'error', message: '网络中断' } });
    const r = await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    expect(r.risks.length).toBeGreaterThan(0);
  });

  it('空输入抛错', async () => {
    const agent = new RiskAgent();
    await expect(agent.execute({} as never, makeContext(new MockLLMProvider()))).rejects.toThrow('风险评估输入为空');
  });

  it('LLM 提示词包含需求与用例摘要', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify(validRiskJson())] });
    await new RiskAgent().execute({ requirement: req, testCases: cases }, makeContext(llm));
    const last = llm.getLastCall()!;
    expect(last.messages[0].content).toContain('JSON Schema');
    expect(last.messages[1].content).toContain('功能模块：wan3');
    expect(last.messages[1].content).toContain('测试用例（');
    expect(last.messages[1].content).toContain('tc-01');
    expect(last.temperature).toBe(0);
    expect(last.jsonMode).toBe(true);
  });

  it('无用例时也能评估（依赖/环境维度）', async () => {
    const r = await new RiskAgent().execute({ requirement: req }, makeContext(new MockLLMProvider({ scripted: ['bad json'] })));
    expect(r.risks.some((x) => x.category === 'dependency')).toBe(true);
  });
});
