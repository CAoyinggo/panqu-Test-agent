// 验收测试：ExecutionPlan → Runner → 真实控制执行行为（不再是报告里的配置）
// 逐项验证 plan 字段真实生效：
//   order（按计划顺序执行）/ maxCases（预算截断计入结果）/ maxConcurrency（并发硬顶）/
//   dryRun + policy.realExecution=false（零副作用）/ timeoutMs（整体预算，到点真实中止）/
//   policy.stopOnFailure（失败即停）/ enableRetry（重试开关真实控制重试次数）
import { describe, it, expect } from 'vitest';
import { runCasesWithEngine, planRequiresDryRun } from '../../src/agents/execution/execution-run-tool.js';
import { Engine, type RunTaskResult } from '../../src/core/engine.js';
import type { AppConfig, TaskDef } from '../../src/core/types.js';
import type { LoadedCase } from '../../src/cases/loader.js';
import type { ExecutionPlan } from '../../src/agents/execution/execution-schema.js';
import { ExecutionAbortError } from '../../src/core/abort.js';
import { ExecutionAgent } from '../../src/agents/execution/execution-agent.js';
import { createAgentContext, NoopMemory, ToolRegistry } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';

const CFG = {
  default_env: 'test',
  environments: { test: { base_url: 'http://127.0.0.1:1', billing_url: 'http://127.0.0.1:1/b', detail_url: 'http://127.0.0.1:1/d', project_id: 1 } },
} as unknown as AppConfig;

/** 构造用例（caseId 进 extra.agentTestCaseId，与 plan.order 匹配） */
function caseOf(caseId: string, opts: { fail?: boolean; retries?: number; hangMs?: number } = {}): LoadedCase {
  const extra: Record<string, unknown> = { agentTestCaseId: caseId };
  if (opts.retries !== undefined) extra.retries = opts.retries;
  return {
    name: caseId,
    feature: 'wan3',
    file: '<test>',
    def: { name: caseId, scene: 'video', model_id: 'm', expected_points: 0, extra } as TaskDef,
  };
}

interface StubControls {
  sequence: string[];
  callsByCase: Record<string, number>;
  active: number;
  maxActive: number;
  signals: Array<AbortSignal | undefined>;
  failOnce?: Record<string, number>; // caseId → 前 N 次尝试抛错（验证重试）
}

/** Stub 引擎：可注入失败/挂起行为；记录执行顺序、并发峰值、收到的取消信号 */
function stubEngine(controls: StubControls, behavior: {
  failCases?: string[];
  hangMs?: number;
  respectSignal?: boolean;
} = {}) {
  class StubEngine extends Engine {
    override async runTask(...args: Parameters<Engine['runTask']>): Promise<RunTaskResult> {
      const def = args[1];
      const signal = args[10];
      const caseId = String(def.extra?.agentTestCaseId ?? def.name);
      controls.sequence.push(caseId);
      controls.callsByCase[caseId] = (controls.callsByCase[caseId] ?? 0) + 1;
      controls.signals.push(signal);
      controls.active++;
      controls.maxActive = Math.max(controls.maxActive, controls.active);
      try {
        if (behavior.hangMs) {
          // 挂起直到自然完成或信号中止（真实引擎语义：signal 贯穿到底层）
          if (behavior.respectSignal !== false && signal) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => resolve(), behavior.hangMs);
              const onAbort = () => {
                clearTimeout(t);
                reject(signal.reason instanceof Error ? signal.reason : new ExecutionAbortError('CANCELLED', '已中止'));
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            });
          } else {
            await new Promise((r) => setTimeout(r, behavior.hangMs));
          }
        } else {
          await new Promise((r) => setTimeout(r, 30));
        }
        const fail = behavior.failCases?.includes(caseId)
          && !(controls.failOnce && controls.callsByCase[caseId] > controls.failOnce[caseId]);
        if (fail) throw new Error(`用例 ${caseId} 断言失败`);
        return {
          files: [],
          passRate: 100,
          hasBlockingIssue: false,
          executed: true,
          status: 'PASS',
          processor: 'execution-plan-fixture-processor',
          processorInvoked: true,
          checks: [{ name: '计划执行业务断言', pass: true, detail: caseId, kind: 'BUSINESS' }],
        };
      } finally {
        controls.active--;
      }
    }
  }
  return new StubEngine();
}

const basePlan = (over: Partial<ExecutionPlan> = {}): ExecutionPlan => ({
  order: [], concurrency: 1, enableRetry: true, reason: 'test', ...over,
});

describe('Plan.order：按计划顺序执行（优先级 P0→P3）', () => {
  it('输入乱序，执行顺序 = plan.order', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const cases = [caseOf('tc-p2'), caseOf('tc-p0'), caseOf('tc-p1')];
    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, cases, {
      env: 'test',
      plan: basePlan({ order: ['tc-p0', 'tc-p1', 'tc-p2'], concurrency: 1 }),
    });
    expect(controls.sequence).toEqual(['tc-p0', 'tc-p1', 'tc-p2']); // 串行：严格计划顺序
    expect(outcome.total).toBe(3);
  });
});

