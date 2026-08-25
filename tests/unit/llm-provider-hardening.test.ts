// 验收测试：LLM Provider 硬化 —— Signal / Token / Retry
// 1. Signal：调用方 signal 真实到达最终 HTTP 请求（服务端观测到连接中断）；
//    且调用方传 signal 时 Provider 自身超时依然生效（旧 ?? 二选一 bug 的回归）
// 2. Token：LLM_MAX_TOKENS（env）→ LLMConfig → 请求体 max_tokens 真正生效；
//    请求级 maxTokens（ModelRouter/Runtime 注入）优先于配置默认
// 3. Retry：有限重试 + 指数退避 + full jitter + Retry-After + 错误分类
//    （429/5xx/超时/网络 → 重试；400 参数错误 / 401 鉴权失败 → 不重试）
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible.js';
import { loadLLMConfigFromEnv } from '../../src/llm/provider.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';
import {
  LLMError,
  classifyLLMError,
  isRetryable,
  parseRetryAfterMs,
  llmRetryDelayMs,
} from '../../src/llm/llm-errors.js';
import { AgentRuntime } from '../../src/agents/core/agent-runtime.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/llm/index.js';
import type { AgentTracer } from '../../src/agents/observability/tracer.js';

// ── 本地真实 HTTP 服务：记录请求体 / 可配置状态码与 Retry-After / 慢响应可被客户端中断 ──
interface MockLLMServer {
  url: string;
  close(): Promise<void>;
  state: {
    bodies: Array<Record<string, unknown>>;
    aborted: boolean; // 服务端观测到请求被客户端中断
  };
  respond(config: { status?: number; retryAfter?: string; delayMs?: number }): void;
}

