// 验收测试：真正的 dryRun / timeout / cancellation（执行层基础设施）
// 核心验收标准：测试执行超时后，底层任务也必须真正停止，而不是只让上层「以为」它停止了。
// 覆盖：
//   1. HTTP 层：超时触发 AbortSignal，服务端真实观测到连接中断（socket 销毁）
//   2. Pipeline：超时中止 → 状态 TIMEOUT；中止后不再产生业务写入或扣费（端点 0 命中）
//   3. 外部取消 → 状态 CANCELLED
//   4. Tool Registry：超时/取消向 Tool 传递 AbortSignal，终态标 TIMEOUT / CANCELLED
//   5. dryRun 零副作用（不触 runner / 引擎 / 配置）
//   6. concurrency 真实限制并发（p-limit 硬顶在途数）
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Http } from '../../src/integrations/http.js';
import { Pipeline } from '../../src/core/pipeline.js';
import type { PipelineResult } from '../../src/core/pipeline.js';
import type { AppConfig, TaskDef, Session } from '../../src/core/types.js';
import type { SceneHandler, } from '../../src/core/scene-handler.js';
import { ExecutionAbortError, abortReasonOf } from '../../src/core/abort.js';
import { evaluateCoreExecution } from '../../src/core/execution-status.js';
import { ToolRegistry } from '../../src/agents/tools/tool-registry.js';
import type { AgentTool } from '../../src/agents/tools/tool.js';
import { ExecutionRunTool, runCasesWithEngine, realEngineRunner } from '../../src/agents/execution/execution-run-tool.js';
import { Engine, type RunTaskResult } from '../../src/core/engine.js';
import type { LoadedCase } from '../../src/cases/loader.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import { createAgentContext, NoopMemory, ToolRegistry as Registry } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';

// ── 本地真实 HTTP 服务：/slow 挂 3s；/write 与 /billing-charge 记录副作用 ──
interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
  state: {
    writeHits: number;
    billingReadHits: number;
    billingChargeHits: number;
    slowStarted: number;
    slowAborted: boolean; // 服务端真实观测到 /slow 连接被客户端中断
    totalHits: number;
  };
}

