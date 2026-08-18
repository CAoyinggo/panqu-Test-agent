// 单元测试：AgentOrchestrator（调度 / 跳过 / 审批 / 重试 / 部分失败 / 超时）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentOrchestrator,
  AgentRegistry,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { TestAgent } from '../../src/agents/core/agent.js';
import type { AgentStage, AgentPlan } from '../../src/agents/orchestration/orchestrator.js';

// ── 测试 Agent ──
function makeAgent(name: string, fn: (input: unknown) => unknown): TestAgent {
  return { name, version: '1.0.0', description: `${name} 测试`, execute: async (input: unknown) => fn(input) };
}

const flakyAgent = ((): TestAgent => {
  let calls = 0;
  return {
    name: 'flaky',
    version: '1.0.0',
    async execute(input: unknown): Promise<unknown> {
      calls++;
      if (calls < 2) throw new Error('首次失败');
      return { attempts: calls, input };
    },
  };
})();

const slowAgent: TestAgent = {
  name: 'slow',
  version: '1.0.0',
  async execute(): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 2000));
    return 'done';
  },
};

function makeContext(): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm: new MockLLMProvider(),
  });
}

describe('orchestrator - 基本调度', () => {
  it('顺序执行全部阶段并串联产物', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('requirement', () => ({ feature: 'wan3' })));
    registry.register(makeAgent('test-design', (input) => ({ cases: 2, from: (input as { feature: string }).feature })));

    const plan: AgentPlan = {
      taskId: 't-1',
      stages: [{ name: 'requirement' }, { name: 'test-design' }],
    };
    const orch = new AgentOrchestrator({ registry });
    const r = await orch.run(plan, makeContext());

    expect(r.success).toBe(true);
    expect(r.stages.requirement).toBe('completed');
    expect(r.stages['test-design']).toBe('completed');
    // 默认输入 = 上一阶段产物
    expect((r.outputs['test-design'] as { from: string }).from).toBe('wan3');
  });

  it('自定义 input 函数可注入上下文', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('a', (input) => ({ got: input })));
    const stage: AgentStage = {
      name: 'a',
      input: (ctx) => ({ env: ctx.environment, task: ctx.taskId }),
    };
    const r = await new AgentOrchestrator({ registry }).run({ taskId: 't-1', stages: [stage] }, makeContext());
    expect((r.outputs.a as { got: { env: string } }).got.env).toBe('test');
  });

  it('Agent 未注册 → 阶段 failed（不中止后续）', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('b', () => 'ok'));
    const r = await new AgentOrchestrator({ registry }).run({
      taskId: 't-1',
      stages: [{ name: 'missing' }, { name: 'b' }],
    }, makeContext());
    expect(r.stages.missing).toBe('failed');
    expect(r.stages.b).toBe('completed');
    expect(r.success).toBe(false);
  });
});

describe('orchestrator - 跳过', () => {
  it('skip 返回 true 时标记 skipped 且不执行', async () => {
    let executed = false;
    const registry = new AgentRegistry();
    registry.register({ name: 'a', version: '1.0.0', execute: async () => { executed = true; return 'x'; } });
    const stage: AgentStage = {
      name: 'a',
      skip: () => true,
    };
    const r = await new AgentOrchestrator({ registry }).run({ taskId: 't-1', stages: [stage] }, makeContext());
    expect(r.stages.a).toBe('skipped');
    expect(executed).toBe(false);
    expect(r.success).toBe(true);
  });

  it('已有产物时跳过（典型：已有 Test Case 跳过 Requirement）', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('risk', (input) => ({ level: 'P0' })));
    const ctx = makeContext();
    ctx.testCases = [{ id: 'existing' }];
    const stage: AgentStage = {
      name: 'requirement',
      skip: (c) => !!c.testCases?.length,
    };
    const r = await new AgentOrchestrator({ registry }).run({
      taskId: 't-1',
      stages: [stage, { name: 'risk' }],
    }, ctx);
    expect(r.stages.requirement).toBe('skipped');
    expect(r.stages.risk).toBe('completed');
  });
});

