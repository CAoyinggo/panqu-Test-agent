// 单元测试：Coverage Agent（Phase 12 覆盖分析）
// 覆盖：确定性覆盖计算（需求/参数/边界/异常/断言/风险/历史） + 组合缺口 + LLM 路径 + 回退
import { describe, it, expect } from 'vitest';
import {
  CoverageAgent,
  computeCoverageAnalysis,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  parseRequirement,
  buildCoverage,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

const REQ_TEXT =
  '测试文生视频功能，覆盖 720P、1080P 分辨率，支持 5 秒和 10 秒视频，' +
  '验证任务提交成功、积分正确扣除，并覆盖并发与模型异常场景。';

/** 构造覆盖较全的用例集：含 billing/异常/并发标签 */
function coveredCases(): TestCase[] {
  const mk = (id: string, priority: TestCase['priority'], tags: string[], input: Record<string, unknown>, name?: string): TestCase => ({
    id,
    feature: 'wan3',
    name: name ?? `用例 ${id}`,
    priority,
    tags,
    steps: [{ action: 'submit', input }],
    assertions: [{ operator: 'equals', path: 'status', expected: 'SUCCESS' }],
  });
  return [
    mk('c1', 'P0', ['billing'], { resolution: '720P', duration: '5s' }, '积分扣除校验'),
    mk('c2', 'P0', ['smoke'], { resolution: '1080P', duration: '5s' }),
    mk('c3', 'P2', ['boundary'], { resolution: '720P', duration: '10s' }),
    mk('c4', 'P3', ['exception'], { resolution: '1080P', duration: '10s' }),
    mk('c5', 'P3', ['concurrency'], { resolution: '720P', duration: '5s' }),
  ];
}

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-coverage',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

describe('coverage - 确定性覆盖计算', () => {
  const input = { requirement: parseRequirement(REQ_TEXT), testCases: coveredCases() };

  it('参数覆盖：1080P/10s 被覆盖', () => {
    const c = computeCoverageAnalysis(input);
    const p = c.dimensions.find((d) => d.name === 'parameter')!;
    expect(p.rate).toBe(100);
  });

  it('风险覆盖：billing/concurrency 被标签覆盖', () => {
    const c = computeCoverageAnalysis(input);
    const r = c.dimensions.find((d) => d.name === 'risk')!;
    expect(r.rate).toBeGreaterThanOrEqual(80);
  });

  it('异常覆盖：存在 exception 用例', () => {
    const c = computeCoverageAnalysis(input);
    const e = c.dimensions.find((d) => d.name === 'exception')!;
    expect(e.rate).toBe(100);
  });

  it('业务规则覆盖：积分规则被断言覆盖', () => {
    const c = computeCoverageAnalysis(input);
    const r = c.dimensions.find((d) => d.name === 'requirement')!;
    // c1 的 billing.amount 断言覆盖「积分正确扣除」
    expect(r.rate).toBeGreaterThan(0);
  });

  it('coverage 快捷映射与 dimensions 一致', () => {
    const c = computeCoverageAnalysis(input);
    expect(c.coverage.parameter).toBe(c.dimensions.find((d) => d.name === 'parameter')!.rate);
  });

  it('history 维度：历史缺陷关键词被覆盖', () => {
    const c = computeCoverageAnalysis({
      ...input,
      historicalDefects: ['积分扣除失败', '不存在缺陷'],
    });
    const h = c.dimensions.find((d) => d.name === 'history')!;
    expect(h.total).toBe(2);
    expect(h.covered).toBe(1);
    expect(c.gaps.some((g) => g.includes('不存在缺陷'))).toBe(true);
  });
});

describe('coverage - 组合缺口检测', () => {
  it('1080P 与 10s 无单一用例同时覆盖 → 组合缺口', () => {
    // 构造：1080P 只与 5s 组合，10s 只与 720P 组合 → 无 1080P+10s
    const mk = (id: string, input: Record<string, unknown>): TestCase => ({
      id,
      feature: 'wan3', name: id, priority: 'P2' as const, tags: [],
      steps: [{ action: 'submit', input }],
      assertions: [{ operator: 'equals', path: 'status', expected: 'SUCCESS' }],
    });
    const cases = [mk('a', { resolution: '1080P', duration: '5s' }), mk('b', { resolution: '720P', duration: '10s' })];
    const c = computeCoverageAnalysis({ requirement: parseRequirement(REQ_TEXT), testCases: cases });
    expect(c.gaps.some((g) => g.toLowerCase().includes('1080p') && g.includes('10'))).toBe(true);
    expect(c.recommendedCases.some((r) => r.dimension === 'parameter')).toBe(true);
  });

  it('组合已覆盖则无该缺口', () => {
    const mk = (id: string, input: Record<string, unknown>): TestCase => ({
      id, feature: 'wan3', name: id, priority: 'P2' as const, tags: [],
      steps: [{ action: 'submit', input }],
      assertions: [{ operator: 'equals', path: 'status', expected: 'SUCCESS' }],
    });
    const cases = [mk('a', { resolution: '1080P', duration: '10s' }), mk('b', { resolution: '720P', duration: '5s' })];
    const c = computeCoverageAnalysis({ requirement: parseRequirement(REQ_TEXT), testCases: cases });
    expect(c.gaps.some((g) => g.includes('1080P') && g.includes('10'))).toBe(false);
  });
});

describe('coverage - Agent（LLM 优先 + 回退）', () => {
  const input = { requirement: parseRequirement(REQ_TEXT), testCases: coveredCases() };
  const agent = new CoverageAgent();

  it('LLM 脚本化响应 → 采用 LLM 缺口判断', async () => {
    const llm = new MockLLMProvider({
      scripted: [
        JSON.stringify({
          feature: 'wan3',
          coverage: { requirement: 92, parameter: 100, boundary: 100, exception: 100, risk: 100 },
          gaps: ['1080P + 10秒组合场景缺失'],
          recommendedCases: [{ description: '补 1080P+10s 组合', priority: 'P2', dimension: 'parameter' }],
        }),
      ],
    });
    const c = await agent.execute(input, makeContext(llm));
    expect(c.coverage.requirement).toBe(92);
    expect(c.gaps[0]).toContain('组合场景缺失');
    expect(c.recommendedCases[0].description).toBe('补 1080P+10s 组合');
  });

  it('LLM 返回非法 → 回退确定性分析', async () => {
    const llm = new MockLLMProvider({ defaultResponse: '{"ok":true}' });
    const c = await agent.execute(input, makeContext(llm));
    expect(c.coverage.parameter).toBe(100);
    expect(Array.isArray(c.dimensions)).toBe(true);
  });

  it('缺 requirement 抛错', async () => {
    await expect(agent.execute({ testCases: [] } as never, makeContext(new MockLLMProvider()))).rejects.toThrow('缺少 requirement');
  });

  it('buildCoverage 默认补齐', () => {
    const c = buildCoverage({ feature: 'wan3', gaps: ['x'] });
    expect(c.coverage).toEqual({});
    expect(c.recommendedCases).toEqual([]);
  });
});
