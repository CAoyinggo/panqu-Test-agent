// 单元测试：Execution Agent（Schema 归一化 / 执行规划 / Tool 执行 / 未注册回退）
import { describe, it, expect } from 'vitest';
import {
  ExecutionAgent,
  createExecutionRunTool,
  computeOutcome,
  normalizeOutcome,
  normalizeCaseExecutionResult,
  parseRequirement,
  generateTestCases,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
  toLoadedCase,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';
const req = parseRequirement(DEMO_REQ);
const cases = generateTestCases(req);

function makeContext(llm: MockLLMProvider, tools: ToolRegistry): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment: 'test',
    tools,
    memory: new NoopMemory(),
    llm,
  });
}

/** 构造 mock 执行器：tc-01 通过，tc-02 失败，其余通过 */
function mockRunner() {
  return async (loaded: { name: string; feature?: string; def: { extra?: Record<string, unknown>; scene?: string; tags?: string[] } }[]): Promise<ExecutionOutcome> => {
    const results = loaded.map((c) => {
      const caseId = String(c.def.extra?.agentTestCaseId ?? c.name);
      const fail = caseId === 'tc-02';
      return {
        caseId,
        name: c.name,
        feature: c.feature,
        scene: c.def.scene,
        priority: 'P0',
        tags: c.def.tags,
        pass: !fail,
        passRate: fail ? 50 : 100,
        error: fail ? '断言失败：状态为 FAILED' : undefined,
        durationMs: 12,
        checks: fail
          ? [{ name: 'status-check', pass: false, detail: 'expected SUCCESS, actual FAILED', level: 'P0' }]
          : [{ name: 'status-check', pass: true, detail: 'status SUCCESS', level: 'P0' }],
      };
    });
    return computeOutcome('wan3', results, { reports: ['report-1.json'], executed: true });
  };
}

describe('execution - Schema 归一化', () => {
  it('computeOutcome 统计通过/失败/超时/通过率', () => {
    const o = computeOutcome('wan3', [
      { caseId: 'a', name: 'A', pass: true, passRate: 100 },
      { caseId: 'b', name: 'B', pass: false, passRate: 0 },
      { caseId: 'c', name: 'C', pass: false, passRate: 0, timedOut: true },
    ]);
    expect(o.total).toBe(3);
    expect(o.passed).toBe(1);
    expect(o.failed).toBe(1);
    expect(o.timedOut).toBe(1);
    expect(o.passRate).toBe(33.3);
  });

  it('normalizeOutcome 兼容 cases 字段', () => {
    const o = normalizeOutcome({ feature: 'wan3', cases: [{ id: 'x', name: 'X', pass: true, passRate: 100 }] });
    expect(o.results).toHaveLength(1);
    expect(o.results[0].caseId).toBe('x');
    expect(o.executed).toBe(true);
  });

  it('normalizeCaseExecutionResult 补默认与过滤', () => {
    const r = normalizeCaseExecutionResult({ id: 'y', name: 'Y' });
    expect(r.caseId).toBe('y');
    expect(r.pass).toBe(false);
    expect(r.passRate).toBe(0);
  });
});

describe('execution - 执行规划', () => {
  const agent = new ExecutionAgent();

  it('按优先级 P0→P3 排序', () => {
    const mixed = [
      ...cases.filter((c) => c.priority === 'P1').slice(0, 2).map((c) => ({ ...c, id: 'p1-case' })),
      ...cases.filter((c) => c.priority === 'P0').slice(0, 2).map((c) => ({ ...c, id: 'p0-case' })),
    ];
    const plan = agent.planExecution(mixed);
    expect(plan.order[0]).toBe('p0-case');
    expect(plan.order[1]).toBe('p0-case');
    expect(plan.order).toContain('p1-case');
  });

  it('并发与重试默认值', () => {
    const plan = agent.planExecution(cases, 4);
    expect(plan.concurrency).toBe(4);
    expect(plan.enableRetry).toBe(true);
    expect(plan.reason).toContain('优先级');
  });
});

describe('execution - ExecutionAgent 全链路', () => {
  it('经 Tool 执行并产出结构化结果', async () => {
    const tools = new ToolRegistry();
    tools.register(createExecutionRunTool(mockRunner()));
    const agent = new ExecutionAgent();
    const o = await agent.execute(
      { testCases: cases, options: { concurrency: 2 } },
      makeContext(new MockLLMProvider(), tools),
    );
    expect(o.executed).toBe(true);
    expect(o.total).toBe(cases.length);
    expect(o.passRate).toBeGreaterThan(0);
    expect(o.results.some((r) => r.caseId === 'tc-02' && !r.pass)).toBe(true);
    expect(o.plan).toBeDefined();
    expect(o.plan!.order).toHaveLength(cases.length);
  });

  it('执行器收到 LoadedCase 且含 agentTestCaseId', async () => {
    let received: unknown = null;
    const runner = async (loaded: unknown[]) => {
      received = loaded;
      return computeOutcome('wan3', [], { executed: true });
    };
    const tools = new ToolRegistry();
    tools.register(createExecutionRunTool(runner as never));
    await new ExecutionAgent().execute({ testCases: cases }, makeContext(new MockLLMProvider(), tools));
    const arr = received as Array<{ def: { extra?: Record<string, unknown>; scene?: string } }>;
    expect(arr[0].def.extra?.agentTestCaseId).toBe('tc-01');
    expect(arr[0].def.scene).toBeTruthy();
  });

  it('未注册 execution.run Tool 时仅产出计划（executed=false）', async () => {
    const agent = new ExecutionAgent();
    const o = await agent.execute({ testCases: cases }, makeContext(new MockLLMProvider(), new ToolRegistry()));
    expect(o.executed).toBe(false);
    expect(o.results).toHaveLength(0);
    expect(o.plan).toBeDefined();
    expect(o.summary).toContain('未执行');
  });

  it('空输入抛错', async () => {
    const agent = new ExecutionAgent();
    await expect(agent.execute({ testCases: [] } as never, makeContext(new MockLLMProvider(), new ToolRegistry())))
      .rejects.toThrow('执行输入为空');
  });

  it('执行器抛错时返回失败结果而非抛出', async () => {
    const tools = new ToolRegistry();
    tools.register(createExecutionRunTool(async () => {
      throw new Error('引擎崩溃');
    }));
    const o = await new ExecutionAgent().execute({ testCases: cases }, makeContext(new MockLLMProvider(), tools));
    expect(o.executed).toBe(false);
    expect(o.summary).toContain('执行失败');
  });

  it('toLoadedCase 产出与 loadCases 兼容（可合并执行链路）', () => {
    const loaded = cases.map(toLoadedCase);
    expect(loaded.length).toBe(cases.length);
    for (const l of loaded) {
      expect(l.name).toBeTruthy();
      expect(l.def.scene).toBeTruthy();
      expect(l.def.extra?.agentTestCaseId).toBeTruthy();
    }
  });
});
