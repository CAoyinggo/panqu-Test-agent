// Autonomous Pipeline HTML Report（Phase 23.6 报告升级）
// 最终 HTML 报告 16 段：
//   01 Requirement / 02 Change Impact / 03 Portfolio / 04 Exploration / 05 Priority
//   06 Regression Plan / 07 Execution / 08 RePlanning / 09 Adaptive Stop / 10 RCA
//   11 Defect / 12 Healing / 13 Knowledge Update / 14 Release Decision / 15 Unified Trace / 16 Cost
// 必须能回答：为什么选这些 Case？为什么没执行其他 Case？为什么重新规划？为什么停止？
//            为什么 BLOCK？为什么 REVIEW？AI 到底做了什么？
// 全部由规则引擎/统计/历史证据推导，无 LLM 参与。

import type { AutonomousPipelineResult } from './autonomous-pipeline.js';
import type { DecisionTrace } from '../decisions/index.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** 渲染端到端自治测试流水线 HTML 报告 */
export function renderAutonomousReportHtml(r: AutonomousPipelineResult): string {
  const s = r.runSummary;
  const decisionColor = r.release.decision === 'PASS' ? '#16a34a' : r.release.decision === 'REVIEW' ? '#d97706' : '#dc2626';

  const card = (title: string, body: string): string => `<section><h2>${title}</h2>${body}</section>`;

  const kv = (rows: Array<[string, string]>): string =>
    `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;

  // 01 Requirement
  const sec01 = kv([
    ['变更类型', r.change.type],
    ['变更目标', r.change.target],
    ['变更范围', `${r.change.from ?? '—'} → ${r.change.to ?? '—'}`],
    ['执行环境', r.environment],
    ['Run ID', r.runId],
    ['Task ID', r.taskId],
    ['创建时间', r.createdAt],
  ]);

  // 02 Change Impact
  const sec02 = kv([
    ['受影响用例', `${r.portfolio.affectedCount}/${r.portfolio.totalCases}`],
    ['受影响率', pct(r.portfolio.totalCases ? r.portfolio.affectedCount / r.portfolio.totalCases : 0)],
    ['模型变更', r.change.type === 'model' ? '是（高风险）' : '否'],
  ]);

  // 03 Portfolio（为什么选这些 Case）
  const p = r.portfolio.policy;
  const sec03 =
    kv([
      ['组合策略', `Core ${pct(p.coreRate)} / Risk ${pct(p.riskRate)} / Change ${pct(p.changeRate)} / Regression ${pct(p.regressionRate)}`],
      ['Historical TopN', String(p.historicalTopN)],
      ['Exploration Budget', pct(p.explorationBudgetRate)],
      ['排除隔离 Flaky', p.excludeQuarantinedFlaky ? '是' : '否'],
      ['选中用例', `${r.portfolio.selectedCaseIds.length}`],
      ['跳过用例', String(r.portfolio.skipped.length)],
    ]) +
    `<p><b>为什么选这些 Case？</b> ${r.portfolio.evidence.join('；')}</p>` +
    `<details><summary>Portfolio 选中列表（${r.portfolio.selectedCaseIds.length}）</summary><p>${esc(r.portfolio.selectedCaseIds.join('、'))}</p></details>`;

  // 04 Exploration
  const ex = r.exploration;
  const sec04 =
    kv([
      ['生成候选', String(ex.generated.length)],
      ['通过门禁（加入回归）', String(ex.screened.length)],
      ['拒绝', String(ex.rejected.length)],
    ]) +
    `<p><b>探索门禁证据</b></p><ul>${ex.evidence.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无）</li>'}</ul>`;

  // 05 Priority（初始执行顺序）
  const sec05 =
    kv([['预测用例数', String(r.regression.predictions.length)]]) +
    `<p><b>初始执行顺序（失败预测 + 优先级）：</b>${esc(r.regression.initialOrder.join(' → ') || '（空）')}</p>` +
    `<details><summary>Top 预测（失败概率）</summary><table><tr><th>Case</th><th>概率</th><th>类别</th></tr>` +
    r.regression.predictions
      .slice(0, 10)
      .map((p) => `<tr><td>${esc(p.caseId)}</td><td>${pct(p.failureProbability)}</td><td>${esc(p.predictedCategory)}</td></tr>`)
      .join('') +
    `</table></details>`;

  // 06 Regression Plan
  const sec06 = `<table><tr><th>#</th><th>Case</th><th>优先级</th><th>标签</th></tr>` +
    r.autonomousCases
      .slice()
      .sort((a, b) => a.priority.localeCompare(b.priority))
      .map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.caseId)}</td><td>${esc(c.priority)}</td><td>${esc((c.changeTags ?? []).join('、'))}</td></tr>`)
      .join('') + `</table>`;

  // 07 Execution
  const skippedExec = s.skipped;
  const sec07 =
    `<table><tr><th>Case</th><th>结果</th><th>预测概率</th></tr>` +
    r.regression.executed
      .map((e) => {
        const prob = r.regression.predictions.find((p) => p.caseId === e.caseId)?.failureProbability ?? 0;
        return `<tr><td>${esc(e.caseId)}</td><td>${e.passed ? '✅ PASS' : '❌ FAIL'}</td><td>${pct(prob)}</td></tr>`;
      })
      .join('') +
    `</table>` +
    `<p><b>为什么没执行其他 Case？</b> 计划 ${s.total} 个，执行 ${s.executed} 个，跳过 ${skippedExec} 个（组合筛选 / 自适应停止 / 暂停低优先级 / 预算上限）。原因：${esc(s.stopReason ?? '按 Portfolio 组合策略筛选')}</p>`;

  // 08 RePlanning（为什么重新规划）
  const sec08 = r.regression.replans.length
    ? `<p><b>为什么重新规划？</b> 失败用例按相关性标签触发提升与暂停。</p>` +
      `<table><tr><th>#</th><th>失败用例</th><th>原因</th><th>动作</th></tr>` +
      r.regression.replans
        .map(
          (rp, i) => `<tr><td>${i + 1}</td><td>${esc(rp.failedCase)}</td><td>${esc(rp.cause)}</td><td>${esc(rp.action)}</td></tr>`,
        )
        .join('') +
      `</table>`
    : '<p>无重新规划</p>';

  // 09 Adaptive Stop（为什么停止）
  const sec09 = s.stopReason
    ? `<p><b>为什么停止？</b> ${esc(s.stopReason)}</p><p>暂停低优先级：${esc(r.trace.pausedCaseIds.join('、') || '无')}</p>`
    : '<p>未触发提前停止（全部计划内用例执行完成）</p>';

  // 10 RCA
  const sec10 = r.rca.length
    ? `<table><tr><th>Case</th><th>类别</th><th>置信度</th><th>根因</th></tr>` +
      r.rca
        .map((rc) => `<tr><td>${esc(rc.caseId)}</td><td>${esc(rc.category)}</td><td>${pct(rc.confidence)}</td><td>${esc(rc.rootCause)}</td></tr>`)
        .join('') +
      `</table>`
    : '<p>无失败，无需 RCA</p>';

  // 11 Defect
  const sec11 = r.defects.length
    ? `<table><tr><th>Case</th><th>类别</th><th>严重度</th><th>说明</th></tr>` +
      r.defects
        .map((d) => `<tr><td>${esc(d.caseId)}</td><td>${esc(d.category)}</td><td>${esc(d.severity)}</td><td>${esc(d.reason)}</td></tr>`)
        .join('') +
      `</table>`
    : '<p>无缺陷</p>';

  // 12 Healing（自愈：已知问题复现不重复建缺陷 + 知识沉淀）
  const sec12 =
    kv([
      ['已知问题复现（不重复创建缺陷）', String(r.regression.knownIssueReappeared.length)],
      ['知识更新条数', String(r.knowledgeUpdates.length)],
    ]) +
    (r.regression.knownIssueReappeared.length
      ? `<p>复现：${esc(r.regression.knownIssueReappeared.join('、'))}</p>`
      : '<p>无自愈动作（无已知问题复现）</p>');

  // 13 Knowledge Update
  const sec13 =
    `<ul>${r.knowledgeUpdates.map((k) => `<li>${esc(k)}</li>`).join('') || '<li>（无）</li>'}</ul>`;

  // 14 Release Decision（为什么 BLOCK / REVIEW）
  const rel = r.release;
  const sec14 =
    kv([
      ['决策', rel.decision],
      ['置信度', rel.confidence.toFixed(2)],
      ['CI Exit Code', String(r.releaseExitCode)],
      ['Release ID', rel.releaseId],
      ['Trace ID', rel.traceId],
    ]) +
    `<p><b>门禁检查</b></p><table><tr><th>检查项</th><th>值</th><th>状态</th></tr>` +
    rel.checks
      .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td><td>${c.status === 'pass' ? '✅' : '❌'}</td></tr>`)
      .join('') +
    `</table>` +
    `<p><b>为什么 ${rel.decision}？</b> ${rel.blockReasons.length ? rel.blockReasons.join('；') : rel.recommendations.join('；')}</p>`;

  // 15 Unified Trace（AI 到底做了什么）
  const dt: DecisionTrace = r.trace.decisionTrace;
  const sec15 =
    `<p><b>AI 到底做了什么？</b> 决策轨迹共 ${dt.records.length} 条（runId: ${esc(r.runId)}，taskId: ${esc(dt.taskId)}）</p>` +
    `<table><tr><th>#</th><th>类型</th><th>决策</th><th>原因/证据</th><th>关联用例</th></tr>` +
    dt.records
      .map(
        (ev, i) =>
          `<tr><td>${i + 1}</td><td>${esc(ev.kind)}</td><td>${esc(ev.decision)}</td><td>${esc(ev.reason || ev.evidence.join('；'))}</td><td>${esc(ev.caseId ?? '—')}</td></tr>`,
      )
      .join('') +
    `</table>`;

  // 16 Cost
  const b = r.regression.budgetUsed as { cases: number; cost: number; replans: number; durationMs: number; llmCalls: number; decisionDepth?: number };
  const sec16 = kv([
    ['执行用例数', String(b.cases)],
    ['预估成本', String(b.cost)],
    ['重新规划次数', String(b.replans)],
    ['执行时长 ms', String(b.durationMs)],
    ['LLM 调用', String(b.llmCalls)],
    ['决策深度', String(b.decisionDepth ?? 0)],
    ['超限项', r.regression.exceededLimit ?? '无'],
  ]);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Autonomous Test Pipeline Report - ${esc(r.runId)}</title>
