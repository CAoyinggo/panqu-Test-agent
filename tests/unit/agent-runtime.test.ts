// 验收测试：统一执行链路（Pipeline / Orchestrator → Agent → PromptRegistry → ModelRouter →
// LLM Provider → Tracer / Budget / Retry）。
// 治理目标：不再存在「A 链路用 ModelRouter / B 链路直连 LLM / C 链路自写 Prompt / D 链路自实现 Retry」。
// 验证：
//   1. Agent LLM 调用唯一入口 runtime.generate：请求自动携带 Router 的 model/temperature/maxTokens
//   2. PromptRegistry 注册版本覆盖 Agent 内置提示词（提示词治理单点）
//   3. Retry：可重试错误（5xx/429/超时）按策略重试 / 换回退模型；不可重试（401）直接暴露
//   4. 超时：AbortSignal 真实传给 Provider（不是放弃等待）
//   5. Tracer / Budget：LLM 调用、重试、回退、token 全部记录
//   6. runStage：essential 语义 + 预算跳过 + 超时中止（Orchestrator 与 Pipeline 共用机制）
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRuntime } from '../../src/agents/core/agent-runtime.js';
import { PromptRegistry } from '../../src/agents/prompts/registry.js';
import { registerBuiltinPrompts } from '../../src/agents/prompts/builtin.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { AgentTracer } from '../../src/agents/observability/tracer.js';
import { AgentBudget } from '../../src/agents/observability/budget.js';
import { RiskAgent, RISK_SYSTEM_PROMPT } from '../../src/agents/index.js';
import { createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { LLMError, MockLLMProvider } from '../../src/llm/index.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import { ExecutionAbortError } from '../../src/core/abort.js';

/** 记录型 Provider：可脚本化失败序列 / 挂起等待信号 */
function recordingProvider(script: Array<(req: LLMRequest, signal?: AbortSignal) => Promise<LLMResponse>> = []) {
  const calls: LLMRequest[] = [];
  const seenSignals: Array<AbortSignal | undefined> = [];
  let i = 0;
  const provider: LLMProvider = {
    name: 'recording',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      calls.push(JSON.parse(JSON.stringify(request)) as LLMRequest);
      seenSignals.push(request.signal);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return step(request);
    },
  };
  return { provider, calls, seenSignals, attempts: () => i };
}

const ok = (content = '{"ok":true}'): LLMResponse => ({ content, latencyMs: 5, usage: { inputTokens: 10, outputTokens: 5 } });
const httpError = (status: number): Promise<LLMResponse> => Promise.reject(
  new LLMError(`LLM 请求失败（HTTP ${status}）：err`, {
    kind: 'http',
    status,
    message: `HTTP ${status}`,
  }),
);

/** 小型固定路由 Router（脱离全局单例，测试确定性） */
function fixedRouter(): ModelRouter {
  return new ModelRouter({
    tiers: { high: 'model-high', medium: 'model-medium', small: 'model-small' },
    routes: {
      risk: { model: 'small', fallbackModel: 'medium', timeoutMs: 500, temperature: 0 },
      requirement: { model: 'high', timeoutMs: 500, temperature: 0, maxTokens: 2000 },
    },
  });
}

