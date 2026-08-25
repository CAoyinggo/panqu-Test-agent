// JUnit XML 报告器：对接 CI / 测试平台
import fs from 'node:fs';
import path from 'node:path';
import type { ReportData } from '../core/types.js';
import type { Reporter } from './index.js';
import { effectiveAssertions } from '../core/execution-evidence.js';

function escXml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class JunitReporter implements Reporter {
  name = 'junit';

  write(outputDir: string, slugBase: string, data: ReportData): string[] {
    const slug = String(slugBase).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const file = path.join(outputDir, `${slug}_${Date.now()}.xml`);

    const businessChecks = effectiveAssertions(data.checks);
    const executionPass = data.executed === true
      && data.executionStatus === 'PASS'
      && businessChecks.length > 0
      && businessChecks.every((check) => check.pass);
    const renderedChecks = executionPass || businessChecks.some((check) => !check.pass)
      ? businessChecks
      : [{
        name: data.executionStatus ?? 'NO_EFFECTIVE_ASSERTION',
        pass: false,
        detail: data.issues.find((issue) => issue.level === '阻塞')?.desc
          ?? '没有可证明 PASS 的有效业务断言或执行证据',
      }];
    const tests = renderedChecks.length || 1;
    const failures = renderedChecks.filter((check) => !check.pass).length;

    const caseXml = renderedChecks
      .map((c) => {
        const inner = c.pass
          ? `<system-out>${escXml(c.detail)}</system-out>`
          : `<failure message="${escXml(c.name)}">${escXml(c.detail)}</failure>`;
        return `    <testcase name="${escXml(c.name)}" classname="${escXml(data.taskDef?.scene || 'scene')}">${inner}</testcase>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escXml(data.title)}" tests="${tests}" failures="${failures}" errors="0" time="0">
${caseXml}
</testsuite>
`;
    fs.writeFileSync(file, xml, 'utf-8');
    return [file];
  }
}
