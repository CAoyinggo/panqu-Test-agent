// 单元测试：QA Workflow（Phase 20.6）
// 覆盖：normalizeExecutionOutcome / analyzeFailures（Mode C）/
// saveTaskRecord + loadTaskRecord + resumeTask（Mode D）
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeExecutionOutcome,
  analyzeFailures,
  saveTaskRecord,
  loadTaskRecord,
  resumeTask,
  DEFAULT_TASK_DIR,
} from '../../src/qa/workflows.js';
import {
  createAgentContext,
  ToolRegistry,
  NoopMemory,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { CaseExecutionResult, ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import type { TaskRecord } from '../../src/qa/workflows.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-workflow-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 'qa-test',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

const failedResult: CaseExecutionResult = {
  caseId: 'c1',
  name: '参数错误码断言',
  feature: 'wan3',
  pass: false,
  passRate: 0,
  error: '断言错误码失败：期望 4001，实际 4003',
  checks: [{ name: '错误码断言', pass: false, detail: '断言错误码失败：期望 4001，实际 4003' }],
};

const okResult: CaseExecutionResult = {
  caseId: 'c2',
  name: '任务提交',
  feature: 'wan3',
  pass: true,
  passRate: 100,
  checks: [{ name: '提交成功', pass: true, detail: 'ok' }],
};

const outcome: ExecutionOutcome = {
  feature: 'wan3',
  total: 2,
  passed: 1,
  failed: 1,
  timedOut: 0,
  passRate: 50,
  results: [failedResult, okResult],
  reports: [],
  executed: true,
  summary: '1 通过，1 失败',
};

describe('normalizeExecutionOutcome', () => {
  it('直接 ExecutionOutcome', () => {
    const o = normalizeExecutionOutcome(outcome);
    expect(o.feature).toBe('wan3');
    expect(o.results).toHaveLength(2);
  });

  it('CaseExecutionResult[] 数组', () => {
    const o = normalizeExecutionOutcome([failedResult, okResult]);
    expect(o.results).toHaveLength(2);
    expect(o.failed).toBe(1);
  });

  it('agent-summary.json 嵌套（outcome / execution）', () => {
    expect(normalizeExecutionOutcome({ outcome }).results).toHaveLength(2);
    expect(normalizeExecutionOutcome({ execution: { outcome } }).results).toHaveLength(2);
  });

  it('非法输入抛错', () => {
    expect(() => normalizeExecutionOutcome({ foo: 1 })).toThrow();
    expect(() => normalizeExecutionOutcome('x')).toThrow();
  });
});

describe('analyzeFailures - Mode C（只分析失败）', () => {
  const llm = new MockLLMProvider({ defaultResponse: JSON.stringify({ reason: '错误码调整，待确认' }) });
  const ctx = makeContext(llm);

  it('产出 RCA / 缺陷草稿 / 自愈建议 / 审批', async () => {
    const out = await analyzeFailures(outcome, ctx, { maxRca: 10, maxDefects: 10 });
    expect(out.feature).toBe('wan3');
    expect(out.failedCount).toBe(1);
    expect(out.rcas).toHaveLength(1);
    expect(out.rcas[0].caseId).toBe('c1');
    // 错误码不匹配 → 自愈建议（error-code，风险 high）
    expect(out.healing?.suggestions).toHaveLength(1);
    expect(out.healing!.suggestions[0].type).toBe('error-code');
    // 缺陷草稿（仅 DRAFT）
    expect(out.defects.length).toBeGreaterThanOrEqual(1);
    expect(out.defects.every((d) => d.status === 'DRAFT')).toBe(true);
    // 审批：错误码自愈高风险 → 至少 pending
    expect(out.approvals.length).toBeGreaterThanOrEqual(1);
  });

  it('无失败用例 → 不产出分析', async () => {
    const clean: ExecutionOutcome = { feature: 'wan3', total: 1, passed: 1, failed: 0, timedOut: 0, passRate: 100, results: [okResult], reports: [], executed: true, summary: '全过' };
    const out = await analyzeFailures(clean, ctx, {});
    expect(out.failedCount).toBe(0);
    expect(out.rcas).toHaveLength(0);
    expect(out.defects).toHaveLength(0);
  });
});

describe('TaskRecord 持久化（Mode D 依据）', () => {
  it('save + load 往返一致', () => {
    const dir = tmpDir();
    const record: TaskRecord = {
      taskId: 'task-demo',
      feature: 'wan3',
      requirement: '测试错误码',
      environment: 'test',
      testCases: [],
      outcome,
      failedCases: [failedResult],
      updatedAt: '2026-08-18T00:00:00.000Z',
    };
    const file = saveTaskRecord(record, dir);
    expect(fs.existsSync(file)).toBe(true);
    const loaded = loadTaskRecord('task-demo', dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe('task-demo');
    expect(loaded!.failedCases).toHaveLength(1);
  });

  it('不存在任务 → null', () => {
    expect(loadTaskRecord('no-such', tmpDir())).toBeNull();
  });
});

describe('resumeTask - Mode D（RCA → Healing → Approval → 应用 → 重新执行）', () => {
  it('获批自愈补丁应用到 Test DSL 并重新执行恢复', async () => {
    const llm = new MockLLMProvider({ defaultResponse: JSON.stringify({ reason: '错误码为预期业务调整' }) });
    const ctx = makeContext(llm);

    const testCase: TestCase = {
      id: 'c1',
      feature: 'wan3',
      name: '参数错误码断言',
      priority: 'P2',
      tags: [],
      steps: [{ action: 'submit' }],
      assertions: [{ target: 'custom', operator: 'equals', expected: '4001', severity: 'P2' }],
    };

    const record: TaskRecord = {
      taskId: 'task-resume',
      feature: 'wan3',
      requirement: '测试错误码',
      environment: 'test',
      testCases: [testCase],
      outcome,
      failedCases: [failedResult],
      updatedAt: '2026-08-18T00:00:00.000Z',
    };

    // 模拟「真实后端已变更为 4003」的重新执行器
    const runner = async (def: TestCase): Promise<CaseExecutionResult> => {
      const actual = 4003;
      const checks = (def.assertions ?? []).map((a) => {
        const pass = String(a.expected) === String(actual);
        return {
          name: a.message ?? '错误码断言',
          pass,
          detail: pass ? `ok: ${actual}` : `断言错误码失败：期望 ${String(a.expected)}，实际 ${actual}`,
          level: a.severity ?? 'P2',
        };
      });
      const pass = checks.every((c) => c.pass);
      return { caseId: def.id, name: def.name, feature: def.feature, pass, passRate: pass ? 100 : 0, error: pass ? undefined : checks[0]?.detail, checks };
    };

    // 不自动批准：获批为 0，不应用
    const blocked = await resumeTask(record, ctx, runner, { autoApprove: false });
    expect(blocked.applied).toHaveLength(0);
    expect(blocked.reexecuted).toBeUndefined();

    // 自动批准：自愈补丁获批并应用，重新执行恢复
    const out = await resumeTask(record, ctx, runner, { autoApprove: true });
    expect(out.healing?.suggestions).toHaveLength(1);
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0].caseId).toBe('c1');
    expect(out.applied[0].diff).toContain('4003');
    expect(out.reexecuted).toBeDefined();
    expect(out.reexecuted!.total).toBe(1);
    expect(out.recoveredCount).toBe(1);
    expect(out.stillFailed).toHaveLength(0);
  });

  it('无失败用例 → 不重新执行', async () => {
    const llm = new MockLLMProvider();
    const ctx = makeContext(llm);
    const record: TaskRecord = {
      taskId: 'task-clean', feature: 'wan3', requirement: 'x', environment: 'test',
      testCases: [], outcome: { ...outcome, failed: 0, results: [okResult] }, failedCases: [],
      updatedAt: '',
    };
    const out = await resumeTask(record, ctx, async (d) => okResult, {});
    expect(out.reexecuted).toBeUndefined();
    expect(out.stillFailed).toHaveLength(0);
  });
});
