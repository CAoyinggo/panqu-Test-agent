// 单元测试：Agent Pipeline（Requirement → Policies → ExecutionPlan → Gate → Execution → DeterministicOutcome → Report）
import { describe, it, expect } from 'vitest';
import {
  runAgentPipeline,
  createAgentContext,
  createExecutionRunTool,
  createDataPrepareTool,
  JsonMemoryStore,
  NoopMemory,
  ToolRegistry,
  executionPlanFingerprint,
} from '../../src/agents/index.js';
import { deterministicExecutionOutcome } from '../../src/agents/orchestration/agent-pipeline.js';
import type { ExecutionOutcome, ExecutionPlan } from '../../src/agents/execution/execution-schema.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { EvidenceEnvelope, ScenarioAssertion } from '../../src/acceptance/scenario-contract.js';
import type { ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEMO = `# 通用资源创建
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | token-user-a |
## Authentication
Bearer Token 认证。
## API
POST /resources
## Acceptance Criteria
AC-1 user-a 创建自己拥有的 Resource resourceId=resource-a，返回 HTTP 201。`;

const APPROVED_EXECUTION = {
  id: 'approval-unit-test',
  status: 'APPROVED' as const,
  approvedBy: 'unit-test-reviewer',
};

function setPath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cursor = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) cursor[part] = value;
    else cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
}

function pipelineProcessor(onRun: () => void): ScenarioProcessor {
  return {
    name: 'pipeline-runtime', supportsAbort: true,
    supportedEvidenceKinds: ['REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE', 'AUDIT_RECORD', 'OTHER'],
    supports: () => true, supportsEvidence: () => true,
    execute: async (operation, context) => {
      onRun();
      const requirements = context.scenario.evidenceRequirements.filter((item) => item.operationId === operation.id);
      const evidence = requirements.map((requirement): EvidenceEnvelope => {
        const data: Record<string, unknown> = {};
        for (const assertionId of requirement.assertionIds) {
          const assertion = context.scenario.assertions.find((item) => item.id === assertionId) as ScenarioAssertion | undefined;
          if (!assertion) continue;
          const value = assertion.operator === 'NOT_EXISTS' ? undefined
            : assertion.operator === 'EXISTS' ? 'observed'
              : assertion.expectedFrom ? 'observed' : assertion.expected;
          setPath(data, assertion.target, value);
        }
        return {
          id: requirement.id, requirementId: requirement.id, scenarioId: context.scenario.id,
          operationId: operation.id, acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
          kind: requirement.kind, channel: requirement.channel, source: 'pipeline-runtime',
          observedAt: new Date().toISOString(), data, verified: true,
        };
      });
      return { status: 'PASS', executed: true, evidence };
    },
  };
}

function makeContext(options?: { skipExecTool?: boolean; memory?: JsonMemoryStore; approve?: boolean }): {
  ctx: AgentContext;
  memory: JsonMemoryStore;
  calls: { dataPrepare: number; runner: number };
} {
  const memory = options?.memory ?? new JsonMemoryStore(path.join(os.tmpdir(), `agent-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`));
  const calls = { dataPrepare: 0, runner: 0 };
  const tools = new ToolRegistry();
  tools.register(createDataPrepareTool(() => {
    calls.dataPrepare += 1;
    return {
      setup: async () => ({}),
      teardown: async () => {},
      generate: async () => ({ account: { id: 'acct-1', nickname: 'n', project_id: 1 }, taskIds: ['t1'] }),
    };
  }));
  if (!options?.skipExecTool) {
    tools.register(createExecutionRunTool());
  }
  const processor = pipelineProcessor(() => { calls.runner += 1; });
  const ctx = createAgentContext({
    taskId: 'pipe-1',
    feature: 'resource',
    environment: 'test',
    tools,
    memory,
    llm: new MockLLMProvider(),
    metadata: {
      ...(options?.approve === false ? {} : { executionApproval: APPROVED_EXECUTION }),
      scenarioRunnerOptions: {
        processors: [processor], environmentAvailable: true, policyAllowed: true,
        availableDependencies: new Set(['runtime.caseCleanup']),
        cleanupHooks: new Map([['runtime.caseCleanup', async () => ({})]]),
      },
    },
  });
  return { ctx, memory, calls };
}