describe('Plan.maxCases：预算截断（计入结果，不静默丢弃）', () => {
  it('超出预算的用例 NOT_EXECUTED（预算截断），按 order 保留高优先级', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const cases = [caseOf('tc-1'), caseOf('tc-2'), caseOf('tc-3'), caseOf('tc-4')];
    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, cases, {
      env: 'test',
      plan: basePlan({ order: ['tc-1', 'tc-2', 'tc-3', 'tc-4'], maxCases: 2, concurrency: 1 }),
    });
    expect(controls.sequence).toEqual(['tc-1', 'tc-2']); // 只执行预算内
    expect(outcome.total).toBe(4); // 被截断的仍计入结果
    const dropped = outcome.results.filter((r) => r.status === 'NOT_EXECUTED');
    expect(dropped).toHaveLength(2);
    expect(dropped.every((r) => r.error?.includes('maxCases 预算截断'))).toBe(true);
  });
});

describe('Plan.maxConcurrency：并发硬顶（与 concurrency 取 min）', () => {
  it('options.concurrency=4 + plan.maxConcurrency=2 → 在途峰值 ≤2', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const cases = Array.from({ length: 6 }, (_, i) => caseOf(`tc-${i}`));
    const outcome = await runCasesWithEngine(stubEngine(controls, { hangMs: 60 }), CFG, cases, {
      env: 'test',
      concurrency: 4,
      plan: basePlan({ maxConcurrency: 2 }),
    });
    expect(controls.maxActive).toBeLessThanOrEqual(2);
    expect(controls.maxActive).toBeGreaterThan(1); // 确实并行
    expect(outcome.total).toBe(6);
  });
});

describe('Plan.dryRun / policy.realExecution=false：零副作用', () => {
  it('plan.dryRun → 引擎零调用，全部 NOT_EXECUTED', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, [caseOf('tc-1')], {
      env: 'test', plan: basePlan({ dryRun: true }),
    });
    expect(controls.sequence).toEqual([]);
    expect(outcome.executed).toBe(false);
    expect(outcome.results.every((r) => r.status === 'NOT_EXECUTED')).toBe(true);
  });

  it('policy.realExecution=false → 同样零副作用（Policy Gate 之后第二道防线）', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const outcome = await runCasesWithEngine(stubEngine(controls), CFG, [caseOf('tc-1')], {
      env: 'test', plan: basePlan({ policy: { realExecution: false } }),
    });
    expect(controls.sequence).toEqual([]);
    expect(outcome.results[0].error).toContain('策略禁止真实执行');
  });

  it('planRequiresDryRun：三种零副作用来源合并判定', () => {
    expect(planRequiresDryRun(undefined, true)).toBe(true);
    expect(planRequiresDryRun({ dryRun: true } as ExecutionPlan)).toBe(true);
    expect(planRequiresDryRun({ policy: { realExecution: false } } as ExecutionPlan)).toBe(true);
    expect(planRequiresDryRun(basePlan(), false)).toBe(false);
  });
});

describe('Plan.timeoutMs：整体时间预算（到点真实中止）', () => {
  it('预算耗尽 → 在途用例收到 abort 信号（TIMEOUT），未启动用例标 TIMEOUT 不再调度', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const cases = [caseOf('tc-hang'), caseOf('tc-next')];
    const t0 = Date.now();
    const outcome = await runCasesWithEngine(
      stubEngine(controls, { hangMs: 10_000 }), // 挂 10s，只有信号能中止
      CFG, cases,
      { env: 'test', concurrency: 1, plan: basePlan({ order: ['tc-hang', 'tc-next'], timeoutMs: 150, concurrency: 1 }) },
    );
    // 远早于 10s 返回 = 在途用例被信号真实中止（不是等它自然结束）
    expect(Date.now() - t0).toBeLessThan(5_000);
    // 引擎收到了已中止的信号
    expect(controls.signals[0]?.aborted).toBe(true);
    // 未启动的用例不再执行，标 TIMEOUT
    expect(controls.sequence).toEqual(['tc-hang']);
    const timeoutResults = outcome.results.filter((r) => r.status === 'TIMEOUT');
    expect(timeoutResults).toHaveLength(2);
    expect(outcome.timedOut).toBe(2);
  }, 10_000);
});

describe('Plan.policy.stopOnFailure：失败即停', () => {
  it('首个失败后停止调度，剩余用例 NOT_EXECUTED（已启动的完成）', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const cases = ['tc-1', 'tc-2', 'tc-3', 'tc-4'].map((id) => caseOf(id));
    const outcome = await runCasesWithEngine(
      stubEngine(controls, { failCases: ['tc-2'] }),
      CFG, cases,
      { env: 'test', concurrency: 1, plan: basePlan({ order: ['tc-1', 'tc-2', 'tc-3', 'tc-4'], policy: { stopOnFailure: true } }) },
    );
    expect(controls.sequence).toEqual(['tc-1', 'tc-2']); // tc-3/tc-4 不再调度
    const stopped = outcome.results.filter((r) => r.error?.includes('stopOnFailure'));
    expect(stopped).toHaveLength(2);
    expect(stopped.every((r) => r.status === 'NOT_EXECUTED')).toBe(true);
  });
});

