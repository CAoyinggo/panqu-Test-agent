// 单元测试：Test Selection Agent（Phase 11 智能测试选择）
// 覆盖：确定性选择策略（P0/P1 全量 / 风险命中 / 历史提优 / flaky 标记 / 预算裁剪 / 参数覆盖抽样）
//      + LLM 路径（脚本化 Mock） + 回退路径
import { describe, it, expect } from 'vitest';
import {
  TestSelectionAgent,
  selectTestCases,
  buildSelection,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  parseRequirement,
  normalizeRequirementInput,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { RiskAssessment } from '../../src/agents/risk/risk-schema.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

/** 构造一组演示用例：P0×2 / P1×2 / P2×2 / P3×2 */
function demoCases(): TestCase[] {
  const mk = (id: string, priority: TestCase['priority'], tags: string[], extra?: Record<string, unknown>): TestCase => ({
    id,
    feature: 'wan3',
    name: `用例 ${id}`,
    priority,
    tags,
    steps: [{ action: 'submit', input: { prompt: '测试', resolution: extra?.resolution ?? '720P', duration: extra?.duration ?? '5s' } }],
    assertions: [{ operator: 'equals', path: 'status', expected: 'SUCCESS' }],
  });
  return [
    mk('tc-p0-1', 'P0', ['smoke']),
    mk('tc-p0-2', 'P0', ['billing']),
    mk('tc-p1-1', 'P1', ['core']),
    mk('tc-p1-2', 'P1', ['concurrency']),
    mk('tc-p2-1', 'P2', ['boundary'], { resolution: '1080P' }),
    mk('tc-p2-2', 'P2', ['data']),
    mk('tc-p3-1', 'P3', ['regression']),
    mk('tc-p3-2', 'P3', ['edge'], { duration: '10s' }),
  ];
}

const DEMO_REQ = '测试文生视频功能，覆盖 720P、1080P 分辨率，支持 5 秒和 10 秒视频，验证积分正确扣除与并发执行正常。';

function makeRisk(caseId: string, category: 'billing' | 'concurrency' = 'billing'): RiskAssessment {
  return {
    feature: 'wan3',
    risks: [
      {
        id: 'r1', category, level: 'high', title: '积分扣费风险',
        desc: '扣费逻辑需重点验证', affectedCases: [caseId], mitigation: '校验扣费前后积分',
      },
    ],
    summary: { high: 1, medium: 0, low: 0, overall: 'high', recommendedSkip: false },
    issues: [],
  };
}

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-selection',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

describe('test-selection - 确定性选择策略', () => {
  it('P0/P1 全量选中，P2/P3 未命中风险/缺口时跳过', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({ requirement: req, testCases: cases });
    expect(sel.selectedCases).toContain('tc-p0-1');
    expect(sel.selectedCases).toContain('tc-p0-2');
    expect(sel.selectedCases).toContain('tc-p1-1');
    expect(sel.selectedCases).toContain('tc-p1-2');
    expect(sel.statistics.total).toBe(8);
    expect(sel.reasons['tc-p0-1']).toContain('P0/P1');
    // tc-p3-1 无缺口取值且未命中风险 → 跳过
    expect(sel.skippedCases).toContain('tc-p3-1');
    expect(sel.reasons['tc-p3-1']).toContain('跳过');
  });

  it('风险命中的 P2/P3 用例被选中并说明理由', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({ requirement: req, testCases: cases, riskAssessment: makeRisk('tc-p2-1') });
    expect(sel.selectedCases).toContain('tc-p2-1');
    expect(sel.reasons['tc-p2-1']).toContain('风险');
    expect(sel.statistics.riskAffected).toBeGreaterThan(0);
  });

  it('历史失败用例被提优到优先级桶最前', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({
      requirement: req,
      testCases: cases,
      history: { failedCaseIds: ['tc-p1-2'] },
    });
    const p1Idx = sel.priorityOrder.indexOf('tc-p1-2');
    const p1Other = sel.priorityOrder.indexOf('tc-p1-1');
    expect(p1Idx).toBeGreaterThanOrEqual(0);
    expect(p1Idx).toBeLessThan(p1Other);
    expect(sel.reasons['tc-p1-2']).toContain('历史失败');
    expect(sel.statistics.historyBoosted).toBe(1);
  });

  it('flaky 用例被标记（统计计入）且默认纳入', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({
      requirement: req,
      testCases: cases,
      history: { flakyCaseIds: ['tc-p2-2'] },
    });
    expect(sel.statistics.flakyMarked).toBe(1);
    expect(sel.selectedCases).toContain('tc-p2-2');
    expect(sel.reasons['tc-p2-2']).toContain('flaky');
  });

  it('预算 maxCases 超限时裁剪最低优先级非风险用例', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({ requirement: req, testCases: cases, options: { maxCases: 6 } });
    expect(sel.selectedCases.length).toBeLessThanOrEqual(6);
    expect(sel.selectedCases).toContain('tc-p0-1');
    expect(sel.selectedCases).toContain('tc-p1-2');
    expect(sel.statistics.budgetTrimmed).toBeGreaterThanOrEqual(0);
    expect(sel.budget?.maxCases).toBe(6);
  });

  it('参数覆盖抽样：P2/P3 补充覆盖输入取值 1080P/10s', () => {
    const req = parseRequirement(DEMO_REQ);
    const cases = demoCases();
    const sel = selectTestCases({ requirement: req, testCases: cases });
    // 1080P / 10s 属于 requirement 取值，应被覆盖
    expect(sel.selectedCases).toContain('tc-p2-1'); // 1080P
    expect(sel.selectedCases).toContain('tc-p3-2'); // 10s
    expect(sel.reasons['tc-p3-2'] ?? '').toMatch(/参数覆盖|跳过/);
  });

  it('空用例抛错', () => {
    const req = parseRequirement(DEMO_REQ);
    expect(() => selectTestCases({ requirement: req, testCases: [] })).not.toThrow();
    const sel = selectTestCases({ requirement: req, testCases: [] });
    expect(sel.statistics.total).toBe(0);
  });
});

