// 验收测试：Analysis 汇总统计的完整性（防 LLM 污染）
// 契约：
//   Runner Outcome → Deterministic Summary → total / passed / failed / timedOut / duration / exitCode / overall
//   LLM 只能贡献逐 Case 的解释；汇总、最终建议与状态必须来自确定性分析
// 任何 LLM 输出（哪怕恶意伪造 summary.total=999）都不得改变平台统计与退出码。
import { describe, it, expect } from 'vitest';
import {
  AnalysisAgent,
  normalizeAnalysis,
  summaryFromOutcome,
  computeOutcome,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';
import type { ExecutionOutcome } from '../../src/agents/execution/execution-schema.js';

const req = {
  feature: 'wan3', goal: 'g', version: 'v1', source: '原文',
  capabilities: ['text-to-video'], requirements: [], businessRules: [], dependencies: [], constraints: [], risks: [],
} as never;

const EXECUTED_FIXTURE = {
  executed: true,
  processor: 'UnitTestProcessor',
  processorInvoked: true,
} as const;

/** 真实执行结果：3 条 = 1 通过 + 1 失败 + 1 超时（真实耗时 10+20+3000） */
function realOutcome(): ExecutionOutcome {
  return computeOutcome('wan3', [
    { ...EXECUTED_FIXTURE, caseId: 'tc-01', name: '正常提交', status: 'PASS', pass: true, passRate: 100, durationMs: 10, checks: [{ name: 'business', pass: true, detail: 'ok', kind: 'BUSINESS' }] },
    { ...EXECUTED_FIXTURE, caseId: 'tc-02', name: '计费', status: 'FAIL', pass: false, passRate: 0, error: '断言失败', durationMs: 20, checks: [{ name: 'business', pass: false, detail: '断言失败', kind: 'BUSINESS' }] },
    { caseId: 'tc-03', name: '并发', status: 'TIMEOUT', executed: false, pass: false, passRate: 0, timedOut: true, durationMs: 3000 },
  ], { executed: true });
}

function makeContext(llm: MockLLMProvider): AgentContext {
  const tools = new ToolRegistry();
  return createAgentContext({
    taskId: 't-integrity', feature: 'wan3', environment: 'test',
    tools, memory: new NoopMemory(), llm,
  });
}

describe('summaryFromOutcome：Runner Outcome → 确定性汇总', () => {
  it('total/passed/failed/timedOut 来自 Runner 计数；duration = 真实用例耗时之和', () => {
    const s = summaryFromOutcome(realOutcome());
    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.timedOut).toBe(1);
    expect(s.durationMs).toBe(3_030); // 10 + 20 + 3000（真实数据求和）
    expect(s.passRate).toBe(realOutcome().passRate); // 与 Runner 一致
    expect(s.overall).toBe('fail'); // 有硬失败
    expect(s.exitCode).toBe(3); // 超时存在 → 退出码 3（超时优先，与既有契约一致）
  });

  it('全部通过 + 无超时 → pass / exitCode 0', () => {
    const ok = computeOutcome('wan3', [
      { ...EXECUTED_FIXTURE, caseId: 'a', name: 'a', status: 'PASS', pass: true, passRate: 100, durationMs: 5, checks: [{ name: 'business', pass: true, detail: 'ok', kind: 'BUSINESS' }] },
    ], { executed: true });
    const s = summaryFromOutcome(ok);
    expect(s.overall).toBe('pass');
    expect(s.exitCode).toBe(0);
  });
});

describe('normalizeAnalysis：trustedSummary 逐字采用，data.summary 丢弃', () => {
  it('伪造的 summary 字段整体被忽略', () => {
    const trusted = summaryFromOutcome(realOutcome());
    const r = normalizeAnalysis(
      {
        feature: 'wan3',
        // 恶意/幻觉统计：声称全部通过、总时长 1ms
        summary: { total: 999, passed: 999, timedOut: 0, durationMs: 1 },
        findings: [{ type: 'fail', title: 't', detail: 'd', severity: 'high', suggestion: 's' }],
        recommendations: ['r1'],
        aiSummary: 'LLM 摘要',
      },
      { trustedSummary: trusted },
    );
    expect(r.summary).toEqual(trusted); // 统计逐字来自真实结果
    expect(r.summary.total).toBe(3);
    expect(r.summary.passed).toBe(1);
    expect(r.findings).toHaveLength(1); // LLM 的结论保留
    expect(r.aiSummary).toBe('LLM 摘要');
  });

  it('无 trustedSummary 时保持旧兜底行为（外部数据源兼容）', () => {
    const r = normalizeAnalysis({ feature: 'wan3', summary: { total: 5, passed: 4, timedOut: 1, durationMs: 100 } });
    expect(r.summary.total).toBe(5);
    expect(r.summary.overall).toBe('partial');
  });
});

describe('AnalysisAgent 端到端：LLM 无法污染统计', () => {
  it('LLM 输出伪造 summary（全通过）→ 平台统计仍为真实结果（1/1/1，exitCode=1）', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify({
        feature: 'wan3',
        aiSummary: '一切正常，全部通过！', // 幻觉摘要
        summary: { total: 3, passed: 3, failed: 0, timedOut: 0, passRate: 100, durationMs: 1, exitCode: 0, overall: 'pass' },
        findings: [{ type: 'pass', title: '看起来都过了', detail: '模型幻觉', severity: 'low', suggestion: '无' }],
        recommendations: ['直接上线'],
      })],
    });
    const agent = new AnalysisAgent();
    const report = await agent.execute({ requirement: req, outcome: realOutcome() }, makeContext(llm));

    // 统计 = 真实执行结果，LLM 的伪造 summary 被整体丢弃
    expect(report.summary.total).toBe(3);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.timedOut).toBe(1);
    expect(report.summary.durationMs).toBe(3_030);
    expect(report.summary.overall).toBe('fail');
    expect(report.summary.exitCode).toBe(3); // 退出码不受「全部通过」幻觉影响（超时 → 3）

    // 与执行事实冲突的模型摘要/上线建议不得进入最终结论；失败项由确定性分析补齐。
    expect(report.aiSummary).toBe('⚠️ wan3 通过率 33.3%：2 条失败，1 条超时。');
    expect(report.aiSummary).not.toContain('全部通过');
    expect(report.findings.map((finding) => finding.caseId).filter(Boolean)).toEqual(['tc-02', 'tc-03']);
    expect(report.findings.some((finding) => !finding.caseId
      && finding.title.includes('用例超时')
      && finding.classification === 'ENVIRONMENT_ERROR')).toBe(true);
    expect(report.recommendations).not.toContain('直接上线');

    // 失败明细来自真实结果（非 LLM 输出）
    expect(report.failedCases.map((c) => c.caseId)).toEqual(['tc-02', 'tc-03']);
  });

  it('LLM 失败回退确定性分析器 → 统计同样来自真实结果', async () => {
    const llm = new MockLLMProvider({ scripted: ['不是 JSON'] });
    const agent = new AnalysisAgent();
    const report = await agent.execute({ requirement: req, outcome: realOutcome() }, makeContext(llm));
    expect(report.summary.total).toBe(3);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.durationMs).toBe(3_030); // 确定性路径同样携带真实耗时（旧实现恒 0）
    expect(report.summary.exitCode).toBe(3);
  });
});
