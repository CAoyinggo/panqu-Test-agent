import { describe, expect, it } from 'vitest';
import { ModelPolicyRegistry } from '../../src/cost/governance.js';
import { AgentRuntime } from '../../src/agents/core/agent-runtime.js';
import { PromptRegistry } from '../../src/agents/prompts/registry.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import type { LLMProvider, LLMRequest } from '../../src/llm/index.js';

describe('Phase 52 Model Cost / Quality Router', () => {
  it('简单任务选择低成本模型，关键 RCA 按策略选择强模型并解释原因', () => {
    const registry = new ModelPolicyRegistry();
    registry.set({ domain: 'RCA', primaryModel: 'strong', fallbackModel: 'cheap', maxCost: 5, maxLatencyMs: 1000, environment: 'PRODUCTION', status: 'ACTIVE' });
    const candidates = [{ model: 'cheap', quality: 90, cost: 1, latencyMs: 400 }, { model: 'strong', quality: 94, cost: 5, latencyMs: 800 }];
    expect(registry.route({ domain: 'Requirement', complexity: 'SIMPLE', candidates }).selectedModel).toBe('cheap');
    const rca = registry.route({ domain: 'RCA', complexity: 'CRITICAL', candidates });
    expect(rca.selectedModel).toBe('strong');
    expect(rca.trace.join(' ')).toContain('quality=94');
  });

  it('Model Policy → ModelRouter → AgentRuntime → LLM 使用同一个策略决策', async () => {
    const registry = new ModelPolicyRegistry();
    registry.set({
      domain: 'RCA', primaryModel: 'strong', fallbackModel: 'cheap',
      maxCost: 5, maxLatencyMs: 1000, environment: 'PRODUCTION', status: 'ACTIVE',
    });
    const decision = registry.route({
      domain: 'RCA',
      complexity: 'CRITICAL',
      candidates: [
        { model: 'cheap', quality: 90, cost: 1, latencyMs: 400 },
        { model: 'strong', quality: 94, cost: 5, latencyMs: 800 },
      ],
    });

    const router = new ModelRouter({
      routes: { rca: { model: 'unconfigured', timeoutMs: 500, temperature: 0 } },
    });
    const applied = router.applyPolicyDecision('rca', decision);
    expect(applied).toMatchObject({ model: 'strong', fallbackModel: 'cheap', timeoutMs: 500 });

    const calls: LLMRequest[] = [];
    const provider: LLMProvider = {
      name: 'model-policy-contract',
      async generate(request) {
        calls.push(request);
        return { content: '{"rootCause":"ok"}', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const runtime = new AgentRuntime({
      llm: provider,
      router,
      prompts: new PromptRegistry(),
      llmRetries: 0,
    });
    await runtime.generate({ task: 'rca', agent: 'root-cause', system: 'RCA', user: 'case failed' });

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(decision.selectedModel);
  });
});
