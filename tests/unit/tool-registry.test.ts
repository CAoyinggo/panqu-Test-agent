// 单元测试：ToolRegistry（注册 / 查询 / 超时 / 错误处理 / 审计 / 安全边界）
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/agents/tools/tool-registry.js';
import type { AgentTool } from '../../src/agents/tools/tool.js';
import { redactSensitive } from '../../src/agents/tools/tool.js';
import { createAgentContext, NoopMemory } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

function makeContext(environment = 'test'): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment,
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm: new MockLLMProvider(),
  });
}

const squareTool: AgentTool<number, number> = {
  name: 'square',
  description: '求平方',
  inputSchema: { type: 'number' },
  outputSchema: { type: 'number' },
  async execute(input: number): Promise<number> {
    return input * input;
  },
};

const throwTool: AgentTool<void, never> = {
  name: 'throw',
  description: '总是失败',
  inputSchema: {},
  outputSchema: {},
  async execute(): Promise<never> {
    throw new Error('工具执行失败');
  },
};

const slowTool: AgentTool<void, string> = {
  name: 'slow',
  description: '超时工具',
  inputSchema: {},
  outputSchema: { type: 'string' },
  timeoutMs: 30,
  async execute(): Promise<string> {
    await new Promise((r) => setTimeout(r, 500));
    return 'too late';
  },
};

describe('tool-registry - 注册与查询', () => {
  let reg: ToolRegistry;
  beforeEach(() => {
    reg = new ToolRegistry({ defaultTimeoutMs: 100 });
    reg.register(squareTool);
  });

  it('注册后可获取/列出', () => {
    expect(reg.has('square')).toBe(true);
    expect(reg.get('square')).toBe(squareTool);
    expect(reg.list()).toEqual(['square']);
    expect(reg.listWithMeta()[0].description).toBe('求平方');
    expect(reg.listWithMeta()[0].inputSchema).toEqual({ type: 'number' });
  });

  it('同名覆盖', () => {
    reg.register({ ...squareTool, description: 'v2' });
    expect(reg.get('square')!.description).toBe('v2');
  });

  it('unregister / clear', () => {
    expect(reg.unregister('square')).toBe(true);
    expect(reg.has('square')).toBe(false);
    reg.register(squareTool);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
  });
});

