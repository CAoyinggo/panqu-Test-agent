// 端到端验收：WAN3 文生视频 15 步闭环 Demo（Phase 10-18 全链路）
// 场景：测试 WAN3 文生视频功能，覆盖正常、边界、异常、积分、并发和模型异常
// 15 步闭环：
//   1 需求解析 → 2 测试设计 → 3 风险评估 → 4 智能选择 → 5 覆盖分析 →
//   6 数据准备 → 7 执行 → 8 结果分析 → 9 根因分析(RCA) → 10 缺陷草稿(Defect) →
//   11 自愈建议(Healing) → 12 分级审批(Approval) → 13 记忆写入(Memory) →
//   14 观测(Trace) → 15 预算控制(Budget)
// 使用 MockLLM + mock 执行引擎（第 2/3/6 条失败：超时 / 路径失效 / 积分扣费），确定性可重复。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentContext,
  createDataPrepareTool,
  JsonMemoryStore,
  ToolRegistry,
  runAgentPipeline,
} from '../../src/agents/index.js';
import type { AgentTool } from '../../src/agents/tools/tool.js';
import type { ExecutionOutcome, CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';
import type { LoadedCase } from '../../src/cases/loader.js';
import { MockLLMProvider } from '../../src/llm/index.js';

const DEMO = '测试 WAN3 文生视频功能，覆盖正常、边界、异常、积分、并发和模型异常';

/** mock 执行引擎：制造 3 条失败（超时 / 路径失效 / 积分扣费） */
const mockRunTool: AgentTool<{ cases: LoadedCase[]; options?: unknown }, ExecutionOutcome> = {
  name: 'execution.run',
  description: 'mock 执行引擎（端到端 Demo）',
  inputSchema: {},
  outputSchema: {},
  permission: 'safe',
  async execute(input) {
    const loaded = (input?.cases ?? []) as LoadedCase[];
    const FAIL: Record<number, { error: string; detail: string; timedOut?: boolean }> = {
      1: { error: '503 服务不可用，接口超时', detail: 'HTTP 503', timedOut: true },
      2: { error: '响应结构变化：data.videos.list 字段 undefined，实际返回 data.videos.items', detail: 'path mismatch' },
      5: { error: '积分扣费异常：用户积分不足，扣费失败', detail: 'billing failed' },
    };
    const results: CaseExecutionResult[] = loaded.map((c, i) => {
      const f = FAIL[i];
      const pass = !f;
      const caseId = String(c.def?.extra?.agentTestCaseId ?? c.def?.name ?? c.name);
      const priority = Array.isArray(c.def?.tags) ? c.def.tags.find((t) => /^P[0-3]$/.test(t)) : undefined;
      return {
        caseId,
        name: c.name ?? caseId,
        feature: c.feature ?? 'wan3',
        priority: priority ?? 'P0',
        pass,
        passRate: pass ? 1 : 0,
        error: f?.error,
        timedOut: f?.timedOut,
        durationMs: 10 + i,
        checks: pass ? [] : [{ name: 'assert', pass: false, detail: f?.detail ?? 'failed' }],
      };
    });
    const passed = results.filter((r) => r.pass).length;
    return {
      feature: 'wan3',
      total: results.length,
      passed,
      failed: results.length - passed,
      timedOut: 1,
      passRate: passed / results.length,
      results,
      reports: [],
      executed: true,
      summary: `执行完成：${passed}/${results.length} 通过`,
      plan: {
        order: loaded.map((c) => String(c.def?.extra?.agentTestCaseId ?? c.def?.name ?? c.name)),
        concurrency: 1,
        enableRetry: true,
        reason: 'mock e2e',
      },
    };
  },
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  file = path.join(dir, 'memory.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('端到端验收 - WAN3 文生视频 15 步闭环', () => {
  it('走通全链路并产出全部阶段产物', async () => {
    const memory = new JsonMemoryStore(file);
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool());
    tools.register(mockRunTool);
    const context = createAgentContext({
      taskId: 'e2e-demo',
      feature: 'wan3',
      environment: 'test',
      tools,
      memory,
      llm: new MockLLMProvider(),
    });

    const r = await runAgentPipeline(
      { requirementText: DEMO, environment: 'test', options: { budget: { maxTokens: 100000 } } },
      context,
    );

    // 1 需求解析 / 2 测试设计 / 3 风险评估
    expect(r.stages.requirement).toBe(true);
    expect(r.requirement.feature).toBe('wan3');
    expect(r.testCases.length).toBeGreaterThanOrEqual(6);
    expect(r.risk.risks.length).toBeGreaterThan(0);

    // 4 智能选择 / 5 覆盖分析
    expect(r.stages.selection).toBe(true);
    expect(r.selection!.selectedCases.length).toBeGreaterThan(0);
    expect(r.stages.coverage).toBe(true);
    expect(r.coverage!.dimensions.length).toBeGreaterThan(0);

    // 6 数据准备 / 7 执行
    expect(r.dataPlan).toBeDefined();
    expect(r.outcome.executed).toBe(true);
    expect(r.outcome.failed).toBeGreaterThanOrEqual(3);

    // 8 结果分析
    expect(r.report.findings.length).toBeGreaterThan(0);

    // 9 根因分析（覆盖全部失败用例，evidence 链完整）
    expect(r.rcas!.length).toBeGreaterThanOrEqual(3);
    expect(r.rcas!.every((x) => x.confidence > 0)).toBe(true);
    expect(r.rcas!.some((x) => x.category === 'TIMEOUT')).toBe(true);
    expect(r.rcas!.some((x) => x.category === 'BILLING_ERROR')).toBe(true);

    // 10 缺陷草稿（仅 DRAFT，未提交）
    expect(r.defects!.length).toBeGreaterThanOrEqual(3);
    expect(r.defects!.every((d) => d.status === 'DRAFT')).toBe(true);

    // 11 自愈建议（仅 SUGGESTED，未应用；路径失效可定位新路径）
    expect(r.healing!.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(r.healing!.suggestions.every((s) => s.status === 'SUGGESTED')).toBe(true);
    expect(r.healing!.suggestions[0].oldPath).toContain('data.videos.list');
    expect(r.healing!.suggestions[0].newPath).toContain('data.videos.items');

    // 12 分级审批 + 审计日志（缺陷草稿 + 自愈建议全部产生审批请求）
    expect(r.approvals!.length).toBeGreaterThanOrEqual(3);
    expect(r.audit!.length).toBe(r.approvals!.length);

    // 13 记忆写入（执行摘要 + 逐条失败记录，可持久化检索）
    const all = await memory.query();
    expect(all.length).toBeGreaterThan(0);
    const failures = await memory.query({ type: 'failure' });
    expect(failures.length).toBeGreaterThanOrEqual(3);

    // 14 观测 Trace（各阶段 span 齐全）
    expect(r.trace!.spans.length).toBeGreaterThanOrEqual(10);
    expect(r.trace!.spans.some((s) => s.agent === 'root-cause')).toBe(true);
    expect(r.trace!.spans.some((s) => s.agent === 'approval')).toBe(true);

    // 15 预算控制（未超限，流程完整）
    expect(r.budgetStatus!.exceededAny).toBe(false);

    // 退出码：含超时用例 → 3（有失败 → 1，全部通过 → 0）
    expect(r.exitCode).toBe(3);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('生产环境执行时拒绝危险操作（安全边界联动）', async () => {
    // 模拟真实执行工具被标记 dangerous 且无审批 → 生产环境直接拒绝
    const dangerousTool: AgentTool<{ cmd: string }, string> = {
      name: 'sys.exec',
      description: '执行系统命令',
      inputSchema: {},
      outputSchema: {},
      permission: 'dangerous',
      async execute(input) {
        return input.cmd;
      },
    };
    const tools = new ToolRegistry({ environment: 'prod' });
    tools.register(dangerousTool);
    const context = createAgentContext({
      taskId: 'e2e-safe',
      feature: 'wan3',
      environment: 'prod',
      tools,
      memory: new JsonMemoryStore(file),
      llm: new MockLLMProvider(),
    });
    const res = await tools.call('sys.exec', { cmd: 'rm -rf /' }, context);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('生产环境禁止');
  });
});
