import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../../bin/run-devtest.js';
import { runDevTest } from '../../../src/devtest/devtest-runner.js';
import { validateDeveloperHandoffMarkdown } from '../../../src/devtest/handoff-validation.js';

let root: string;
let cases: string;
let report: string;
let reportDir: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'handoff-gate-'));
  const result = await runDevTest({ docPath: 'tests/acceptance/fixtures/devtest-sample.md', mode: 'DRY_RUN', outDir: root, maxCases: 20 });
  cases = await readFile(result.artifacts.testCasesMd, 'utf8');
  report = await readFile(result.artifacts.developerSelfTestReportMd, 'utf8');
  reportDir = result.artifacts.dir;
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
afterEach(() => vi.restoreAllMocks());

describe('developer handoff structural and cross-file gate', () => {
  it('accepts actual kernel output without inventing executed code evidence', () => {
    expect(validateDeveloperHandoffMarkdown(cases, report)).toEqual({ valid: true, errors: [] });
  });
  it.each([
    ['ninth chapter from a free-form historical report', (text: string) => `${text}\n## 9. 最重要的下一步\n\n修复产品\n`, 'SECTION_ORDER'],
    ['renamed section', (text: string) => text.replace('## 2. 需求与实现核对', '## 2. 页面截图'), 'SECTION_ORDER'],
    ['HTML line break', (text: string) => text.replace('Top 风险', 'Top<br>风险'), 'NON_TABLE_CONTENT'],
    ['screenshot wall', (text: string) => `${text}\n![图](evidence.png)\n`, 'NON_TABLE_CONTENT'],
    ['code block', (text: string) => `${text}\n\x60\x60\x60\nanything\n\x60\x60\x60\n`, 'NON_TABLE_CONTENT'],
    ['per-case subheadings', (text: string) => `${text}\n### B5 PASS\n`, 'EXTRA_HEADING'],
    ['extra table', (text: string) => text.replace('## 2. 需求与实现核对', '| 附表 | 结果 |\n| --- | --- |\n| a | b |\n\n## 2. 需求与实现核对'), 'ONE_TABLE_REQUIRED'],
    ['unescaped column delimiter', (text: string) => text.replace('| Top 风险 |', '| Top | 风险 |'), 'COLUMN_COUNT'],
    ['missing heading spacing', (text: string) => text.replace('## 2. 需求与实现核对\n\n', '## 2. 需求与实现核对\n'), 'HEADING_SPACING'],
    ['tampered total', (text: string) => text.replace(/\| 用例统计 \| \d+ \|/, '| 用例统计 | 99999 |'), 'REPORT_COUNT_MISMATCH'],
    ['conflicting release recommendation', (text: string) => text.replace('| 最终判定 | 待补测 |', '| 最终判定 | 建议发布 |'), 'RECOMMENDATION_MISMATCH'],
    ['both recommendations hiding unexecuted cases', (text: string) => text.replaceAll('| 待补测 |', '| 建议发布 |'), 'INCOMPLETE_RELEASE_CLAIM'],
  ])('rejects %s', (_name, mutate, code) => {
    const result = validateDeveloperHandoffMarkdown(cases, mutate(report));
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes(code))).toBe(true);
  });
  it('rejects a silent case removal instead of re-counting to make it pass', () => {
    const section = report.split('## 3. 用例执行清单')[1].split('## 4. 审查中发现的问题')[0];
    const row = section.split('\n').filter(line => line.startsWith('|'))[2];
    const result = validateDeveloperHandoffMarkdown(cases, report.replace(row + '\n', ''));
    expect(result.errors).toContain('CASE_ID_STATUS_MISMATCH');
  });
  it('rejects duplicate case IDs even when the displayed aggregate stays unchanged', () => {
    const section = report.split('## 3. 用例执行清单')[1].split('## 4. 审查中发现的问题')[0];
    const row = section.split('\n').filter(line => line.startsWith('|'))[2];
    expect(validateDeveloperHandoffMarkdown(cases, report.replace(row, `${row}\n${row}`)).errors).toContain('CASE_ID_DUPLICATE_OR_EMPTY');
  });
  it('rejects a removed evidence row', () => {
    const section = report.split('## 5. 自动化执行证据')[1].split('## 6. 未覆盖项与回归建议')[0];
    const row = section.split('\n').filter(line => line.startsWith('|'))[2];
    expect(validateDeveloperHandoffMarkdown(cases, report.replace(row + '\n', '')).errors).toContain('EVIDENCE_CASE_MISSING');
  });
  it('rejects nonstandard merged status rather than treating it as PASS', () => {
    const section = report.split('## 3. 用例执行清单')[1].split('## 4. 审查中发现的问题')[0];
    const row = section.split('\n').filter(line => line.startsWith('|'))[2];
    const altered = row.replace(/\| (BLOCKED|NOT_EXECUTED) \|/, '| PASS（并入其他用例） |');
    expect(altered).not.toBe(row);
    expect(validateDeveloperHandoffMarkdown(cases, report.replace(row, altered)).errors).toContain('CASE_STATUS_INVALID');
  });
  it('checks the companion case document aggregate', () => {
    expect(validateDeveloperHandoffMarkdown(cases.replace(/共 \d+ 条/, '共 99999 条'), report).errors).toContain('CASES_COUNT_MISMATCH');
  });
  it('accepts escaped pipes and CRLF in ordinary cells', () => {
    expect(validateDeveloperHandoffMarkdown(cases.replaceAll('\n', '\r\n'), report.replace('Top 风险', 'Top 风险\\|备注')).valid).toBe(true);
  });
  it('validates the real output through the CLI without business verification or fetch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    expect(await main(['validate-report', reportDir])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ valid: true, businessVerified: false, scope: 'FORMAT_AND_CONSISTENCY_ONLY' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed manual output without rewriting the original files', async () => {
    const dir = path.join(root, 'manual'); await mkdir(dir);
    const malformed = '# 历史报告\n\n## 9. 下一步\n\n请自动删除资源\n';
    await writeFile(path.join(dir, '测试用例.md'), cases);
    await writeFile(path.join(dir, '开发自测测试报告.md'), malformed);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['validate-report', dir])).toBe(1);
    expect(await readFile(path.join(dir, '开发自测测试报告.md'), 'utf8')).toBe(malformed);
  });
  it.each([[], ['a', 'b'], ['--output']])('rejects invalid validator arguments %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['validate-report', ...args])).toBe(2);
  });
  it('rejects a missing companion file', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['validate-report', root])).toBe(2);
  });
  it('refuses a symlink report instead of reading another artifact', async () => {
    const dir = path.join(root, 'symlink'); await mkdir(dir);
    await writeFile(path.join(dir, '测试用例.md'), cases);
    await symlink(path.join(reportDir, '开发自测测试报告.md'), path.join(dir, '开发自测测试报告.md'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['validate-report', dir])).toBe(2);
  });
  it('refuses oversized input before parsing the report', async () => {
    const dir = path.join(root, 'oversized'); await mkdir(dir);
    await writeFile(path.join(dir, '测试用例.md'), cases);
    await writeFile(path.join(dir, '开发自测测试报告.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['validate-report', dir])).toBe(2);
  });
});
