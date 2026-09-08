// 验收测试：DataContext 生命周期打通（DataSession 统一 setup → Execution → teardown）
// 重点解决：
//   1. 数据准备结果真正传给 Runner（外部会话直达 Pipeline/Engine，不重复准备）
//   2. 不重复准备（setup 幂等；外部会话进入 Pipeline 后工厂 setup 零调用）
//   3. setup 失败是否阻断执行（block 默认阻断 + 清理部分产出；continue 显式降级）
//   4. teardown 必须执行（执行抛错 / setup 失败 / 正常完成 三条路径全部清理）
//   5. 数据生命周期归属明确（谁创建谁 teardown；runner 只消费不清理）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataSession, DataSessionSetupError, runWithDataSession } from '../../src/core/data-session.js';
import { registerDataFactory } from '../../src/core/data-factory.js';
import type { DataFactory, DataContext, RunContext } from '../../src/core/types.js';
import { Pipeline } from '../../src/core/pipeline.js';
import type { AppConfig, TaskDef, Session } from '../../src/core/types.js';
import type { SceneHandler } from '../../src/core/scene-handler.js';
import { runCasesWithEngine, ExecutionRunTool } from '../../src/agents/execution/execution-run-tool.js';
import { Engine, type RunTaskResult } from '../../src/core/engine.js';
import { runAgentPipeline } from '../../src/agents/orchestration/agent-pipeline.js';
import { createDataPrepareTool, createExecutionRunTool } from '../../src/agents/index.js';
import { createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';
import type { ScenarioProcessorContext } from '../../src/acceptance/scenario-runner.js';
import { fixtureScenarioProcessor } from '../helpers/scenario-runtime.js';

/** 追踪调用的工厂（setup/generate 产出可识别数据；teardown 记录收到的上下文） */
function trackingFactory(opts: { setupThrows?: boolean; teardownThrows?: boolean } = {}) {
  const calls = { setup: 0, teardown: 0, generate: 0, teardownContexts: [] as Array<DataContext | undefined> };
  const factory: DataFactory = {
    async setup(): Promise<DataContext> {
      calls.setup++;
      if (opts.setupThrows) throw new Error('模拟数据准备失败（账号创建失败）');
      return { account: { id: 'acct-setup', nickname: 'n', project_id: 1 }, taskIds: ['task-1'] };
    },
    async teardown(_ctx, data) {
      calls.teardown++;
      calls.teardownContexts.push(data);
      if (opts.teardownThrows) throw new Error('模拟清理失败（删除任务失败）');
    },
    async generate(): Promise<DataContext> {
      calls.generate++;
      return { account: { id: 'acct-gen', nickname: 'n', project_id: 1 }, taskIds: ['task-g1'] };
    },
  };
  return { factory, calls };
}

describe('DataSession：生命周期语义', () => {
  it('setup 幂等：重复调用不重复准备（工厂 setup 只执行一次）', async () => {
    const { factory, calls } = trackingFactory();
    const session = DataSession.forFactory(factory, 'f');
    const c1 = await session.setup();
    const c2 = await session.setup();
    expect(calls.setup).toBe(1);
    expect(c2).toBe(c1);
    expect(session.isReady).toBe(true);
    expect(session.currentState).toBe('ready');
  });

  it('teardown 幂等且必达：清理失败不抛错（不掩盖执行结果）', async () => {
    const { factory, calls } = trackingFactory({ teardownThrows: true });
    const session = DataSession.forFactory(factory, 'f');
    await session.setup();
    await expect(session.teardown()).resolves.toBeUndefined();
    await expect(session.teardown()).resolves.toBeUndefined();
    expect(calls.teardown).toBe(1); // 幂等：只执行一次
    expect(session.currentState).toBe('torn-down');
  });

  it('runWithDataSession：执行抛错 teardown 仍执行，错误原样传播', async () => {
    const { factory, calls } = trackingFactory();
    const session = DataSession.forFactory(factory, 'f');
    await expect(runWithDataSession(session, async () => {
      throw new Error('执行阶段业务异常');
    })).rejects.toThrow('执行阶段业务异常');
    expect(calls.teardown).toBe(1);
    expect(session.currentState).toBe('torn-down');
  });

  it('setup 失败（block 默认）：清理部分产出后抛 DataSessionSetupError 阻断执行', async () => {
    const { factory, calls } = trackingFactory({ setupThrows: true });
    const session = DataSession.forFactory(factory, 'f');
    await expect(session.setup()).rejects.toBeInstanceOf(DataSessionSetupError);
    expect(calls.teardown).toBe(1); // 阻断前已尽力清理
    expect(session.currentState).toBe('torn-down');
  });

  it('setup 失败（continue）：降级为空上下文继续执行（显式策略）', async () => {
    const { factory, calls } = trackingFactory({ setupThrows: true });
    const session = DataSession.forFactory(factory, 'f', { setupFailurePolicy: 'continue' });
    const ctx = await session.setup();
    expect(ctx).toEqual({});
    expect(session.isReady).toBe(true);
    expect(calls.teardown).toBe(0); // continue：数据留给执行用，teardown 由 finally 收尾
    await session.teardown();
    expect(calls.teardown).toBe(1);
  });

  it('adopt：外部已准备的数据不重复 setup，teardown 仍接管', async () => {
    const { factory, calls } = trackingFactory();
    const session = DataSession.adopt({ taskIds: ['pre-made'] }, factory, 'adopted');
    expect(session.isReady).toBe(true);
    expect(session.context).toEqual({ taskIds: ['pre-made'] });
    // adopt 后 setup 是 no-op（不重复准备）
    await session.setup();
    expect(calls.setup).toBe(0);
    await session.teardown();
    expect(calls.teardown).toBe(1);
    expect(calls.teardownContexts[0]).toEqual({ taskIds: ['pre-made'] });
  });
});

// ── Pipeline 层：外部会话只消费不重建；内部 autoSetup 走 DataSession ──

/** 即时应答的本地 HTTP 服务（Pipeline 业务步骤不打真实外网，避免重试超时） */
async function startEchoServer(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 1, data: { available_points: 100, consumed_7d: 0 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const echoServers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of echoServers.splice(0)) await s.close();
});

