/** Structural handoff gate, not a business oracle. Never rewrites historical evidence. */
export const HANDOFF_SECTIONS = [
  '1. 结论概览', '2. 需求与实现核对', '3. 用例执行清单', '4. 审查中发现的问题',
  '5. 自动化执行证据', '6. 未覆盖项与回归建议', '7. 发布判定',
] as const;
const HEADERS = [
  ['项目', '结果', '说明'],
  ['类型', '编号', '需求/问题', '状态/来源', '关联用例', '负责人/说明'],
  ['编号', '模块', '类型/优先级', '结果', '场景与 Oracle', '执行、证据与备注'],
  ['编号', '级别', '状态', '问题与复现', '证据与处理'],
  ['编号', '执行状态', 'Oracle 结论', '证据与说明'],
  ['未覆盖项', '原因', '需要补充的材料'],
  ['判定项', '结果', '依据'],
];
const statuses = ['PASS', 'FAIL', 'BLOCKED', 'NOT_EXECUTED'];

function cells(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let slashes = 0;
  for (const char of line.trim().slice(1, -1)) {
    if (char === '|' && slashes % 2 === 0) { values.push(value.trim()); value = ''; }
    else value += char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  values.push(value.trim());
  return values;
}

/** Both files must describe exactly the same cases and statuses, including unexecuted ones. */
export function validateDeveloperHandoffMarkdown(testCases: string, report: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  function parse(text: string, expected: readonly string[], headers: string[][], label: string): string[][][] {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.filter(line => /^# /.test(line)).length !== 1) errors.push(`${label}:TITLE_COUNT`);
    if (/<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->|!\[[^\]]*\]\(|^\s*(?:```|~~~)/m.test(text)) errors.push(`${label}:NON_TABLE_CONTENT`);
    const headings = lines.flatMap((line, index) => /^## /.test(line) ? [{ name: line.slice(3), index }] : []);
    if (JSON.stringify(headings.map(item => item.name)) !== JSON.stringify(expected)) errors.push(`${label}:SECTION_ORDER`);
    if (lines.some(line => /^#{3,}/.test(line))) errors.push(`${label}:EXTRA_HEADING`);
    return expected.map((name, section) => {
      const at = headings.find(item => item.name === name)?.index;
      if (at === undefined) return [];
      const next = headings.find(item => item.index > at)?.index ?? lines.length;
      const content = lines.slice(at + 1, next);
      const tableLines = content.filter(line => line.trim().startsWith('|'));
      if (lines[at - 1]?.trim() || lines[at + 1]?.trim()) errors.push(`${label}:${section}:HEADING_SPACING`);
      const groups = content.filter((line, index) => line.trim().startsWith('|') && !content[index - 1]?.trim().startsWith('|')).length;
      if (groups !== 1 || tableLines.length < 3) errors.push(`${label}:${section}:ONE_TABLE_REQUIRED`);
      const parsed = tableLines.map(cells);
      if (JSON.stringify(parsed[0]) !== JSON.stringify(headers[section])) errors.push(`${label}:${section}:HEADERS`);
      if (parsed.some(row => row.length !== headers[section].length) || tableLines.some(line => !line.trim().endsWith('|'))) errors.push(`${label}:${section}:COLUMN_COUNT`);
      if (!parsed[1]?.every(cell => /^:?-{3,}:?$/.test(cell))) errors.push(`${label}:${section}:SEPARATOR`);
      if (content.some(line => line.trim() && !line.trim().startsWith('|') && !(section === expected.length - 1 && line.startsWith('> 说明：')))) errors.push(`${label}:${section}:EXTRA_CONTENT`);
      return parsed.slice(2);
    });
  }
  const caseTables = parse(testCases, ['全部测试用例'], [HEADERS[2]], 'cases');
  const reportTables = parse(report, HANDOFF_SECTIONS, HEADERS, 'report');
  function indexRows(rows: string[][]): Map<string, string> {
    const indexed = new Map<string, string>();
    for (const row of rows) {
      if (row[0] === 'N/A（不适用）') continue;
      if (!row[0] || indexed.has(row[0])) errors.push('CASE_ID_DUPLICATE_OR_EMPTY');
      if (!statuses.includes(row[3])) errors.push('CASE_STATUS_INVALID');
      indexed.set(row[0], row[3]);
    }
    return indexed;
  }
  const design = indexRows(caseTables[0]);
  const execution = indexRows(reportTables[2]);
  if (design.size !== execution.size || [...design].some(([id, status]) => execution.get(id) !== status)) errors.push('CASE_ID_STATUS_MISMATCH');
  const counts = statuses.map(status => [...execution.values()].filter(value => value === status).length);
  const expectedCountText = statuses.map((status, index) => `${status} ${counts[index]}`).join('；');
  const statistics = reportTables[0].filter(row => row[0] === '用例统计');
  if (statistics.length !== 1 || statistics[0][1] !== String(execution.size) || statistics[0][2] !== expectedCountText) errors.push('REPORT_COUNT_MISMATCH');
  const summary = `- 用例统计：共 ${execution.size} 条｜${statuses.map((status, index) => `${status} ${counts[index]}`).join('｜')}`;
  if (!testCases.split(/\r?\n/).includes(summary)) errors.push('CASES_COUNT_MISMATCH');
  const seenEvidence = new Set<string>();
  for (const row of reportTables[4]) {
    if (row[0] === 'N/A（不适用）') continue;
    if (seenEvidence.has(row[0]) || !execution.has(row[0]) || execution.get(row[0]) !== row[1]) errors.push('EVIDENCE_ID_STATUS_MISMATCH');
    seenEvidence.add(row[0]);
  }
  // Missing evidence cannot be hidden by omitting the case from chapter 5.
  if ([...execution.keys()].some(id => !seenEvidence.has(id))) errors.push('EVIDENCE_CASE_MISSING');
  const recommendations = [...reportTables[0], ...reportTables[6]].filter(row => ['提测建议', '最终判定'].includes(row[0]));
  if (recommendations.length !== 2 || recommendations[0][1] !== recommendations[1][1]) errors.push('RECOMMENDATION_MISMATCH');
  if (counts.slice(1).some(Boolean) && recommendations.some(row => row[1] === '建议发布')) errors.push('INCOMPLETE_RELEASE_CLAIM');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