describe('AgentRuntime.generate：LLM 调用唯一链路', () => {
  it('请求自动携带 ModelRouter 的 model/temperature + PromptRegistry 的提示词（覆盖内置）', async () => {
    const { provider, calls } = recordingProvider([() => Promise.resolve(ok())]);
    const prompts = new PromptRegistry();
    registerBuiltinPrompts(prompts);
    // 注册 v2 覆盖内置 risk.v1（提示词治理：Registry 优先于 Agent 内置常量）
    prompts.register({
      key: 'risk.v2', name: 'risk', version: 'v2', purpose: '测试覆盖',
      inputSchema: {}, outputSchema: {}, system: 'RISK-V2-SYSTEM-PROMPT', temperature: 0.1,
    });
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts });

    await runtime.generate({ task: 'risk', agent: 'risk', system: 'AGENT-INLINE-FALLBACK', user: 'u', jsonMode: true });

    expect(calls).toHaveLength(1);
    // 模型来自 Router（small 档 → model-small）
    expect(calls[0].model).toBe('model-small');
    // 提示词来自 Registry v2（非 Agent 内置回退）
    expect(calls[0].messages[0].content).toBe('RISK-V2-SYSTEM-PROMPT');
    // 温度：Prompt 定义（0.1）> Router（0）
    expect(calls[0].temperature).toBe(0.1);
    expect(calls[0].jsonMode).toBe(true);
  });

  it('未注册提示词时回退 Agent 内置 system；未指定温度时用 Router 路由温度', async () => {
    const { provider, calls } = recordingProvider([() => Promise.resolve(ok())]);
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts: new PromptRegistry() });
    await runtime.generate({ task: 'requirement', agent: 'requirement', system: 'INLINE', user: 'u' });
    expect(calls[0].messages[0].content).toBe('INLINE');
    expect(calls[0].model).toBe('model-high');
    expect(calls[0].temperature).toBe(0); // 路由温度
    expect(calls[0].maxTokens).toBe(2000); // 路由 maxTokens
  });

  it('Orchestrator fork Runtime 时保留注入的 Model Policy 与 Prompt Policy', async () => {
    const { provider, calls } = recordingProvider([() => Promise.resolve(ok())]);
    const prompts = new PromptRegistry();
    prompts.register({
      key: 'risk.v9', name: 'risk', version: 'v9', purpose: 'fork-policy',
      inputSchema: {}, outputSchema: {}, system: 'FORK-PROMPT', temperature: 0.2,
    });
    const base = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts });
    const runtime = base.fork({});

    await runtime.generate({ task: 'risk', agent: 'risk', system: 'fallback', user: 'u' });
    expect(calls[0]).toMatchObject({ model: 'model-small', temperature: 0.2 });
    expect(calls[0].messages[0].content).toBe('FORK-PROMPT');
    expect(runtime.policySnapshot(['risk']).prompts[0]).toMatchObject({ key: 'risk.v9', version: 'v9' });
  });

  it('Retry：可重试错误（HTTP 500）重试后成功，Tracer 记录 retry + LLM 调用', async () => {
    const tracer = new AgentTracer('t-runtime');
    const { provider, attempts } = recordingProvider([
      () => httpError(500),
      () => Promise.resolve(ok()),
    ]);
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts: new PromptRegistry(), tracer, llmRetries: 1, retryBackoffMs: 1 });

    // LLM 调用发生在阶段 span 内（真实链路：Agent 在 runStage 中调用 runtime.generate）
    const r = await runtime.runStage({ agent: 'risk', stage: 'risk', essential: true }, () =>
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }));
    expect(r.ok).toBe(true);
    expect(attempts()).toBe(2); // 失败一次 + 重试一次
    const span = tracer.toTrace().spans.find((s) => s.stage === 'risk')!;
    expect(span.llmCalls).toBe(1); // 成功 LLM 调用记录到 span
    expect(span.retryCount).toBe(1); // 重试记录
    expect(span.inputTokens).toBe(10);
    expect(span.outputTokens).toBe(5);
  });

  it('Fallback：主模型链重试耗尽后切换 fallbackModel（请求 model 变化），Tracer 记录 fallback', async () => {
    const tracer = new AgentTracer('t-runtime');
    const { provider, calls } = recordingProvider([
      () => httpError(429), // 主模型第 1 次失败（可重试）
      () => httpError(429), // 主模型重试失败（llmRetries=1 耗尽）
      () => Promise.resolve(ok()), // 回退模型成功
    ]);
    const runtime = new AgentRuntime({
      llm: provider, router: fixedRouter(), prompts: new PromptRegistry(), tracer,
      llmRetries: 1, retryPolicy: { jitter: false, baseMs: 1 },
    });

    const r = await runtime.runStage({ agent: 'risk', stage: 'risk', essential: true }, () =>
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }));
    expect(r.ok).toBe(true);
    // 主模型 ×2（含重试）→ 回退模型 ×1：真实切换了模型
    expect(calls.map((c) => c.model)).toEqual(['model-small', 'model-small', 'model-medium']);
    const span = tracer.toTrace().spans.find((s) => s.stage === 'risk')!;
    expect(span.fallbackCount).toBe(1); // 模型回退记录
    expect(span.status).toBe('fallback');
  });

  it('不可重试错误（HTTP 401）直接暴露，不重试不换模型', async () => {
    const { provider, attempts } = recordingProvider([() => httpError(401)]);
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts: new PromptRegistry(), llmRetries: 1, retryBackoffMs: 1 });

    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }))
      .rejects.toThrow(/HTTP 401/);
    expect(attempts()).toBe(1); // 立即失败
  });

  it('Context overflow：Provider 调用前以结构化 REQUEST_TOO_LARGE fail-fast', async () => {
    const { provider, attempts } = recordingProvider([() => Promise.resolve(ok())]);
    const router = fixedRouter();
    router.configure('risk', { maxInputTokens: 10 });
    const runtime = new AgentRuntime({ llm: provider, router, prompts: new PromptRegistry() });

    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 'system', user: 'x'.repeat(100) }))
      .rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(attempts()).toBe(0);
  });

  it('超时：AbortSignal 真实传给 Provider（Provider 观测到中止），错误为 TIMEOUT', async () => {
    const { provider, seenSignals } = recordingProvider([
      (_req, signal) => new Promise<LLMResponse>((resolve, reject) => {
        const t = setTimeout(() => resolve(ok()), 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new ExecutionAbortError('TIMEOUT', 'provider aborted'));
        }, { once: true });
      }),
    ]);
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts: new PromptRegistry(), llmRetries: 0 });
    const t0 = Date.now();
    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }))
      .rejects.toThrow(/超时/);
    expect(Date.now() - t0).toBeLessThan(3_000); // 路由 timeout 500ms，而非 Provider 的 10s
    expect(seenSignals[0]?.aborted).toBe(true); // 信号真实送达（可中止底层 fetch）
  }, 8_000);

  it('Budget：LLM token 用量实时计入预算（调用发生即扣减，不等流程结束）', async () => {
    const budget = new AgentBudget({ maxTokens: 5_000 });
    const { provider } = recordingProvider([() => Promise.resolve(ok())]); // 10+5=15 tokens
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts: new PromptRegistry(), budget });
    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' });
    // 调用刚结束即已扣减（旧模式此处为 0，流程末 importTrace 才统计）
    expect(budget.status().tokensUsed).toBe(15);
    expect(budget.status().llmCalls).toBe(1);
  });
});

