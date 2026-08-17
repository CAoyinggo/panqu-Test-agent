// JUnit XML 报告生成器：跨用例级别，供 CI 平台（GitLab/GitHub）解析展示
// 与 src/reports/junit-reporter.ts（per-task 级别，基于 checks）互补
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionSummary, CaseResult } from './exit-code.js';
import { ensureDir } from './fs-utils.js';
import { logger } from './logger.js';

/** JUnit XML 生成选项 */
export interface JUnitXmlOptions {
  /** 输出目录（如 output/<日期>/<功能名>/） */
  outputDir: string;
  /** 文件名（默认 junit.xml） */
  fileName?: string;
  /** 顶层 testsuites 名称 */
  suiteName?: string;
}

/** XML 特殊字符转义 */
function escXml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 按 feature 分组用例 */
function groupByFeature(cases: CaseResult[]): Map<string, CaseResult[]> {
  const groups = new Map<string, CaseResult[]>();
  for (const c of cases) {
    const key = c.feature || 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return groups;
}

/**
 * 生成 JUnit XML 并写入文件。
 *
 * 结构：
 *   <testsuites name="..." tests="N" failures="F" errors="E" time="T">
 *     <testsuite name="feature" tests="N" failures="F" errors="E" time="T">
 *       <testcase classname="feature" name="case-name" time="0.123">
 *         <failure message="...">stack trace</failure>   <!-- 失败时 -->
 *         <error message="...">timeout</error>           <!-- 超时时 -->
 *         <skipped/>                                      <!-- 跳过/待执行时 -->
 *       </testcase>
 *     </testsuite>
 *   </testsuites>
 *
 * @returns 生成的文件路径，失败时返回 null
 */
export function generateJUnitXml(
  summary: ExecutionSummary,
  cases: CaseResult[],
  options: JUnitXmlOptions,
): string | null {
  const { outputDir: outDir, fileName = 'junit.xml', suiteName = 'test-flow' } = options;

  try {
    ensureDir(outDir);

    const groups = groupByFeature(cases);
    const totalTime = cases.reduce((sum, c) => sum + (c.durationMs || 0), 0) / 1000;

    // 统计全局数字
    const totalTests = cases.length;
    const totalFailures = cases.filter((c) => !c.pass && !c.timedOut && !c.pending).length;
    const totalErrors = cases.filter((c) => c.timedOut).length;
    const totalSkipped = cases.filter((c) => c.pending).length;

    const suiteXmls: string[] = [];

    for (const [feature, featureCases] of groups) {
      const suiteTests = featureCases.length;
      const suiteFailures = featureCases.filter((c) => !c.pass && !c.timedOut && !c.pending).length;
      const suiteErrors = featureCases.filter((c) => c.timedOut).length;
      const suiteSkipped = featureCases.filter((c) => c.pending).length;
      const suiteTime = featureCases.reduce((sum, c) => sum + (c.durationMs || 0), 0) / 1000;

      const caseXmls = featureCases.map((c) => {
        const time = ((c.durationMs || 0) / 1000).toFixed(3);
        const classname = escXml(c.feature || 'default');
        const name = escXml(c.name);

        let inner = '';
        if (c.timedOut) {
          // 超时 → <error>
          const msg = escXml(c.error || '执行超时');
          inner = `\n        <error message="${msg}">timeout</error>`;
        } else if (c.pending) {
          // 跳过/待执行 → <skipped/>
          inner = '\n        <skipped/>';
        } else if (!c.pass) {
          // 失败 → <failure>
          const msg = escXml(c.error || '用例执行失败');
          const trace = escXml(c.stack || c.error || '');
          inner = `\n        <failure message="${msg}">${trace}</failure>`;
        }
        return `      <testcase classname="${classname}" name="${name}" time="${time}">${inner}\n      </testcase>`;
      });

      const skippedAttr = suiteSkipped > 0 ? ` skipped="${suiteSkipped}"` : '';

      suiteXmls.push(
        `    <testsuite name="${escXml(feature)}" tests="${suiteTests}" failures="${suiteFailures}" errors="${suiteErrors}" skipped="${suiteSkipped}" time="${suiteTime.toFixed(3)}">\n` +
          caseXmls.join('\n') +
          `\n    </testsuite>`,
      );
    }

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<testsuites name="${escXml(suiteName)}" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${totalTime.toFixed(3)}">\n` +
      suiteXmls.join('\n') +
      `\n</testsuites>\n`;

    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, xml, 'utf-8');
    logger.info(`JUnit XML 报告已生成：${filePath}`);
    return filePath;
  } catch (e: any) {
    logger.warn(`JUnit XML 报告生成失败（已降级跳过）：${e.message}`);
    return null;
  }
}