describe('agent-pipeline - 完整链路', () => {
  it('端到端产出全部阶段产物与报告', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    expect(r.requirement.feature).toBeTruthy();
    expect(r.testCases.length).toBeGreaterThan(0);
    expect(r.risk.risks.length).toBeGreaterThan(0);
    expect(r.policyGate.verdict).toBe('ALLOW');
    expect(r.dataPlan.needsSetup).toBe(false);
    expect(r.outcome.executed).toBe(false); // 仍有 DESIGNED_ONLY，严格区分“部分已执行”与“全部已执行”
    expect(r.outcome.results.some((result) => result.executed && result.processorInvoked)).toBe(true);
    expect(r.outcome.total).toBe(r.testCases.length);
    expect(r.outcome.passed).toBeGreaterThan(0);
    expect(r.report.summary.overall).toBe('fail');
    expect(r.stages.requirement).toBe(true);
    expect(r.stages.testDesign).toBe(true);
    expect(r.stages.risk).toBe(true);
    expect(r.stages.policyGate).toBe(true);
    expect(r.stages.data).toBe(true);
    expect(r.stages.execution).toBe(true);
    expect(r.stages.analysis).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('执行结果写入记忆（执行摘要）', async () => {
    const { ctx, memory } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO }, ctx);
    const all = await memory.query({ limit: 50 });
    expect(all.some((record) => record.type === 'execution' && record.data?.feature === r.requirement.feature)).toBe(true);
  });

  it('skipExecution 时仅产出计划，不执行', async () => {
    const { ctx } = makeContext({ skipExecTool: true });
    const r = await runAgentPipeline(
      { requirementText: DEMO, options: { skipExecution: true } },
      ctx,
    );
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results).toHaveLength(r.testCases.length);
    expect(r.outcome.results.every((item) => item.status === 'NOT_EXECUTED' && item.pass === false)).toBe(true);
    expect(r.stages.execution).toBe(false);
    expect(r.report.summary.total).toBe(r.testCases.length); // 分析基于计划
  });

  it('未注册执行 Tool 时执行阶段标记未执行但流程继续', async () => {
    const { ctx } = makeContext({ skipExecTool: true });
    const r = await runAgentPipeline({ requirementText: DEMO }, ctx);
    expect(r.outcome.executed).toBe(false);
    expect(r.stages.execution).toBe(false);
    expect(r.report).toBeDefined();
  });

  it('Quality Gate 未产出 Case 时 fail-close，不调用 Runner 也不伪造 PASS', async () => {
    const { ctx, calls } = makeContext();
    const r = await runAgentPipeline({ requirementText: '# Context\n仅供背景说明，无验收标准。' }, ctx);

    expect(r.testCases).toHaveLength(0);
    expect(calls.runner).toBe(0);
    expect(r.outcome).toMatchObject({ total: 0, passed: 0, executed: false });
    expect(r.stages.execution).toBe(false);
  });

  it('Policy Gate 未获批准时在数据准备和 Runner 之前阻断', async () => {
    const { ctx, calls } = makeContext({ approve: false });
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    expect(r.policyGate.allowed).toBe(false);
    expect(r.policyGate.verdict).toBe('APPROVAL_REQUIRED');
    expect(r.stages.data).toBe(true); // 纯 Data Plan 在 Gate 前生成
    expect(r.stages.dataPrepare).toBe(false);
    expect(calls.dataPrepare).toBe(0);
    expect(calls.runner).toBe(0);
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results).toHaveLength(r.testCases.length);
    expect(r.outcome.results.every((item) => item.status === 'BLOCKED' && item.pass === false)).toBe(true);
    expect(r.outcome.passed).toBe(0);
  });

  it('Policy Gate 人工审批成功后允许 V2 Case 进入 Scenario Runtime', async () => {
    const { ctx, calls } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    expect(r.policyGate).toMatchObject({ allowed: true, verdict: 'ALLOW' });
    expect(r.stages.dataPrepare).toBe(true);
    expect(calls.dataPrepare).toBe(0);
    expect(calls.runner).toBeGreaterThan(0);
    expect(r.outcome.results.some((result) => result.executed && result.processorInvoked)).toBe(true);
  });

  it('Orchestrator 六类策略汇总后，Gate 与 Runner 消费同一份 Execution Plan', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);
    const fingerprint = executionPlanFingerprint(r.executionPlan);

    expect(r.stages.executionPlan).toBe(true);
    expect(r.stages.policyGate).toBe(true);
    expect(r.stages.deterministicOutcome).toBe(true);
    expect(r.policyGate.executionPlanFingerprint).toBe(fingerprint);
    expect(executionPlanFingerprint(r.outcome.plan!)).toBe(fingerprint);
    expect(r.policies.risk.overall).toBe(r.risk.summary.overall);
    expect(r.policies.budget).toBeDefined();
    expect(r.policies.model.requirement?.model).toBeTruthy();
    expect(r.policies.prompt.some((item) => item.task === 'requirement')).toBe(true);
    expect(r.policies.data.factoryName).toBe(r.dataPlan.factoryName);
    expect(r.policies.approval).toMatchObject({ status: 'APPROVED', evidencePresent: true });
  });

  it('dry-run 只产出计划状态，不准备数据也不调用 Runner', async () => {
    const { ctx, calls } = makeContext({ approve: false });
    const r = await runAgentPipeline(
      { requirementText: DEMO, environment: 'production', options: { dryRun: true } },
      ctx,
    );

    expect(r.policyGate.verdict).toBe('ALLOW');
    expect(r.policyGate.realExecution).toBe(false);
    expect(r.stages.data).toBe(true);
    expect(r.stages.dataPrepare).toBe(false);
    expect(calls.dataPrepare).toBe(0);
    expect(calls.runner).toBe(0);
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results.every((item) => item.status === 'NOT_EXECUTED' && item.pass === false)).toBe(true);
  });

  it('历史失败记忆补充风险项', async () => {
    const { ctx, memory } = makeContext();
    // 预置历史失败：tc-09 两次失败
    for (let i = 0; i < 2; i++) {
      await memory.save({
        id: `pre-${i}`,
        type: 'failure',
        createdAt: new Date().toISOString(),
        data: { caseId: 'tc-09', category: 'error', message: '历史失败', evidence: [] },
        tags: ['user', 'failure'],
      });
    }
    const r = await runAgentPipeline({ requirementText: DEMO }, ctx);
    expect(r.risk.risks.some((x) => x.category === 'compatibility' && x.title.includes('tc-09'))).toBe(true);
  });
});

