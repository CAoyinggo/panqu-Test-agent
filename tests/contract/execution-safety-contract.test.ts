import { describe, expect, it } from 'vitest';
import {
  createAgentContext,
  createDataPrepareTool,
  createExecutionRunTool,
  NoopMemory,
  runAgentPipeline,
  ToolRegistry,
} from '../../src/agents/index.js';
import { AgentRuntime } from '../../src/agents/core/agent-runtime.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import { AgentBudget } from '../../src/agents/observability/budget.js';
import { UsageMeter } from '../../src/agents/observability/usage-meter.js';
import { evaluateExecutionPolicy } from '../../src/agents/policy/policy-gate.js';
import type { ExecutionPlan } from '../../src/agents/execution/execution-schema.js';
import { computeOutcome } from '../../src/agents/execution/execution-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { LoadedCase } from '../../src/cases/loader.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';
import type { LLMProvider, LLMRequest } from '../../src/llm/types.js';
import { resumeTask, type TaskRecord } from '../../src/qa/workflows.js';

const DEMO =
  '测试 WAN3 文生视频，验证任务提交、状态成功、积分正确扣除和并发执行，使用隔离测试账号与素材。';

const executionApproval = {
  id: 'approval-original-plan',
  status: 'APPROVED' as const,
  approvedBy: 'reviewer-a',
};

function loadedCase(): LoadedCase {
  return {
    name: 'dry-run-probe',
    feature: 'wan3',
    file: '<contract>',
    def: {
      name: 'dry-run-probe',
      scene: 'video',
      extra: { agentTestCaseId: 'dry-run-probe' },
    },
  };
}

function context(tools = new ToolRegistry(), llm: LLMProvider = new MockLLMProvider()): AgentContext {
  return createAgentContext({
    taskId: 'execution-safety-contract',
    feature: 'wan3',
    environment: 'test',
    tools,
    memory: new NoopMemory(),
    llm,
    metadata: { executionApproval },
  });
}

function policyTestCase(): TestCase {
  return {
    id: 'tc-policy',
    feature: 'wan3',
    name: 'policy binding',
    priority: 'P0',
    tags: ['P0'],
    steps: [{ action: 'submit', scene: 'video', input: { prompt: 'probe' } }],
    assertions: [{ target: 'submit', path: 'taskId', operator: 'exists' }],
  };
}

function executionPlan(): ExecutionPlan {
  return {
    order: ['tc-policy'],
    concurrency: 1,
    enableRetry: false,
    reason: 'approval binding contract',
    policy: { realExecution: true },
  };
}

function highRiskAssessment() {
  return {
    feature: 'wan3',
    risks: [{
      id: 'risk-production',
      category: 'billing' as const,
      level: 'high' as const,
      title: 'production billing',
      desc: 'real side effect',
      mitigation: 'approval',
    }],
    issues: [],
    summary: { high: 1, medium: 0, low: 0, overall: 'high' as const, recommendedSkip: false },
  };
}

function policyRequirement() {
  return {
    feature: 'wan3',
    goal: 'execute video',
    capabilities: ['video'],
    inputs: [],
    requirements: [],
    businessRules: [],
    dependencies: [],
    constraints: [],
    risks: [],
    source: 'execute video',
  };
}