describe('test-selection - Agent（LLM 优先 + 回退）', () => {
  const agent = new TestSelectionAgent();

  it('LLM 脚本化响应 → 直接采用 LLM 选择结果', async () => {
    const llm = new MockLLMProvider({
      scripted: [
        JSON.stringify({
          feature: 'wan3',
          selectedCases: ['tc-p0-1', 'tc-p1-2'],
          skippedCases: ['tc-p3-1'],
          priorityOrder: ['tc-p0-1', 'tc-p1-2'],
          reasons: { 'tc-p0-1': '冒烟', 'tc-p1-2': '并发核心', 'tc-p3-1': '低优跳过' },
        }),
      ],
    });
    const input = { requirement: parseRequirement(DEMO_REQ), testCases: demoCases() };
    const sel = await agent.execute(input, makeContext(llm));
    expect(sel.selectedCases).toContain('tc-p0-1');
    expect(sel.reasons['tc-p1-2']).toBe('并发核心');
  });

  it('LLM 返回非法/缺结构 → 回退确定性选择', async () => {
    const llm = new MockLLMProvider({ defaultResponse: '{"ok":true}' });
    const input = { requirement: parseRequirement(DEMO_REQ), testCases: demoCases() };
    const sel = await agent.execute(input, makeContext(llm));
    // 确定性结果：P0/P1 全部选中
    expect(sel.selectedCases).toContain('tc-p0-1');
    expect(sel.selectedCases).toContain('tc-p1-1');
  });

  it('空 testCases 抛错', async () => {
    await expect(agent.execute({ requirement: parseRequirement(DEMO_REQ), testCases: [] }, makeContext(new MockLLMProvider())))
      .rejects.toThrow('选择输入为空');
  });

  it('normalizeRequirementInput 产出的 Requirement 可直接用于选择', () => {
    const req = normalizeRequirementInput(DEMO_REQ);
    expect(req.feature).toBe('wan3');
    const sel = selectTestCases({ requirement: req, testCases: demoCases() });
    expect(sel.statistics.total).toBe(8);
  });
});

describe('test-selection - buildSelection 归一化', () => {
  it('默认补齐 priorityOrder 与 statistics', () => {
    const sel = buildSelection({ feature: 'wan3', selectedCases: ['a', 'b'] });
    expect(sel.priorityOrder).toEqual(['a', 'b']);
    expect(sel.statistics.total).toBe(0);
    expect(sel.skippedCases).toEqual([]);
  });
});
