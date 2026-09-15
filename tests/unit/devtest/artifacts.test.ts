import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  artifactSafe,
  formatReportDate,
  handoffProblemLevel,
  buildDevTestReportEnvelope,
  renderDeveloperSelfTestReport,
  renderProblemsMarkdown,
  renderDevTestHtml,
  DEVTEST_REPORT_SCHEMA,
} from '../../../src/devtest/artifacts.js';
import { runDevTest } from '../../../src/devtest/devtest-runner.js';
import type { DevTestProblem, DevTestRunResult } from '../../../src/devtest/types.js';

function problem(overrides: Partial<DevTestProblem>): DevTestProblem {
  return {
    id: 'P001',
    type: 'TEST_FAILED',
    severity: 'HIGH',
    dimension: 'FUNCTIONAL',
    message: '确定性断言失败',
    affectedCases: ['CASE-1'],
    failureClass: 'PRODUCT_BUG',
    issueClassification: 'PRODUCT_BUG',
    ...overrides,
  };
}

describe('DevTest developer handoff artifact', () => {
  it('removes runtime URLs, accounts, database connections, and local paths from artifacts', () => {
    const rendered = JSON.stringify(artifactSafe({
      baseUrl: 'https://sandbox.example.test/api/tasks?token=runtime-token',
      databaseUrl: 'postgres://runtime-user:runtime-password@db.internal/devtest',
      account: 'real-account@example.test',
      message: 'username=runtime-user nickname=runtime-name',
      sourcePath: '/Users/private-user/workspace/requirement.md',
    }));

    expect(rendered).toContain('[ENV:DEVTEST_BASE_URL]/api/tasks');
    expect(rendered).toContain('[ENV:DATABASE_URL]');
    expect(rendered).toContain('[LOCAL_PATH]');
    expect(rendered).toContain('***');
    expect(rendered).not.toMatch(/runtime-token|runtime-user|runtime-password|real-account|runtime-name|private-user/);
  });

  it.each([
    ['越权/数据隔离产品问题是 P0', problem({ category: 'Permission Error', dimension: 'DATA_ISOLATION' }), {}, 'P0'],
    ['核心主流程产品问题是 P0', problem({}), { 'CASE-1': { core: true, coreKind: 'HAPPY_PATH' } }, 'P0'],
    ['持久化主流程产品问题是 P0', problem({}), { 'CASE-1': { core: true, coreKind: 'PERSISTENCE' } }, 'P0'],
    ['核心参数校验仍是 P2', problem({ category: 'Parameter Validation Error', dimension: 'PARAMETER_VALIDATION' }), { 'CASE-1': { core: true, coreKind: 'CORE_VALIDATION' } }, 'P2'],
    ['非核心业务结果错误是 P1', problem({}), {}, 'P1'],
    ['一般参数校验问题是 P2', problem({ category: 'Parameter Validation Error', dimension: 'PARAMETER_VALIDATION' }), {}, 'P2'],
    ['一般 UI 一致性问题是 P2', problem({ category: 'UI Behavior Error', dimension: 'UI' }), {}, 'P2'],
    ['低风险建议是 P3', problem({ failureClass: 'UNSUPPORTED', issueClassification: 'EXECUTION_ERROR', severity: 'LOW' }), {}, 'P3'],
  ] as const)('%s', (_name, input, caseProfiles, expected) => {
    expect(handoffProblemLevel(input, { caseProfiles: caseProfiles as never })).toBe(expected);
  });

  it('uses the report timezone instead of truncating the UTC date', () => {
    expect(formatReportDate('2026-08-26T16:30:00.000Z', 'Asia/Shanghai')).toBe('2026-08-27');
    expect(formatReportDate('2026-08-26T16:30:00.000Z', 'UTC')).toBe('2026-08-26');
  });
});

