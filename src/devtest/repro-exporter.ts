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

    // 2. 检查关键参数完整性
    const missingParams: string[] = [];
    if (!taskInfo.modelId) missingParams.push('taskInfo.modelId');
    if (!baseUrl) missingParams.push('taskInfo.baseUrl');

    // 3. 生成标题
    const invariantText = violatedInvariants.length > 0 ? ` [${violatedInvariants.join('+')}]` : '';
    const title = `[DevTest 自测阻断 ${severity}] 模型 ${taskInfo.modelId ?? '(未指定模型)'} (${taskInfo.mediaType}) 出现 ${failureCategory}${invariantText}`;

    // 4. 生成独立 cURL 命令
    const postPayload = isVideo
      ? {
          'row[type]': 1,
          'row[extra][selmodels]': `${taskInfo.modelId || '<MODEL_ID>'}-model`,
          'row[extra][hs_tssp_cueword]': taskInfo.prompt || 'devtest_repro_prompt',
          'row[extra][hs_tssp_video_duration]': taskInfo.duration || 4,
          'row[extra][hs_tssp_video_resolution]': taskInfo.resolution || '720p',
          'row[extra][hs_tssp_videoratio]': taskInfo.aspectRatio || '16:9',
        }
      : {
          selmodelsId: taskInfo.modelId || '<MODEL_ID>',
          cueword: taskInfo.prompt || 'devtest_repro_prompt',
          serviceline: taskInfo.serviceline || 'r',
          resolution: taskInfo.resolution || '1k',
          aspectRatio: taskInfo.aspectRatio || '1:1',
        };

    const curlWarning = missingParams.length > 0
      ? `# ⚠️ 警告: 缺少关键参数 [${missingParams.join(', ')}]，请补充真实参数后再执行\n`
      : '';

    const curlCommand = [
      curlWarning + `curl -X POST '${baseUrl}${submitEndpoint}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'Cookie: PHPSESSID=\${PANQU_SESSION:-your_cookie_here}' \\`,
      `  -d '${JSON.stringify(postPayload, null, 2).replace(/'/g, "'\\''")}'`,
    ].join('\n');

    // 5. 生成独立 Playwright 最小复现脚本
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

    // 6. 生成标准 Markdown Bug 提单模版
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

    const severityExplanation = severity === 'P0'
      ? '存在资金少扣/漏退/重复扣等资损风险，或核心链路中断，需紧急阻断发布。'
      : severity === 'P1'
        ? '核心生成产物损坏或任务持续失败，直接影响用户交付。'
        : '业务规则或非关键参数校验不一致，需排查修复。';
    const invariantExplanation = violatedInvariants.length > 0
      ? `违背账务核心不变量: [${violatedInvariants.join(', ')}]`
      : '未观测到违背账务不变量，属于业务逻辑或规格不一致。';

    const markdownReport = `# ${title}

- **用例标识**: \`${caseId}\`
- **缺陷等级**: **${severity}**
- **测试环境**: \`${env}\` (\`${baseUrl}\`)
- **模型 ID**: \`${taskInfo.modelId ?? '未指定'}\` (${taskInfo.mediaType})
- **发现时间**: ${new Date().toISOString()}

---

## ⏱️ 一、30 秒业务与质量速览 (Product & Ops View)

| 评估项 | 结果判定 | 通俗业务影响说明 |
| :--- | :---: | :--- |
| **缺陷等级** | **${severity}** | ${severityExplanation} |
| **异常分类** | \`${failureCategory}\` | ${violatedInvariants.length > 0 ? '违背资损防线不变量' : '业务执行或产物校验失败'} |
| **资损与规则** | ${violatedInvariants.length > 0 ? '🔴 存在资损漏洞' : '🟢 无直接资损'} | ${invariantExplanation} |
| **代码定位状态** | \`UNKNOWN (未确认代码行，严禁盲猜)\` | 需研发根据下方现场 cURL / 脚本复现后查看报错堆栈定位 |
| **下一步指引** | \`业务研发与通道研发\` | 在测试环境执行下方复现脚本，定位并修复问题 |

---

## 🛠️ 二、研发执行取证与现场详情 (Developer View)

### 1. 预期结果 vs 实际结果

| 维度 | 预期 (Expected) | 实际 (Actual) |
| :--- | :--- | :--- |
| **状态/决策** | \`${typeof expected === 'string' ? expected : JSON.stringify(expected)}\` | \`${typeof actual === 'string' ? actual : JSON.stringify(actual)}\` |

#### 违背的业务规则与不变量
${
  violatedInvariants.length > 0
    ? violatedInvariants.map((v) => `- ❌ **[CRITICAL]** \`${v}\``).join('\n')
    : '- ⚠️ 观测到业务逻辑或规格不一致'
}

