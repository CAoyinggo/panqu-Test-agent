// Phase 20.5 Self-Healing 真实验证：3 个真实变更场景闭环
// 场景 1：data.result.url → data.output.url（JSON Path 结构变化）
// 场景 2：status → taskStatus（API 字段重命名）
// 场景 3：错误码 4001 → 4003（错误码业务调整）
// 验证完整闭环：发现失效 → 分析新响应 → 生成 Patch/Diff → 人工审批 →
//           应用 Patch → 重新执行 → 测试恢复。
// 不能只验证「Agent 找到了新字段」，必须验证 Patch → 重新执行 → 测试恢复。
import { describe, it, expect } from 'vitest';
import {
  SelfHealingAgent,
  runHealingLoop,
  applyHealingPatch,
  parseHealingPatch,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
} from '../../../src/agents/index.js';
import { MockLLMProvider } from '../../../src/llm/index.js';
import type { AgentContext } from '../../../src/agents/core/agent-context.js';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import type { CaseExecutionResult } from '../../../src/agents/execution/execution-schema.js';
import type { HealingAnalysis } from '../../../src/agents/self-healing/healing-schema.js';

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-heal-real',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

/** 按点分路径取值 */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * 构造「真实变更后端」的重新执行器：
 * 用当前后端响应（新结构 / 新错误码）求值测试用例断言。
 */
function makeRunner(response: Record<string, unknown> | { code: number }) {
  return async (def: TestCase): Promise<CaseExecutionResult> => {
    const checks = (def.assertions ?? []).map((a) => {
      if (a.operator === 'equals' && a.path) {
        const val = getByPath(response, a.path);
        const pass = val !== undefined && String(val) === String(a.expected);
        return {
          name: `${a.path} 断言`,
          pass,
          detail: pass
            ? `ok: ${String(val)}`
            : `断言 ${a.path} 失败：期望 ${String(a.expected)}，实际 ${val === undefined ? 'undefined' : String(val)}`,
          level: a.severity ?? 'P0',
        };
      }
      if (a.operator === 'equals' && a.target === 'custom' && typeof a.expected === 'string') {
        const actual = (response as { code?: unknown }).code;
        const pass = String(actual) === String(a.expected);
        return {
          name: '错误码断言',
          pass,
          detail: pass
            ? `ok: ${String(actual)}`
            : `断言错误码失败：期望 ${a.expected}，实际 ${String(actual)}`,
          level: a.severity ?? 'P0',
        };
      }
      return { name: a.message ?? '断言', pass: true, detail: 'skip' };
    });
    const pass = checks.every((c) => c.pass);
    return {
      caseId: def.id,
      name: def.name,
      feature: def.feature,
      pass,
      passRate: pass ? 100 : 0,
      error: pass ? undefined : checks.find((c) => !c.pass)?.detail,
      checks,
    };
  };
}

/** 场景 1：data.result.url → data.output.url */
const SCENE1_RESPONSE = { data: { output: { url: 'https://cdn.example.com/v.mp4' } } };
function scene1TestCase(): TestCase {
  return {
    id: 'scene1-001',
    feature: 'wan3',
    name: '文生视频 URL 断言',
    priority: 'P0',
    tags: ['wan3', 'healing'],
    steps: [{ action: 'submit', scene: 'video', input: { prompt: 'hello', duration: '5s' } }],
    assertions: [
      { target: 'response', path: 'data.result.url', operator: 'equals', expected: 'https://cdn.example.com/v.mp4', severity: 'P0' },
    ],
  };
}

/** 场景 2：status → taskStatus */
const SCENE2_RESPONSE = { data: { task: { taskStatus: 'SUCCESS' } } };
function scene2TestCase(): TestCase {
  return {
    id: 'scene2-001',
    feature: 'wan3',
    name: '任务状态断言',
    priority: 'P1',
    tags: ['wan3', 'healing'],
    steps: [{ action: 'wait', until: 'SUCCESS' }],
    assertions: [
      { target: 'response', path: 'data.task.status', operator: 'equals', expected: 'SUCCESS', severity: 'P1' },
    ],
  };
}

/** 场景 3：错误码 4001 → 4003 */
const SCENE3_RESPONSE = { code: 4003, message: '参数已调整' };
function scene3TestCase(): TestCase {
  return {
    id: 'scene3-001',
    feature: 'wan3',
    name: '参数错误码断言',
    priority: 'P2',
    tags: ['wan3', 'healing'],
    steps: [{ action: 'submit', scene: 'video', input: { prompt: '', duration: '1s' } }],
    assertions: [
      { target: 'custom', operator: 'equals', expected: '4001', message: '错误码断言', severity: 'P2' },
    ],
  };
}

