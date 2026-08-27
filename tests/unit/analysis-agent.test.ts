// 单元测试：Analysis Agent（Schema 归一化 / 确定性分析器 / LLM 全链路）
import { describe, it, expect } from 'vitest';
import {
  AnalysisAgent,
  analyzeExecution,
  normalizeAnalysis,
  computeAnalysisSummary,
  toMemoryWorthy,
  parseRequirement,
  generateTestCases,
  analyzeRisks,
  computeOutcome,
  createAgentContext,
  NoopMemory,
  ToolRegistry,
} from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';
import type { AgentContext } from '../../src/agents/core/agent-context.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';
const req = parseRequirement(DEMO_REQ);
const cases = generateTestCases(req);
const risk = analyzeRisks({ requirement: req, testCases: cases });

const EXECUTED_FIXTURE = {
  executed: true,
  processor: 'UnitTestProcessor',
  processorInvoked: true,
  evidence: { source: 'unit-test-runner' },
} as const;

/** 构造包含失败/超时的执行结果 */
function makeOutcome(): ReturnType<typeof computeOutcome> {
  return computeOutcome('wan3', [
    { ...EXECUTED_FIXTURE, caseId: 'tc-01', name: '正常提交并成功', feature: 'wan3', priority: 'P0', tags: ['smoke'], status: 'PASS', pass: true, passRate: 100, durationMs: 10, checks: [{ name: 's', pass: true, detail: 'ok', level: 'P0', kind: 'BUSINESS' }] },
    { ...EXECUTED_FIXTURE, caseId: 'tc-02', name: '计费规则', feature: 'wan3', priority: 'P0', tags: ['business-rule'], status: 'FAIL', pass: false, passRate: 0, error: '断言失败：积分扣减异常', durationMs: 20, checks: [{ name: 'billing', pass: false, detail: 'expected 10, actual 5', level: 'P0', kind: 'BUSINESS' }] },
    { caseId: 'tc-03', name: '并发', feature: 'wan3', priority: 'P3', tags: ['concurrency'], status: 'TIMEOUT', executed: false, pass: false, passRate: 0, timedOut: true, durationMs: 3000 },
  ], { executed: true });
}

function makeContext(llm: MockLLMProvider): AgentContext {
  return createAgentContext({
    taskId: 't-1',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });
}

describe('analysis - Schema 归一化', () => {
  it('computeAnalysisSummary 计算汇总与退出码', () => {
    const s = computeAnalysisSummary(10, 7, 2, 500);
    expect(s.passed).toBe(7);
    expect(s.failed).toBe(1);
    expect(s.timedOut).toBe(2);
    expect(s.passRate).toBe(70);
    expect(s.overall).toBe('fail');
    expect(s.exitCode).toBe(3); // 超时优先
    const p = computeAnalysisSummary(10, 10, 0, 100);
    expect(p.overall).toBe('pass');
    expect(p.exitCode).toBe(0);
    const partial = computeAnalysisSummary(10, 9, 1, 100); // 1 超时、无硬失败 → partial
    expect(partial.overall).toBe('partial');
    expect(partial.exitCode).toBe(3); // 超时优先
    const fail = computeAnalysisSummary(10, 9, 0, 100); // 1 硬失败 → fail
    expect(fail.overall).toBe('fail');
    expect(fail.exitCode).toBe(1);
  });

  it('toMemoryWorthy 生成待记忆失败记录', () => {
    const m = toMemoryWorthy([{ ...EXECUTED_FIXTURE, caseId: 'x', name: 'X', status: 'FAIL', pass: false, passRate: 0, error: 'boom', tags: ['P0', 'wan3'], checks: [{ name: 'c', pass: false, detail: 'd', level: 'P0', kind: 'BUSINESS' }] }]);
    expect(m[0].caseId).toBe('x');
    expect(m[0].category).toBe('error');
    expect(m[0].evidence).toEqual(['c: d']);
    expect(m[0].tags).toContain('wan3');
  });

  it('normalizeAnalysis 过滤非法结论并重算汇总', () => {
    const r = normalizeAnalysis({
      feature: 'wan3',
      findings: [
        { type: 'fail', title: '失败', detail: 'd', severity: 'high', suggestion: 's' },
        { type: 'bogus', title: '', detail: '', severity: 'extreme', suggestion: '' },
      ],
      failedCases: [{ ...EXECUTED_FIXTURE, caseId: 'a', name: 'A', status: 'FAIL', pass: false, passRate: 0, checks: [{ name: 'business', pass: false, detail: 'failed', kind: 'BUSINESS' }] }],
      summary: { total: 1, passed: 0 },
    });
    expect(r.findings).toHaveLength(1);
    expect(r.summary.failed).toBe(1);
    expect(r.failedCases).toHaveLength(1);
    expect(r.memoryWorthy).toHaveLength(1);
  });
});

