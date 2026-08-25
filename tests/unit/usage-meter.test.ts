// 验收测试：Budget 实时计费（LLM Decorator / Tool Decorator → UsageMeter → Budget Manager）
// 修复的旧模式：Agent 执行 → 流程结束 → importTrace 事后统计（超限不停任何东西）。
// 新语义验收：
//   1. LLM Call → token 实时扣减（调用发生即计入，无需等流程结束）
//   2. 执行前预留额度 → 并发在途调用合计不超支（预留失败立即拒绝）
//   3. 达到上限 → 立即 STOP：后续 LLM/Tool/阶段/用例全部 fail-fast，不再执行
//   4. Tool Call → 次数实时扣减 → 超限 STOP（Tool 不被调用）
//   5. maxCases / maxConcurrency（BudgetLimits）真正参与执行（此前是死配置）
import { describe, it, expect } from 'vitest';
import { UsageMeter, BudgetExceededError } from '../../src/agents/observability/usage-meter.js';
import { AgentBudget } from '../../src/agents/observability/budget.js';
import { AgentRuntime } from '../../src/agents/core/agent-runtime.js';
import { ToolRegistry } from '../../src/agents/tools/tool-registry.js';
import { runCasesWithEngine } from '../../src/agents/execution/execution-run-tool.js';
import { Engine, type RunTaskResult } from '../../src/core/engine.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/llm/index.js';
import { createAgentContext, NoopMemory } from '../../src/agents/index.js';
import { MockLLMProvider as MockLLM } from '../../src/llm/index.js';
import { PromptRegistry } from '../../src/agents/prompts/registry.js';
import type { AppConfig, TaskDef } from '../../src/core/types.js';
import type { LoadedCase } from '../../src/cases/loader.js';

/** 记录型 Provider */
function recordingProvider(script: Array<() => Promise<LLMResponse>> = []) {
  let i = 0;
  const calls: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'recording',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls.push(JSON.parse(JSON.stringify(request)) as LLMRequest);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return step();
    },
  };
  return { provider, calls, attempts: () => i };
}

const okResp = (inTok = 10, outTok = 5): LLMResponse => ({ content: '{"ok":true}', latencyMs: 1, usage: { inputTokens: inTok, outputTokens: outTok } });

/** 无回退模型的固定路由（单模型，预留语义确定） */
function singleModelRouter(maxTokens?: number): ModelRouter {
  return new ModelRouter({
    tiers: { high: 'm-high', medium: 'm-med', small: 'm-small' },
    routes: { risk: { model: 'small', timeoutMs: 2_000, temperature: 0, ...(maxTokens ? { maxTokens } : {}) } },
  });
}

