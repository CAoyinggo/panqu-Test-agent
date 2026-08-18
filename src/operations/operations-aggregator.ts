// Operations Aggregator：统一运维视图聚合（Phase 21.8）
// 将健康 / 执行 / Flaky / RCA / Defect / Healing / 成本 / Coverage / Knowledge / Quality
// 聚合为单一运维快照，给出总体状态（HEALTHY / DEGRADED / CRITICAL）与关注项。

import type { OperationsInput, OperationsView, OperationsStatus } from './operations-schema.js';

/** 聚合运维视图 */
export function buildOperationsView(input: OperationsInput, now: string = new Date().toISOString()): OperationsView {
  const health = input.health ?? { ok: true, checks: [] };
  const runs = input.runs ?? [];
  const totalCases = runs.reduce((s, r) => s + r.total, 0);
  const totalPassed = runs.reduce((s, r) => s + r.passed, 0);
  const totalFailed = runs.reduce((s, r) => s + r.failed, 0);
  const passRate = totalCases > 0 ? Math.round((totalPassed / totalCases) * 10000) / 10000 : 1;

  const flaky = input.flaky ?? { byStatus: {}, quarantineIds: [] };
  const rca = input.rca ?? { total: 0 };
  const defects = input.defects ?? { total: 0, open: 0 };
  const healing = input.healing ?? { suggestions: 0, applied: 0, recovered: 0 };
  const cost = input.cost ?? { total: 0 };
  const coverage = input.coverage ?? {};
  const knowledge = input.knowledge ?? {};
  const quality = input.quality ?? [];

  // 自治运行摘要（Phase 23.6）
  const autonomousRuns = input.autonomous?.runs ?? [];
  const latestRelease: OperationsView['autonomous']['latestReleaseDecision'] =
    autonomousRuns.length > 0 ? autonomousRuns[autonomousRuns.length - 1].releaseDecision : 'NONE';
  const autonomousStatus: OperationsView['autonomous']['status'] =
    latestRelease === 'PASS'
      ? 'AUTONOMOUS_PASS'
      : latestRelease === 'REVIEW'
        ? 'AUTONOMOUS_REVIEW'
        : latestRelease === 'BLOCK'
          ? 'AUTONOMOUS_BLOCK'
          : 'AUTONOMOUS_NONE';
  const autonomous = {
    runs: autonomousRuns,
    runCount: autonomousRuns.length,
    status: autonomousStatus,
    latestReleaseDecision: latestRelease,
    totalPlanned: autonomousRuns.reduce((s, r) => s + r.total, 0),
    totalExecuted: autonomousRuns.reduce((s, r) => s + r.executed, 0),
    totalSkipped: autonomousRuns.reduce((s, r) => s + r.skipped, 0),
    totalReplans: autonomousRuns.reduce((s, r) => s + r.replans, 0),
    totalRca: autonomousRuns.reduce((s, r) => s + r.rcaCount, 0),
  };

  // 总体状态：健康检查失败 → CRITICAL；存在开放缺陷/隔离用例/低通过率 → DEGRADED
  const failedChecks = health.checks.filter((c) => !c.ok);
  let status: OperationsStatus = 'HEALTHY';
  if (!health.ok || failedChecks.length > 0 || passRate < 0.5) {
    status = 'CRITICAL';
  } else if ((defects.open ?? 0) > 0 || flaky.quarantineIds.length > 0 || (defects.critical ?? 0) > 0) {
    status = 'DEGRADED';
  }

  // 关注项（按严重度排序）
  const highlights: string[] = [];
  for (const c of failedChecks) highlights.push(`[CRITICAL] 健康检查失败：${c.name}${c.detail ? `（${c.detail}）` : ''}`);
  if (passRate < 0.5 && totalCases > 0) highlights.push(`[CRITICAL] 执行通过率过低：${(passRate * 100).toFixed(1)}%（${totalPassed}/${totalCases}）`);
  if ((defects.critical ?? 0) > 0) highlights.push(`[HIGH] 严重缺陷 ${defects.critical} 个未关闭`);
  if ((defects.open ?? 0) > 0) highlights.push(`[HIGH] 开放缺陷 ${defects.open} 个`);
  if (flaky.quarantineIds.length > 0) highlights.push(`[MEDIUM] Flaky 隔离中用例 ${flaky.quarantineIds.length} 条：${flaky.quarantineIds.join(', ')}`);
  const lowCoverage = Object.entries(coverage).filter(([, rate]) => rate < 0.9);
  for (const [dim, rate] of lowCoverage) highlights.push(`[MEDIUM] 覆盖率不足：${dim} ${(rate * 100).toFixed(1)}% < 90%`);
  const lowQuality = quality.filter((q) => q.score < 70);
  for (const q of lowQuality) highlights.push(`[MEDIUM] 质量分过低：${q.feature} ${q.score}（${q.grade}）`);
  // 自治运行关注项（Phase 23.6）
  for (const ar of autonomousRuns) {
    if (ar.releaseDecision === 'BLOCK') {
      highlights.push(`[HIGH] 自治运行 ${ar.runId} Release BLOCK：${ar.stopReason ?? '存在阻断信号'}（失败 ${ar.failed}，RCA ${ar.rcaCount}）`);
    } else if (ar.releaseDecision === 'REVIEW') {
      highlights.push(`[MEDIUM] 自治运行 ${ar.runId} Release REVIEW：需要人工评审（失败 ${ar.failed}，RePlan ${ar.replans}）`);
    }
  }

  const summary =
    `运维状态 ${status}：执行 ${runs.length} 轮（通过率 ${(passRate * 100).toFixed(1)}%），` +
    `RCA ${rca.total}，缺陷 ${defects.total}（开放 ${defects.open}），自愈恢复 ${healing.recovered}，` +
    `成本 ${cost.total}，知识 ${Object.values(knowledge).reduce((s, n) => s + n, 0)} 条` +
    (autonomousRuns.length > 0 ? `，自治运行 ${autonomousRuns.length} 次（最新 ${latestRelease}，RePlan ${autonomous.totalReplans}，RCA ${autonomous.totalRca}）` : '') +
    (highlights.length > 0 ? `；关注项 ${highlights.length} 条` : '');

  return {
    generatedAt: now,
    status,
    health,
    runs: { count: runs.length, totalCases, totalPassed, totalFailed, passRate, items: runs },
    flaky: { byStatus: flaky.byStatus, quarantined: flaky.quarantineIds.length, quarantineIds: flaky.quarantineIds },
    rca: { total: rca.total, byCategory: rca.byCategory ?? {} },
    defects: { total: defects.total, open: defects.open, critical: defects.critical ?? 0, bySeverity: defects.bySeverity ?? {} },
    healing: { ...healing, recoveryRate: healing.applied > 0 ? Math.round((healing.recovered / healing.applied) * 10000) / 10000 : 0 },
    cost: { total: cost.total, byCategory: cost.byCategory ?? {}, costPerFeature: cost.costPerFeature ?? {} },
    coverage,
    knowledge,
    quality,
    autonomous,
    highlights,
    summary,
  };
}