describe('analysis - 确定性分析器', () => {
  const outcome = makeOutcome();

  it('定位失败/超时/阻塞并给出建议', () => {
    const r = analyzeExecution({ requirement: req, testCases: cases, outcome, risk });
    expect(r.summary.overall).toBe('fail');
    expect(r.failedCases).toHaveLength(2);
    expect(r.findings.some((f) => f.type === 'fail' && f.caseId === 'tc-02')).toBe(true);
    expect(r.findings.find((f) => f.caseId === 'tc-02')).toEqual(expect.objectContaining({
      classification: 'PRODUCT_BUG', confidence: 'CONFIRMED', evidence: ['billing: expected 10, actual 5'],
    }));
    expect(r.findings.find((f) => f.caseId === 'tc-03')?.classification).toBe('ENVIRONMENT_ERROR');
    expect(r.findings.some((f) => f.title.includes('超时'))).toBe(true);
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.memoryWorthy).toHaveLength(2);
    expect(r.findings[0]).toEqual(expect.objectContaining({ classification: 'PRODUCT_BUG', confidence: 'CONFIRMED' }));
  });

  it('高风险 + 对应用例失败 → 阻塞结论', () => {
    // 给 risk 注入 tc-02 关联的高风险
    const extraRisk = {
      id: 'r-x', category: 'billing' as const, level: 'high' as const, title: '计费复核', desc: 'd', affectedCases: ['tc-02'], mitigation: 'm',
    };
    const riskWithBilling = { ...risk, risks: [...risk.risks, extraRisk] };
    const r = analyzeExecution({ requirement: req, testCases: cases, outcome, risk: riskWithBilling });
    expect(r.findings.some((f) => f.type === 'blocked')).toBe(true);
  });

  it('flaky 历史标记 → 不稳定结论', () => {
    const r = analyzeExecution({ requirement: req, testCases: cases, outcome, risk, flakyCaseIds: ['tc-02'] });
    const flaky = r.findings.find((f) => f.caseId === 'tc-02');
    expect(flaky?.type).toBe('flaky');
    expect(flaky?.severity).toBe('medium');
  });

  it('全通过 → pass 结论', () => {
    const allPass = computeOutcome('wan3', cases.map((c) => ({
      ...EXECUTED_FIXTURE,
      caseId: c.id,
      name: c.name,
      status: 'PASS' as const,
      pass: true,
      passRate: 100,
      checks: [{ name: 'business', pass: true, detail: 'ok', kind: 'BUSINESS' as const }],
    })));
    const r = analyzeExecution({ requirement: req, testCases: cases, outcome: allPass });
    expect(r.summary.overall).toBe('pass');
    expect(r.findings.some((f) => f.type === 'pass')).toBe(true);
  });

  it('aiSummary 规则兜底', () => {
    const r = analyzeExecution({ requirement: req, testCases: cases, outcome, risk });
    expect(r.aiSummary).toContain('通过率');
  });
});