async function startLLMServer(): Promise<MockLLMServer> {
  const state: MockLLMServer['state'] = { bodies: [], aborted: false };
  let cfg: { status?: number; retryAfter?: string; delayMs?: number } = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('close', () => {
      if (!res.writableEnded) state.aborted = true; // 响应前连接断开 = 客户端真实中止
    });
    req.on('end', () => {
      try { state.bodies.push(JSON.parse(raw)); } catch { state.bodies.push({ raw }); }
      if (cfg.delayMs) {
        setTimeout(() => respond(), cfg.delayMs);
        return;
      }
      respond();
      function respond() {
        const status = cfg.status ?? 200;
        if (status !== 200) {
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(cfg.retryAfter ? { 'retry-after': cfg.retryAfter } : {}),
          });
          res.end(JSON.stringify({ error: { message: `server error ${status}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    state,
    respond: (c) => { cfg = c; },
  };
}

const servers: MockLLMServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function provider(url: string, cfg: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}) {
  return new OpenAICompatibleProvider({ baseUrl: url, apiKey: 'test-key', model: 'm1', ...cfg });
}

describe('Signal：调用方 signal 真实到达 HTTP 请求', () => {
  it('调用方取消 → 服务端观测到连接中断（fetch 真实中止）', async () => {
    const s = await startLLMServer();
    servers.push(s);
    s.respond({ delayMs: 3_000 }); // 慢响应，只有取消能结束
    const p = provider(s.url, { timeoutMs: 60_000 }); // Provider 超时设长，排除其干扰
    const controller = new AbortController();
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 120);
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }))
      .rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000); // 不是等满 3s
    await new Promise((r) => setTimeout(r, 200));
    expect(s.state.aborted).toBe(true); // 服务端真实观测到中断
  }, 8_000);

  it('调用方传 signal 时 Provider 自身超时依然生效（旧 ?? 二选一 bug 回归）', async () => {
    const s = await startLLMServer();
    servers.push(s);
    s.respond({ delayMs: 5_000 });
    const p = provider(s.url, { timeoutMs: 150 }); // Provider 超时远小于服务端延迟
    const callerSignal = new AbortController().signal; // 调用方传了 signal 但从不 abort
    const t0 = Date.now();
    await expect(p.generate({ messages: [{ role: 'user', content: 'hi' }], signal: callerSignal }))
      .rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2_000); // Provider 超时触发（旧实现会等满 5s）
  }, 8_000);

  it('MockLLM：延迟/超时等待期间 signal 中止立即拒绝', async () => {
    const mock = new MockLLMProvider({ failureMode: { type: 'timeout', timeoutMs: 5_000 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const t0 = Date.now();
    await expect(mock.generate({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal }))
      .rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_500);
  }, 5_000);
});

describe('Token：LLM_MAX_TOKENS / --max-tokens 真正生效', () => {
  it('LLMConfig.maxTokens（env / CLI 来源）→ 请求体 max_tokens', async () => {
    const s = await startLLMServer();
    servers.push(s);
    // 模拟 LLM_MAX_TOKENS=888 经 loadLLMConfigFromEnv → LLMConfig
    const cfg = loadLLMConfigFromEnv({ LLM_MAX_TOKENS: '888' });
    expect(cfg.maxTokens).toBe(888);
    const p = new OpenAICompatibleProvider({ baseUrl: s.url, apiKey: 'k', model: 'm', maxTokens: cfg.maxTokens });
    await p.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(s.state.bodies[0].max_tokens).toBe(888); // 旧实现固定 2048
  });

  it('请求级 maxTokens（ModelRouter/Runtime 注入）优先于配置默认；未配置时回退默认', async () => {
    const s = await startLLMServer();
    servers.push(s);
    const p = provider(s.url, { maxTokens: 888, temperature: 0.7 });
    await p.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 555, temperature: 0 });
    expect(s.state.bodies[0].max_tokens).toBe(555);
    expect(s.state.bodies[0].temperature).toBe(0);
    // 未传请求级 → 配置默认
    await p.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(s.state.bodies[1].max_tokens).toBe(888);
    expect(s.state.bodies[1].temperature).toBe(0.7);
    // 均未配置 → 兜底 2048
    const p2 = provider(s.url);
    await p2.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(s.state.bodies[2].max_tokens).toBe(2048);
  });

  it('Runtime 全链路：Router 的 maxTokens 直达 HTTP 请求体', async () => {
    const s = await startLLMServer();
    servers.push(s);
    const router = new ModelRouter({
      tiers: { high: 'm-high', medium: 'm-med', small: 'm-small' },
      routes: { risk: { model: 'small', timeoutMs: 3_000, temperature: 0, maxTokens: 4321 } },
    });
    const runtime = new AgentRuntime({ llm: provider(s.url), router });
    await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' });
    expect(s.state.bodies[0].max_tokens).toBe(4321);
    expect(s.state.bodies[0].model).toBe('m-small');
  });
});

describe('Retry：分类 / 退避 / jitter / Retry-After', () => {
  it('错误分类：429/5xx/超时/网络 → 可重试；400/401 → 不重试', () => {
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'http', status: 429, message: 'x' })))).toBe(true);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'http', status: 503, message: 'x' })))).toBe(true);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'timeout', message: 'x' })))).toBe(true);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'network', message: 'fetch failed' })))).toBe(true);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'http', status: 400, message: 'bad param' })))).toBe(false);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'http', status: 401, message: 'unauthorized' })))).toBe(false);
    expect(isRetryable(classifyLLMError(new LLMError('x', { kind: 'http', status: 403, message: 'forbidden' })))).toBe(false);
  });

  it('Provider HTTP 错误携带结构化状态与 Retry-After（毫秒）', async () => {
    const s = await startLLMServer();
    servers.push(s);
    s.respond({ status: 429, retryAfter: '2' });
    const p = provider(s.url);
    try {
      await p.generate({ messages: [{ role: 'user', content: 'x' }] });
      expect.unreachable();
    } catch (e) {
      const f = classifyLLMError(e);
      expect(f.kind).toBe('http');
      expect(f.status).toBe(429);
      expect(f.retryAfterMs).toBe(2_000); // retry-after: 2（秒）→ 2000ms
      expect(isRetryable(f)).toBe(true);
    }
  });

  it('parseRetryAfterMs：秒数 / HTTP-date / 非法值', () => {
    expect(parseRetryAfterMs('2')).toBe(2_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThanOrEqual(4_000);
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it('llmRetryDelayMs：指数退避 + 封顶 + full jitter + Retry-After 优先（封顶）', () => {
    const policy = { baseMs: 100, maxDelayMs: 1_000, jitter: false };
    expect(llmRetryDelayMs({ kind: 'network', message: 'x' }, 0, policy)).toBe(100);
    expect(llmRetryDelayMs({ kind: 'network', message: 'x' }, 1, policy)).toBe(200);
    expect(llmRetryDelayMs({ kind: 'network', message: 'x' }, 2, policy)).toBe(400);
    expect(llmRetryDelayMs({ kind: 'network', message: 'x' }, 10, policy)).toBe(1_000); // 封顶
    // Retry-After 优先（200ms 覆盖退避）
    expect(llmRetryDelayMs({ kind: 'http', status: 429, message: 'x', retryAfterMs: 200 }, 0, policy)).toBe(200);
    // Retry-After 过大 → 封顶 retryAfterCapMs
    expect(llmRetryDelayMs({ kind: 'http', status: 429, message: 'x', retryAfterMs: 60_000 }, 0, { ...policy, retryAfterCapMs: 5_000, jitter: false })).toBe(5_000);
    // full jitter：延迟均匀落在 [0, exp]
    let maxSeen = 0;
    for (let i = 0; i < 200; i++) {
      const d = llmRetryDelayMs({ kind: 'network', message: 'x' }, 1, { ...policy, jitter: true }, () => 0.999) ?? 0;
      maxSeen = Math.max(maxSeen, d);
      expect(d).toBeLessThanOrEqual(200);
      expect(d).toBeGreaterThanOrEqual(0);
    }
    expect(maxSeen).toBeGreaterThan(150); // 随机上界确实生效
  });

  /** 脚本化失败序列的记录型 Provider */
  function scriptedLLM(script: Array<() => Promise<LLMResponse>>): { provider: LLMProvider; attempts: () => number } {
    let i = 0;
    return {
      provider: {
        name: 'scripted',
        async generate(): Promise<LLMResponse> {
          const step = script[Math.min(i, script.length - 1)];
          i++;
          return step();
        },
      },
      attempts: () => i,
    };
  }

  function retryRouter(): ModelRouter {
    return new ModelRouter({
      tiers: { high: 'h', medium: 'm', small: 's' },
      routes: { risk: { model: 's', timeoutMs: 3_000, temperature: 0 } },
    });
  }

  it('Runtime 重试：429（Retry-After）→ 按服务端建议等待后重试成功', async () => {
    const { provider: llm, attempts } = scriptedLLM([
      () => Promise.reject(new LLMError('HTTP 429', { kind: 'http', status: 429, message: 'x', retryAfterMs: 120 })),
      () => Promise.resolve({ content: '{"ok":true}', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]);
    const runtime = new AgentRuntime({
      llm, router: retryRouter(),
      llmRetries: 2, retryPolicy: { jitter: false, retryAfterCapMs: 5_000 },
    });
    const t0 = Date.now();
    const resp = await runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' });
    expect(resp.content).toBe('{"ok":true}');
    expect(attempts()).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100); // 尊重 Retry-After（120ms，jitter 关）
  });

  it('Runtime 重试：401 鉴权失败 → 立即抛出，不重试不换模型', async () => {
    const { provider: llm, attempts } = scriptedLLM([
      () => Promise.reject(new LLMError('HTTP 401', { kind: 'http', status: 401, message: 'unauthorized' })),
    ]);
    const runtime = new AgentRuntime({ llm, router: retryRouter(), llmRetries: 2, retryPolicy: { jitter: false } });
    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }))
      .rejects.toThrow(/401/);
    expect(attempts()).toBe(1);
  });

  it('Runtime 重试：400 参数错误 → 不重试；500 → 有限重试后耗尽抛出', async () => {
    const bad = scriptedLLM([
      () => Promise.reject(new LLMError('HTTP 400', { kind: 'http', status: 400, message: 'bad' })),
    ]);
    const rt1 = new AgentRuntime({ llm: bad.provider, router: retryRouter(), llmRetries: 2, retryPolicy: { jitter: false, baseMs: 1 } });
    await expect(rt1.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' })).rejects.toThrow(/400/);
    expect(bad.attempts()).toBe(1);

    const flaky = scriptedLLM([
      () => Promise.reject(new LLMError('HTTP 500', { kind: 'http', status: 500, message: 'boom' })),
    ]);
    const rt2 = new AgentRuntime({ llm: flaky.provider, router: retryRouter(), llmRetries: 2, retryPolicy: { jitter: false, baseMs: 1 } });
    await expect(rt2.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' })).rejects.toThrow(/500/);
    expect(flaky.attempts()).toBe(3); // 1 次原始 + 2 次重试（有限重试）
  });

  it('Runtime 重试：Tracer 记录每次重试', async () => {
    const tracer: AgentTracer = new (await import('../../src/agents/observability/tracer.js')).AgentTracer('t-retry');
    const { provider: llm, attempts } = scriptedLLM([
      () => Promise.reject(new LLMError('HTTP 503', { kind: 'http', status: 503, message: 'x' })),
      () => Promise.reject(new LLMError('HTTP 503', { kind: 'http', status: 503, message: 'x' })),
      () => Promise.resolve({ content: '{"ok":true}', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]);
    const runtime = new AgentRuntime({
      llm, router: retryRouter(), tracer,
      llmRetries: 2, retryPolicy: { jitter: false, baseMs: 1 },
    });
    await runtime.runStage({ agent: 'risk', stage: 'risk', essential: true }, () =>
      runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' }));
    expect(attempts()).toBe(3);
    const span = tracer.toTrace().spans.find((x) => x.stage === 'risk')!;
    expect(span.retryCount).toBe(2);
  });
});
