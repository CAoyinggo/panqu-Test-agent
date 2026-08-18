// 单元测试：Root Cause Agent（Phase 13 RCA 深度根因分析）
// 覆盖：证据链收集 / 确定性分类 / LLM 路径 / 证据事实合并 / 历史相似失败 / 归一化
import { describe, it, expect } from 'vitest';
import {
  RootCauseAgent,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  classifyFailure,
  collectEvidence,
  collectHistoricalFailures,
  buildRootCause,
  normalizeRootCause,
  validateRootCause,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';
import type { MemoryRecord } from '../../src/agents/memory/memory-store.js';

function makeContext(llm: MockLLMProvider, memory = new NoopMemory()): AgentContext {
  return createAgentContext({
    taskId: 't-rca',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory,
    llm,
  });
}

/** 构造失败用例 */
function failCase(overrides: Partial<CaseExecutionResult> = {}): CaseExecutionResult {
  return {
    caseId: 'wan3-001',
    name: '文生视频正常链路',
    feature: 'wan3',
    pass: false,
    passRate: 0,
    error: '断言 data.result.video.url 为空',
    checks: [
      { name: '任务提交成功', pass: true, detail: '202 OK' },
      { name: '视频 URL 存在', pass: false, detail: 'expected data.result.video.url, got undefined' },
    ],
    ...overrides,
  };
}

describe('rca - 证据链收集', () => {
  it('断言失败收集 assertion 证据并标记为 fact', () => {
    const c = collectEvidence({ executionResult: failCase(), environment: 'test', feature: 'wan3' });
    expect(c.facts.length).toBeGreaterThanOrEqual(2);
    expect(c.items.every((e) => e.certainty === 'fact')).toBe(true);
    expect(c.items.some((e) => e.type === 'assertion')).toBe(true);
    expect(c.items.some((e) => e.type === 'environment')).toBe(true);
  });

  it('错误消息含 503 → 分类 MODEL_ERROR', () => {
    const c = collectEvidence({ executionResult: failCase({ error: 'HTTP 503 Service Unavailable' }) });
    expect(c.classification.category).toBe('MODEL_ERROR');
    expect(c.classification.confidence).toBeGreaterThan(0.8);
  });

  it('timedOut → 分类 TIMEOUT 且置信度高', () => {
    const cls = classifyFailure({ caseId: 'x', timedOut: true });
    expect(cls.category).toBe('TIMEOUT');
    expect(cls.confidence).toBe(0.95);
  });

  it('401 → 分类 AUTH_ERROR', () => {
    const cls = classifyFailure({ caseId: 'x', error: 'HTTP 401 Unauthorized' });
    expect(cls.category).toBe('AUTH_ERROR');
  });

  it('历史相似失败：记忆层检索并追加证据', async () => {
    const mem = new NoopMemory();
    const memWithSave = {
      ...mem,
      getSimilarFailures: async () => [
        { id: 'mem-1', type: 'failure' as const, createdAt: '2026-08-01', data: { caseId: 'wan3-001', category: 'MODEL_ERROR', message: '模型 503' }, tags: ['wan3'] },
      ],
    };
    const c = await collectHistoricalFailures(
      collectEvidence({ executionResult: failCase({ error: 'HTTP 503' }) }),
      memWithSave as never,
    );
    expect(c.hasHistoricalSimilar).toBe(true);
    expect(c.items.some((e) => e.type === 'historical-failure')).toBe(true);
  });
});

describe('rca - 确定性回退', () => {
  it('LLM 失败 → 规则回退，facts 来自证据链', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'error', message: 'LLM 挂了' } });
    const agent = new RootCauseAgent();
    const rca = await agent.execute({ executionResult: failCase(), environment: 'test' }, makeContext(llm));
    expect(rca.source).toBe('rules');
    expect(rca.facts.length).toBeGreaterThan(0);
    expect(rca.category).toBe('ASSERTION');
  });

  it('LLM 返回非法 JSON → 规则回退', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'invalid-json' } });
    const agent = new RootCauseAgent();
    const rca = await agent.execute({ executionResult: failCase() }, makeContext(llm));
    expect(rca.source).toBe('rules');
  });
});