describe('analysis - AnalysisAgent 全链路', () => {
  const outcome = makeOutcome();

  it('LLM 返回合法 JSON → 走 LLM 分析', async () => {
    const llm = new MockLLMProvider({
      scripted: [JSON.stringify({
        feature: 'wan3',
        aiSummary: '存在计费断言失败，需人工复核',
        findings: [{ type: 'fail', caseId: 'tc-02', title: '计费失败', detail: '积分扣减异常', severity: 'high', suggestion: '复核账单' }],
        recommendations: ['复核账单'],
      })],
    });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.feature).toBe('wan3');
    expect(r.findings[0].caseId).toBe('tc-02');
    expect(r.findings[0]).toEqual(expect.objectContaining({
      detail: '积分扣减异常',
      suggestion: '复核账单',
      classification: 'PRODUCT_BUG',
      confidence: 'CONFIRMED',
    }));
    expect(r.aiSummary).toContain('通过率 33.3%');
    expect(r.aiSummary).not.toContain('计费断言失败');
    expect(llm.getCallCount()).toBe(1);
    // LLM 分支仍补全真实失败明细
    expect(r.failedCases).toHaveLength(2);
    expect(r.memoryWorthy).toHaveLength(2);
  });

  it('LLM 返回非法 JSON → 回退确定性分析器', async () => {
    const llm = new MockLLMProvider({ scripted: ['不是 JSON'] });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.summary.overall).toBe('fail');
    expect(r.findings.some((f) => f.caseId === 'tc-02')).toBe(true);
  });

  it('LLM 空响应 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [''] });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.failedCases).toHaveLength(2);
  });

  it('LLM 缺 feature → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: ['{"findings":[]}'] });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.feature).toBe('wan3');
  });

  it('LLM 抛错 → 回退分析器', async () => {
    const llm = new MockLLMProvider({ scripted: [], failureMode: { type: 'error', message: '网络中断' } });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('空输入抛错', async () => {
    await expect(new AnalysisAgent().execute({} as never, makeContext(new MockLLMProvider())))
      .rejects.toThrow('分析输入为空');
  });

  it('LLM 提示词包含执行结果与风险摘要', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({ feature: 'wan3', findings: [] })] });
    await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    const last = llm.getLastCall()!;
    expect(last.messages[1].content).toContain('执行结果：共 3 条');
    expect(last.messages[1].content).toContain('通过 1');
    expect(last.messages[1].content).toContain('高风险项');
    expect(last.messages[1].content).toContain('processorInvoked');
    expect(last.messages[0].content).toContain('LLM 不是 Oracle');
    expect(last.temperature).toBe(0);
  });

  it('过滤 LLM 编造的失败 Case，并补回模型遗漏的真实失败', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({
      feature: 'wan3',
      findings: [{ type: 'fail', caseId: 'tc-does-not-exist', title: '编造失败', detail: '无', severity: 'high', suggestion: '无' }],
    })] });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    expect(r.findings.some((finding) => finding.caseId === 'tc-does-not-exist')).toBe(false);
    expect(r.findings.some((finding) => finding.caseId === 'tc-02' && finding.classification === 'PRODUCT_BUG')).toBe(true);
    expect(r.findings.some((finding) => finding.caseId === 'tc-03' && finding.classification === 'ENVIRONMENT_ERROR')).toBe(true);
  });

  it('LLM 不能把真实 P0 失败降级为 info/low，也不能伪造无 Case 结论', async () => {
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({
      feature: 'wan3',
      findings: [
        { type: 'info', caseId: 'tc-02', title: '可忽略', detail: '模型解释', severity: 'low', suggestion: '不处理' },
        { type: 'fail', title: '无来源的整体失败', detail: '编造', severity: 'high', suggestion: '无' },
      ],
    })] });
    const r = await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome, risk }, makeContext(llm));
    const billing = r.findings.find((finding) => finding.caseId === 'tc-02');
    expect(billing).toEqual(expect.objectContaining({ type: 'fail', severity: 'high', classification: 'PRODUCT_BUG' }));
    expect(r.findings.some((finding) => finding.title === '无来源的整体失败')).toBe(false);
  });

  it('发给 LLM 的执行摘要会脱敏，且包含 Expected/断言上下文', async () => {
    const sensitiveOutcome = makeOutcome();
    sensitiveOutcome.results[1].error = 'Authorization: Bearer top-secret-token';
    const llm = new MockLLMProvider({ scripted: [JSON.stringify({ feature: 'wan3', findings: [] })] });
    await new AnalysisAgent().execute({ requirement: req, testCases: cases, outcome: sensitiveOutcome, risk }, makeContext(llm));
    const prompt = llm.getLastCall()!.messages[1].content;
    expect(prompt).not.toContain('top-secret-token');
    expect(prompt).toContain('expected');
    expect(prompt).toContain('assertions');
  });
});