function makeCfg(): AppConfig {
  return {
    default_env: 'test',
    environments: {
      test: { base_url: 'http://127.0.0.1:1', billing_url: 'http://127.0.0.1:1/billing', detail_url: 'http://127.0.0.1:1/detail', project_id: 1 },
    },
  } as unknown as AppConfig;
}

function makeSession(): Session {
  return { env: 'test', cookie_string: 'sid=1', token_exp: Math.floor(Date.now() / 1000) + 3600, project_id: 1, account: 'tester' };
}

/** 处理器：submit 捕获 ctx.data（验证数据是否真正到达执行层） */
function capturingHandler(captured: { data?: DataContext | null }): SceneHandler {
  return {
    name: 'ds-test',
    supportedScenes: ['video'],
    supports: (s) => s === 'video',
    async submit(ctx) {
      captured.data = (ctx.data as DataContext) ?? null;
      return { taskId: 42, submit: { status: '成功' } };
    },
    async detail() {},
    async status(ctx) { ctx.submit.status = '成功'; },
    analyzeBilling: (d) => d,
  };
}

function makeTaskDef(dataFactory?: string, extra?: Record<string, unknown>): TaskDef {
  return { name: 'ds-case', scene: 'video', model_id: 'm', expected_points: 0, ...(dataFactory ? { dataFactory } : {}), extra: extra ?? {} } as TaskDef;
}

/** 启动即时应答服务并返回指向它的 cfg（每用例独立，afterEach 统一关闭） */
async function freshCfg(): Promise<AppConfig> {
  const s = await startEchoServer();
  echoServers.push(s);
  return {
    default_env: 'test',
    environments: {
      test: { base_url: s.url, billing_url: `${s.url}/billing`, detail_url: `${s.url}/detail`, project_id: 1 },
    },
  } as unknown as AppConfig;
}

