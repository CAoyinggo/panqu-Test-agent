// 单元测试：Flaky Agent（Phase 13 Flaky Test 管理）
// 覆盖：flakiness_index / 分类（STABLE/FLAKY/UNSTABLE/BROKEN）/ 隔离 / LLM 解释 / 归一化
import { describe, it, expect } from 'vitest';
import {
  FlakyAgent,
  analyzeFlakiness,
  computeFlakinessIndex,
  classifyStatus,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  buildFlakyAnalysis,
  normalizeFlakyAnalysis,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { RunRecord } from '../../src/agents/flaky/flaky-schema.js';

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-flaky',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

/** 生成多次运行记录 */
function runs(caseId: string, pattern: boolean[], opts: Partial<RunRecord> = {}): RunRecord[] {
  return pattern.map((pass, i) => ({
    caseId,
    name: `用例 ${caseId}`,
    pass,
    at: `2026-08-0${(i % 9) + 1}`,
    ...opts,
  }));
}

describe('flaky - 指数与分类', () => {
  it('flakinessIndex：五五开为 1，全过/全挂为 0', () => {
    expect(computeFlakinessIndex(0.5)).toBe(1);
    expect(computeFlakinessIndex(1)).toBe(0);
    expect(computeFlakinessIndex(0)).toBe(0);
  });

  it('classifyStatus：STABLE / FLAKY / UNSTABLE / BROKEN', () => {
    expect(classifyStatus(1, 4)).toBe('STABLE');
    expect(classifyStatus(0.5, 4)).toBe('FLAKY');
    expect(classifyStatus(0.9, 10)).toBe('UNSTABLE');
    expect(classifyStatus(0, 4)).toBe('BROKEN');
  });
});

describe('flaky - 确定性统计分析', () => {
  it('全过 → STABLE，全挂 → BROKEN，混合 → FLAKY', () => {
    const a = analyzeFlakiness({
      feature: 'wan3',
      runs: [
        ...runs('s1', [true, true, true]),
        ...runs('b1', [false, false, false]),
        ...runs('f1', [true, false, true, false]),
      ],
    });
    expect(a.records.find((r) => r.caseId === 's1')?.status).toBe('STABLE');
    expect(a.records.find((r) => r.caseId === 'b1')?.status).toBe('BROKEN');
    const f1 = a.records.find((r) => r.caseId === 'f1')!;
    expect(f1.status).toBe('FLAKY');
    expect(f1.flakinessIndex).toBe(1);
  });

  it('边缘波动 → UNSTABLE，且进入隔离列表', () => {
    const a = analyzeFlakiness({ feature: 'wan3', runs: runs('u1', [true, true, false, true, true]) });
    const u1 = a.records.find((r) => r.caseId === 'u1')!;
    expect(u1.status).toBe('UNSTABLE');
    expect(a.quarantineIds).toContain('u1');
  });

  it('flaky/unstable 进入隔离，stable/broken 不隔离', () => {
    const a = analyzeFlakiness({
      feature: 'wan3',
      runs: [
        ...runs('s1', [true, true]),
        ...runs('b1', [false, false]),
        ...runs('f1', [true, false]),
        ...runs('u1', [true, true, false, true, true]),
      ],
    });
    expect(a.quarantineIds.sort()).toEqual(['f1', 'u1']);
    expect(a.brokenCaseIds).toContain('b1');
    expect(a.flakyCaseIds).toContain('f1');
  });

  it('环境相关性：失败集中于同一环境时标记', () => {
    const a = analyzeFlakiness({
      feature: 'wan3',
      runs: [
        ...runs('e1', [true, false, false], { environment: 'test' }),
        ...runs('e1', [true, true], { environment: 'preonline' }),
      ].map((r, i) => ({ ...r, at: `2026-08-${String(i + 1).padStart(2, '0')}` })),
    });
    const e1 = a.records.find((r) => r.caseId === 'e1')!;
    expect(e1.environmentCorrelation).toBe(true);
  });

  it('空输入抛出或返回空记录', () => {
    const a = analyzeFlakiness({ feature: 'wan3', runs: [] });
    expect(a.total).toBe(0);
  });
});

describe('flaky - LLM 解释路径', () => {
  it('LLM 提供 summary，统计保持规则结果', async () => {
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify({
        summary: '发现 1 个 flaky 用例，主要受并发影响',
        notes: [{ caseId: 'f1', note: '并发下偶发失败' }],
      }),
    });
    const agent = new FlakyAgent();
    const a = await agent.execute({
      feature: 'wan3',
      runs: [...runs('f1', [true, false, true, false])],
    }, makeContext(llm));
    expect(a.source).toBe('rules+llm');
    expect(a.summary).toContain('并发');
    expect(a.records[0].status).toBe('FLAKY'); // 统计不被 LLM 改动
  });

  it('LLM 失败 → 保留规则汇总', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'error', message: '挂了' } });
    const agent = new FlakyAgent();
    const a = await agent.execute({ feature: 'wan3', runs: runs('f1', [true, false]) }, makeContext(llm));
    expect(a.source).toBe('rules');
    expect(a.quarantineIds).toContain('f1');
  });
});

describe('flaky - schema 归一化', () => {
  it('buildFlakyAnalysis 派生集合字段', () => {
    const a = buildFlakyAnalysis({
      feature: 'wan3',
      records: [
        { caseId: 'f1', runs: 4, passes: 2, failures: 2, passRate: 50, flakinessIndex: 1, status: 'FLAKY', failedRuns: [], quarantine: true },
      ],
    });
    expect(a.flakyCaseIds).toContain('f1');
    expect(a.quarantineIds).toContain('f1');
  });

  it('normalizeFlakyAnalysis 过滤非法记录', () => {
    const a = normalizeFlakyAnalysis({
      feature: 'wan3',
      records: [
        { caseId: 'f1', status: 'FLAKY', runs: 4, passes: 2, failures: 2, passRate: 50, flakinessIndex: 1, failedRuns: [], quarantine: true },
        { status: 'STABLE' },
      ],
    });
    expect(a.total).toBe(1);
    expect(a.records[0].caseId).toBe('f1');
  });
});
