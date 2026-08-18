// 单元测试：Defect Agent（Phase 14 标准缺陷草稿）
// 覆盖：确定性生成（规则）/ LLM 路径 / 只生成 DRAFT 不提交 / 严重度映射 / 归一化
import { describe, it, expect } from 'vitest';
import {
  DefectAgent,
  buildDefectFromRca,
  buildDefect,
  normalizeDefect,
  validateDefect,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  buildRootCause,
  normalizeRootCause,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';
import type { RootCauseAnalysis } from '../../src/agents/analysis/root-cause-schema.js';

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-defect',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

function failCase(): CaseExecutionResult {
  return {
    caseId: 'wan3-001',
    name: '文生视频 1080P+10秒 正常链路',
    feature: 'wan3',
    scene: '1080P 10 秒视频生成',
    pass: false,
    passRate: 0,
    error: 'HTTP 503 Service Unavailable',
    checks: [{ name: '任务状态最终成功', pass: false, detail: 'expected SUCCESS, got 503' }],
  };
}

function rcaOf(category: RootCauseAnalysis['category'], rootCause = '模型服务 503'): RootCauseAnalysis {
  return buildRootCause({
    caseId: 'wan3-001',
    name: '文生视频 1080P+10秒 正常链路',
    category,
    confidence: 0.9,
    rootCause,
    evidenceItems: [
      { type: 'http-response', detail: 'HTTP 状态码：503', certainty: 'fact' },
      { type: 'assertion', detail: '任务状态最终成功 断言失败', certainty: 'fact' },
    ],
    recommendedAction: '检查模型服务',
  });
}

describe('defect - 确定性生成', () => {
  it('基于 RCA 生成草稿：严重度/优先级按分类映射', () => {
    const d = buildDefectFromRca(failCase(), rcaOf('MODEL_ERROR'), 'wan3', 'test', 1);
    expect(d.severity).toBe('P1');
    expect(d.priority).toBe('HIGH');
    expect(d.title).toContain('MODEL_ERROR');
    expect(d.title).toContain('模型服务 503');
    expect(d.status).toBe('DRAFT');
    expect(d.relatedCases).toContain('wan3-001');
    expect(d.rca?.category).toBe('MODEL_ERROR');
    expect(d.evidence.some((e) => e.includes('503'))).toBe(true);
  });

  it('计费错误映射为 P1/HIGH', () => {
    const d = buildDefectFromRca(failCase(), rcaOf('BILLING_ERROR', '积分扣费异常'), 'wan3', 'test', 1);
    expect(d.severity).toBe('P1');
    expect(d.priority).toBe('HIGH');
  });

  it('环境错误映射为 P3/LOW', () => {
    const d = buildDefectFromRca(failCase(), rcaOf('ENVIRONMENT_ERROR'), 'wan3', 'test', 1);
    expect(d.severity).toBe('P3');
    expect(d.priority).toBe('LOW');
  });

  it('无 RCA 时仍可生成草稿（默认 P2/MEDIUM）', () => {
    const d = buildDefectFromRca(failCase(), undefined, 'wan3', 'test', 1);
    expect(d.severity).toBe('P2');
    expect(d.priority).toBe('MEDIUM');
  });
});

describe('defect - LLM 路径', () => {
  it('LLM 生成草稿数组，RCA 引用以确定性为准', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify([
        {
          title: '文生视频生成失败：模型服务 503',
          severity: 'P1',
          priority: 'HIGH',
          description: '1080P 10 秒视频生成任务返回 503',
          steps: ['提交 1080P 10 秒生成任务', '等待任务完成'],
          expected: '任务状态 SUCCESS',
          actual: 'HTTP 503',
          impact: '视频生成功能不可用',
          environment: 'test',
          evidence: ['503'],
          relatedCases: ['wan3-001'],
        },
      ]),
    });
    const agent = new DefectAgent();
    const drafts = await agent.execute(
      { feature: 'wan3', environment: 'test', failedCases: [failCase()], rcas: [rcaOf('MODEL_ERROR')] },
      makeContext(llm),
    );
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.status).toBe('DRAFT');
    expect(d.source).toBe('llm');
    expect(d.severity).toBe('P1');
    expect(d.rca?.category).toBe('MODEL_ERROR'); // 来自确定性 RCA 对齐
    expect(d.relatedCases).toContain('wan3-001');
  });

  it('LLM 失败 → 确定性回退', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'error', message: '挂了' } });
    const agent = new DefectAgent();
    const drafts = await agent.execute(
      { feature: 'wan3', environment: 'test', failedCases: [failCase()], rcas: [rcaOf('MODEL_ERROR')] },
      makeContext(llm),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source).toBe('rules');
    expect(drafts[0].severity).toBe('P1');
  });

  it('LLM 非法 JSON → 确定性回退', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'invalid-json' } });
    const agent = new DefectAgent();
    const drafts = await agent.execute(
      { feature: 'wan3', environment: 'test', failedCases: [failCase()], rcas: [] },
      makeContext(llm),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source).toBe('rules');
  });

  it('无失败用例 → 返回空数组', async () => {
    const llm = new MockLLMProvider();
    const agent = new DefectAgent();
    const drafts = await agent.execute(
      { feature: 'wan3', environment: 'test', failedCases: [], rcas: [] },
      makeContext(llm),
    );
    expect(drafts).toEqual([]);
  });
});

describe('defect - schema 归一化', () => {
  it('normalizeDefect 合法化严重度/优先级并强制 DRAFT', () => {
    const d = normalizeDefect({
      title: 'T', severity: 'INVALID', priority: 'TOP', description: 'D',
      steps: ['s1'], expected: 'E', actual: 'A', environment: 'test',
    });
    expect(d.severity).toBe('P2');
    expect(d.priority).toBe('MEDIUM');
    expect(d.status).toBe('DRAFT');
  });

  it('buildDefect 默认补全字段', () => {
    const d = buildDefect({ feature: 'wan3', title: 'T', severity: 'P1', priority: 'HIGH', environment: 'test' });
    expect(d.status).toBe('DRAFT');
    expect(d.steps).toEqual([]);
    expect(d.evidence).toEqual([]);
    expect(d.id).toMatch(/^defect-/);
  });

  it('validateDefect 通过合法结构', async () => {
    const out = await validateDefect({
      title: 'T', severity: 'P1', priority: 'HIGH', description: 'D',
      steps: [], expected: 'E', actual: 'A', environment: 'test',
    });
    expect(out.title).toBe('T');
  });
});