describe('LLM Decorator：token 实时扣减 + 预留额度', () => {
  it('LLM Call → token/调用次数实时计入预算（不等流程结束）', async () => {
    const budget = new AgentBudget({ maxTokens: 10_000 });
    const { provider } = recordingProvider([() => Promise.resolve(okResp(100, 50))]);
    const runtime = new AgentRuntime({ llm: provider, router: singleModelRouter(), prompts: new PromptRegistry(), meter: new UsageMeter({ budget }) });

    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' });

    const s = budget.status(); // 调用刚结束即已扣减（旧模式此处为 0，流程末才 importTrace）
    expect(s.tokensUsed).toBe(150);
    expect(s.llmCalls).toBe(1);
    expect(s.exceededAny).toBe(false);
  });

  it('执行前预留额度：并发在途调用合计不超支（预留失败立即拒绝，不发起请求）', async () => {
    const budget = new AgentBudget({ maxTokens: 5_000 });
    const { provider, attempts } = recordingProvider([
      () => new Promise((r) => setTimeout(() => r(okResp(10, 5)), 80)), // 慢调用，制造在途窗口
      () => new Promise((r) => setTimeout(() => r(okResp(10, 5)), 80)),
    ]);
    const meter = new UsageMeter({ budget });
    const runtime = new AgentRuntime({ llm: provider, router: singleModelRouter(), meter });

    // 三路并发，每次预留 maxTokens=2000：前两路预留 4000 ≤ 5000，第三路 4000+2000 > 5000 → 立即拒绝
    const results = await Promise.allSettled([
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 2000 }),
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 2000 }),
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 2000 }),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('rejected');
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
    expect(attempts()).toBe(2); // 第三路被预留检查拒绝，未打 Provider
    // 结算后按实际用量：2 × 15 = 30（预留 4000 已释放）
    expect(budget.status().tokensUsed).toBe(30);
  });

  it('达到上限（maxLLMCalls）→ 立即 STOP：后续 LLM 调用 fail-fast，Provider 不再被调用', async () => {
    const budget = new AgentBudget({ maxLLMCalls: 1 });
    const { provider, attempts } = recordingProvider([() => Promise.resolve(okResp())]);
    const runtime = new AgentRuntime({ llm: provider, router: singleModelRouter(), meter: new UsageMeter({ budget }) });

    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }); // 用掉唯一额度
    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(attempts()).toBe(1); // STOP 生效：第二次没有打 Provider
  });

  it('达到上限（maxTokens）→ 结算即 STOP（本调用完成，后续拒绝）', async () => {
    const budget = new AgentBudget({ maxTokens: 20 });
    const { provider, attempts } = recordingProvider([
      () => Promise.resolve(okResp(10, 5)),  // 15，未到 20
      () => Promise.resolve(okResp(3, 2)),   // +5 = 20 → 达到上限
    ]);
    const runtime = new AgentRuntime({
      llm: provider,
      router: singleModelRouter(),
      prompts: new PromptRegistry(),
      meter: new UsageMeter({ budget }),
    });

    // maxTokens=4 + 最少 1 个输入 token：15 + 5 ≤ 20 允许第二次；结算 20/20 后 STOP
    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 4 });
    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 4 });
    expect(runtime['meter'].isStopped).toBe(true); // 第二次结算后立即 STOP
    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 4 }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(attempts()).toBe(2);
  });

  it('预算 STOP → 阶段内花费立即停止：LLM 调用 fail-fast（Provider 不被调用），阶段以预算错误失败', async () => {
    const budget = new AgentBudget({ maxLLMCalls: 0 });
    const meter = new UsageMeter({ budget });
    meter.stop(['maxLLMCalls']); // 模拟已超限
    const { provider, attempts } = recordingProvider([() => Promise.resolve(okResp())]);
    const runtime = new AgentRuntime({ llm: provider, router: singleModelRouter(), meter });

    const r = await runtime.runStage({ agent: 'risk', stage: 'risk', essential: true }, () =>
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }));
    expect(attempts()).toBe(0); // 花费立即停止：Provider 零调用
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('预算超限');
      expect(r.cause).toBeInstanceOf(BudgetExceededError);
    }
  });
});

describe('Tool Decorator：次数实时扣减 + 超限 STOP', () => {
  function makeCtx() {
    const tools = new ToolRegistry();
    return {
      tools,
      ctx: createAgentContext({ taskId: 't', feature: 'wan3', environment: 'test', tools, memory: new NoopMemory(), llm: new MockLLM() }),
    };
  }

  it('Tool Call → 次数实时计入；达到 maxToolCalls → 后续调用 fail-fast（Tool 不执行）', async () => {
    const budget = new AgentBudget({ maxToolCalls: 1 });
    const meter = new UsageMeter({ budget });
    const { tools, ctx } = makeCtx();
    tools.setMeter(meter);
    let execCount = 0;
    tools.register({
      name: 'demo.tool', description: 'd', inputSchema: {}, outputSchema: {},
      async execute() { execCount++; return 'ok'; },
    });

    const r1 = await tools.call('demo.tool', {}, ctx);
    expect(r1.ok).toBe(true);
    expect(budget.status().toolCalls).toBe(1); // 实时扣减

    const r2 = await tools.call('demo.tool', {}, ctx);
    expect(r2.ok).toBe(false); // 超限 STOP
    expect(r2.error).toContain('预算超限');
    expect(execCount).toBe(1); // 第二次 Tool 未执行
  });
});

