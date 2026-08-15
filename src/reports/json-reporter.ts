// JSON 报告器：结构化输出（CI/程序消费友好）
import fs from 'node:fs';
import path from 'node:path';
import type { ReportData } from '../core/types.js';
import type { Reporter } from './index.js';

export class JsonReporter implements Reporter {
  name = 'json';

  write(outputDir: string, slugBase: string, data: ReportData): string[] {
    const slug = String(slugBase).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
    const file = path.join(outputDir, `${slug}_${Date.now()}.json`);
    const payload = {
      schema: 'test-flow/report/json@1',
      generatedAt: new Date().toISOString(),
      title: data.title,
      env: data.env,
      task: {
        name: data.taskDef?.name,
        scene: data.taskDef?.scene,
        model: data.taskDef?.model_name,
        projectId: data.taskDef?.project_id,
        account: data.taskDef?.account,
      },
      submit: data.submit,
      summary: {
        passRate: data.passRate,
        checksTotal: data.checks.length,
        checksPass: data.checks.filter((c) => c.pass).length,
        issues: data.issues.length,
      },
      checks: data.checks,
      issues: data.issues,
      responses: data.responses,
      impact: data.impact,
      manual: data.manual,
      billing: {
        net: data.billingData?.net,
        modelTrend: data.billingData?.modelTrend,
      },
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    return [file];
  }
}