describe('orchestrator - 审批', () => {
  it('AUTO 模式直接执行', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('a', () => 'run'));
    const r = await new AgentOrchestrator({ registry }).run({
      taskId: 't-1',
      stages: [{ name: 'a', approval: { mode: 'AUTO' } }],
    }, makeContext());
    expect(r.stages.a).toBe('completed');
  });

  it('MANUAL 审批通过 → 执行', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('a', () => 'run'));
    const orch = new AgentOrchestrator({ registry, approvalHandler: () => true });
    const r = await orch.run({
      taskId: 't-1',
      stages: [{ name: 'a', approval: { mode: 'MANUAL', message: '确认执行？' } }],
    }, makeContext());
    expect(r.stages.a).toBe('completed');
  });

  it('MANUAL 审批拒绝 → 阶段 failed', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('a', () => 'run'));
    const orch = new AgentOrchestrator({ registry, approvalHandler: () => false });
    const r = await orch.run({
      taskId: 't-1',
      stages: [{ name: 'a', approval: { mode: 'MANUAL' } }],
    }, makeContext());
    expect(r.stages.a).toBe('failed');
    expect(r.success).toBe(false);
  });

  it('审批回调收到阶段与载荷', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('a', (input) => ({ received: input })));
    let seen: { name: string; payload: unknown } | null = null;
    const orch = new AgentOrchestrator({
      registry,
      approvalHandler: (stage, payload) => { seen = { name: stage.name, payload }; return true; },
    });
    const r = await orch.run({
      taskId: 't-1',
      stages: [{ name: 'a', approval: { mode: 'REVIEW' }, input: () => '审批载荷' }],
    }, makeContext());
    expect(seen!.name).toBe('a');
    expect(seen!.payload).toBe('审批载荷');
    // 执行输入与审批载荷一致
    expect((r.outputs.a as { received: unknown }).received).toBe('审批载荷');
  });
});

describe('orchestrator - 重试与超时', () => {
  it('maxStageRetries=1 时首次失败后重试成功', async () => {
    const registry = new AgentRegistry();
    registry.register(flakyAgent);
    const r = await new AgentOrchestrator({ registry, maxStageRetries: 1 }).run({
      taskId: 't-1',
      stages: [{ name: 'flaky' }],
    }, makeContext());
    expect(r.stages.flaky).toBe('completed');
    expect((r.outputs.flaky as { attempts: number }).attempts).toBe(2);
  });

  it('重试耗尽仍失败 → failed', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('always-fail', () => { throw new Error('始终失败'); }));
    const r = await new AgentOrchestrator({ registry, maxStageRetries: 1 }).run({
      taskId: 't-1',
      stages: [{ name: 'always-fail' }],
    }, makeContext());
    expect(r.stages['always-fail']).toBe('failed');
    expect(r.success).toBe(false);
  });

  it('阶段超时 → failed（不阻塞）', async () => {
    const registry = new AgentRegistry();
    registry.register(slowAgent);
    const r = await new AgentOrchestrator({ registry, stageTimeoutMs: 100 }).run({
      taskId: 't-1',
      stages: [{ name: 'slow' }],
    }, makeContext());
    expect(r.stages.slow).toBe('failed');
    expect(r.success).toBe(false);
  });
});

describe('orchestrator - 部分失败策略', () => {
  it('abortOnStageFailure=false（默认）：失败后继续后续阶段', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('bad', () => { throw new Error('失败'); }));
    registry.register(makeAgent('good', () => 'ok'));
    const r = await new AgentOrchestrator({ registry }).run({
      taskId: 't-1',
      stages: [{ name: 'bad' }, { name: 'good' }],
    }, makeContext());
    expect(r.stages.bad).toBe('failed');
    expect(r.stages.good).toBe('completed');
    expect(r.success).toBe(false);
  });

  it('abortOnStageFailure=true：失败后中止，后续阶段保持 pending', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('bad', () => { throw new Error('失败'); }));
    registry.register(makeAgent('good', () => 'ok'));
    const r = await new AgentOrchestrator({ registry, abortOnStageFailure: true }).run({
      taskId: 't-1',
      stages: [{ name: 'bad' }, { name: 'good' }],
    }, makeContext());
    expect(r.stages.bad).toBe('failed');
    expect(r.stages.good).toBe('pending');
    expect(r.success).toBe(false);
  });
});
