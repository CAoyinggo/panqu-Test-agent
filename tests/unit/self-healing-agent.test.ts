// 单元测试：Self-Healing Agent（Phase 15 自愈建议）
// 覆盖：路径失效检测 / 最近路径搜索 / Patch 生成 / LLM 理由补充 / 不自动改码（状态恒 SUGGESTED）
import { describe, it, expect } from 'vitest';
import {
  SelfHealingAgent,
  analyzeHealing,
  findClosestPath,
  pathSimilarity,
  extractPaths,
  isPathFailure,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  buildHealingSuggestion,
  normalizeHealingSuggestion,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { CaseExecutionResult } from '../../src/agents/execution/execution-schema.js';

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-heal',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

/** 路径失效用例：旧路径 data.result.video.url 无法读取 */
function pathFailureCase(): CaseExecutionResult {
  return {
    caseId: 'wan3-001',
    name: '文生视频 URL 断言',
    feature: 'wan3',
    pass: false,
    passRate: 0,
    error: '断言 data.result.video.url 失败：got undefined',
    checks: [
      { name: '视频 URL 存在', pass: false, detail: 'cannot read data.result.video.url, got undefined' },
    ],
  };
}

/** 正常失败（非路径失效）：503 服务错误 */
function nonPathFailureCase(): CaseExecutionResult {
  return {
    caseId: 'wan3-002',
    name: '模型服务',
    feature: 'wan3',
    pass: false,
    passRate: 0,
    error: 'HTTP 503 Service Unavailable',
    checks: [{ name: '任务成功', pass: false, detail: 'expected SUCCESS, got 503' }],
  };
}

const ACTUAL_SCHEMA = { data: { output: { video: { url: 'https://cdn.example.com/v.mp4' } } } };

describe('healing - 工具函数', () => {
  it('extractPaths 提取点分路径', () => {
    expect(extractPaths('data.result.video.url 无法读取')).toContain('data.result.video.url');
    expect(extractPaths('没有路径')).toEqual([]);
  });

  it('pathSimilarity 按段计算相似度', () => {
    expect(pathSimilarity('a.b.c.d', 'a.b.c.d')).toBe(1);
    expect(pathSimilarity('a.result.c', 'a.output.c')).toBe(2 / 3);
    expect(pathSimilarity('a.b', 'x.y')).toBe(0);
  });

  it('findClosestPath 找到最相似路径且置信度阈值过滤', () => {
    const hit = findClosestPath('data.result.video.url', ['data.output.video.url', 'data.id']);
    expect(hit?.path).toBe('data.output.video.url');
    expect(hit!.confidence).toBeGreaterThan(0.5);
    expect(findClosestPath('a.b', ['x.y.z', 'm.n'])).toBeNull(); // 相似度过低
  });

  it('isPathFailure 判定路径失效', () => {
    expect(isPathFailure(pathFailureCase())).toBe(true);
    expect(isPathFailure(nonPathFailureCase())).toBe(false);
  });
});

describe('healing - 确定性分析', () => {
  it('路径失效 + 新 Schema → 生成 SUGGESTED 建议', () => {
    const a = analyzeHealing({ feature: 'wan3', failedCases: [pathFailureCase()], actualSchema: ACTUAL_SCHEMA });
    expect(a.suggestions).toHaveLength(1);
    const s = a.suggestions[0];
    expect(s.status).toBe('SUGGESTED'); // 绝不自动改码
    expect(s.oldPath).toBe('data.result.video.url');
    expect(s.newPath).toBe('data.output.video.url');
    expect(s.patch).toContain("data.result.video.url");
    expect(s.patch).toContain("data.output.video.url");
  });

  it('非路径失效（503）→ 不产出建议', () => {
    const a = analyzeHealing({ feature: 'wan3', failedCases: [nonPathFailureCase()] });
    expect(a.suggestions).toHaveLength(0);
    expect(a.summary).toContain('不做修改');
  });

  it('证据不足（无新 Schema 且相似度过低）→ 不产出建议', () => {
    const a = analyzeHealing({ feature: 'wan3', failedCases: [pathFailureCase()] });
    expect(a.suggestions).toHaveLength(0);
  });
});

describe('healing - Agent 路径', () => {
  it('确定性检测优先，LLM 仅补充理由，状态仍为 SUGGESTED', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify({ reason: '服务端字段 result 已重命名为 output，建议按新结构断言' }),
    });
    const agent = new SelfHealingAgent();
    const a = await agent.execute(
      { feature: 'wan3', failedCases: [pathFailureCase()], actualSchema: ACTUAL_SCHEMA },
      makeContext(llm),
    );
    expect(a.source).toBe('rules+llm');
    expect(a.suggestions).toHaveLength(1);
    expect(a.suggestions[0].status).toBe('SUGGESTED');
    expect(a.suggestions[0].reason).toContain('result');
    expect(a.suggestions[0].newPath).toBe('data.output.video.url'); // 路径不被 LLM 改动
  });

  it('LLM 失败 → 保留确定性理由', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'error', message: '挂了' } });
    const agent = new SelfHealingAgent();
    const a = await agent.execute(
      { feature: 'wan3', failedCases: [pathFailureCase()], actualSchema: ACTUAL_SCHEMA },
      makeContext(llm),
    );
    expect(a.source).toBe('rules');
    expect(a.suggestions[0].reason).toContain('最可能的新路径');
  });

  it('无可修复项时不调用 LLM 直接返回', async () => {
    const llm = new MockLLMProvider();
    const agent = new SelfHealingAgent();
    const a = await agent.execute(
      { feature: 'wan3', failedCases: [nonPathFailureCase()] },
      makeContext(llm),
    );
    expect(a.suggestions).toHaveLength(0);
    expect(llm.getCallCount()).toBe(0);
  });
});

describe('healing - schema 归一化', () => {
  it('buildHealingSuggestion 默认 SUGGESTED', () => {
    const s = buildHealingSuggestion({ caseId: 'c1', oldPath: 'a.b', patch: '- a.b\n+ a.c' });
    expect(s.status).toBe('SUGGESTED');
    expect(s.risk).toBe('medium');
    expect(s.confidence).toBe(0.5);
  });

  it('normalizeHealingSuggestion 合法化字段（越界置信度 clamp 到 0~1）', () => {
    const s = normalizeHealingSuggestion({
      caseId: 'c1', type: 'INVALID', oldPath: 'a.b', patch: 'p',
      confidence: 2, risk: 'CRITICAL', status: 'DONE',
    });
    expect(s.type).toBe('json-path');
    expect(s.confidence).toBe(1);
    expect(s.risk).toBe('medium');
    expect(s.status).toBe('SUGGESTED');
  });
});