describe('Pipeline：数据会话消费与不重复准备', () => {
  it('外部会话（adopt）→ 数据直达执行层，工厂 setup 零调用（不重复准备），Pipeline 不负责 teardown', async () => {
    const cfg = await freshCfg();
    const { factory, calls } = trackingFactory();
    const session = DataSession.adopt({ account: { id: 'acct-from-agent', nickname: 'n', project_id: 1 }, taskIds: ['agent-task'] }, factory, 'agent');
    const captured: { data?: DataContext | null } = {};

    const pipeline = new Pipeline({ cfg, session: makeSession(), taskDef: makeTaskDef(), handler: capturingHandler(captured), dataSession: session });
    const result = await pipeline.run();

    // 数据准备结果真正传给 Runner：handler 看到的就是会话里的数据
    expect(captured.data?.account?.id).toBe('acct-from-agent');
    expect(result.dataContext?.taskIds).toEqual(['agent-task']);
    // 不重复准备：外部会话路径工厂 setup 不会被调用
    expect(calls.setup).toBe(0);
    // 归属明确：Pipeline 不 teardown 外部会话（生命周期归编排层）
    expect(calls.teardown).toBe(0);
    expect(session.currentState).toBe('ready');
  });

  it('内部 autoSetup → DataSession.forTaskDef：setup 一次 + teardown 必达', async () => {
    const cfg = await freshCfg();
    const { factory, calls } = trackingFactory();
    registerDataFactory('ds-internal', factory);
    const captured: { data?: DataContext | null } = {};

    const pipeline = new Pipeline({ cfg, session: makeSession(), taskDef: makeTaskDef('ds-internal'), handler: capturingHandler(captured), autoSetup: true });
    const result = await pipeline.run();

    expect(calls.setup).toBe(1);
    expect(captured.data?.account?.id).toBe('acct-setup');
    expect(result.dataContext?.account?.id).toBe('acct-setup');
    expect(calls.teardown).toBe(1); // 无论成败必达
  });

  it('内部 autoSetup + setup 失败（block 默认）→ 阻断执行（抛错），部分产出已清理', async () => {
    const { factory, calls } = trackingFactory({ setupThrows: true });
    registerDataFactory('ds-fail', factory);
    const captured: { data?: DataContext | null } = {};

    const pipeline = new Pipeline({ cfg: makeCfg(), session: makeSession(), taskDef: makeTaskDef('ds-fail'), handler: capturingHandler(captured), autoSetup: true });
    await expect(pipeline.run()).rejects.toBeInstanceOf(DataSessionSetupError);
    expect(captured.data).toBeUndefined(); // 执行层未被触达（阻断）
    expect(calls.teardown).toBe(1);
  });

  it('内部 autoSetup + setup 失败（extra.dataSetupFailure=continue）→ 降级继续执行', async () => {
    const cfg = await freshCfg();
    const { factory, calls } = trackingFactory({ setupThrows: true });
    registerDataFactory('ds-continue', factory);
    const captured: { data?: DataContext | null } = {};

    const pipeline = new Pipeline({ cfg, session: makeSession(), taskDef: makeTaskDef('ds-continue', { dataSetupFailure: 'continue' }), handler: capturingHandler(captured), autoSetup: true });
    const result = await pipeline.run();

    expect(captured.data).toEqual({}); // 降级为空上下文，执行未被阻断
    expect(result.dataContext).toEqual({});
    expect(calls.teardown).toBe(1);
  });

  it('外部会话未就绪（未 setup）→ 拒绝执行（fail-closed，不静默跑无数据用例）', async () => {
    const { factory } = trackingFactory();
    const session = DataSession.forFactory(factory, 'f');
    const pipeline = new Pipeline({ cfg: makeCfg(), session: makeSession(), taskDef: makeTaskDef(), handler: capturingHandler({}), dataSession: session });
    await expect(pipeline.run()).rejects.toThrow(/外部数据会话未就绪/);
  });
});

describe('Runner 层：会话贯穿与归属', () => {
  const cases = Array.from({ length: 2 }, (_, i) => ({
    name: `ds-${i}`, feature: 'wan3', file: 'x.ts',
    def: makeTaskDef(),
  }));

  it('runCasesWithEngine：dataSession 直达 Engine.runTask；runner 不越权 teardown（归编排层）', async () => {
    const { factory, calls } = trackingFactory();
    const session = DataSession.adopt({ taskIds: ['shared'] }, factory, 'agent');
    const received: Array<DataSession | undefined> = [];

    class StubEngine extends Engine {
      override async runTask(...args: Parameters<Engine['runTask']>): Promise<RunTaskResult> {
        received.push(args[11]);
        return {
          files: [],
          passRate: 100,
          hasBlockingIssue: false,
          executed: true,
          status: 'PASS',
          processor: 'data-session-fixture-processor',
          processorInvoked: true,
          checks: [{ name: '数据会话已传入执行层', pass: true, detail: 'fixture verified', kind: 'BUSINESS' }],
        };
      }
    }
    const outcome = await runCasesWithEngine(new StubEngine(), makeCfg(), cases, { env: 'test', dataSession: session });

    expect(outcome.total).toBe(2);
    // 每条用例都拿到同一份会话（数据准备结果真正传给 Runner，且只准备一次）
    expect(received).toHaveLength(2);
    expect(received.every((s) => s === session)).toBe(true);
    // 归属明确：runner 消费但不清理
    expect(calls.teardown).toBe(0);
    expect(session.currentState).toBe('ready');
    // 编排层随后 teardown 正常收尾
    await session.teardown();
    expect(calls.teardown).toBe(1);
  });
});