describe('Contract 5 & 6: DevTest Artifacts Schema & Output Structure Invariants', () => {
  let root: string;
  let runResult: DevTestRunResult;
  let reportJsonContent: Record<string, any>;
  let devReportMdContent: string;
  let problemsMdContent: string;
  let reportHtmlContent: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'artifacts-contract-test-'));
    runResult = await runDevTest({
      docPath: 'tests/acceptance/fixtures/contract-safety-fixture.md',
      mode: 'DRY_RUN',
      outDir: root,
      maxCases: 20,
    });
    reportJsonContent = JSON.parse(await readFile(runResult.artifacts.reportJson, 'utf8'));
    devReportMdContent = await readFile(runResult.artifacts.developerSelfTestReportMd, 'utf8');
    problemsMdContent = await readFile(runResult.artifacts.problemsMd, 'utf8');
    reportHtmlContent = await readFile(runResult.artifacts.reportHtml, 'utf8');
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('Contract 5: produces acceptance-summary.md with 30s view and verified coverage', async () => {
    const summaryMd = await readFile(runResult.artifacts.acceptanceSummaryMd, 'utf8');
    expect(summaryMd).toMatch(/^# Feature Acceptance/);
    expect(summaryMd).toContain('## ⏱️ 一、30 秒业务与质量速览 (Product & Ops View)');
    expect(summaryMd).toContain('1. 测了什么 (Tested)');
    expect(summaryMd).toContain('2. 没测什么 (Untested)');
    expect(summaryMd).toContain('3. 确认产品缺陷数 (Bugs)');

    expect(runResult.executionPlan).toBeDefined();
    expect(runResult.deliveryCoverage).toBeDefined();
    expect(runResult.deliveryCoverage.cases).toMatchObject({
      generated: expect.any(Number),
      executable: expect.any(Number),
      executed: expect.any(Number),
      verified: expect.any(Number),
    });
  });

  it('Contract 6: report.json strictly adheres to DEVTEST_REPORT_SCHEMA v8 structure', () => {
    expect(reportJsonContent.schema).toBe(DEVTEST_REPORT_SCHEMA);
    expect(reportJsonContent.schema).toBe('devtest.report.v8');

    // Required top-level keys
    expect(reportJsonContent).toHaveProperty('run');
    expect(reportJsonContent).toHaveProperty('feature');
    expect(reportJsonContent).toHaveProperty('summary');
    expect(reportJsonContent).toHaveProperty('cases');
    expect(reportJsonContent).toHaveProperty('problems');
    expect(reportJsonContent).toHaveProperty('coverageLedger');
    expect(reportJsonContent).toHaveProperty('coverageLedgerSummary');
    expect(reportJsonContent).toHaveProperty('fourLists');
    expect(reportJsonContent).toHaveProperty('reconciliation');
    expect(reportJsonContent).toHaveProperty('presentation');

    // Run metadata
    expect(reportJsonContent.run).toMatchObject({
      id: runResult.runId,
      environment: expect.any(String),
      mode: 'DRY_RUN',
    });
    expect(typeof reportJsonContent.run.id).toBe('string');
    expect(typeof reportJsonContent.feature.name).toBe('string');
    expect(Array.isArray(reportJsonContent.cases)).toBe(true);
    expect(Array.isArray(reportJsonContent.problems)).toBe(true);
    expect(Array.isArray(reportJsonContent.coverageLedger)).toBe(true);

    // Summary structure
    expect(reportJsonContent.summary).toMatchObject({
      status: expect.any(String),
      totalCases: expect.any(Number),
      pass: expect.any(Number),
      fail: expect.any(Number),
      blocked: expect.any(Number),
      notExecuted: expect.any(Number),
      devConfidence: expect.objectContaining({ score: expect.any(Number) }),
    });

    // Four Lists structure (array of case IDs)
    expect(reportJsonContent.fourLists).toMatchObject({
      confirmedBugs: expect.any(Array),
      testBlocked: expect.any(Array),
      untested: expect.any(Array),
      passed: expect.any(Array),
    });

    // Presentation levels
    expect(reportJsonContent.presentation).toHaveProperty('level1');
    expect(reportJsonContent.presentation).toHaveProperty('level2');
    expect(reportJsonContent.presentation.level1).toHaveProperty('conclusion');
    expect(reportJsonContent.presentation.level1).toHaveProperty('actionOwner');

    // Solidify count relationships across summary, cases, fourLists, and coverageLedger
    const summary = reportJsonContent.summary;
    const casesCount = reportJsonContent.cases.length;
    const fourListsCount =
      reportJsonContent.fourLists.passed.length +
      reportJsonContent.fourLists.confirmedBugs.length +
      reportJsonContent.fourLists.testBlocked.length +
      reportJsonContent.fourLists.untested.length;
    const ledgerCount = reportJsonContent.coverageLedger.length;
    const sumOfBuckets = summary.pass + summary.fail + summary.blocked + summary.notExecuted;

    expect(summary.totalCases).toBe(casesCount);
    expect(summary.totalCases).toBe(fourListsCount);
    expect(summary.totalCases).toBe(ledgerCount);
    expect(summary.totalCases).toBe(sumOfBuckets);
    expect(reportJsonContent.coverageLedgerSummary.totalPlanned).toBe(summary.totalCases);
  });

  it('Contract 6: 开发自测测试报告.md strictly adheres to 7-chapter Feishu specification in order', () => {
    // Title
    expect(devReportMdContent).toMatch(/^# .+ 开发自测测试报告/);
    expect(devReportMdContent).toContain('资源审计与转义');

    // 7 chapters in exact numerical order
    const chapters = [
      '## 1. 结论概览',
      '## 2. 需求与实现核对',
      '## 3. 用例执行清单',
      '## 4. 审查中发现的问题',
      '## 5. 自动化执行证据',
      '## 6. 未覆盖项与回归建议',
      '## 7. 发布判定',
    ];

    let lastIndex = -1;
    for (const chapter of chapters) {
      const idx = devReportMdContent.indexOf(chapter);
      expect(idx, `Chapter "${chapter}" must be present`).toBeGreaterThan(-1);
      expect(idx, `Chapter "${chapter}" must appear after preceding chapter`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }

    // Solidify mandatory table headers in each chapter
    const expectedHeaders = [
      '| 项目 | 结果 | 说明 |', // Chapter 1
      '| 类型 | 编号 | 需求/问题 | 状态/来源 | 关联用例 | 负责人/说明 |', // Chapter 2
      '| 编号 | 模块 | 类型/优先级 | 结果 | 场景与 Oracle | 执行、证据与备注 |', // Chapter 3
      '| 编号 | 级别 | 状态 | 问题与复现 | 证据与处理 |', // Chapter 4
      '| 编号 | 执行状态 | Oracle 结论 | 证据与说明 |', // Chapter 5
      '| 未覆盖项 | 原因 | 需要补充的材料 |', // Chapter 6
      '| 判定项 | 结果 | 依据 |', // Chapter 7
    ];

    for (const header of expectedHeaders) {
      expect(devReportMdContent, `Mandatory header "${header}" must be present in markdown report`).toContain(header);
    }

    // Solidify consistency between Markdown report and report.json summary counts
    const summary = reportJsonContent.summary;
    expect(devReportMdContent).toContain(
      `| 用例统计 | ${summary.totalCases} | PASS ${summary.pass}；FAIL ${summary.fail}；BLOCKED ${summary.blocked}；NOT_EXECUTED ${summary.notExecuted} |`
    );
    expect(devReportMdContent).toContain(
      `Dev Confidence ${summary.devConfidence.score}/100`
    );

    // Mandatory explanatory footer
    expect(devReportMdContent).toContain('> 说明：生成不等于执行，执行不等于验证。');
  });

  it('Contract 6: problems.md renders three parallel lists A/B/C and 30-second summary in order', () => {
    expect(problemsMdContent).toMatch(/^# DevTest Problems/);

    const sections = [
      '## ⏱️ 一、30 秒业务影响与质量速览 (Product & Ops View)',
      '## 🛠️ 二、清单 A：确认产品缺陷【开发修复单】 (Confirmed Bugs - Dev Action Required)',
      '## 🟡 三、清单 B：测试阻断【测试阻断单】 (Test Blocked - Ops/Env Remediation)',
      '## ⚪ 四、清单 C：未测试项【未测试清单】 (Untested Items - Coverage Gap)',
      '## ❓ 五、待澄清与未决事项 (Unknowns)',
    ];

    let lastIndex = -1;
    for (const section of sections) {
      const idx = problemsMdContent.indexOf(section);
      expect(idx, `Section "${section}" must be present`).toBeGreaterThan(-1);
      expect(idx, `Section "${section}" must appear after preceding section`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('Contract 6: report.html renders standard HTML5 skeleton with 30s view and four lists section', () => {
    // HTML5 skeleton
    expect(reportHtmlContent).toMatch(/^<!doctype html>/i);
    expect(reportHtmlContent).toContain('<html lang="zh-CN">');
    expect(reportHtmlContent).toContain('<meta charset="utf-8">');
    expect(reportHtmlContent).toContain('<style>');
    expect(reportHtmlContent).toContain('<body>');
    expect(reportHtmlContent).toContain('<main class="wrap">');

    // Key visual sections
    expect(reportHtmlContent).toContain('⏱️ 30 秒业务与质量速览 (Product & Ops View)');
    expect(reportHtmlContent).toContain('📋 核心四大清单与执行事实 (Four Parallel Lists)');
    expect(reportHtmlContent).toContain('</html>');

    // Anti-XSS and injection escaping: raw tags/quotes from fixture input MUST be escaped
    expect(reportHtmlContent).not.toContain('<script>alert("xss")</script>');
    expect(reportHtmlContent).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(reportHtmlContent).toContain('&amp;');
    expect(reportHtmlContent).toContain('&quot;测试&quot;');
  });

  it('Contract 6: artifactSafe ensures sensitive paths and credentials are scrubbed across all artifacts', () => {
    const rawJson = JSON.stringify(reportJsonContent);

    // No raw home/User paths leaked
    expect(rawJson).not.toMatch(/\/Users\/[^\s"')\]}>,]+/);
    expect(devReportMdContent).not.toMatch(/\/Users\/[^\s"')\]}>,]+/);
    expect(problemsMdContent).not.toMatch(/\/Users\/[^\s"')\]}>,]+/);
    expect(reportHtmlContent).not.toMatch(/\/Users\/[^\s"')\]}>,]+/);

    // Any database URLs scrubbed
    expect(rawJson).not.toMatch(/(?:postgres|mysql|redis):\/\/[^\s"']+/);
    expect(devReportMdContent).not.toMatch(/(?:postgres|mysql|redis):\/\/[^\s"']+/);
    expect(problemsMdContent).not.toMatch(/(?:postgres|mysql|redis):\/\/[^\s"']+/);
    expect(reportHtmlContent).not.toMatch(/(?:postgres|mysql|redis):\/\/[^\s"']+/);
  });
});