describe('Plan.enableRetry：重试开关真实控制重试', () => {
  it('enableRetry=true + extra.retries=1 → 首次失败后重试一次并成功', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [], failOnce: { 'tc-flaky': 1 } };
    const outcome = await runCasesWithEngine(
      stubEngine(controls, { failCases: ['tc-flaky'] }),
      CFG, [caseOf('tc-flaky', { retries: 1 })],
      { env: 'test', plan: basePlan({ enableRetry: true }) },
    );
    expect(controls.callsByCase['tc-flaky']).toBe(2); // 重试了一次
    expect(outcome.results[0].status).toBe('PASS');
  });

  it('enableRetry=false → 忽略用例级 retries，只执行一次', async () => {
    const controls: StubControls = { sequence: [], callsByCase: {}, active: 0, maxActive: 0, signals: [] };
    const outcome = await runCasesWithEngine(
      stubEngine(controls, { failCases: ['tc-flaky'] }),
      CFG, [caseOf('tc-flaky', { retries: 2 })],
      { env: 'test', plan: basePlan({ enableRetry: false }) },
    );
    expect(controls.callsByCase['tc-flaky']).toBe(1); // 不重试
    expect(outcome.results[0].pass).toBe(false);
  });
});

describe('ExecutionAgent：控制参数全部入 Plan 并传给 Tool（options.plan）', () => {
  function makeContext(captured: Array<Record<string, unknown>>): AgentContext {
    const tools = new ToolRegistry();
    // 直接注册裸 Tool：捕获 options 并返回最小 outcome
    tools.register({
      name: 'execution.run',
      description: 'capture',
      inputSchema: {}, outputSchema: {}, permission: 'safe',
      async execute(input: { cases: unknown[]; options?: Record<string, unknown> }) {
        captured.push(input.options ?? {});
        return { feature: 'wan3', total: 0, passed: 0, failed: 0, timedOut: 0, passRate: 0, results: [], reports: [], executed: false } satisfies ExecutionOutcome;
      },
    });
    return createAgentContext({
      taskId: 'plan-test', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm: new MockLLMProvider(),
    });
  }

  const tcs: TestCase[] = [
    { id: 'tc-9', name: 'a', feature: 'wan3', priority: 'P2', tags: [], steps: [], assertions: [] } as unknown as TestCase,
    { id: 'tc-1', name: 'b', feature: 'wan3', priority: 'P0', tags: [], steps: [], assertions: [] } as unknown as TestCase,
  ];

  it('plan 携带 maxCases/maxConcurrency/timeoutMs/policy/dryRun，且 order 按优先级', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const agent = new ExecutionAgent();
    const outcome = await agent.execute({
      testCases: tcs,
      environment: 'test',
      options: {
        concurrency: 4,
        maxCases: 10,
        maxConcurrency: 2,
        timeoutMs: 60_000,
        dryRun: false,
        policy: { stopOnFailure: true, realExecution: true, realBilling: false },
      },
    }, makeContext(captured));

    const plan = captured[0]?.plan as ExecutionPlan;
    expect(plan).toBeDefined();
    expect(plan.order).toEqual(['tc-1', 'tc-9']); // P0 优先
    expect(plan.maxCases).toBe(10);
    expect(plan.maxConcurrency).toBe(2);
    expect(plan.timeoutMs).toBe(60_000);
    expect(plan.policy).toEqual({ stopOnFailure: true, realExecution: true, realBilling: false });
    expect(outcome.plan).toBe(plan); // outcome 挂的就是这份控制契约
  });

  it('Gate 前提供的预构建 Plan 被原样传给 Tool，ExecutionAgent 不再重新规划', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const agent = new ExecutionAgent();
    const prebuilt = agent.planExecution(tcs, 2, {
      maxCases: 2,
      policy: { realExecution: true, realBilling: false },
    });
    const outcome = await agent.execute({
      testCases: tcs,
      options: { plan: prebuilt },
    }, makeContext(captured));

    expect(captured[0]?.plan).toBe(prebuilt);
    expect(outcome.plan).toBe(prebuilt);
  });

  it('Gate 后 Plan 用例集合被篡改时拒绝调用 Tool', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const agent = new ExecutionAgent();
    const tampered = agent.planExecution(tcs);
    tampered.order = ['unknown-case'];

    await expect(agent.execute({ testCases: tcs, options: { plan: tampered } }, makeContext(captured)))
      .rejects.toThrow('Execution Plan 与待执行用例不一致');
    expect(captured).toHaveLength(0);
  });
});
