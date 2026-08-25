/**
 * DevTest 固定格式报告渲染器。
 *
 * 四类产出一一对应：
 * - report.html  ：七个固定章节的自包含单文件报告（给人看、可直接分享）
 * - report.json  ：与 HTML 章节同构的机读信封，内嵌完整 acceptance 报告
 * - cases.csv    ：五维用例清单（UTF-8 BOM，Excel 友好）
 * - problems.md  ：四级问题清单（Markdown）
 *
 * 样式规范沿用 QA 已验收的版式：内容宽度 CSS 变量固定，
 * 表格最小宽度固定，消除左右滚动条。
 */

import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type {
  DevTestConclusion,
  DevTestDimensionStat,
  DevTestProblem,
} from './types.js';

export const DEVTEST_REPORT_SCHEMA = 'devtest.report.v1';

export interface DevTestRenderMeta {
  docSource: string;
  baseUrl: string;
  environment: string;
  mode: 'execute' | 'dry-run';
  confirmMutations: boolean;
}

export interface DevTestRenderInput {
  runId: string;
  generatedAt: string;
  meta: DevTestRenderMeta;
  conclusion: DevTestConclusion;
  report: AcceptanceReport;
  problems: DevTestProblem[];
  dimensionStats: DevTestDimensionStat[];
  pendingMutationCaseIds: string[];
}

