/**
 * 缺陷一键复现包导出器 (Bug Reproduction Exporter)
 *
 * 核心功能：
 * 当开发自测或流水线发现计费少扣/漏退/重复扣、分流未按预期切流、产物介质结构损坏等异常时，
 * 自动导出包含独立 cURL 调试命令、Playwright 最小脱敏复现脚本与 Markdown 提单模版的标准交付包。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ReproExportOptions {
  caseId: string;
  failureCategory:
    | 'BILLING_ANOMALY'
    | 'DIVERSION_MISMATCH'
    | 'ARTIFACT_CORRUPT'
    | 'TASK_FAILED'
    | 'PARAM_REJECTED'
    | string;
  taskInfo: {
    taskId?: number;
    modelId: number;
    mediaType: 'video' | 'image';
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    prompt?: string;
    serviceline?: string;
    env?: string;
    baseUrl?: string;
  };
  expected: Record<string, unknown> | string;
  actual: Record<string, unknown> | string;
  reasons: string[];
  violatedInvariants?: string[];
  scoreLogs?: Array<{ type: number | string; score?: number; points?: number; memo?: string }>;
  outputDir?: string;
}

export interface ReproPackageResult {
  ok: boolean;
  caseId: string;
  severity: 'P0' | 'P1' | 'P2';
  title: string;
  curlCommand: string;
  playwrightScript: string;
  markdownReport: string;
  savedFiles?: {
    markdownPath: string;
    scriptPath: string;
  };
}

export class ReproExporter {
  public static async generatePackage(options: ReproExportOptions): Promise<ReproPackageResult> {
    const {
      caseId,
      failureCategory,
      taskInfo,
      expected,
      actual,
      reasons,
      violatedInvariants = [],
      scoreLogs = [],
      outputDir,
    } = options;

    const env = taskInfo.env || 'test';
    const baseUrl = taskInfo.baseUrl || (env === 'preonline' ? 'https://preonline.panqu.com' : 'https://test.panqu.com');
    const isVideo = taskInfo.mediaType === 'video';
    const submitEndpoint = isVideo ? '/aivideo/videonew/add' : '/aivideo/v2/image/generate';

    // 1. 评估缺陷严重程度
    let severity: 'P0' | 'P1' | 'P2' = 'P1';
    if (
      violatedInvariants.includes('ANTI_DOUBLE_BILLING') ||
      violatedInvariants.includes('NET_CHARGE_ZERO') ||
      failureCategory === 'BILLING_ANOMALY'
    ) {
      severity = 'P0'; // 资损或资金流水违背为最高优先级
    } else if (failureCategory === 'ARTIFACT_CORRUPT' || failureCategory === 'TASK_FAILED') {
      severity = 'P1';
    } else {
      severity = 'P2';
    }

    // 2. 生成标题
    const invariantText = violatedInvariants.length > 0 ? ` [${violatedInvariants.join('+')}]` : '';
    const title = `[DevTest 自测阻断 ${severity}] 模型 ${taskInfo.modelId} (${taskInfo.mediaType}) 出现 ${failureCategory}${invariantText}`;

    // 3. 生成独立 cURL 命令
    const postPayload = isVideo
      ? {
          'row[type]': 1,
          'row[extra][selmodels]': `${taskInfo.modelId}-model`,
          'row[extra][hs_tssp_cueword]': taskInfo.prompt || 'devtest_repro_prompt',
          'row[extra][hs_tssp_video_duration]': taskInfo.duration || 4,
          'row[extra][hs_tssp_video_resolution]': taskInfo.resolution || '720p',
          'row[extra][hs_tssp_videoratio]': taskInfo.aspectRatio || '16:9',
        }
      : {
          selmodelsId: taskInfo.modelId,
          cueword: taskInfo.prompt || 'devtest_repro_prompt',
          serviceline: taskInfo.serviceline || 'r',
          resolution: taskInfo.resolution || '1k',
          aspectRatio: taskInfo.aspectRatio || '1:1',
        };

    const curlCommand = [
      `curl -X POST '${baseUrl}${submitEndpoint}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Cookie: PHPSESSID=\${PANQU_SESSION:-your_cookie_here}' \\`,
      `  -d '${JSON.stringify(postPayload, null, 2).replace(/'/g, "'\\''")}'`,
    ].join('\n');

    // 4. 生成独立 Playwright 最小复现脚本
    const playwrightScript = `import { test, expect, request } from '@playwright/test';

test.describe('最小缺陷复现: ${caseId}', () => {
  test('复现模型 ${taskInfo.modelId} 任务创建与断言异常', async () => {
    const apiContext = await request.newContext({
      baseURL: '${baseUrl}',
      extraHTTPHeaders: {
        'Cookie': process.env.PANQU_COOKIE || '',
        'Content-Type': 'application/json',
      },
    });

    // 1. 提交生成任务
    const res = await apiContext.post('${submitEndpoint}', {
      data: ${JSON.stringify(postPayload, null, 6)},
    });

    expect(res.status(), '接口应返回 HTTP 200').toBe(200);
    const body = await res.json();
    console.log('任务创建响应:', body);

    // 2. 验证任务 ID 是否返回
    expect(body.code, '业务状态码应为 1').toBe(1);
    const taskId = body.data?.id;
    expect(taskId, '应返回合法任务 ID').toBeDefined();

    // 3. 详情轮询
    const detailRes = await apiContext.get(\`/aivideo/v2/video/getEditData?video_id=\${taskId}\`);
    const detailBody = await detailRes.json();
    console.log('任务详情数据:', detailBody);

    // 预期结果与实际对比
    // Expected: ${typeof expected === 'string' ? expected : JSON.stringify(expected)}
    // Actual: ${typeof actual === 'string' ? actual : JSON.stringify(actual)}
  });
});
`;

    // 5. 生成标准 Markdown Bug 提单模版
    const scoreLogTable =
      scoreLogs.length > 0
        ? [
            '| 类型 (Type) | 积分变动 (Score) | 备注 (Memo) |',
            '| :--- | :--- | :--- |',
            ...scoreLogs.map(
              (log) => `| ${log.type} | ${log.score ?? log.points ?? 0} | ${log.memo || '-'} |`
            ),
          ].join('\n')
        : '_未采集到关联账单流水记录_';

    const markdownReport = `# ${title}

- **用例标识**: \`${caseId}\`
- **缺陷等级**: **${severity}**
- **测试环境**: \`${env}\` (\`${baseUrl}\`)
- **模型 ID**: \`${taskInfo.modelId}\` (${taskInfo.mediaType})
- **发现时间**: ${new Date().toISOString()}

---

## 1. 预期结果 vs 实际结果

| 维度 | 预期 (Expected) | 实际 (Actual) |
| :--- | :--- | :--- |
| **状态/决策** | \`${typeof expected === 'string' ? expected : JSON.stringify(expected)}\` | \`${typeof actual === 'string' ? actual : JSON.stringify(actual)}\` |

### 违背的业务规则与不变量
${
  violatedInvariants.length > 0
    ? violatedInvariants.map((v) => `- ❌ **[CRITICAL]** \`${v}\``).join('\n')
    : '- ⚠️ 观测到业务逻辑或规格不一致'
}

### 详细诊断原因
${reasons.map((r) => `- ${r}`).join('\n')}

---

## 2. 账单流水审计现场 (Score Logs)

${scoreLogTable}

---

## 3. 终端一键 cURL 调试复现

\`\`\`bash
${curlCommand}
\`\`\`

---

## 4. 独立 Playwright 复现测试脚本

> 可直接复制保存至本地并在终端运行：\`npx playwright test repro-${caseId}.ts\`

\`\`\`typescript
${playwrightScript}
\`\`\`
`;

    let savedFiles;
    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      const markdownPath = path.resolve(outputDir, `${caseId}-repro.md`);
      const scriptPath = path.resolve(outputDir, `${caseId}-repro.spec.ts`);
      await writeFile(markdownPath, markdownReport, 'utf8');
      await writeFile(scriptPath, playwrightScript, 'utf8');
      savedFiles = { markdownPath, scriptPath };
    }

    return {
      ok: true,
      caseId,
      severity,
      title,
      curlCommand,
      playwrightScript,
      markdownReport,
      savedFiles,
    };
  }
}