describe('Execution Safety Contract', () => {
  it('[P0-07] production risky execution without approval stops before Data Prepare and Runner', async () => {
    const calls = { dataPrepare: 0, runner: 0 };
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool(() => {
      calls.dataPrepare += 1;
      return {
        setup: async () => ({}),
        teardown: async () => {},
        generate: async () => ({
          account: { id: 'should-not-exist', nickname: 'blocked-probe', project_id: -1 },
          taskIds: ['should-not-exist'],
        }),
      };
    }));
    tools.register(createExecutionRunTool(async (cases) => {
      calls.runner += 1;
      return computeOutcome('wan3', cases.map((item) => ({
        caseId: String(item.def.extra?.agentTestCaseId ?? item.name),
        name: item.name,
        feature: item.feature,
        executed: true,
        status: 'PASS',
        pass: true,
        passRate: 100,
        checks: [{ name: 'business-evidence', pass: true, detail: 'executed' }],
      })), { executed: true });
    }));
    const noApprovalContext = createAgentContext({
      taskId: 'production-no-approval-contract',
      feature: 'wan3',
      environment: 'production',
      tools,
      memory: new NoopMemory(),
      llm: new MockLLMProvider(),
      metadata: {},
    });

    const result = await runAgentPipeline(
      { requirementText: DEMO, environment: 'production' },
      noApprovalContext,
    );

    expect(result.policyGate.allowed).toBe(false);
    expect(calls.dataPrepare).toBe(0);
    expect(calls.runner).toBe(0);
    expect(result.outcome.executed).toBe(false);
    expect(result.outcome.results.every((item) => item.status === 'BLOCKED' && !item.pass)).toBe(true);
  });

  it('[P0-08] approval is bound to the reviewed environment and Execution Plan', () => {
    const result = evaluateExecutionPolicy({
      requirement: policyRequirement(),
      risk: highRiskAssessment(),
      testCases: [policyTestCase()],
      environment: 'production',
      executionPlan: executionPlan(),
      approval: executionApproval,
      projectPolicy: { allowRealBilling: true },
    });

    expect(result.verdict).toBe('BLOCK');
    expect(result.reasons.join(' ')).toMatch(/fingerprint|审批.*环境|PLAN_FINGERPRINT_MISMATCH/i);
  });

  it('[P0-09] dryRun invokes neither Runner nor side-effect Tool', async () => {
    let runnerCalls = 0;
    const tool = createExecutionRunTool(async () => {
      runnerCalls += 1;
      return computeOutcome('wan3', []);
    });
    const result = await tool.execute({
      cases: [loadedCase()],
      options: {
        plan: {
          order: ['dry-run-probe'],
          concurrency: 1,
          enableRetry: false,
          reason: 'dry-run contract',
          dryRun: true,
          policy: { realExecution: false, realBilling: false },
        },
      },
    }, context());

    expect(runnerCalls).toBe(0);
    expect(result.executed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: 'NOT_EXECUTED', pass: false });
  });

  it.each(['missing', 'timeout', 'error', 'empty'] as const)(
    '[P0-10] Data Prepare %s blocks execution',
    async (mode) => {
      let runnerCalls = 0;
      const tools = new ToolRegistry();
      if (mode !== 'missing') {
        tools.register({
          name: 'data.prepare',
          description: `data prepare ${mode}`,
          inputSchema: {},
          outputSchema: {},
          timeoutMs: mode === 'timeout' ? 10 : 1_000,
          async execute(_input, _context, signal) {
            if (mode === 'timeout') {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 100);
                signal?.addEventListener('abort', () => {
                  clearTimeout(timer);
                  resolve();
                }, { once: true });
              });
              return {};
            }
            if (mode === 'error') throw new Error('data prepare failed');
            return {};
          },
        });
      }
      tools.register(createExecutionRunTool(async (cases) => {
        runnerCalls += 1;
        return computeOutcome('wan3', cases.map((item) => ({
          caseId: String(item.def.extra?.agentTestCaseId ?? item.name),
          name: item.name,
          feature: item.feature,
          executed: true,
          status: 'PASS',
          pass: true,
          passRate: 100,
          checks: [{ name: 'business-evidence', pass: true, detail: 'executed', level: 'P0' }],
        })), { executed: true });
      }));

      const result = await runAgentPipeline(
        { requirementText: DEMO, environment: 'test', options: { executionApproval } },
        context(tools),
      );

      expect(result.dataPlan.needsSetup).toBe(true);
      expect(runnerCalls).toBe(0);
      expect(result.outcome.executed).toBe(false);
      expect(result.outcome.results.every((item) => item.status === 'BLOCKED' && !item.pass)).toBe(true);
    },
  );

  it('[P0-12] maxLLMCalls=0 rejects before the first Provider call', async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: 'budget-probe',
      async generate(_request: LLMRequest) {
        providerCalls += 1;
        return { content: '{}', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const meter = new UsageMeter({ budget: new AgentBudget({ maxLLMCalls: 0 }) });
    const runtime = new AgentRuntime({ llm: provider, meter });

    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u' })).rejects.toThrow(/预算超限/);
    expect(providerCalls).toBe(0);
  });

  it('[P0-12] maxToolCalls=0 rejects before the first Tool call', async () => {
    let toolCalls = 0;
    const meter = new UsageMeter({ budget: new AgentBudget({ maxToolCalls: 0 }) });
    const tools = new ToolRegistry({ meter });
    tools.register({
      name: 'side-effect.probe',
      description: 'side effect probe',
      inputSchema: {},
      outputSchema: {},
      async execute() {
        toolCalls += 1;
        return { ok: true };
      },
    });

    const result = await tools.call('side-effect.probe', {}, context(tools));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/预算超限/);
    expect(toolCalls).toBe(0);
  });

  it('[P0-12] maxTokens=1 rejects before the first Provider call', async () => {
    let providerCalls = 0;
    const provider: LLMProvider = {
      name: 'token-budget-probe',
      async generate() {
        providerCalls += 1;
        return { content: '{}', latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const runtime = new AgentRuntime({
      llm: provider,
      meter: new UsageMeter({ budget: new AgentBudget({ maxTokens: 1 }) }),
    });

    await expect(runtime.generate({ task: 'risk', agent: 'risk', system: 's', user: 'u', maxTokens: 1 })).rejects.toThrow(/预算超限/);
    expect(providerCalls).toBe(0);
  });

  it('[P0-14] resume in production re-runs Risk/Gate and does not call the injected Runner', async () => {
    const failed = {
      caseId: 'resume-case',
      name: '错误码断言',
      feature: 'wan3',
      executed: true,
      status: 'FAIL' as const,
      pass: false,
      passRate: 0,
      error: '断言错误码失败：期望 4001，实际 4003',
      checks: [{ name: '错误码断言', pass: false, detail: '期望 4001，实际 4003' }],
    };
    const testCase: TestCase = {
      id: 'resume-case',
      feature: 'wan3',
      name: '错误码断言',
      priority: 'P1',
      tags: ['P1'],
      steps: [{ action: 'submit', scene: 'video', input: {} }],
      assertions: [{ target: 'custom', operator: 'equals', expected: '4001', severity: 'P1' }],
    };
    const record: TaskRecord = {
      taskId: 'resume-contract',
      feature: 'wan3',
      requirement: '测试错误码',
      environment: 'production',
      testCases: [testCase],
      outcome: computeOutcome('wan3', [failed], { executed: true }),
      failedCases: [failed],
      updatedAt: '2026-08-22T00:00:00.000Z',
    };
    let runnerCalls = 0;
    const resumeContext = context(
      new ToolRegistry(),
      new MockLLMProvider({ defaultResponse: JSON.stringify({ reason: '错误码已调整' }) }),
    );
    resumeContext.environment = 'production';

    await resumeTask(record, resumeContext, async (definition) => {
      runnerCalls += 1;
      return {
        caseId: definition.id,
        name: definition.name,
        feature: definition.feature,
        executed: true,
        status: 'PASS',
        pass: true,
        passRate: 100,
        checks: [{ name: 'business-evidence', pass: true, detail: 'executed' }],
      };
    }, { autoApprove: true });

    expect(runnerCalls).toBe(0);
  });
});