describe('Agent Pipeline 端到端：Data Agent 数据 → Execution → teardown 必达', () => {
  const DEMO = `# Resource Query
GET /resources
无需认证
返回 200
AC-1 GET /resources 查询资源返回 200`;
  const APPROVED_EXECUTION = { id: 'approval-ds-test', status: 'APPROVED' as const, approvedBy: 'ds-test-reviewer' };

  /** 共享追踪（beforeEach 重新注册 wan3 工厂并重置计数） */
  let shared = { setup: 0, teardown: 0, generate: 0, teardownContexts: [] as Array<DataContext | undefined> };

  function makeContext(beforeExecute?: (context: ScenarioProcessorContext) => void | Promise<void>) {
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool()); // 默认解析器 → 全局注册表（下方注册 wan3 追踪工厂）
    tools.register(createExecutionRunTool());
    const ctx = createAgentContext({
      taskId: 'ds-pipe', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm: new MockLLMProvider(),
      metadata: {
        executionApproval: APPROVED_EXECUTION,
        scenarioRunnerOptions: {
          processors: [fixtureScenarioProcessor('data-session-fixture-processor', beforeExecute)],
          environmentAvailable: true,
          policyAllowed: true,
        },
      },
    });
    return ctx;
  }

  beforeEach(() => {
    // 端到端：确定性分析器对 wan3 推荐 factoryName='wan3' → 注册可追踪工厂
    const { factory, calls } = trackingFactory();
    registerDataFactory('wan3', factory);
    shared = calls;
  });

  it('准备的数据以 DataSession 直达 execution.run，执行完成后编排层 teardown（必达）', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let runnerSawAccountId: string | undefined;
    const ctx = makeContext((context) => {
      seen.push({ ...context.variables });
      runnerSawAccountId = (context.variables.account as DataContext['account'] | undefined)?.id;
    });
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    expect(r.dataPlan.needsSetup).toBe(true);
    expect(r.dataContext.account?.id).toBe('acct-gen');
    // DataSession 中的数据经 V2 Adapter 变量上下文传给 Scenario Processor。
    expect((seen[0]?.account as DataContext['account'] | undefined)?.id).toBe('acct-gen');
    expect(runnerSawAccountId).toBe('acct-gen');
    expect(shared.generate).toBe(1); // data.prepare 只准备一次
    expect(shared.teardown).toBe(1);
  });

  it('执行失败（runner 抛错被 Tool 捕获为失败结果）→ teardown 仍然执行（无数据残留）', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = makeContext((context) => {
      seen.push({ ...context.variables });
      throw new Error('执行引擎崩溃');
    });
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);
    // Tool 层把 runner 异常转为失败结果（不向 Agent 抛出），执行未真正完成
    expect(r.outcome.executed).toBe(false);
    // 但数据清理不受影响：teardown 依然执行
    expect(shared.teardown).toBeGreaterThanOrEqual(1);
    expect((seen[0]?.account as DataContext['account'] | undefined)?.id).toBe('acct-gen');
  });

  it('并发 Pipeline 使用各自 DataFactory/DataContext，互不覆盖且分别 teardown', async () => {
    const observed = new Map<string, string | undefined>();
    const teardownAccounts = new Map<string, string | undefined>();

    const run = async (label: string, delayMs: number) => {
      const factory: DataFactory = {
        async setup() { return {}; },
        async generate() {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { account: { id: `account-${label}`, nickname: label, project_id: 1 } };
        },
        async teardown(_ctx, data) {
          teardownAccounts.set(label, data.account?.id);
        },
      };
      const tools = new ToolRegistry();
      tools.register(createDataPrepareTool(() => factory));
      tools.register(createExecutionRunTool());
      const context = createAgentContext({
        taskId: `concurrent-${label}`,
        feature: 'wan3',
        environment: 'test',
        tools,
        memory: new NoopMemory(),
        llm: new MockLLMProvider(),
        metadata: {
          executionApproval: { id: `approval-${label}`, status: 'APPROVED', approvedBy: 'qa' },
          scenarioRunnerOptions: {
            processors: [fixtureScenarioProcessor('data-isolation-fixture-processor', (scenarioContext) => {
              observed.set(label, (scenarioContext.variables.account as DataContext['account'] | undefined)?.id);
            })],
            environmentAvailable: true,
            policyAllowed: true,
          },
        },
      });
      return runAgentPipeline({ requirementText: DEMO, environment: 'test' }, context);
    };

    const [a, b] = await Promise.all([run('A', 20), run('B', 5)]);
    expect(a.outcome.passed).toBe(a.outcome.total);
    expect(b.outcome.passed).toBe(b.outcome.total);
    expect(observed).toEqual(new Map([['B', 'account-B'], ['A', 'account-A']]));
    expect(teardownAccounts).toEqual(new Map([['B', 'account-B'], ['A', 'account-A']]));
  });
});
