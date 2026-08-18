// 单元测试：Agent 核心（接口 / BaseAgent / Registry / RunState / Context）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BaseAgent,
  AgentRegistry,
  AgentRunState,
  createAgentContext,
  NoopMemory,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import { ToolRegistry } from '../../src/agents/tools/tool-registry.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

class EchoAgent extends BaseAgent<unknown, { echoed: unknown }> {
  name = 'echo';
  description = '回显输入';
  async execute(input: unknown): Promise<{ echoed: unknown }> {
    return { echoed: input };
  }
}

class BoomAgent extends BaseAgent<unknown, never> {
  name = 'boom';
  async execute(): Promise<never> {
    throw new Error('boom 失败');
  }
}

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

describe('agent-core - BaseAgent', () => {
  const agent = new EchoAgent();
  it('继承统一接口（name/version/execute）', () => {
    expect(agent.name).toBe('echo');
    expect(typeof agent.version).toBe('string');
    expect(agent.description).toBe('回显输入');
    expect(typeof agent.execute).toBe('function');
  });

  it('runWithResult 成功时返回结构化结果', async () => {
    const r = await agent.runWithResult('hi', makeContext());
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ echoed: 'hi' });
    expect(r.agent).toBe('echo');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runWithResult 失败时返回 error 而非抛异常', async () => {
    const r = await new BoomAgent().runWithResult(undefined, makeContext());
    expect(r.success).toBe(false);
    expect(r.error).toBe('boom 失败');
  });
});

describe('agent-core - AgentRegistry', () => {
  let registry: AgentRegistry;
  beforeEach(() => registry = new AgentRegistry());

  it('注册与获取', () => {
    registry.register(new EchoAgent());
    expect(registry.has('echo')).toBe(true);
    expect(registry.get('echo')).toBeInstanceOf(EchoAgent);
    expect(registry.get('nope')).toBeUndefined();
  });

  it('同名覆盖', () => {
    registry.register(new EchoAgent());
    registry.register({ name: 'echo', version: '2.0.0', execute: async () => 'v2' });
    expect(registry.get('echo')!.version).toBe('2.0.0');
  });

  it('list / listWithMeta / unregister / clear', () => {
    registry.register(new EchoAgent());
    registry.register(new BoomAgent());
    expect(registry.list().sort()).toEqual(['boom', 'echo']);
    expect(registry.listWithMeta()).toHaveLength(2);
    expect(registry.unregister('echo')).toBe(true);
    expect(registry.has('echo')).toBe(false);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});

describe('agent-core - AgentRunState', () => {
  it('初始全部 pending', () => {
    const s = new AgentRunState('t-1', ['a', 'b']);
    expect(s.getStatus('a')).toBe('pending');
    expect(s.isDone()).toBe(false);
  });

  it('setStatus 流转并记录时间戳', () => {
    const s = new AgentRunState('t-1', ['a']);
    s.setStatus('a', 'running');
    expect(s.getStatus('a')).toBe('running');
    expect(s.getState('a')!.startedAt).toBeGreaterThan(0);
    s.setStatus('a', 'completed');
    expect(s.getState('a')!.completedAt).toBeGreaterThan(0);
    expect(s.isDone()).toBe(true);
    expect(s.hasFailure()).toBe(false);
  });

  it('failed 计入失败与完成', () => {
    const s = new AgentRunState('t-1', ['a', 'b']);
    s.setStatus('a', 'failed', 'err');
    s.setStatus('b', 'skipped');
    expect(s.hasFailure()).toBe(true);
    expect(s.isDone()).toBe(true);
    expect(s.getState('a')!.error).toBe('err');
  });

  it('toJSON 输出结构化', () => {
    const s = new AgentRunState('t-1', ['a']);
    s.setStatus('a', 'completed');
    expect(s.toJSON()).toHaveProperty('taskId', 't-1');
    expect(s.toJSON().stages.a.status).toBe('completed');
  });
});

describe('agent-core - createAgentContext', () => {
  it('默认 logger 与空 metadata', () => {
    const ctx = makeContext();
    expect(ctx.taskId).toBe('t-1');
    expect(ctx.feature).toBe('wan3');
    expect(ctx.environment).toBe('test');
    expect(ctx.metadata).toEqual({});
    expect(typeof ctx.logger.info).toBe('function');
    expect(ctx.llm.name).toBe('mock');
  });

  it('传入阶段产物', () => {
    const ctx = createAgentContext({
      taskId: 't-2',
      feature: 'user',
      environment: 'preonline',
      tools: new ToolRegistry(),
      memory: new NoopMemory(),
      llm: new MockLLMProvider(),
      requirement: { feature: 'user' },
      testCases: [{ id: 'c1' }],
      metadata: { k: 'v' },
    });
    expect(ctx.requirement).toEqual({ feature: 'user' });
    expect(ctx.testCases).toEqual([{ id: 'c1' }]);
    expect(ctx.metadata.k).toBe('v');
  });
});