async function startTestServer(): Promise<TestServer> {
  const state: TestServer['state'] = {
    writeHits: 0, billingReadHits: 0, billingChargeHits: 0,
    slowStarted: 0, slowAborted: false, totalHits: 0,
  };
  const server = http.createServer((req, res) => {
    state.totalHits++;
    // 注意：Http 客户端拼接 baseUrl + path 会产生 //slow 形式，用 includes 匹配
    if (req.url?.includes('slow')) {
      state.slowStarted++;
      let responded = false;
      // 客户端 abort → 服务端请求流被销毁（真实停止的证据）
      req.on('close', () => {
        if (!responded) state.slowAborted = true;
      });
      setTimeout(() => {
        responded = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 1, data: { ok: true } }));
      }, 3000);
      return;
    }
    if (req.url?.includes('write')) {
      state.writeHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 1 }));
      return;
    }
    if (req.url?.includes('billing-charge')) {
      state.billingChargeHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 1 }));
      return;
    }
    if (req.url?.includes('billing')) {
      state.billingReadHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 1, data: { cost: 1 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 1, data: { pong: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function makeCfg(base: string): AppConfig {
  return {
    default_env: 'test',
    environments: {
      test: { base_url: base, billing_url: `${base}/billing`, detail_url: `${base}/detail`, project_id: 1 },
    },
  } as unknown as AppConfig;
}

function makeSession(): Session {
  return { env: 'test', cookie_string: 'sid=1', token_exp: Math.floor(Date.now() / 1000) + 3600, project_id: 1, account: 'tester' };
}

/** 场景处理器：submit 挂在 /slow（可中止），detail 向 /write 写业务数据 */
function makeHandler(): SceneHandler {
  return {
    name: 'abort-test',
    supportedScenes: ['video'],
    supports: (scene) => scene === 'video',
    async submit(ctx) {
      await ctx.http.api('提交', 'POST', '/slow', { timeout: 10_000, retryable: false });
      // 若超时/取消，这里不应被执行；执行到此处说明中止未生效
      await ctx.http.api('业务写', 'POST', '/write', { retryable: false });
      await ctx.http.api('真实扣费', 'POST', '/billing-charge', { retryable: false });
      return { taskId: 1001, submit: { status: '成功' } };
    },
    async detail(ctx) {
      await ctx.http.api('业务写-detail', 'POST', '/write', { retryable: false });
      ctx.submit.detail = { ok: true };
    },
    async status(ctx) {
      ctx.submit.status = '成功';
    },
    analyzeBilling(data) {
      return data;
    },
  };
}

function makeTaskDef(): TaskDef {
  return { name: 'abort-acceptance', scene: 'video', model_id: 'm-1', expected_points: 0, extra: {} } as TaskDef;
}

describe('HTTP 层：超时真实中止底层请求', () => {
  it('请求超时 → 客户端快速失败，且服务端观测到连接中断（底层真正停止）', async () => {
    const s = await startTestServer();
    servers.push(s);
    const http_ = new Http(s.url, 'sid=1');
    const t0 = Date.now();
    await expect(http_.api('慢请求', 'GET', '/slow?x=1', { timeout: 150, retryable: false }))
      .rejects.toThrow(/超时/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000); // 不是等满服务端 3s
    // 服务端在响应前观测到请求流关闭 = fetch 被真实 abort（socket 断开），而非仅客户端放弃等待
    await new Promise((r) => setTimeout(r, 300));
    expect(s.state.slowAborted).toBe(true);
  });

  it('外部取消（CANCELLED）→ 立即失败且不重试', async () => {
    const s = await startTestServer();
    servers.push(s);
    const controller = new AbortController();
    const http_ = new Http(s.url, 'sid=1', controller.signal);
    const pending = http_.api('慢请求', 'GET', '/slow?y=1', { timeout: 10_000, retries: 3 });
    setTimeout(() => controller.abort(new ExecutionAbortError('CANCELLED', '外部取消')), 120);
    await expect(pending).rejects.toSatisfy((e: unknown) => abortReasonOf(e) === 'CANCELLED');
    const hitsAfterCancel = s.state.slowStarted;
    await new Promise((r) => setTimeout(r, 500));
    // 取消后不再有新请求（不重试）
    expect(s.state.slowStarted).toBe(hitsAfterCancel);
  });
});

describe('Pipeline：超时/取消贯穿（状态明确 + 无超时后业务写入/扣费）', () => {
  it('用例超时（TIMEOUT 信号）→ 状态 TIMEOUT，底层连接中断，/write 与 /billing-charge 零命中', async () => {
    const s = await startTestServer();
    servers.push(s);
    const controller = new AbortController();
    // 模拟 Engine 的用例级超时：150ms 后以 TIMEOUT 原因中止
    setTimeout(() => controller.abort(new ExecutionAbortError('TIMEOUT', '用例超时（0.15s）：abort-acceptance')), 150);

    const pipeline = new Pipeline({
      cfg: makeCfg(s.url),
      session: makeSession(),
      taskDef: makeTaskDef(),
      handler: makeHandler(),
      func: 'abort-test',
      signal: controller.signal,
    });
    const result: PipelineResult = await pipeline.run();

    // 终态明确为 TIMEOUT（fail-closed：不 PASS / 不 FAIL / 不 BLOCKED）
    expect(result.status).toBe('TIMEOUT');
    expect(result.executed).toBe(false);
    expect(result.passRate).toBe(0);
    expect(result.issues.some((i) => i.title === 'TIMEOUT')).toBe(true);

    // 底层真正停止：服务端观测到 /slow 连接中断
    await new Promise((r) => setTimeout(r, 300));
    expect(s.state.slowAborted).toBe(true);

    // 提交前允许读取一次计费基线，但中止后不得产生业务写入、真实扣费或后续计费查询。
    expect(s.state.writeHits).toBe(0);
    expect(s.state.billingChargeHits).toBe(0);
    expect(s.state.billingReadHits).toBe(1);
    const hits = s.state.totalHits;
    const billingReads = s.state.billingReadHits;
    await new Promise((r) => setTimeout(r, 600));
    expect(s.state.totalHits).toBe(hits);
    expect(s.state.writeHits).toBe(0);
    expect(s.state.billingChargeHits).toBe(0);
    expect(s.state.billingReadHits).toBe(billingReads);
  }, 10_000);

  it('外部取消（CANCELLED 信号）→ 状态 CANCELLED', async () => {
    const s = await startTestServer();
    servers.push(s);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new ExecutionAbortError('CANCELLED', '编排层取消')), 120);

    const pipeline = new Pipeline({
      cfg: makeCfg(s.url),
      session: makeSession(),
      taskDef: makeTaskDef(),
      handler: makeHandler(),
      func: 'abort-test',
      signal: controller.signal,
    });
    const result = await pipeline.run();
    expect(result.status).toBe('CANCELLED');
    expect(result.executed).toBe(false);
    expect(s.state.writeHits).toBe(0);
    expect(s.state.billingChargeHits).toBe(0);
    expect(s.state.billingReadHits).toBe(1);
  }, 10_000);

  it('evaluateCoreExecution：中止错误直接判 TIMEOUT/CANCELLED（fail-closed，优先于其它判定）', () => {
    const timeout = evaluateCoreExecution({
      hasProcessor: true,
      processorInvoked: true,
      error: new ExecutionAbortError('TIMEOUT', 'x'),
      checks: [{ name: 'c', pass: true, detail: '', level: 'P0' }],
    });
    expect(timeout).toMatchObject({ status: 'TIMEOUT', executed: false, passRate: 0 });

    const cancelled = evaluateCoreExecution({ hasProcessor: true, processorInvoked: true, error: new ExecutionAbortError('CANCELLED', 'x'), checks: [] });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', executed: false });
  });
});

describe('Tool Registry：超时/取消传递 AbortSignal，终态明确', () => {
  function makeContext(): AgentContext {
    const tools = new Registry();
    return createAgentContext({
      taskId: 't-abort', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm: new MockLLMProvider(),
    });
  }

  it('Tool 超时 → status=TIMEOUT，且 signal 已传递给 Tool 并被 abort', async () => {
    const registry = new ToolRegistry({ defaultTimeoutMs: 100 });
    let captured: AbortSignal | undefined;
    const tool: AgentTool = {
      name: 'slow.tool',
      description: '慢工具',
      inputSchema: {}, outputSchema: {},
      async execute(_i, _c, signal) {
        captured = signal;
        await new Promise((r) => setTimeout(r, 5000)); // 故意不返回
        return 'never';
      },
    };
    registry.register(tool);
    const t0 = Date.now();
    const result = await registry.call('slow.tool', {}, makeContext());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('TIMEOUT');
    expect(result.error).toContain('TIMEOUT');
    // 信号已送达 Tool：真实中止的钩子已触发（Tool 内部可将其贯穿到 Engine/HTTP）
    expect(captured?.aborted).toBe(true);
  });

  it('外部取消 → status=CANCELLED，signal 级联', async () => {
    const registry = new ToolRegistry({ defaultTimeoutMs: 10_000 });
    let captured: AbortSignal | undefined;
    const tool: AgentTool = {
      name: 'cancellable.tool',
      description: '可取消',
      inputSchema: {}, outputSchema: {},
      async execute(_i, _c, signal) {
        captured = signal;
        await new Promise((r) => setTimeout(r, 5000));
        return 'never';
      },
    };
    registry.register(tool);
    const external = new AbortController();
    const pending = registry.call('cancellable.tool', {}, makeContext(), { signal: external.signal });
    setTimeout(() => external.abort(new ExecutionAbortError('CANCELLED', '上游取消')), 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('CANCELLED');
    expect(captured?.aborted).toBe(true);
  });
});

describe('dryRun：真正零副作用', () => {
  function makeCtx(): AgentContext {
    return createAgentContext({
      taskId: 't-dry', feature: 'wan3', environment: 'test',
      tools: new Registry(), memory: new NoopMemory(), llm: new MockLLMProvider(),
    });
  }

  const cases: LoadedCase[] = [
    { name: 'dry-1', feature: 'wan3', file: 'x.ts', def: { name: 'dry-1', scene: 'video', model_id: 'm', expected_points: 0, extra: {} } as TaskDef },
  ];

  it('ExecutionRunTool dryRun → runner 不被调用', async () => {
    let called = 0;
    const tool = new ExecutionRunTool(async () => {
      called++;
      throw new Error('dry-run 下 runner 不应被调用');
    });
    const outcome = await tool.execute({ cases, options: { dryRun: true } }, makeCtx());
    expect(called).toBe(0);
    expect(outcome.executed).toBe(false);
    expect(outcome.results.every((r) => r.status === 'NOT_EXECUTED')).toBe(true);
  });

  it('realEngineRunner dryRun → 不加载配置/引擎，全部 NOT_EXECUTED（env 无效也不报配置错误）', async () => {
    const outcome = await realEngineRunner(cases, { dryRun: true, env: 'no-such-env' });
    expect(outcome.executed).toBe(false);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].status).toBe('NOT_EXECUTED');
    expect(outcome.summary).toContain('零副作用');
  });
});