describe('AgentRuntime.runStage：阶段执行（Pipeline/Orchestrator 共用机制）', () => {
  it('essential 阶段失败 → 保留原始错误对象向上抛', async () => {
    const runtime = new AgentRuntime({ llm: new MockLLMProvider() });
    const r = await runtime.runStage({ agent: 'a', stage: 's', essential: true }, async () => {
      throw new Error('业务失败');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('业务失败');
      expect((r.cause as Error).message).toBe('业务失败');
    }
  });

  it('预算超限 → 非关键阶段跳过（ok=false 且 error 含预算），关键阶段继续执行', async () => {
    const budget = new AgentBudget({ maxAgentCalls: 0 }); // 已超限
    const runtime = new AgentRuntime({ llm: new MockLLMProvider(), budget });
    const skipped = await runtime.runStage({ agent: 'a', stage: 'enhanced', essential: false }, async () => 'ran');
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.error).toContain('预算超限');
    const critical = await runtime.runStage({ agent: 'a', stage: 'core', essential: true }, async () => 'ran-anyway');
    expect(critical).toEqual({ ok: true, value: 'ran-anyway' });
  });

  it('阶段超时 → fn 收到中止信号，结果失败（真 abort 而非仅放弃等待）', async () => {
    const runtime = new AgentRuntime({ llm: new MockLLMProvider() });
    let signalSeen: AbortSignal | undefined;
    const r = await runtime.runStage(
      { agent: 'a', stage: 'slow', essential: true, timeoutMs: 100 },
      (signal) => {
        signalSeen = signal;
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('done'), 5_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('被中止'));
          }, { once: true });
        });
      },
    );
    expect(r.ok).toBe(false);
    expect(signalSeen?.aborted).toBe(true); // 信号真实送达阶段函数
  }, 5_000);

  it('Tracer span：成功/失败均记录（startSpan → endSpan）', async () => {
    const tracer = new AgentTracer('t-stage');
    const runtime = new AgentRuntime({ llm: new MockLLMProvider(), tracer });
    await runtime.runStage({ agent: 'risk', stage: 'risk', essential: true }, async () => 42);
    await runtime.runStage({ agent: 'data', stage: 'data', essential: false }, async () => { throw new Error('x'); });
    const spans = tracer.toTrace().spans;
    expect(spans.find((s) => s.stage === 'risk')?.status).toBe('ok');
    expect(spans.find((s) => s.stage === 'data')?.status).toBe('error');
  });
});

describe('Agent 接入验证：RiskAgent 经 runtime 走完整链路', () => {
  it('Agent LLM 请求带 Router 模型 + Registry 内置提示词（不再直连 llm Provider）', async () => {
    const { provider, calls } = recordingProvider([
      () => Promise.resolve(ok(JSON.stringify({
        feature: 'wan3', risks: [], summary: { total: 0, high: 0, medium: 0, low: 0, overall: 'low' },
      }))),
    ]);
    const prompts = new PromptRegistry();
    registerBuiltinPrompts(prompts); // 内置 risk.v1 → 与 RISK_SYSTEM_PROMPT 一致
    const runtime = new AgentRuntime({ llm: provider, router: fixedRouter(), prompts });
    const tools = new ToolRegistry();
    const context: AgentContext = createAgentContext({
      taskId: 't-risk', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm: provider, runtime,
    });

    const agent = new RiskAgent();
    const req = {
      requirement: { feature: 'wan3', goal: 'g', capabilities: ['text-to-video'], requirements: [], businessRules: [], dependencies: [], constraints: [], risks: [] },
      testCases: [],
      environment: 'test',
    } as never;
    await agent.execute(req, context);

    expect(calls).toHaveLength(1);
    // PromptRegistry 命中内置版本（内容 = Agent 内置常量，治理单点已收敛）
    expect(calls[0].messages[0].content).toBe(RISK_SYSTEM_PROMPT);
    expect(calls[0].messages[0].content).toBe(prompts.getVersion('risk')?.system);
    // ModelRouter 生效
    expect(calls[0].model).toBe('model-small');
  });
});