describe('tool-registry - call 行为', () => {
  let reg: ToolRegistry;
  let ctx: AgentContext;
  beforeEach(() => {
    reg = new ToolRegistry({ defaultTimeoutMs: 100 });
    ctx = makeContext();
  });

  it('成功调用返回 ok 与数据', async () => {
    reg.register(squareTool);
    const r = await reg.call<number, number>('square', 4, ctx);
    expect(r.ok).toBe(true);
    expect(r.data).toBe(16);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('未注册 Tool 返回 ok=false（不抛异常）', async () => {
    const r = await reg.call('nope', undefined, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未注册');
  });

  it('Tool 抛错返回 ok=false 且带错误信息', async () => {
    reg.register(throwTool);
    const r = await reg.call('throw', undefined, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('工具执行失败');
  });

  it('Tool 超时返回 ok=false', async () => {
    reg.register(slowTool);
    const r = await reg.call('slow', undefined, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('触发审计回调', async () => {
    const audits: unknown[] = [];
    reg = new ToolRegistry({ defaultTimeoutMs: 100, onAudit: (e) => audits.push(e) });
    reg.register(squareTool);
    await reg.call('square', 3, ctx);
    await reg.call('nope', undefined, ctx);
    expect(audits).toHaveLength(2);
    expect((audits[0] as { name: string; ok: boolean }).name).toBe('square');
    expect((audits[0] as { name: string; ok: boolean }).ok).toBe(true);
    expect((audits[1] as { name: string; ok: boolean }).ok).toBe(false);
  });
});

describe('tool-registry - 安全边界（权限执行 + 脱敏）', () => {
  const dangerousTool: AgentTool<{ cmd: string }, string> = {
    name: 'sys.exec',
    description: '执行系统命令（危险）',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
    outputSchema: { type: 'string' },
    permission: 'dangerous',
    async execute(input): Promise<string> {
      return `exec ${input.cmd}`;
    },
  };

  const riskyTool: AgentTool<void, string> = {
    name: 'billing.realCharge',
    description: '真实扣费（风险）',
    inputSchema: {},
    outputSchema: { type: 'string' },
    permission: 'risky',
    async execute(): Promise<string> {
      return 'charged';
    },
  };

  const deniedTool: AgentTool<void, string> = {
    name: 'db.drop',
    description: '删除数据库（生产一律禁止）',
    inputSchema: {},
    outputSchema: { type: 'string' },
    permission: 'dangerous',
    deniedInProduction: true,
    async execute(): Promise<string> {
      return 'dropped';
    },
  };

  it('redactSensitive 递归脱敏敏感字段', () => {
    const red = redactSensitive({
      url: 'https://x/api',
      token: 'abc123',
      headers: { authorization: 'Bearer xxx', 'content-type': 'json' },
      body: { userId: 1, password: 'secret', nested: { apiKey: 'k' } },
    });
    expect(red).toEqual({
      url: 'https://x/api',
      token: '***',
      headers: { authorization: '***', 'content-type': 'json' },
      body: { userId: 1, password: '***', nested: { apiKey: '***' } },
    });
  });

  it('生产环境 strict 拒绝 dangerous Tool（返回 ok=false 且不抛异常）', async () => {
    const reg = new ToolRegistry({ environment: 'prod' });
    reg.register(dangerousTool);
    const r = await reg.call('sys.exec', { cmd: 'rm -rf /' }, makeContext('prod'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('生产环境禁止');
  });

  it('生产环境 preonline 同样拒绝 dangerous Tool', async () => {
    const reg = new ToolRegistry({ environment: 'preonline' });
    reg.register(dangerousTool);
    const r = await reg.call('sys.exec', { cmd: 'x' }, makeContext('preonline'));
    expect(r.ok).toBe(false);
  });

  it('生产环境 risky 默认拒绝，但 read/safe 放行', async () => {
    const reg = new ToolRegistry({ environment: 'prod' });
    reg.register(riskyTool);
    reg.register(squareTool);
    const risky = await reg.call('billing.realCharge', undefined, makeContext('prod'));
    expect(risky.ok).toBe(false);
    const safe = await reg.call('square', 4, makeContext('prod'));
    expect(safe.ok).toBe(true);
  });

  it('生产环境 onApproval 通过时 risky 放行，拒绝时拦截', async () => {
    const reg = new ToolRegistry({ environment: 'prod', onApproval: (name) => name === 'billing.realCharge' });
    reg.register(riskyTool);
    const ok = await reg.call('billing.realCharge', undefined, makeContext('prod'));
    expect(ok.ok).toBe(true);
    expect(ok.data).toBe('charged');

    const reg2 = new ToolRegistry({ environment: 'prod', onApproval: () => false });
    reg2.register(riskyTool);
    const denied = await reg2.call('billing.realCharge', undefined, makeContext('prod'));
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('未获审批');
  });

  it('生产环境 deniedInProduction 显式禁止', async () => {
    const reg = new ToolRegistry({ environment: 'prod' });
    reg.register(deniedTool);
    const r = await reg.call('db.drop', undefined, makeContext('prod'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('生产环境禁止操作');
  });

  it('测试环境 dangerous Tool 放行（本地研发不受限）', async () => {
    const reg = new ToolRegistry({ environment: 'test' });
    reg.register(dangerousTool);
    const r = await reg.call('sys.exec', { cmd: 'echo hi' }, makeContext('test'));
    expect(r.ok).toBe(true);
  });

  it('permissive 策略仅告警放行 risky 操作', async () => {
    const reg = new ToolRegistry({ environment: 'prod', permissionPolicy: 'permissive' });
    reg.register(riskyTool);
    const r = await reg.call('billing.realCharge', undefined, makeContext('prod'));
    expect(r.ok).toBe(true);
  });

  it('被拦截的 Tool 同样写入审计（含 reason），且输入已脱敏', async () => {
    const audits: Array<{ name: string; input: unknown; reason?: string; ok: boolean }> = [];
    const reg = new ToolRegistry({ environment: 'prod', onAudit: (e) => audits.push(e) });
    reg.register(dangerousTool);
    const r = await reg.call('sys.exec', { cmd: 'rm', token: 'secret-token' }, makeContext('prod'));
    expect(r.ok).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBeDefined();
    expect((audits[0].input as { token: string }).token).toBe('***');
  });
});