describe('concurrency：真实限制并发', () => {
  const cases: LoadedCase[] = Array.from({ length: 6 }, (_, i) => ({
    name: `conc-${i}`,
    feature: 'wan3',
    file: 'x.ts',
    def: { name: `conc-${i}`, scene: 'video', model_id: 'm', expected_points: 0, extra: {} } as TaskDef,
  }));

  it('concurrency=2 → 在途用例数硬顶 ≤2，全部完成', async () => {
    let active = 0;
    let maxActive = 0;
    const seenCaseIds: Array<string | undefined> = [];
    class StubEngine extends Engine {
      override async runTask(...args: Parameters<Engine['runTask']>): Promise<RunTaskResult> {
        active++;
        maxActive = Math.max(maxActive, active);
        seenCaseIds.push(args[6]);
        await new Promise((r) => setTimeout(r, 80));
        active--;
        return {
          files: [], passRate: 100, hasBlockingIssue: false,
          executed: true, status: 'PASS', processor: 'stub-video-processor', processorInvoked: true,
          checks: [{ name: 'business-outcome', pass: true, detail: 'controlled assertion passed', kind: 'BUSINESS' }],
        };
      }
    }
    const cfg = makeCfg('http://127.0.0.1:1'); // stub engine 不发请求
    const outcome = await runCasesWithEngine(new StubEngine(), cfg, cases, { env: 'test', concurrency: 2, func: 'wan3' });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // 确实并行了
    expect(outcome.total).toBe(6);
    expect(outcome.results.every((r) => r.status === 'PASS')).toBe(true);
    // 并发 >1 时必须用 caseId 隔离日志/报告目录
    expect(seenCaseIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });
});