describe('agent-pipeline - Deterministic Outcome', () => {
  it('忽略 Runner 虚报 totals/PASS：无断言改为 BLOCKED，缺失用例补 NOT_EXECUTED', () => {
    const testCases = [
      { id: 'tc-1', feature: 'wan3', name: '虚报通过', priority: 'P0', tags: [], steps: [], assertions: [] },
      { id: 'tc-2', feature: 'wan3', name: '未返回', priority: 'P1', tags: [], steps: [], assertions: [] },
    ] as never;
    const plan: ExecutionPlan = {
      order: ['tc-1', 'tc-2'], concurrency: 1, enableRetry: true, reason: 'contract',
    };
    const raw: ExecutionOutcome = {
      feature: 'wan3', total: 99, passed: 99, failed: 0, timedOut: 0, passRate: 100,
      results: [{ caseId: 'tc-1', name: '虚报通过', executed: true, status: 'PASS', pass: true, passRate: 100, checks: [] }],
      reports: [], executed: true,
    };

    const result = deterministicExecutionOutcome('wan3', testCases, raw, plan);
    expect(result).toMatchObject({ total: 2, passed: 0, failed: 2, passRate: 0, executed: false });
    expect(result.results[0]).toMatchObject({ status: 'BLOCKED', pass: false });
    expect(result.results[1]).toMatchObject({ status: 'NOT_EXECUTED', pass: false });
  });
});

