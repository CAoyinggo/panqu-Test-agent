// Analysis 确定性分析器：根据 Requirement + TestCase + 执行结果 + 风险评估，产出结构化 AnalysisReport
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证分析链路始终可产出结构化结论。
// 根因维度：失败（断言/错误）、超时、阻塞（高风险+失败）、不稳定（历史 flaky）、部分通过。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { RiskAssessment } from '../risk/risk-schema.js';
import type { ExecutionOutcome } from '../execution/execution-schema.js';
import {
  AnalysisReport,
  AnalysisFinding,
  summaryFromOutcome,
  toMemoryWorthy,
} from './analysis-schema.js';

/** 分析器输入 */
export interface AnalysisAnalyzerInput {
  requirement: Requirement;
  testCases?: TestCase[];
  outcome: ExecutionOutcome;
  risk?: RiskAssessment;
  /** 历史 flaky 用例 ID（来自记忆层，可选） */
  flakyCaseIds?: string[];
}

/** 根据失败类型给出建议 */
function suggestFor(c: { error?: string; timedOut?: boolean; checks?: Array<{ name: string; pass: boolean }> }): string {
  if (c.timedOut) return '延长用例超时或拆分长链路，确认轮询间隔是否合理';
  if (c.error && /ECONN|fetch|网络/i.test(c.error)) return '检查网络与依赖服务可用性，必要时重试';
  if (c.error && /5\d{2}/.test(c.error)) return '服务端 5xx，需排查服务端异常或限流';
  const failedChecks = (c.checks ?? []).filter((ch) => !ch.pass).length;
  if (failedChecks > 0) return '核对断言期望值是否与当前实现一致，定位断言路径';
  return '查看执行错误详情，人工介入定位';
}

/** 确定性分析 */
export function analyzeExecution(input: AnalysisAnalyzerInput): AnalysisReport {
  const { requirement, testCases = [], outcome, risk, flakyCaseIds = [] } = input;
  const feature = outcome.feature || requirement.feature || 'default';
  const findings: AnalysisFinding[] = [];
  const recommendations: string[] = [];
  const failed = outcome.results.filter((r) => !r.pass);

  // ── 整体汇总（真实执行结果确定性计算，含各用例真实耗时之和） ──
  const summary = summaryFromOutcome(outcome);

  // ── 失败用例 → 结论 ──
  for (const c of failed) {
    const isFlaky = flakyCaseIds.includes(c.caseId);
    const type: AnalysisFinding['type'] = c.timedOut ? 'fail' : isFlaky ? 'flaky' : 'fail';
    findings.push({
      type,
      caseId: c.caseId,
      title: isFlaky ? `不稳定用例（历史 flaky）：${c.name}` : `用例失败：${c.name}`,
      detail: c.error ?? `断言失败，通过率 ${c.passRate}%`,
      severity: c.timedOut ? 'high' : isFlaky ? 'medium' : 'high',
      suggestion: suggestFor(c),
    });
    recommendations.push(`${c.caseId} ${c.name}：${suggestFor(c)}`);
  }

  // ── 超时 ──
  if (outcome.timedOut > 0) {
    findings.push({
      type: 'fail',
      title: `${outcome.timedOut} 条用例超时`,
      detail: '整体或用例级超时导致结果缺失，可能为长链路或服务响应慢',
      severity: 'high',
      suggestion: '增大超时阈值、拆分用例或优化轮询间隔',
    });
  }

  // ── 阻塞风险（高风险 + 对应用例失败） ──
  const highRisks = risk?.risks.filter((r) => r.level === 'high') ?? [];
  for (const r of highRisks) {
    const blocked = failed.filter((c) => r.affectedCases?.includes(c.caseId));
    if (blocked.length) {
      findings.push({
        type: 'blocked',
        title: `高风险「${r.title}」下用例失败（${blocked.length} 条）`,
        detail: r.desc,
        severity: 'high',
        suggestion: r.mitigation,
      });
      recommendations.push(`阻塞风险 ${r.title}：${r.mitigation}`);
    }
  }

  // ── 部分通过（无失败但未全过，或通过率 <100%） ──
  if (outcome.total > 0 && summary.overall !== 'pass' && failed.length === 0) {
    findings.push({
      type: 'info',
      title: '存在超时/待人工结果，整体为部分通过',
      detail: `通过率 ${summary.passRate}%，需人工确认超时与待处理项`,
      severity: 'medium',
      suggestion: '人工复核超时项，必要时重跑',
    });
  }

  // ── 全通过提示 ──
  if (summary.overall === 'pass') {
    findings.push({
      type: 'pass',
      title: '全部用例通过',
      detail: `${outcome.total} 条用例全部通过，通过率 100%`,
      severity: 'low',
      suggestion: '可归档基线，进入回归稳定阶段',
    });
  }

  // ── AI 摘要兜底 ──
  const aiSummary = summary.overall === 'pass'
    ? `✅ ${feature} 全部 ${outcome.total} 条用例通过，可归档基线。`
    : `⚠️ ${feature} 通过率 ${summary.passRate}%：${failed.length} 条失败，${outcome.timedOut} 条超时。`
      + (highRisks.length ? `存在 ${highRisks.length} 项高风险待关注（${highRisks.map((r) => r.title).join('、')}）。` : '');

  return {
    feature,
    summary,
    findings,
    failedCases: failed,
    topFailures: failed.slice(0, 10).map((c) => ({ caseId: c.caseId, name: c.name, error: c.error })),
    recommendations: Array.from(new Set(recommendations)).slice(0, 20),
    memoryWorthy: toMemoryWorthy(failed),
    aiSummary,
    source: requirement.source,
  };
}