/** 渲染运维视图为自包含 HTML（供 agent:dashboard 输出） */
export function renderOperationsHtml(view: OperationsView): string {
  const statusColor = view.status === 'HEALTHY' ? '#16a34a' : view.status === 'DEGRADED' ? '#d97706' : '#dc2626';
  const autoColor =
    view.autonomous.status === 'AUTONOMOUS_PASS'
      ? '#16a34a'
      : view.autonomous.status === 'AUTONOMOUS_REVIEW'
        ? '#d97706'
        : view.autonomous.status === 'AUTONOMOUS_BLOCK'
          ? '#dc2626'
          : '#6b7280';
  const autoStatusLabel =
    view.autonomous.status === 'AUTONOMOUS_PASS'
      ? 'AUTONOMOUS PASS'
      : view.autonomous.status === 'AUTONOMOUS_REVIEW'
        ? 'AUTONOMOUS REVIEW'
        : view.autonomous.status === 'AUTONOMOUS_BLOCK'
          ? 'AUTONOMOUS BLOCK'
          : 'AUTONOMOUS NONE';
  const rows = (obj: Record<string, number | string>): string =>
    Object.entries(obj).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('') ||
    '<tr><td colspan="2">（空）</td></tr>';

  // 自治运行摘要区块（Phase 23.6）
  const latest = view.autonomous.runs[view.autonomous.runs.length - 1];
  const autoRunSummary = latest
    ? `<table>
        <tr><td>Run</td><td>${escapeHtml(latest.runId)}</td></tr>
        <tr><td>Feature</td><td>${escapeHtml(latest.feature)}</td></tr>
        <tr><td>Cases Planned</td><td>${latest.total}</td></tr>
        <tr><td>Cases Executed</td><td>${latest.executed}</td></tr>
        <tr><td>Cases Skipped</td><td>${latest.skipped}</td></tr>
        <tr><td>RePlans</td><td>${latest.replans}</td></tr>
        <tr><td>Coverage</td><td>${(latest.coverage * 100).toFixed(1)}%</td></tr>
        <tr><td>Risk</td><td>${escapeHtml(latest.riskLevel)}</td></tr>
        <tr><td>Failures</td><td>${latest.failed}</td></tr>
        <tr><td>RCA</td><td>${latest.rcaCount}</td></tr>
        <tr><td>Decision</td><td>${escapeHtml(latest.releaseDecision)}</td></tr>
        <tr><td>Reason</td><td>${escapeHtml(latest.stopReason ?? '—')}</td></tr>
      </table>`
    : '<p>（尚无自治运行）</p>';

  const autoRunTable =
    `<tr><th>Run</th><th>Decision</th><th>执行/计划</th><th>RePlan</th><th>RCA</th><th>停止原因</th></tr>` +
    view.autonomous.runs
      .map(
        (ar) =>
          `<tr><td>${escapeHtml(ar.runId)}</td><td><b>${escapeHtml(ar.releaseDecision)}</b></td>` +
          `<td>${ar.executed}/${ar.total}</td><td>${ar.replans}</td><td>${ar.rcaCount}</td><td>${escapeHtml(ar.stopReason ?? '—')}</td></tr>`,
      )
      .join('') || '<tr><td colspan="6">（空）</td></tr>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Test Operations Dashboard</title>
<style>
  body { font-family: 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', sans-serif; margin: 0; background: #f5f7fa; color: #1f2937; }
  header { background: #111827; color: #fff; padding: 20px 32px; }
  header h1 { margin: 0 0 8px; font-size: 20px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; color: #fff; font-weight: 600; background: ${statusColor}; }
  main { padding: 24px 32px; display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  section { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  section h2 { margin: 0 0 12px; font-size: 15px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 4px 8px; border-bottom: 1px solid #f0f2f5; text-align: left; }
  .highlights li { margin: 4px 0; font-size: 13px; }
  .summary { grid-column: 1 / -1; font-size: 14px; }
  footer { padding: 16px 32px; color: #6b7280; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>AI Test Operations Dashboard</h1>
  <span class="badge">${view.status}</span>
  <span style="margin-left:12px;color:#9ca3af;font-size:13px;">生成于 ${escapeHtml(view.generatedAt)}</span>
  <br><span style="display:inline-block;margin-top:10px;padding:4px 12px;border-radius:12px;color:#fff;font-weight:600;background:${autoColor};">${autoStatusLabel}</span>
</header>
<main>
  <section class="summary"><h2>总览</h2><p>${escapeHtml(view.summary)}</p>
    <ul class="highlights">${view.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('') || '<li>无关注项</li>'}</ul>
  </section>
  <section><h2>Autonomous Status（自治状态）</h2>
    <p>自治运行 ${view.autonomous.runCount} 次 · 最新 Release <b>${escapeHtml(view.autonomous.latestReleaseDecision)}</b> · RePlan ${view.autonomous.totalReplans} · RCA ${view.autonomous.totalRca}</p>
    <p>组合执行率（最新）：${latest ? `${(latest.portfolioRate * 100).toFixed(0)}%` : '—'} · 探索（最新）：${latest ? `生成 ${latest.explorationGenerated} / 通过 ${latest.explorationScreened} / 拒绝 ${latest.explorationRejected}` : '—'}</p>
  </section>
  <section><h2>Autonomous Run Summary（自治运行摘要）</h2>${autoRunSummary}</section>
  <section><h2>Decision Trace / RePlan / Stop / Release</h2><table>${autoRunTable}</table></section>
  <section><h2>健康检查</h2><table>${view.health.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${c.ok ? '✅' : '❌'} ${escapeHtml(c.detail ?? '')}</td></tr>`).join('') || '<tr><td>（未执行）</td></tr>'}</table></section>
  <section><h2>执行任务（${view.runs.count} 轮 / 通过率 ${(view.runs.passRate * 100).toFixed(1)}%）</h2><table>
    <tr><th>Run</th><th>Feature</th><th>通过/总数</th></tr>
    ${view.runs.items.map((r) => `<tr><td>${escapeHtml(r.runId)}</td><td>${escapeHtml(r.feature)}</td><td>${r.passed}/${r.total}</td></tr>`).join('') || '<tr><td colspan="3">（空）</td></tr>'}
  </table></section>
  <section><h2>Flaky</h2><table>${rows(view.flaky.byStatus)}</table><p>隔离中：${view.flaky.quarantined} 条</p></section>
  <section><h2>RCA（${view.rca.total}）</h2><table>${rows(view.rca.byCategory)}</table></section>
  <section><h2>缺陷（总 ${view.defects.total} / 开放 ${view.defects.open} / 严重 ${view.defects.critical}）</h2><table>${rows(view.defects.bySeverity)}</table></section>
  <section><h2>自愈</h2><table><tr><td>建议</td><td>${view.healing.suggestions}</td></tr><tr><td>应用</td><td>${view.healing.applied}</td></tr><tr><td>恢复</td><td>${view.healing.recovered}</td></tr><tr><td>恢复率</td><td>${(view.healing.recoveryRate * 100).toFixed(1)}%</td></tr></table></section>
  <section><h2>成本（合计 ${view.cost.total}）</h2><table>${rows(view.cost.byCategory)}</table></section>
  <section><h2>Coverage</h2><table>${rows(view.coverage)}</table></section>
  <section><h2>Knowledge</h2><table>${rows(view.knowledge)}</table></section>
  <section><h2>Agent Quality</h2><table><tr><th>Feature</th><th>得分</th><th>等级</th></tr>
    ${view.quality.map((q) => `<tr><td>${escapeHtml(q.feature)}</td><td>${q.score}</td><td>${escapeHtml(q.grade)}</td></tr>`).join('') || '<tr><td colspan="3">（空）</td></tr>'}
  </table></section>
</main>
<footer>AI Test Agent · Phase 21.8 Production Operations</footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