describe('Phase 20.5 - 真实变更场景闭环验证', () => {
  const llm = new MockLLMProvider({ defaultResponse: JSON.stringify({ reason: '服务端结构已调整，按新响应结构断言' }) });
  const agent = new SelfHealingAgent();
  const ctx = makeContext(llm);

  it('场景 1：data.result.url → data.output.url（JSON Path 结构变化）全闭环恢复', async () => {
    const testCase = scene1TestCase();
    const runner = makeRunner(SCENE1_RESPONSE);

    // 1) 旧断言对上新后端 → 失败
    const failedResult = await runner(testCase);
    expect(failedResult.pass).toBe(false);
    expect(failedResult.error).toContain('data.result.url');

    // 2) 自愈 Agent：发现 Path 失效 → 分析新响应 → 生成 Patch
    const analysis: HealingAnalysis = await agent.execute(
      { feature: 'wan3', failedCases: [failedResult], actualSchema: SCENE1_RESPONSE },
      ctx,
    );
    expect(analysis.suggestions).toHaveLength(1);
    const s = analysis.suggestions[0];
    expect(s.oldPath).toBe('data.result.url');
    expect(s.newPath).toBe('data.output.url');
    expect(s.patch).toContain("data.output.url");
    expect(parseHealingPatch(s.patch)).toEqual({ from: 'data.result.url', to: 'data.output.url' });

    // 3) 审批拒绝 → 不应用补丁，测试保持失败
    const blocked = await runHealingLoop({
      feature: 'wan3', testCase, failedResult, analysis,
      runner, environment: 'test', humanApproval: 'rejected',
    });
    expect(blocked.approval.granted).toBe(false);
    expect(blocked.applied).toBeUndefined();
    expect(blocked.recovered).toBe(false);

    // 4) 人工审批通过 → 应用 Patch → 重新执行 → 测试恢复
    const loop = await runHealingLoop({
      feature: 'wan3', testCase, failedResult, analysis,
      runner, environment: 'test', humanApproval: 'approved',
    });
    expect(loop.detected).toBe(true);
    expect(loop.approval.granted).toBe(true);
    expect(loop.applied).toBeDefined();
    expect(loop.applied!.diff).toContain("data.output.url");
    expect(loop.applied!.def.assertions[0].path).toBe('data.output.url');
    expect(loop.reexecuted!.pass).toBe(true);
    expect(loop.recovered).toBe(true);
  });

  it('场景 2：status → taskStatus（API 字段重命名）全闭环恢复', async () => {
    const testCase = scene2TestCase();
    const runner = makeRunner(SCENE2_RESPONSE);

    const failedResult = await runner(testCase);
    expect(failedResult.pass).toBe(false);
    expect(failedResult.error).toContain('data.task.status');

    const analysis: HealingAnalysis = await agent.execute(
      { feature: 'wan3', failedCases: [failedResult], actualSchema: SCENE2_RESPONSE },
      ctx,
    );
    expect(analysis.suggestions).toHaveLength(1);
    const s = analysis.suggestions[0];
    expect(s.type).toBe('api-field'); // 叶子字段重命名
    expect(s.oldPath).toBe('data.task.status');
    expect(s.newPath).toBe('data.task.taskStatus');

    const loop = await runHealingLoop({
      feature: 'wan3', testCase, failedResult, analysis,
      runner, environment: 'test', humanApproval: 'approved',
    });
    expect(loop.applied!.def.assertions[0].path).toBe('data.task.taskStatus');
    expect(loop.recovered).toBe(true);
  });

  it('场景 3：错误码 4001 → 4003（错误码业务调整）全闭环恢复（风险 high 需人工确认）', async () => {
    const testCase = scene3TestCase();
    const runner = makeRunner(SCENE3_RESPONSE);

    const failedResult = await runner(testCase);
    expect(failedResult.pass).toBe(false);
    expect(failedResult.error).toContain('4001');

    const analysis: HealingAnalysis = await agent.execute(
      { feature: 'wan3', failedCases: [failedResult], actualSchema: undefined },
      ctx,
    );
    expect(analysis.suggestions).toHaveLength(1);
    const s = analysis.suggestions[0];
    expect(s.type).toBe('error-code');
    expect(s.oldPath).toBe('error.code');
    expect(s.newPath).toBe('4003');
    expect(s.risk).toBe('high'); // 修改期望错误码可能掩盖回归缺陷 → 高风险
    expect(s.reason).toContain('人工确认');

    // 补丁：更新期望错误码
    const applied = applyHealingPatch(s, testCase);
    expect(parseHealingPatch(s.patch)).toEqual({ from: '4001', to: '4003' });
    expect(applied.def.assertions[0].expected).toBe('4003');

    // 未审批 → 不应用
    const blocked = await runHealingLoop({
      feature: 'wan3', testCase, failedResult, analysis,
      runner, environment: 'test', humanApproval: 'rejected',
    });
    expect(blocked.recovered).toBe(false);

    // 人工确认为预期业务调整 → 应用 → 恢复
    const loop = await runHealingLoop({
      feature: 'wan3', testCase, failedResult, analysis,
      runner, environment: 'test', humanApproval: 'approved',
    });
    expect(loop.recovered).toBe(true);
    expect(loop.reexecuted!.checks!.every((c) => c.pass)).toBe(true);
  });

  it('未检测到可自愈变更 → 不产出建议、不做修改', async () => {
    const runner = makeRunner(SCENE1_RESPONSE);
    const failedResult: CaseExecutionResult = {
      caseId: 'x-1', name: '模型服务 503', feature: 'wan3', pass: false, passRate: 0,
      error: 'HTTP 503 Service Unavailable',
      checks: [{ name: '任务成功', pass: false, detail: 'expected SUCCESS, got 503' }],
    };
    const analysis: HealingAnalysis = await agent.execute(
      { feature: 'wan3', failedCases: [failedResult] },
      ctx,
    );
    expect(analysis.suggestions).toHaveLength(0);
    const loop = await runHealingLoop({
      feature: 'wan3', testCase: scene1TestCase(), failedResult, analysis,
      runner, environment: 'test', humanApproval: 'approved',
    });
    expect(loop.detected).toBe(false);
    expect(loop.recovered).toBe(false);
  });
});