<style>
  body { font-family: 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', sans-serif; margin: 0; background: #f5f7fa; color: #1f2937; }
  header { background: #111827; color: #fff; padding: 20px 32px; }
  header h1 { margin: 0 0 8px; font-size: 20px; }
  .badge { display: inline-block; padding: 4px 14px; border-radius: 12px; color: #fff; font-weight: 700; background: ${decisionColor}; }
  main { padding: 24px 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  section { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  section h2 { margin: 0 0 12px; font-size: 15px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #f0f2f5; text-align: left; vertical-align: top; }
  ul { margin: 6px 0; padding-left: 20px; font-size: 13px; }
  details { margin-top: 8px; font-size: 12px; }
  footer { padding: 16px 32px; color: #6b7280; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Autonomous Test Pipeline Report</h1>
  <span class="badge">${rel.decision} / exit ${r.releaseExitCode}</span>
  <span style="margin-left:12px;color:#9ca3af;font-size:13px;">${esc(r.runId)} · ${esc(r.feature)} · 生成于 ${esc(r.createdAt)}</span>
</header>
<main>
  ${card('01 Requirement', sec01)}
  ${card('02 Change Impact', sec02)}
  ${card('03 Portfolio', sec03)}
  ${card('04 Exploration', sec04)}
  ${card('05 Priority', sec05)}
  ${card('06 Regression Plan', sec06)}
  ${card('07 Execution', sec07)}
  ${card('08 RePlanning', sec08)}
  ${card('09 Adaptive Stop', sec09)}
  ${card('10 RCA', sec10)}
  ${card('11 Defect', sec11)}
  ${card('12 Healing', sec12)}
  ${card('13 Knowledge Update', sec13)}
  ${card('14 Release Decision', sec14)}
  ${card('15 Unified Trace', sec15)}
  ${card('16 Cost', sec16)}
</main>
<footer>AI Test Agent · Phase 23.6 Autonomous Production Acceptance · Deterministic First（无 LLM 决策）</footer>
</body>
</html>`;
}