#### 详细诊断原因
${reasons.map((r) => `- ${r}`).join('\n')}

---

### 2. 账单流水审计现场 (Score Logs)

${scoreLogTable}

---

### 3. 终端一键 cURL 调试复现

\`\`\`bash
${curlCommand}
\`\`\`

---

### 4. 独立 Playwright 复现测试脚本

> 可直接复制保存至本地并在终端运行：\`npx playwright test repro-${caseId}.ts\`

\`\`\`typescript
${playwrightScript}
\`\`\`

---

### 5. 🛠️ 开发修复指引 (Remediation Guidance)

${
  failureCategory === 'BILLING_ANOMALY' || violatedInvariants.includes('ANTI_DOUBLE_BILLING') || violatedInvariants.includes('NET_CHARGE_ZERO')
    ? `- **目标组件**: 计费与积分变动流水服务 (\`pq_score_log\` / \`site_recharge\`)
- **修复方案**:
  1. 确保任务创建与扣费事务中，有且仅产生一条与当前 \`taskId\` 绑定的扣费记录，利用 \`(user_id, task_id, type)\` 防并发重复扣费；
  2. 针对失败任务，在终态回调中触发全额退款补偿事务，确保净扣积分严格归零；
  3. 退款流水执行幂等性检查，防止重试导致重复退款。`
    : failureCategory === 'DIVERSION_MISMATCH'
      ? `- **目标组件**: FastAdmin 后端分流判定与快照持久化模块
- **修复方案**:
  1. 确保在创建任务事务中调用 \`check_diversion()\`，将分流决策值完整写入 \`pq_aivideo_new.extra\` JSON；
  2. 显式固化 \`extra.diversion = 10\` 与 \`extra.newapi_model\`，杜绝快照丢失；
  3. 确认组织与用户是否处于 NewAPI 专线白名单。`
      : failureCategory === 'ARTIFACT_CORRUPT'
        ? `- **目标组件**: 媒体合成转码与 OSS 上传管道
- **修复方案**:
  1. 排查上游转码配置参数，确保视频输出格式符合标准 MP4/H.264 容器标准；
  2. 确保 MP4 moov box 放置于文件首部支持流式播放；
  3. 确认 OSS 存储签名链接具备公开读或有效凭证。`
        : `- **目标组件**: 业务接口处理与参数校验层
- **修复方案**:
  1. 对照预期行为 \`${typeof expected === 'string' ? expected : JSON.stringify(expected)}\` 排查业务分支逻辑；
  2. 结合现场 cURL 调试报错排查参数合法性并修正契约处理。`
}

---

### 6. ⚠️ 潜在回归风险与回滚方案 (Risk & Rollback)

- **潜在回归风险**:
  - 修改可能影响下游任务消费端对状态字段的解析，或对关联用例产生副作用；
  - 涉及事务调整时需评估数据库锁竞争与高并发性能表现。
- **回滚操作方案**:
  - 代码上线若发现异常，立即执行 \`git revert\` 回滚对应的修复 commit；
  - 若涉及配置项调整，恢复至配置快照备份。

---

### 7. 🎯 真正解决的验收标准 (Definition of Done - DoD)

- [ ] **DoD-1**: 使用上述独立复现 cURL / Playwright 脚本在测试环境执行，接口返回 HTTP 200 且业务 \`code === 1\`。
- [ ] **DoD-2**: 实测行为与预期完全一致，不变量检查 100% 通过：\`${violatedInvariants.length > 0 ? violatedInvariants.join(', ') : '核心业务契约合规'}\`。
- [ ] **DoD-3**: 数据库持久化记录无多扣、漏退或重复流水，全链路回归测试用例全部通过。
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