describe('rca - LLM 路径', () => {
  it('LLM 推断与证据链合并：facts 来自证据，inferences 来自 LLM', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify({
        caseId: 'wan3-001',
        category: 'MODEL_ERROR',
        confidence: 0.9,
        rootCause: '模型服务返回 503，视频生成服务暂不可用',
        evidence: ['HTTP 503'],
        inferences: ['模型服务 503 导致生成失败'],
        excludedCauses: ['测试数据错误'],
        recommendedAction: '检查模型服务健康状态并重试',
      }),
    });
    const agent = new RootCauseAgent();
    const rca = await agent.execute({ executionResult: failCase({ error: 'HTTP 503 Service Unavailable' }), environment: 'test' }, makeContext(llm));
    expect(rca.source).toBe('llm');
    expect(rca.category).toBe('MODEL_ERROR');
    // 确定事实恒来自证据链
    expect(rca.facts.some((f) => f.includes('HTTP 状态码'))).toBe(true);
    expect(rca.facts.some((f) => f.includes('LLM'))).toBe(false);
    // LLM 推断被归入 inferences
    expect(rca.inferences.some((i) => i.includes('模型服务 503'))).toBe(true);
    expect(rca.excludedCauses).toContain('测试数据错误');
    expect(rca.recommendedAction).toContain('模型服务');
  });

  it('LLM 非法分类 → 回落确定性分类', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify({
        caseId: 'wan3-001',
        category: 'NOT_A_REAL_CATEGORY',
        confidence: 0.9,
        rootCause: '未知',
        evidence: [],
        recommendedAction: '检查',
      }),
    });
    const agent = new RootCauseAgent();
    const rca = await agent.execute({ executionResult: failCase() }, makeContext(llm));
    expect(rca.category).toBe('ASSERTION');
  });
});

describe('rca - schema 归一化', () => {
  it('normalizeRootCause 从 evidenceItems 派生三类证据', () => {
    const rca = normalizeRootCause({
      caseId: 'c1',
      category: 'TIMEOUT',
      confidence: 0.9,
      rootCause: '超时',
      evidence: ['超时'],
      evidenceItems: [
        { type: 'assertion', detail: '断言失败', certainty: 'fact' },
        { type: 'llm', detail: '怀疑网络', certainty: 'inference' },
        { type: 'llm', detail: '可能 DNS 问题', certainty: 'guess' },
      ],
      recommendedAction: '重试',
    });
    expect(rca.facts).toContain('断言失败');
    expect(rca.inferences).toContain('怀疑网络');
    expect(rca.guesses).toContain('可能 DNS 问题');
  });

  it('LLM 只给字符串 evidence → 归入 AI 推断（非事实）', () => {
    const rca = normalizeRootCause({
      caseId: 'c1', category: 'UNKNOWN', confidence: 0.4,
      rootCause: '未知', evidence: ['猜测原因 A'], recommendedAction: '检查',
    });
    expect(rca.inferences).toContain('猜测原因 A');
    expect(rca.facts).toHaveLength(0);
  });

  it('validateRootCause 通过合法结构', async () => {
    const out = await validateRootCause({
      caseId: 'c1', category: 'MODEL_ERROR', confidence: 0.8,
      rootCause: '503', evidence: ['503'], recommendedAction: '检查',
    });
    expect(out.caseId).toBe('c1');
  });

  it('buildRootCause 默认补全字段', () => {
    const rca = buildRootCause({ caseId: 'c1', category: 'TIMEOUT', rootCause: '超时' });
    expect(rca.confidence).toBe(0.5);
    expect(rca.evidence).toEqual([]);
    expect(rca.excludedCauses).toEqual([]);
  });
});
