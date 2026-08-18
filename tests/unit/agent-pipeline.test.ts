// 单元测试：Agent Pipeline（统一串联：Requirement → TestDesign → Risk → Data → Execution → Memory → Analysis）
import { describe, it, expect } from 'vitest';
import {
  runAgentPipeline,
  createAgentContext,
  createExecutionRunTool,
  createDataPrepareTool,
  JsonMemoryStore,
  NoopMemory,
  ToolRegistry,
  computeOutcome,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEMO =
  '测试 WAN3 文生视频，覆盖 720P、1080P 分辨率，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';

/** mock 执行器：tc-02 失败，其余通过 */
function mockRunner() {
  return async (loaded: Array<{ name: string; feature?: string; def: { extra?: Record<string, unknown>; scene?: string; tags?: string[] } }>) => {
    const results = loaded.map((c) => {
      const caseId = String(c.def.extra?.agentTestCaseId ?? c.name);
      return {
        caseId,
        name: c.name,
        feature: c.feature,
        scene: c.def.scene,
        priority: 'P0',
        tags: c.def.tags,
        pass: caseId !== 'tc-02',
        passRate: caseId === 'tc-02' ? 0 : 100,
        error: caseId === 'tc-02' ? '断言失败' : undefined,
        durationMs: 8,
        checks: [{ name: 's', pass: caseId !== 'tc-02', detail: caseId === 'tc-02' ? 'failed' : 'ok', level: 'P0' }],
      };
    });
    return computeOutcome('wan3', results, { reports: ['r.json'], executed: true });
  };
}

function makeContext(options?: { skipExecTool?: boolean; memory?: JsonMemoryStore }): { ctx: AgentContext; memory: JsonMemoryStore } {
  const memory = options?.memory ?? new JsonMemoryStore(path.join(os.tmpdir(), `agent-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`));
  const tools = new ToolRegistry();
  tools.register(createDataPrepareTool(() => ({
    setup: async () => ({}),
    teardown: async () => {},
    generate: async () => ({ account: { id: 'acct-1', nickname: 'n', project_id: 1 }, taskIds: ['t1'] }),
  })));
  if (!options?.skipExecTool) {
    tools.register(createExecutionRunTool(mockRunner() as never));
  }
  const ctx = createAgentContext({
    taskId: 'pipe-1',
    feature: 'wan3',
    environment: 'test',
    tools,
    memory,
    llm: new MockLLMProvider(),
  });
  return { ctx, memory };
}

describe('agent-pipeline - 完整链路', () => {
  it('端到端产出全部阶段产物与报告', async () => {
    const { ctx } = makeContext();
    const r = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, ctx);

    expect(r.requirement.feature).toBe('wan3');
    expect(r.testCases.length).toBeGreaterThan(0);
    expect(r.risk.risks.length).toBeGreaterThan(0);
    expect(r.dataPlan.needsSetup).toBe(true);
    expect(r.dataContext.account?.id).toBe('acct-1'); // 经 data.prepare 准备
    expect(r.outcome.executed).toBe(true);
    expect(r.outcome.total).toBe(r.testCases.length);
    expect(r.outcome.failed).toBe(1); // tc-02
    expect(r.report.summary.overall).toBe('fail');
    expect(r.report.failedCases.some((c) => c.caseId === 'tc-02')).toBe(true);
    expect(r.stages.requirement).toBe(true);
    expect(r.stages.testDesign).toBe(true);
    expect(r.stages.risk).toBe(true);
    expect(r.stages.data).toBe(true);
    expect(r.stages.execution).toBe(true);
    expect(r.stages.analysis).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('执行结果写入记忆（执行摘要 + 失败记录）', async () => {
    const { ctx, memory } = makeContext();
    await runAgentPipeline({ requirementText: DEMO }, ctx);
    const all = await memory.query({ limit: 50 });
    expect(all.some((r) => r.type === 'execution' && r.data?.feature === 'wan3')).toBe(true);
    expect(all.some((r) => r.type === 'failure' && r.data?.caseId === 'tc-02')).toBe(true);
  });

  it('skipExecution 时仅产出计划，不执行', async () => {
    const { ctx } = makeContext({ skipExecTool: true });
    const r = await runAgentPipeline(
      { requirementText: DEMO, options: { skipExecution: true } },
      ctx,
    );
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results).toHaveLength(0);
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

  it('历史失败记忆补充风险项', async () => {
    const { ctx, memory } = makeContext();
    // 预置历史失败：tc-09 两次失败
    for (let i = 0; i < 2; i++) {
      await memory.save({
        id: `pre-${i}`,
        type: 'failure',
        createdAt: new Date().toISOString(),
        data: { caseId: 'tc-09', category: 'error', message: '历史失败', evidence: [] },
        tags: ['wan3', 'failure'],
      });
    }
    const r = await runAgentPipeline({ requirementText: DEMO }, ctx);
    expect(r.risk.risks.some((x) => x.category === 'compatibility' && x.title.includes('tc-09'))).toBe(true);
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
    expect(r.coverage!.feature).toBe('wan3');
    expect(r.coverage!.dimensions.length).toBeGreaterThan(0);

    // RCA（tc-02 失败用例）
    expect(r.stages.rca).toBe(true);
    expect(r.rcas?.some((x) => x.caseId === 'tc-02')).toBe(true);

    // Defect（LLM 空输出 → 回退规则，产出 DRAFT 草稿）
    expect(r.stages.defect).toBe(true);
    expect(r.defects?.some((d) => d.status === 'DRAFT')).toBe(true);

    // Approval（默认不自动批准：REVIEW → pending，不拒绝）
    expect(r.stages.approval).toBe(true);
    expect(r.approvals?.some((a) => a.operation === 'create-defect')).toBe(true);
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
    expect(r.outcome.executed).toBe(true);
    expect(r.outcome.total).toBeGreaterThan(0);
    expect(r.stages.execution).toBe(true);
  });
});