// ============================================================
//  公共工具
// ============================================================

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCsvField(value: unknown): string {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

const SEVERITY_LABELS: Record<DevTestProblem['severity'], string> = {
  critical: 'critical（严重）',
  major: 'major（主要）',
  minor: 'minor（次要）',
  trivial: 'trivial（轻微）',
};

const CONCLUSION_BANNERS: Record<DevTestConclusion, { label: string; cssClass: string; text: string }> = {
  PASS: { label: 'PASS', cssClass: 'ok', text: '初步验证通过：本次真实执行的只读路径全部通过。注意这仅代表 Operation Contract 层证据，不等价于完整业务验收。' },
  FAIL: { label: 'FAIL', cssClass: 'bad', text: '发现失败断言：请优先处理问题清单中的 critical/major 项。' },
  BLOCKED: { label: 'BLOCKED', cssClass: 'warn', text: '运行被阻断：前置条件未满足，按问题清单逐项补齐后重跑。系统没有猜测任何未声明的契约。' },
  PARTIAL: { label: 'PARTIAL', cssClass: 'warn', text: '部分完成：存在未执行或挂起项，查看「待确认写路径」与「未知项」章节决定下一步。' },
};

// ============================================================
//  cases.csv
// ============================================================

export function renderCasesCsv(input: Pick<DevTestRenderInput, 'report'>): string {
  const statusByCase = new Map(input.report.executions.map((item) => [item.caseId, item]));
  const header = ['用例ID', '维度', '优先级', '名称', '执行模式', '状态', '耗时ms', 'AC追踪', '备注'];
  const lines = [header.map(escapeCsvField).join(',')];
  for (const item of input.report.cases) {
    const execution = statusByCase.get(item.caseId);
    lines.push([
      item.caseId,
      item.testType,
      item.priority,
      item.scenario,
      item.executionMode,
      item.executionStatus,
      execution?.durationMs !== undefined ? String(execution.durationMs) : '',
      item.evidence?.acceptanceCriteriaIds?.join('; ') ?? '',
      item.qualityIssues?.join('; ') ?? '',
    ].map(escapeCsvField).join(','));
  }
  // UTF-8 BOM：保证 Excel 直接打开中文不乱码。
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ============================================================
//  problems.md
// ============================================================

export function renderProblemsMarkdown(
  problems: readonly DevTestProblem[],
  meta: { conclusion: DevTestConclusion; pendingMutationCaseIds: readonly string[] },
): string {
  const lines: string[] = [
    '# DevTest 问题清单',
    '',
    `> 结论：**${meta.conclusion}**；生成时间以报告为准。`,
    '',
  ];
  if (!problems.length) {
    lines.push('未发现问题。注意：这只表示当前可观测范围内无异常信号。', '');
    return lines.join('\n');
  }
  const order: DevTestProblem['severity'][] = ['critical', 'major', 'minor', 'trivial'];
  for (const severity of order) {
    const group = problems.filter((problem) => problem.severity === severity);
    if (!group.length) continue;
    lines.push(`## ${SEVERITY_LABELS[severity]}（${group.length}）`, '');
    for (const problem of group) {
      lines.push(`### ${problem.id} ${problem.title}`);
      lines.push('');
      if (problem.dimension) lines.push(`- 维度：${problem.dimension}`);
      if (problem.reasonCode) lines.push(`- 原因码：\`${problem.reasonCode}\``);
      if (problem.caseIds.length) lines.push(`- 关联用例：${problem.caseIds.join(', ')}`);
      if (problem.reproduce.length) {
        lines.push('- 复现步骤：');
        problem.reproduce.forEach((step) => lines.push(`  ${step}`));
      }
      if (problem.evidence.length) {
        lines.push('- 证据：');
        problem.evidence.forEach((item) => lines.push(`  - ${item}`));
      }
      if (problem.suggestion) lines.push(`- 建议：${problem.suggestion}`);
      lines.push('');
    }
  }
  if (meta.pendingMutationCaseIds.length) {
    lines.push('## 待确认写路径', '', `以下写操作在 SAFE 模式下未真实执行：${meta.pendingMutationCaseIds.join(', ')}`,
      '', '确认风险后使用 `--confirm-mutations` 重跑以放行写路径。', '');
  }
  return lines.join('\n');
}

// ============================================================
//  report.json（与 HTML 章节同构的信封）
// ============================================================

export function buildDevTestReportEnvelope(input: DevTestRenderInput): Record<string, unknown> {
  const { report } = input;
  return {
    schema: DEVTEST_REPORT_SCHEMA,
    runId: input.runId,
    generatedAt: input.generatedAt,
    input: input.meta,
    conclusionBanner: CONCLUSION_BANNERS[input.conclusion],
    nextStepHint: nextStepHint(input),
    summary: report.summary,
    trust: report.trust,
    dimensions: input.dimensionStats,
    problems: input.problems,
    pendingMutations: {
      count: input.pendingMutationCaseIds.length,
      caseIds: input.pendingMutationCaseIds,
      hint: 'SAFE 模式默认拦截写路径；确认风险后加 --confirm-mutations 重跑。',
    },
    unknowns: {
      unverifiedFacts: report.coverage.unverifiedFacts.map((fact) => ({ id: fact.id, statement: fact.statement })),
      observationGaps: report.observationGaps,
      bindingIssues: report.bindingIssues,
    },
    rtm: report.cases.map((item) => ({
      caseId: item.caseId,
      testType: item.testType,
      priority: item.priority,
      executionStatus: item.executionStatus,
      acceptanceCriteriaIds: item.evidence?.acceptanceCriteriaIds ?? [],
      factIds: item.sourceFactIds,
      objectiveIds: item.sourceObjectiveIds,
    })),
    acceptanceReport: JSON.parse(reportJsonOf(input.report)),
  };
}

function reportJsonOf(report: AcceptanceReport): string {
  // 延迟 import 会造成循环依赖风险；这里直接内联序列化核心报告。
  return JSON.stringify(report);
}

function nextStepHint(input: DevTestRenderInput): string {
  if (input.conclusion === 'FAIL') return '先修复 critical/major 问题，再重跑确认。';
  if (input.pendingMutationCaseIds.length && !input.meta.confirmMutations) {
    return `有 ${input.pendingMutationCaseIds.length} 条写路径待确认；确认后加 --confirm-mutations 重跑放行。`;
  }
  if (input.conclusion === 'BLOCKED') return '按问题清单补齐需求/环境前置条件后重跑。';
  if (input.conclusion === 'PARTIAL') return '查看未知项与挂起清单，补齐适配能力或凭据后重跑。';
  return '本轮只读验证完成；如需覆盖写路径与状态证据，接入 Adapter 后扩展 LIVE 演练。';
}

// ============================================================
//  report.html（七个固定章节）
// ============================================================

export function renderDevTestHtml(input: DevTestRenderInput): string {
  const { report } = input;
  const banner = CONCLUSION_BANNERS[input.conclusion];
  const statusByCase = new Map(report.executions.map((item) => [item.caseId, item]));
  const parts: string[] = [];

  parts.push(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DevTest 报告 · ${escapeHtml(report.requirement.title)} · ${escapeHtml(input.runId)}</title>
<style>
:root { --container-max:1600px; --toc-width:200px; --table-min-width:720px; }
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:#1f2328; background:#f6f8fa; }
.container { max-width:var(--container-max); margin:0 auto; padding:24px; }
h1 { font-size:22px; } h2 { font-size:18px; margin-top:32px; border-bottom:1px solid #d0d7de; padding-bottom:6px; }
.banner { border-left:6px solid #888; padding:14px 18px; border-radius:6px; background:#fff; margin:12px 0; }
.banner.ok { border-color:#1a7f37; } .banner.bad { border-color:#cf222e; } .banner.warn { border-color:#9a6700; }
.banner .label { font-weight:700; font-size:16px; margin-right:10px; }
.trust { color:#59636e; font-size:13px; margin-top:6px; }
.cards { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
.card { background:#fff; border:1px solid #d0d7de; border-radius:6px; padding:10px 16px; min-width:110px; }
.card .num { font-size:22px; font-weight:700; } .card .cap { font-size:12px; color:#59636e; }
section { background:#fff; border:1px solid #d0d7de; border-radius:6px; padding:4px 20px 16px; margin-bottom:18px; }
.table-wrap { overflow-x:auto; }
table { border-collapse:collapse; width:100%; min-width:var(--table-min-width); font-size:13px; }
th, td { border:1px solid #d0d7de; padding:6px 10px; text-align:left; vertical-align:top; }
th { background:#f6f8fa; white-space:nowrap; }
.st-PASS { color:#1a7f37; font-weight:600; } .st-FAIL { color:#cf222e; font-weight:600; }
.st-BLOCKED { color:#9a6700; font-weight:600; } .st-NOT_EXECUTED { color:#59636e; }
.sev-critical { color:#cf222e; font-weight:700; } .sev-major { color:#bc4c00; font-weight:600; }
.sev-minor { color:#9a6700; } .sev-trivial { color:#59636e; }
details { margin:6px 0; } summary { cursor:pointer; color:#0969da; }
code, pre { background:#f6f8fa; border-radius:4px; font-size:12px; }
pre { padding:10px; overflow-x:auto; }
.hint { background:#fff8c5; border:1px solid #d4a72c66; padding:10px 14px; border-radius:6px; font-size:13px; }
ul { margin:6px 0; }
</style>
</head>
<body><div class="container">
`);

  // ① 结论横幅
  parts.push(`<h1>DevTest 初步验证报告 · ${escapeHtml(report.requirement.title)}</h1>
<div class="banner ${banner.cssClass}"><span class="label">${banner.label}</span>${banner.text}
<div class="trust">Run: ${escapeHtml(input.runId)} · 模式: ${input.meta.mode}${input.meta.mode === 'execute' ? (input.meta.confirmMutations ? '（写路径已确认放行）' : '（SAFE，写路径挂起）') : '（DRY_RUN，零 HTTP 调用）'} · 环境: ${escapeHtml(input.meta.environment)} · 目标: ${escapeHtml(input.meta.baseUrl)} · 来源: ${escapeHtml(input.meta.docSource)} · 生成于 ${escapeHtml(input.generatedAt)}
<div class="trust">${escapeHtml(report.trust.interpretation)}</div>
</div></div>
<div class="hint"><b>下一步：</b>${escapeHtml(nextStepHint(input))}</div>
`);

  // ② 统计卡片 + 五维统计表
  const s = report.summary;
  parts.push(`<section id="stats"><h2>② 五维用例统计</h2>
<div class="cards">
  <div class="card"><div class="num">${s.designed}</div><div class="cap">设计用例</div></div>
  <div class="card"><div class="num">${s.executable}</div><div class="cap">可执行</div></div>
  <div class="card"><div class="num st-PASS">${s.passed}</div><div class="cap">PASS</div></div>
  <div class="card"><div class="num st-FAIL">${s.failed}</div><div class="cap">FAIL</div></div>
  <div class="card"><div class="num st-BLOCKED">${s.blocked}</div><div class="cap">BLOCKED</div></div>
  <div class="card"><div class="num st-NOT_EXECUTED">${s.notExecuted}</div><div class="cap">NOT_EXECUTED</div></div>
  <div class="card"><div class="num">${s.unverified}</div><div class="cap">未验证规范 Fact</div></div>
</div>
<div class="table-wrap"><table><tr><th>维度</th><th>总数</th><th>可执行</th><th>PASS</th><th>FAIL</th><th>BLOCKED</th><th>NOT_EXECUTED</th></tr>
${input.dimensionStats.map((stat) => `<tr><td>${escapeHtml(stat.dimension)}</td><td>${stat.total}</td><td>${stat.executable}</td><td class="st-PASS">${stat.passed}</td><td class="st-FAIL">${stat.failed}</td><td class="st-BLOCKED">${stat.blocked}</td><td class="st-NOT_EXECUTED">${stat.notExecuted}</td></tr>`).join('\n')}
</table></div></section>
`);

  // ③ 执行结果明细
  parts.push(`<section id="executions"><h2>③ 执行结果明细</h2>
<div class="table-wrap"><table><tr><th>用例ID</th><th>维度</th><th>优先级</th><th>名称</th><th>模式</th><th>状态</th><th>耗时</th></tr>
${report.cases.map((item) => {
    const execution = statusByCase.get(item.caseId);
    return `<tr><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.testType)}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.executionMode)}</td><td class="st-${escapeHtml(item.executionStatus)}">${escapeHtml(item.executionStatus)}</td><td>${execution?.durationMs !== undefined ? `${execution.durationMs}ms` : '-'}</td></tr>`;
  }).join('\n')}
</table></div></section>
`);

  // ④ 问题清单
  parts.push(`<section id="problems"><h2>④ 问题清单（${input.problems.length}）</h2>`);
  if (!input.problems.length) {
    parts.push('<p>未发现问题。注意：这只表示当前可观测范围内无异常信号。</p>');
  } else {
    parts.push('<div class="table-wrap"><table><tr><th>ID</th><th>级别</th><th>类别</th><th>标题</th><th>维度</th><th>关联用例</th><th>建议</th></tr>');
    for (const problem of input.problems) {
      parts.push(`<tr><td>${escapeHtml(problem.id)}</td><td class="sev-${problem.severity}">${escapeHtml(SEVERITY_LABELS[problem.severity])}</td><td>${escapeHtml(problem.category)}</td><td>${escapeHtml(problem.title)}${problem.reasonCode ? `<br><code>${escapeHtml(problem.reasonCode)}</code>` : ''}</td><td>${escapeHtml(problem.dimension ?? '-')}</td><td>${escapeHtml(problem.caseIds.join(', ') || '-')}</td><td>${escapeHtml(problem.suggestion ?? '-')}</td></tr>`);
    }
    parts.push('</table></div>');
  }
  if (input.pendingMutationCaseIds.length) {
    parts.push(`<p class="hint"><b>待确认写路径（${input.pendingMutationCaseIds.length}）：</b>${escapeHtml(input.pendingMutationCaseIds.join(', '))}<br>SAFE 模式默认不执行写操作；确认风险后加 <code>--confirm-mutations</code> 重跑。</p>`);
  }
  parts.push('</section>');

  // ⑤ 未覆盖与未知项
  const unknownRows = [
    ...report.coverage.unverifiedFacts.map((fact) => `<tr><td>未验证 Fact</td><td><code>${escapeHtml(fact.id)}</code></td><td>${escapeHtml(fact.statement)}</td></tr>`),
    ...report.observationGaps.map((gap) => `<tr><td>观察缺口</td><td><code>${escapeHtml(gap.id)}</code></td><td>${escapeHtml(gap.missingObservation)}（需能力：${escapeHtml(gap.requiredCapability)}）</td></tr>`),
    ...report.bindingIssues.slice(0, 50).map((issue) => `<tr><td>绑定问题</td><td><code>${escapeHtml(issue.code)}</code></td><td>${escapeHtml(issue.message)}</td></tr>`),
  ];
  parts.push(`<section id="unknowns"><h2>⑤ 未覆盖与未知项</h2>`);
  if (!unknownRows.length) parts.push('<p>无。</p>');
  else parts.push(`<div class="table-wrap"><table><tr><th>类型</th><th>标识</th><th>说明</th></tr>\n${unknownRows.join('\n')}</table></div>`);
  parts.push('</section>');

  // ⑥ RTM 追踪矩阵
  parts.push(`<section id="rtm"><h2>⑥ RTM 追踪矩阵</h2>
<div class="table-wrap"><table><tr><th>用例ID</th><th>维度</th><th>优先级</th><th>AC</th><th>Fact</th><th>Objective</th><th>状态</th></tr>
${report.cases.map((item) => `<tr><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.testType)}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml((item.evidence?.acceptanceCriteriaIds ?? []).join(', ') || '-')}</td><td>${escapeHtml((item.sourceFactIds ?? []).join(', ') || '-')}</td><td>${escapeHtml((item.sourceObjectiveIds ?? []).join(', ') || '-')}</td><td class="st-${escapeHtml(item.executionStatus)}">${escapeHtml(item.executionStatus)}</td></tr>`).join('\n')}
</table></div></section>
`);

  // ⑦ 证据附录
  const evidenceBlocks = report.executions
    .filter((item) => item.evidence?.assertions?.length || item.evidence?.request)
    .map((item) => {
      const assertionLines = (item.evidence.assertions ?? []).map((assertion) =>
        `    { "type": "${escapeHtml(assertion.type)}", "pass": ${assertion.pass}, "detail": "${escapeHtml(assertion.detail)}" }`).join(',\n');
      const requestLine = item.evidence.request
        ? `"method": "${escapeHtml(item.evidence.request.method)}", "url": "${escapeHtml(item.evidence.request.url)}", `
        : '';
      return `<details><summary>${escapeHtml(item.caseId)} · ${escapeHtml(item.name)} · ${escapeHtml(item.status)}</summary><pre>{ ${requestLine}"assertions": [\n${assertionLines}\n] }</pre></details>`;
    });
  parts.push(`<section id="evidence"><h2>⑦ 证据附录</h2>`);
  parts.push(evidenceBlocks.length ? evidenceBlocks.join('\n') : '<p>本轮无可展示的传输层证据（DRY_RUN 或全部挂起/阻断）。</p>');
  parts.push('</section>');

  parts.push('</div></body></html>');
  return parts.join('\n');
}