// ── Runner：budget.maxCases / maxConcurrency 真正参与执行 ──

const CFG = {
  default_env: 'test',
  environments: { test: { base_url: 'http://127.0.0.1:1', billing_url: 'http://127.0.0.1:1/b', detail_url: 'http://127.0.0.1:1/d', project_id: 1 } },
} as unknown as AppConfig;

function caseOf(id: string): LoadedCase {
  return {
    name: id, feature: 'wan3', file: '<test>',
    def: { name: id, scene: 'video', model_id: 'm', expected_points: 0, extra: { agentTestCaseId: id } } as TaskDef,
  };
}

/** Stub 引擎：记录并发峰值与执行顺序 */
function stubEngine(controls: { active: number; maxActive: number; sequence: string[] }) {
  class StubEngine extends Engine {
    override async runTask(...args: Parameters<Engine['runTask']>): Promise<RunTaskResult> {
      const id = String(args[1].extra?.agentTestCaseId ?? args[1].name);
      controls.sequence.push(id);
      controls.active++;
      controls.maxActive = Math.max(controls.maxActive, controls.active);
      await new Promise((r) => setTimeout(r, 50));
      controls.active--;
      return { files: [], passRate: 100, hasBlockingIssue: false, executed: true, status: 'PASS', checks: [] };
    }
  }
  return new StubEngine();
}

describe('Runner：maxCases / maxConcurrency（预算）真正参与执行', () => {
  it('budget.maxCases=2 → 只执行 2 条，剩余 NOT_EXECUTED（maxCases 预算截断），实时计数', async () => {
    const budget = new AgentBudget({ maxCases: 2 });
    const meter = new UsageMeter({ budget });
    const controls = { active: 0, maxActive: 0, sequence: [] as string[] };
    const cases = ['tc-1', 'tc-2', 'tc-3', 'tc-4'].map(caseOf);

    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, cases, { env: 'test', meter });

    expect(controls.sequence).toEqual(['tc-1', 'tc-2']); // 预算截断
    expect(budget.status().casesUsed).toBe(2); // 实时计数
    const dropped = outcome.results.filter((r) => r.status === 'NOT_EXECUTED');
    expect(dropped).toHaveLength(2);
    // 达到 maxCases 上限后 STOP：剩余用例均明确标注预算原因，不再调度
    expect(dropped.every((r) => r.error?.includes('maxCases'))).toBe(true);
    expect(dropped.every((r) => r.error?.includes('预算'))).toBe(true);
    expect(outcome.total).toBe(4); // 截断用例计入结果
  });

  it('budget.maxConcurrency=2（options.concurrency=8）→ 在途峰值 ≤ 2', async () => {
    const budget = new AgentBudget({ maxConcurrency: 2 });
    const meter = new UsageMeter({ budget });
    const controls = { active: 0, maxActive: 0, sequence: [] as string[] };
    const cases = Array.from({ length: 6 }, (_, i) => caseOf(`tc-${i}`));

    await runCasesWithEngine(stubEngine(controls), CFG, cases, { env: 'test', concurrency: 8, meter });

    expect(controls.maxActive).toBeLessThanOrEqual(2); // 预算并发钳制真实生效
    expect(controls.maxActive).toBeGreaterThan(1);
  });

  it('实时预算 STOP（LLM 超限）→ 剩余用例停止调度', async () => {
    const budget = new AgentBudget({ maxLLMCalls: 0 }); // 已超限
    const meter = new UsageMeter({ budget });
    meter.stop(['maxLLMCalls']);
    const controls = { active: 0, maxActive: 0, sequence: [] as string[] };
    const cases = ['tc-1', 'tc-2'].map(caseOf);

    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, cases, { env: 'test', meter });

    expect(controls.sequence).toEqual([]); // 全部停止调度
    expect(outcome.results.every((r) => r.status === 'NOT_EXECUTED' && r.error?.includes('预算超限'))).toBe(true);
  });
});
