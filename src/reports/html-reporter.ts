// HTML 报告器：自包含、无外部依赖，视觉遵循现有规范
import fs from 'node:fs';
import path from 'node:path';
import type { ReportData, CheckResult, ResponseSummary, ImpactItem } from '../core/types.js';
import type { Reporter } from './index.js';
import {
  visualizeAssertion,
  buildAssertionHeatmap,
  type AssertionHeatmap,
  type DiffDetail,
  type HeatmapCell,
} from '../utils/assertion-visualizer.js';

const STATUS_BADGE: Record<string, [string, string]> = {
  PASS: ['#16a34a', 'PASS'],
  FAIL: ['#dc2626', 'FAIL'],
  WARN: ['#d97706', '部分/待确认'],
  MANUAL: ['#2563eb', '待人工实测'],
  INFO: ['#6b7280', '信息'],
};

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatValueShort(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 50 ? v.slice(0, 50) + '...' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 50 ? s.slice(0, 50) + '...' : s;
  } catch { return String(v); }
}

function badge(status: string): string {
  const [bg, label] = STATUS_BADGE[status] || STATUS_BADGE.INFO;
  return `<span class="badge" style="background:${bg};color:#fff">${label}</span>`;
}

function tableHtml(headers: string[], rows: string[][]): string {
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += headers.map((h) => `<th>${h}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (const r of rows) html += `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  html += '</tbody></table></div>';
  return html;
}

function buildReport(d: ReportData): string {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const overviewCards = [
    { label: '任务状态', value: esc(d.submit?.status || '-') },
    { label: '任务 ID', value: esc(d.submit?.taskId ?? d.submit?.task_id ?? '-') },
    { label: '模型', value: esc(d.taskDef?.model_name || '-') },
    { label: '环境', value: esc(d.env) },
    { label: '积分净消耗', value: String((d.billingData && d.billingData.net) ?? '-') },
    { label: '用例通过率', value: d.passRate ? d.passRate + '%' : '-' },
  ];

  const casesRows = (d.manual || []).map((m) => [esc(m.id), esc(m.steps || '-'), badge('MANUAL'), '-']);
  const respRows = (d.responses || []).map((r: ResponseSummary) => [
    esc(r.name), esc(r.method), esc(r.status), esc(r.code != null ? r.code : '-'),
    '<code>' + esc(String(r.summary || '').slice(0, 160)) + '</code>',
  ]);
  const impactRows = (d.impact || []).map((i: ImpactItem) => [esc(i.type), esc(i.name), esc(i.action), esc(i.desc)]);
  const checkRows = (d.checks || []).map((c: CheckResult) => [esc(c.name), c.pass ? badge('PASS') : badge('FAIL'), esc(c.detail || '-')]);
  const assertChecks = (d.checks || []).filter((c) => c.assertionType);
  const assertGroups: Record<string, typeof assertChecks> = {};
  for (const c of assertChecks) {
    const t = c.assertionType || 'other';
    if (!assertGroups[t]) assertGroups[t] = [];
    assertGroups[t].push(c);
  }
  const assertGroupLabels: Record<string, string> = {
    response: 'HTTP 响应', submit: '提交结果', billing: '计费数据', headers: '响应头', env: '环境', metrics: '性能指标', custom: '自定义'
  };

  // 断言可视化（DEBT-05：接入 assertion-visualizer 的 diff_view + assertion_heatmap 协议）
  const vizModuleName = d.taskDef?.name || d.title || 'module';
  const assertionMatrix = assertChecks.map((c) => ({
    assertionId: `${d.taskDef?.project_id ?? 'task'}-${c.name}`,
    name: c.name,
    target: d.taskDef?.name || d.title || 'module',
    path: c.path,
    operator: c.operator,
    failureCount: c.pass ? 0 : 1,
    totalRuns: 1,
  }));
  const failedAssertions = assertChecks.filter((c) => !c.pass);
  const heatmap: AssertionHeatmap | null = assertionMatrix.length
    ? buildAssertionHeatmap(vizModuleName, assertionMatrix)
    : null;
  const diffViews = failedAssertions.map((c) =>
    visualizeAssertion({
      assertion_failure: {
        operator: c.operator || 'unknown',
        path: c.path,
        expected: c.expected,
        actual: c.actual,
        message: c.detail,
      },
      history_metrics: [],
      suite_assertion_matrix: assertionMatrix,
      module_name: vizModuleName,
    }).diff_view,
  );
  const manualRows = (d.manual || []).map((m) => [esc(m.id), esc(m.steps || '-')]);
  const issueRows = (d.issues || []).map((i) => [esc(i.level), esc(i.title), esc(i.desc || '')]);

  const issueHtml = issueRows.length ? tableHtml(['级别', '问题', '说明'], issueRows) : '<p class="muted">无</p>';
  const manualHtml = manualRows.length ? tableHtml(['用例', '人工操作步骤'], manualRows) : '<p class="muted">本次无浏览器人工待办</p>';

  // 并发调整历史
  const concurrencyChanges = (d.metrics?.concurrencyChanges as Array<{ timestamp: number; from: number; to: number; reason: string; windowPassRate: number }>) || [];
  const concurrencyHtml = concurrencyChanges.length
    ? tableHtml(
        ['时间', '调整前', '调整后', '原因', '窗口通过率'],
        concurrencyChanges.map((c) => [
          new Date(c.timestamp).toLocaleTimeString('zh-CN'),
          String(c.from),
          String(c.to),
          c.reason === 'high_failure_rate' ? '失败率高，降级' : c.reason === 'high_pass_rate' ? '通过率高，升级' : c.reason,
          `${(c.windowPassRate * 100).toFixed(0)}%`,
        ]),
      )
    : '<p class="muted">未启用动态并发或无调整记录</p>';

  const ai = d.assetInfo || {};
  let assetHtml: string;
  if (ai.exists) {
    const counts = ai.counts ? `图片 ${ai.counts.image} / 音频 ${ai.counts.audio} / 视频 ${ai.counts.video} / 文本 ${ai.counts.text}` : '-';
    const resolvedRows = (ai.resolved || []).map((r) => [esc(r.field), '<code>' + esc(r.path) + '</code>', esc(r.full || '⚠ 未找到')]);
    const resolvedHtml = resolvedRows.length ? tableHtml(['字段', '相对路径', '解析结果'], resolvedRows) : '<p class="muted">本任务未引用素材库文件</p>';
    assetHtml = `<p class="muted">素材库 Test-panqu（${esc(counts)}）</p>${resolvedHtml}`;
  } else {
    assetHtml = '<p class="muted">素材库不存在或未配置</p>';
  }

  return `<!-- Generated by Trae Work -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(d.title || '测试报告')}</title>
<style>
:root { --bg:#f8fafc; --bg2:#fff; --ink:#0f172a; --muted:#64748b; --rule:#e2e8f0; --accent:#2563eb; --accent2:#0ea5e9; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif; line-height:1.7; font-size:15px; }
.wrap { max-width:1080px; margin:0 auto; padding:24px 20px 60px; }
header.cover { background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; border-radius:14px; padding:32px 28px; margin-bottom:28px; }
header.cover h1 { margin:0 0 8px; font-size:26px; }
header.cover .sub { opacity:.92; font-size:14px; }
.meta { display:flex; flex-wrap:wrap; gap:10px 22px; margin-top:14px; font-size:13px; opacity:.95; }
h2 { font-size:19px; margin:34px 0 14px; padding-bottom:8px; border-bottom:2px solid var(--accent); }
h3 { font-size:16px; margin:22px 0 10px; color:var(--accent); }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin:18px 0; }
.card { background:var(--bg2); border:1px solid var(--rule); border-radius:12px; padding:16px; }
.card .v { font-size:22px; font-weight:700; color:var(--accent); }
.card .l { font-size:12px; color:var(--muted); margin-top:4px; }
.table-wrap { overflow-x:auto; overflow-y:auto; max-height:600px; border:1px solid var(--rule); border-radius:10px; background:var(--bg2); }
table { border-collapse:collapse; width:100%; min-width:640px; font-size:13.5px; }
th { background:#f1f5f9; text-align:left; padding:10px 12px; border-bottom:2px solid var(--rule); position:sticky; top:0; z-index:1; font-weight:600; }
td { padding:9px 12px; border-bottom:1px solid var(--rule); vertical-align:top; }
tr:last-child td { border-bottom:none; }
.badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
code { background:#f1f5f9; border:1px solid var(--rule); border-radius:4px; padding:1px 5px; font-size:12px; word-break:break-all; }
.muted { color:var(--muted); }
.callout { background:var(--bg2); border-left:4px solid var(--accent2); padding:14px 16px; border-radius:0 8px 8px 0; margin:16px 0; }
footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--rule); color:var(--muted); font-size:12.5px; }
@media (max-width:768px){ .cards{grid-template-columns:repeat(2,1fr);} body{font-size:14px;} .wrap{padding:16px 12px 40px;} }
.assert-fail { background:#fef2f2; }
.assert-fail td:nth-child(4) { color:#dc2626; font-weight:600; }
.assert-pass td:nth-child(4) { color:#16a34a; }
</style>
</head>
<body>
<div class="wrap">
  <header class="cover">
    <h1>${esc(d.title || 'AI 功能测试报告')}</h1>
    <div class="sub">${esc(d.taskDef?.scene || '')} ｜ ${esc(d.env)} 环境 ｜ 生成于 ${esc(time)}</div>
    <div class="meta">
      <span>任务名：${esc(d.taskDef?.name || '-')}</span>
      <span>项目 ID：${esc(d.taskDef?.project_id ?? '-')}</span>
      <span>账号：${esc(d.taskDef?.account ?? '-')}</span>
    </div>
  </header>

  <h2>一、执行概览</h2>
  <div class="cards">${overviewCards.map((c) => `<div class="card"><div class="v">${c.value}</div><div class="l">${c.label}</div></div>`).join('')}</div>
  ${d.submit?.err ? `<div class="callout"><strong>任务失败原因：</strong>${esc(d.submit.err)}</div>` : ''}

  <h2>二、测试用例结果</h2>
  ${casesRows.length ? tableHtml(['编号', '用例名称', '结果', '说明/预期'], casesRows) : '<p class="muted">无用例</p>'}

  <h2>三、接口响应摘要</h2>
  ${respRows.length ? tableHtml(['环节', '方法', 'HTTP', '业务码', '响应摘要'], respRows) : '<p class="muted">无接口调用</p>'}

  <h2>四、数据隔离 / 影响分析</h2>
  <h3>4.1 表与模块影响清单</h3>
  ${impactRows.length ? tableHtml(['类型', '对象', '动作', '说明'], impactRows) : '<p class="muted">无</p>'}
  <h3>4.2 数据正确性核验</h3>
  ${checkRows.length ? tableHtml(['核验项', '结果', '说明'], checkRows) : '<p class="muted">无</p>'}
  <h3>4.3 断言详情</h3>
  ${assertChecks.length ? Object.entries(assertGroups).map(([type, checks]) => {
    const label = assertGroupLabels[type] || type;
    const rows = checks.map((c) => {
      const cls = c.pass ? 'assert-pass' : 'assert-fail';
      const expected = c.expected !== undefined ? esc(formatValueShort(c.expected)) : '-';
      const actual = c.actual !== undefined ? esc(formatValueShort(c.actual)) : '-';
      const dur = c.durationMs != null ? c.durationMs + 'ms' : '-';
      return `<tr class="${cls}"><td>${esc(c.name)}</td><td><code>${esc(c.operator || '-')}</code></td><td>${expected}</td><td>${actual}</td><td>${dur}</td><td>${c.pass ? badge('PASS') : badge('FAIL')}</td></tr>`;
    }).join('');
    return `<h4 style="margin:14px 0 6px;font-size:13px;color:var(--muted)">${esc(label)}（${checks.length} 条）</h4><div class="table-wrap"><table><thead><tr><th>断言项</th><th>操作符</th><th>期望值</th><th>实际值</th><th>耗时</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('') : '<p class="muted">无声明式断言（仅使用业务适配器断言）</p>'}
  <h3>4.4 断言可视化</h3>
  <p class="muted">Diff 视图（失败断言节点级差异）+ 断言热力图（权重：0 绿 / 1-3 黄橙 / 4-5 红；Flakiness Index ${heatmap ? heatmap.flakiness_index : '-'}，基于本报告单次运行）</p>
  ${diffViews.length ? diffViews.map((dv, i) => {
    const failed = failedAssertions[i];
    const rows = (dv.diff_details || []).map((dd: DiffDetail) => [
      esc(dd.path || '/'),
      esc(dd.change_type),
      esc(formatValueShort(dd.expected)),
      esc(formatValueShort(dd.actual)),
      esc(dd.hint || ''),
    ]);
    return `<h4 style="margin:14px 0 6px;font-size:13px;color:var(--muted)">${esc(failed?.name || '')} ｜ ${esc(dv.data_type)} ｜ ${esc(dv.summary)}</h4>${rows.length ? tableHtml(['路径', '变更', '期望', '实际', '说明'], rows) : '<p class="muted">无节点级差异明细</p>'}`;
  }).join('') : '<p class="muted">全部断言通过，无失败差异视图</p>'}
  ${heatmap ? tableHtml(['断言', '目标', '路径', '操作符', '权重', '失败率', '运行'], heatmap.matrix.map((cell: HeatmapCell) => [
    esc(cell.assertion_name),
    esc(cell.target || '-'),
    esc(cell.path || '-'),
    esc(cell.operator || '-'),
    `<span style="color:${cell.weight <= 0 ? '#16a34a' : cell.weight <= 3 ? '#d97706' : '#dc2626'};font-weight:700">${cell.weight}</span>`,
    `${(cell.failure_rate * 100).toFixed(1)}%`,
    `${cell.failure_count}/${cell.total_runs}`,
  ])) : '<p class="muted">无声明式断言，无可视化数据</p>'}

  <h2>五、素材库使用</h2>
  ${assetHtml}

  <h2>六、问题卡点</h2>
  ${issueHtml}

  <h2>七、浏览器人工待办</h2>
  ${manualHtml}

  <h2>八、并发调整历史</h2>
  ${concurrencyHtml}

  ${d.debugProducts ? `<h2>九、Debug 产物</h2><div class="callout"><strong>调试目录：</strong><code>${esc(d.debugProducts)}</code><br><span class="muted">包含中间产物（HTTP 请求/响应、上下文快照、断言输入等），需 --debug --debug-level verbose/full 模式生成</span></div>` : ''}

  <footer><p>由 test-flow 一键执行脚本自动生成 ｜ 数据来源：test.panqu.com API 实测</p></footer>
</div>
</body>
</html>
`;
}

export class HtmlReporter implements Reporter {
  name = 'html';

  write(outputDir: string, slugBase: string, data: ReportData): string[] {
    const slug = String(slugBase).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const file = path.join(outputDir, `${slug}_${Date.now()}.html`);
    fs.writeFileSync(file, buildReport(data));
    return [file];
  }
}

export { buildReport, esc, badge, tableHtml };