describe('agent-pipeline - Phase 10-18 增强阶段', () => {
  it('完整链路产出增强产物（selection/coverage/rca/defect/approval/trace）', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    // Selection
    expect(r.stages.selection).toBe(true);
    expect(r.selection).toBeDefined();
    expect(r.selection!.selectedCases.length).toBeGreaterThan(0);
    expect(Object.keys(r.selection!.reasons ?? {}).length).toBeGreaterThan(0);

    // Coverage
    expect(r.stages.coverage).toBe(true);
    expect(r.coverage).toBeDefined();
    expect(r.coverage!.feature).toBe(r.requirement.feature);
    expect(r.coverage!.dimensions.length).toBeGreaterThan(0);

    // 无产品失败时 RCA 可以为空，但阶段必须真实完成。
    expect(r.stages.rca).toBe(true);
    expect(r.rcas).toBeDefined();

    // Defect（LLM 空输出 → 回退规则，产出 DRAFT 草稿）
    expect(r.stages.defect).toBe(true);
    expect(r.defects).toBeDefined();

    // Approval（默认不自动批准：REVIEW → pending，不拒绝）
    expect(r.stages.approval).toBe(true);
    expect(r.approvals).toBeDefined();
    expect(r.approvalResults?.every((x) => x.verdict !== 'rejected')).toBe(true);

    // Trace
    expect(r.trace).toBeDefined();
    expect(r.trace!.spans.length).toBeGreaterThan(0);
    expect(r.trace!.spans.some((s) => s.agent === 'root-cause')).toBe(true);
    expect(r.trace!.spans.every((s) => s.startAt > 0)).toBe(true);
    // Mock LLM 同步执行，耗时可能为 0ms；只需验证耗时已记录且进入汇总
    expect(r.trace!.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(r.trace!.summary).toContain('LLM');
    expect(r.trace!.summary).toContain('ms');
  });

  it('增强阶段可全部关闭，核心阶段不受影响', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline(
      {
        requirementText: DEMO,
        options: {
          runSelection: false,
          runCoverage: false,
          runRca: false,
          runDefect: false,
          runHealing: false,
          runApproval: false,
          runTrace: false,
        },
      },
      ctx,
    );
    expect(r.selection).toBeUndefined();
    expect(r.coverage).toBeUndefined();
    expect(r.rcas).toBeUndefined();
    expect(r.defects).toBeUndefined();
    expect(r.healing).toBeUndefined();
    expect(r.approvals).toBeUndefined();
    expect(r.trace).toBeUndefined();
    expect(r.stages.requirement).toBe(true);
    expect(r.stages.risk).toBe(true);
    expect(r.stages.analysis).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  it('autoApprove 时 REVIEW 级审批自动通过并写入审计日志', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline(
      { requirementText: DEMO, environment: 'test', options: { autoApprove: true } },
      ctx,
    );
    expect(r.approvalResults?.length).toBeGreaterThan(0);
    expect(r.approvalResults!.every((x) => x.verdict === 'approved')).toBe(true);
    expect(r.audit?.length).toBe(r.approvals!.length);
    expect(r.audit!.every((a) => a.actor === 'system')).toBe(true);
  });

  it('预算超限时增强阶段跳过但核心阶段继续', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline(
      { requirementText: DEMO, options: { budget: { maxAgentCalls: 4 } } },
      ctx,
    );
    // selection 为第 4 个 Agent 调用，达上限 → 跳过；后续增强阶段均跳过
    expect(r.stages.selection).toBe(false);
    expect(r.stages.coverage).toBe(false);
    expect(r.stages.rca).toBe(false);
    expect(r.stages.defect).toBe(false);
    // 核心阶段继续
    expect(r.stages.requirement).toBe(true);
    expect(r.stages.risk).toBe(true);
    expect(r.stages.analysis).toBe(true);
    expect(r.budgetStatus?.exceededAny).toBe(true);
    expect(r.budgetStatus?.exceeded).toContain('maxAgentCalls');
  });

  it('useSelection 时按选中用例集执行且流程完整', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline(
      { requirementText: DEMO, options: { useSelection: true } },
      ctx,
    );
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results.some((result) => result.executed && result.processorInvoked)).toBe(true);
    expect(r.outcome.total).toBeGreaterThan(0);
    expect(r.stages.execution).toBe(true);
  });
});
