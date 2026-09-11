/**
 * Panqu Playwright 闭环测试命令行运行器（Playwright Flow CLI Runner）
 *
 * 用法示例：
 *   # 运行受控模拟闭环测试（覆盖成功、分流、产物、对账）
 *   node dist/src/devtest/run-playwright-cli.js --mock --media video
 *   node dist/src/devtest/run-playwright-cli.js --mock --media image
 *   node dist/src/devtest/run-playwright-cli.js --mock --media video --expect-failure
 *
 *   # 真实测试环境端到端验证（需测试预算与会话）
 *   node dist/src/devtest/run-playwright-cli.js --media video --model 84 --env test
 *   node dist/src/devtest/run-playwright-cli.js --media image --model 201 --env test
 */

import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  runPanquPlaywrightFlow,
  sanitizeSensitiveText,
  createSyntheticValidMp4,
  type PlaywrightFlowRunOptions,
  type FlowRunEvidence,
} from './panqu-playwright-engine.js';
import { STANDARD_RECHARGE_PRESETS } from './supplier-cost-oracle.js';

// 标准测试媒体 Buffer（用于受控快速自验，包含完整容器与元数据）
const MOCK_MP4_HEADER = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });

const MOCK_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export function parseCliArgs(args: string[]): PlaywrightFlowRunOptions & { isMock: boolean } {
  const options: PlaywrightFlowRunOptions & { isMock: boolean } = {
    mediaType: 'video',
    env: 'test',
    outputDir: path.resolve(process.cwd(), 'devtest-results'),
    isMock: false,
    executionMode: 'API_INTEGRATION',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--media' && args[i + 1]) {
      options.mediaType = args[++i] as 'video' | 'image';
    } else if (arg === '--mode' && args[i + 1]) {
      const modeStr = args[++i].toLowerCase();
      if (modeStr === 'browser' || modeStr === 'ui' || modeStr === 'ui_e2e') {
        options.executionMode = 'UI_E2E';
        options.useBrowserPage = true;
      } else if (modeStr === 'api' || modeStr === 'api_integration') {
        options.executionMode = 'API_INTEGRATION';
        options.useBrowserPage = false;
      } else if (modeStr === 'mock') {
        options.executionMode = 'MOCK';
        options.isMock = true;
      }
    } else if (arg === '--task-id' && args[i + 1]) {
      options.taskId = Number(args[++i]);
    } else if (arg === '--model' && args[i + 1]) {
      options.modelId = Number(args[++i]);
    } else if (arg === '--task-type' && args[i + 1]) {
      options.taskType = Number(args[++i]);
    } else if (arg === '--prompt' && args[i + 1]) {
      options.prompt = args[++i];
    } else if (arg === '--duration' && args[i + 1]) {
      options.duration = Number(args[++i]);
    } else if (arg === '--resolution' && args[i + 1]) {
      options.resolution = args[++i];
    } else if (arg === '--aspect' && args[i + 1]) {
      options.aspectRatio = args[++i];
    } else if (arg === '--serviceline' && args[i + 1]) {
      options.serviceline = args[++i];
    } else if (arg === '--env' && args[i + 1]) {
      options.env = args[++i] as 'test' | 'preonline';
    } else if (arg === '--timeout' && args[i + 1]) {
      options.pollTimeoutSec = Number(args[++i]);
    } else if (arg === '--output' && args[i + 1]) {
      options.outputDir = path.resolve(args[++i]);
    } else if (arg === '--mock') {
      options.isMock = true;
      options.executionMode = 'MOCK';
    } else if (arg === '--expect-failure') {
      options.expectFailure = true;
    }
  }

  return options;
}

export function renderEvidenceMarkdown(report: FlowRunEvidence): string {
  const isVideo = report.mediaType === 'video';
  const levelDescriptions: Record<string, string> = {
    BROWSER_PIXEL_DECODED: '✅ 浏览器端真实像素解码完成 (已渲染验证)',
    CONTAINER_METADATA_VERIFIED: '✅ 容器结构与元数据校验通过 (已解析 MP4 Box 树/PNG IHDR，未做像素全流解码)',
    HTTP_ACCESSIBLE_ONLY: '⚠️ 仅验证 HTTP 200 可达 (元数据未完全解析)',
    SKIPPED_ON_FAILURE: '✅ 业务失败分支优雅跳过 (直接进入退款审计)',
    UNVERIFIED: '❌ 未完成有效物理校验',
  };

  return `# Panqu Playwright 闭环自测报告

- **用例编号**: \`${report.caseId}\`
- **运行 ID**: \`${report.runId}\`
- **媒体类型**: \`${report.mediaType.toUpperCase()}\`
- **执行模式**: \`${report.executionMode}\`${report.degradedFromBrowser ? ' *(⚠️ 浏览器不可用已安全降级为 API 模式，禁止视作页面 E2E 通过)*' : ''}
- **业务任务终态**: \`${report.businessTaskStatus || report.taskTracking.terminalStatus}\`
- **测试断言判定**: **${report.testAssertionStatus === 'PASS' ? '✅ 通过 (PASS)' : report.testAssertionStatus === 'BLOCKED' ? '⏸ 阻塞 (BLOCKED)' : '❌ 失败 (FAIL)'}**
- **开始时间**: \`${report.startedAt}\`
- **结束时间**: \`${report.finishedAt}\`

---

## 1. 页面提交与任务关联

| 属性 | 结果 | 说明 |
| :--- | :--- | :--- |
| **任务 ID (taskId)** | \`${report.taskId ?? 'N/A'}\` | 响应拦截提取，严禁猜测 |
| **提交接口** | \`${report.submission.url}\` | HTTP ${report.submission.responseStatus} |
| **提交通道** | \`${report.submission.submissionTransport || 'API_REQUEST'}\` | ${report.submission.submissionTransport === 'BROWSER_PAGE' ? '真实浏览器页面网络拦截' : '直接 HTTP 请求上下文'} |
| **业务返回码** | \`${report.submission.responseCode}\` (${sanitizeSensitiveText(report.submission.responseMsg || 'ok').split('\n')[0].replace(/\|/g, '/').trim().slice(0, 100)}) | code === 1 判定成功 |
| **提交耗时** | \`${report.submission.durationMs}ms\` | 网络响应时间 |

---

## 2. 异步状态机跟踪

- **轮询次数**: ${report.taskTracking.pollCount} 次
- **最终状态**: \`${report.taskTracking.terminalStatus}\`
- **耗时**: \`${report.taskTracking.durationMs}ms\`
${report.taskTracking.failureCategory ? `- **失败分类**: \`${report.taskTracking.failureCategory}\`` : ''}

### 状态变化时间线
| 时间 | 状态码 | 进度 | 阶段说明 |
| :--- | :--- | :--- | :--- |
${report.taskTracking.timeline.map((t) => `| ${t.timestamp.slice(11, 19)} | ${t.status} | ${t.progress}% | ${t.label} |`).join('\n')}

---

## 3. 实际分流独立核查

- **分流核查判定**: **${report.diversion.passed ? '✅ 通过' : '❌ 未达成'}** (状态: \`${report.diversion.status}\`)
- **证据置信状态**: \`${report.diversion.evidenceState}\`
- **预期分流渠道**: \`${report.diversion.expectedChannels?.join(', ') || (Array.isArray(report.diversion.expectedChannel) ? report.diversion.expectedChannel.join(', ') : report.diversion.expectedChannel || '(未指定)')}\`
- **实际分流线路**: \`${report.diversion.actualChannel}\` (命中NewAPI: ${report.diversion.isDiverted ? '是' : '否'})
- **底层快照**:
  - \`newapi_model\`: \`${report.diversion.newapiModel || '(未设置)'}\`
  - \`newapi_org_id\`: \`${report.diversion.actualOrgId ?? '(未记录)'}\`
  - \`newapi_group\`: \`${report.diversion.actualGroup || '(未设置)'}\`

${report.diversion.reasons.length > 0 ? `> [!WARNING]\n> ${report.diversion.reasons.join('\n> ')}` : ''}

---

## 4. 产物物理校验

- **产物校验判定**: **${report.artifact.passed ? '✅ 通过' : '❌ 失败'}** (状态: \`${report.artifact.status}\`)
- **物理校验级别**: \`${report.artifact.verificationLevel || 'UNVERIFIED'}\`
  - *口径说明*: ${report.artifact.verificationLevel ? levelDescriptions[report.artifact.verificationLevel] : '未执行物理校验'}
- **容器结构完整**: ${report.artifact.containerValid ? '✅ 完整' : '❌ 异常'}
- **元数据成功解析**: ${report.artifact.metadataParsed ? '✅ 成功' : '❌ 失败'}
- **真实像素全流解码**: ${report.artifact.fullStreamDecoded ? '✅ 已在浏览器解码渲染' : '⚠️ 未执行全流解码 (以容器与元数据核验为准)'}
${report.artifact.skipped ? '> [!NOTE]\n> 因任务为生成失败分支，按协议已跳过产物物理校验，进入退费检查。' : ''}
${report.artifact.fileAccessible ? `- **HTTP 可访问性**: ✅ 正常 (HTTP ${report.artifact.httpStatus ?? 200})` : ''}
${report.artifact.format ? `- **物理容器/格式**: \`${report.artifact.format}\`` : ''}
${report.artifact.dimensions ? `- **分辨率规格**: \`${report.artifact.dimensions.width}x${report.artifact.dimensions.height}\`` : ''}
${report.artifact.durationSeconds ? `- **视频时长**: \`${report.artifact.durationSeconds}s\`` : ''}
${report.artifact.sha256 ? `- **SHA-256**: \`${report.artifact.sha256}\` (${report.artifact.sizeBytes} bytes)` : ''}

${report.artifact.reasons.length > 0 ? `> [!CAUTION]\n> ${report.artifact.reasons.join('\n> ')}` : ''}

---

## 5. 用户侧积分对账

- **对账核验判定**: **${report.billing.passed ? '✅ 账务一致' : '❌ 存在账务差错'}**
- **预期扣除积分**: \`${report.billing.expectedPoints} 积分\`
- **预扣金额**: \`${report.billing.preDeductedPoints} 积分\`
- **退款金额**: \`${report.billing.refundedPoints} 积分\`
- **实际净扣**: \`${report.billing.netDeductedPoints} 积分\`
- **少扣检测**: ${report.billing.underCharged ? '❌ 存在少扣' : '✅ 正常'}
- **多扣检测**: ${report.billing.overCharged ? '❌ 存在多扣' : '✅ 正常'}
- **重复扣费检测**: ${report.billing.duplicateCharged ? '❌ 发现重复扣费' : '✅ 正常'}
- **重复退款检测**: ${report.billing.duplicateRefunded ? '❌ 发现重复退款' : '✅ 正常'}

${report.billing.reasons.length > 0 ? `> [!CAUTION]\n> 账务异常详情:\n> ${report.billing.reasons.join('\n> ')}` : ''}

---

## 6. 平台侧供应商成本与毛利核算 (Supplier Cost & Gross Margin)

- **成本核验判定**: **${report.supplierCost.passed ? '✅ 通过' : '❌ 存在差错'}** (状态: \`${report.supplierCost.status}\`)
- **预期供应商成本**: \`¥${report.supplierCost.expectedCostCny.toFixed(4)} 元\`
- **计费单价与依据**: \`${report.supplierCost.pricingBasis}\` (\`${report.supplierCost.unitCostCny} ${report.supplierCost.unit}\`)
- **供应商与渠道**: \`${report.supplierCost.channelName} (${report.supplierCost.channelCode}, 线路 line${report.supplierCost.line})\`
- **上游执行状态**: \`${report.supplierCost.upstreamExecutionState}\`
- **充值折算依据**: \`${report.supplierCost.revenueCalculationBasis}\`
- **有效积分单价**: \`¥${report.supplierCost.effectiveCnyPerPoint.toFixed(6)} 元/积分\`
- **用户付费折算**: \`¥${report.supplierCost.userRevenueCny.toFixed(4)} 元\` (${report.billing.netDeductedPoints} 积分)
- **平台预估毛利**: \`¥${report.supplierCost.estimatedGrossProfitCny.toFixed(4)} 元\` (预估毛利率: \`${report.supplierCost.grossMarginLabel}\`)
- **成本证据等级**: \`${report.supplierCost.evidenceLevel}\` (${report.supplierCost.evidenceLevel === 'INTERNAL_ESTIMATED' ? '内部 Oracle 规则推导' : (report.supplierCost.evidenceLevel === 'BILL_RECONCILED' || report.supplierCost.evidenceLevel === 'EXTERNAL_RECONCILED') ? '外部供应商账单勾兑' : report.supplierCost.evidenceLevel === 'DB_RECORD_VERIFIED' ? '业务数据库记录核验' : '待对账核验'})
- **外部账单状态**: \`${report.supplierCost.externalBillStatus}\`
${report.supplierCost.upstreamCalls && report.supplierCost.upstreamCalls.length > 0 ? `
### 上游多调用记录明细:
| 序号 | 渠道 | 模型 | 执行状态 | 计费产生 | 产生费用 (元) |
| --- | --- | --- | --- | --- | --- |
${report.supplierCost.upstreamCalls.map((c, idx) => `| ${idx + 1} | ${c.channelName} | ${c.modelName || c.model || '-'} | ${c.executionState} | ${c.billed ? '是' : '否'} | ¥${(c.costCny ?? c.incurredCostCny ?? 0).toFixed(4)} |`).join('\n')}
` : ''}
${report.supplierCost.reasons.length > 0 ? `> [!NOTE]\n> 成本对账备注:\n> ${report.supplierCost.reasons.join('\n> ')}` : ''}

---

## 7. 证据档案与安全脱敏

${report.tracePath ? `- **Playwright Trace 档案**: \`${report.tracePath}\` (使用 \`npx playwright show-trace ${report.tracePath}\` 查看录屏与网络流)` : '- **Playwright Trace**: (无)'}
- **脱敏声明**: 已执行系统规则脱敏（已对已知模式的 Cookie、FastAdmin 会话凭据、JWT、密钥等实施掩码过滤；归档文件仅存放于本地受控目录，严禁对外直传）。
`;
}

export async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  console.log(`\n======================================================`);
  console.log(`🎭 Panqu Playwright 闭环测试智能体启动`);
  console.log(`模式: ${cliOptions.isMock ? '模拟受控验证 (MOCK)' : '真实环境执行 (REAL)'}`);
  console.log(`媒体: ${cliOptions.mediaType}`);
  console.log(`======================================================\n`);

  let runOptions: PlaywrightFlowRunOptions = {
    ...cliOptions,
    executionMode: cliOptions.isMock ? 'MOCK' : (cliOptions.executionMode || 'API_INTEGRATION'),
  };

  if (cliOptions.isMock) {
    // 注入模拟夹具参数
    runOptions.userGroupIds = [10];
    if (cliOptions.mediaType === 'video') {
      const isFail = cliOptions.expectFailure;
      runOptions.modelId = 84;
      runOptions.duration = 4;
      runOptions.resolution = '480p';
      runOptions.rechargeBatch = STANDARD_RECHARGE_PRESETS['100_TIER'];
      if (isFail) {
        runOptions.upstreamExecutionState = 'REJECTED_BEFORE_EXECUTION';
      }
      runOptions.mockSubmitResponse = {
        status: 200,
        body: { code: 1, msg: 'ok', data: { id: 29001 } },
      };
      runOptions.mockStatusResponses = isFail
        ? [
            { status: 200, body: { task_status: 1, progress: 30 } },
            { status: 200, body: { task_status: 3, progress: 0, err: 'UPSTREAM_MODEL_LIMIT' } },
          ]
        : [
            { status: 200, body: { task_status: 1, progress: 40 } },
            { status: 200, body: { task_status: 2, progress: 100, video_url: 'https://v.panqu.com.cn/video/sample.mp4' } },
          ];
      runOptions.mockTaskDetails = {
        id: 29001,
        video_url: 'https://v.panqu.com.cn/video/sample.mp4',
        extra: {
          diversion: 10,
          newapi_model: 'wan3.0-video',
          newapi_org_id: 0,
          newapi_group: '',
          points: 28,
          channel_name: '万相—yhuo',
        },
      };
      runOptions.mockAssetBuffer = isFail ? undefined : MOCK_MP4_HEADER;
      runOptions.mockScoreLogs = isFail
        ? [
            { task_id: 29001, type: 2, score: -28, memo: '预扣 Wan 3.0 视频生成费用' },
            { task_id: 29001, type: 1, score: 28, memo: '任务生成失败退款' },
          ]
        : [
            { task_id: 29001, type: 2, score: -28, memo: '预扣 Wan 3.0 视频生成费用' },
            { task_id: 29001, type: 3, score: 28, memo: 'Wan 3.0 任务完成结算' },
          ];
    } else {
      runOptions.modelId = 201;
      runOptions.rechargeBatch = STANDARD_RECHARGE_PRESETS['100_TIER'];
      runOptions.mockSubmitResponse = {
        status: 200,
        body: { code: 1, msg: 'ok', data: { id: 29002 } },
      };
      runOptions.mockStatusResponses = [
        { status: 200, body: { task_status: 1, progress: 50 } },
        { status: 200, body: { task_status: 2, progress: 100, pic_url: 'https://v.panqu.com.cn/image/sample.png' } },
      ];
      runOptions.mockTaskDetails = {
        id: 29002,
        pic_url: 'https://v.panqu.com.cn/image/sample.png',
        extra: {
          newapi_image: 1,
          newapi_model: 'runninghub-nano-banana-2',
          newapi_org_id: 10,
          newapi_group: 'panqu_test',
        },
      };
      runOptions.mockAssetBuffer = MOCK_PNG_HEADER;
      runOptions.mockScoreLogs = [
        { task_id: 29002, type: 2, score: -5, memo: '场景生图预扣费用' },
        { task_id: 29002, type: 3, score: 5, memo: '场景生图完成结算' },
      ];
    }
  }

  const evidence = await runPanquPlaywrightFlow(runOptions);
  const mdReport = renderEvidenceMarkdown(evidence);

  const outDir = cliOptions.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `${evidence.caseId}-playwright-report.md`);
  await writeFile(reportPath, mdReport, 'utf8');

  console.log(`\n======================================================`);
  console.log(`🎯 测试执行结果汇总:`);
  console.log(`测试断言判定: ${evidence.testAssertionStatus === 'PASS' ? '✅ PASS' : evidence.testAssertionStatus === 'BLOCKED' ? '⏸ BLOCKED' : '❌ FAIL'}`);
  console.log(`业务任务终态: ${evidence.businessTaskStatus}`);
  console.log(`执行接入模式: ${evidence.executionMode}${evidence.degradedFromBrowser ? ' (⚠️ 浏览器不可用降级至 API)' : ''}`);
  console.log(`任务关联 ID: ${evidence.taskId ?? 'N/A'}`);
  console.log(`路由分流核查: ${evidence.diversion.passed ? '✅ 命中' : '❌ 异常'} (${evidence.diversion.actualChannel})`);
  console.log(`产物校验级别: ${evidence.artifact.passed ? '✅ 通过' : '❌ 异常'} [${evidence.artifact.verificationLevel}] (${evidence.artifact.qualityClassification})`);
  console.log(`用户积分对账: ${evidence.billing.passed ? '✅ 平衡' : '❌ 差错'} (净扣 ${evidence.billing.netDeductedPoints} pt / 预期 ${evidence.billing.expectedPoints} pt, 退款 ${evidence.billing.refundedPoints} pt)`);
  console.log(`供应商成本核算: ${evidence.supplierCost.evidenceLevel !== 'UNVERIFIED' ? '✅ 完成' : '⚠️ 待对账'} (预估成本 ¥${evidence.supplierCost.expectedCostCny}, 毛利 ¥${evidence.supplierCost.estimatedGrossProfitCny} [${evidence.supplierCost.grossMarginLabel}], 凭证等级: ${evidence.supplierCost.evidenceLevel})`);
  console.log(`详细报告文件: ${reportPath}`);
  console.log(`======================================================\n`);
}

// CLI 直调支持
if (process.argv[1]?.endsWith('run-playwright-cli.js') || process.argv[1]?.endsWith('run-playwright-cli.ts')) {
  main().catch((err) => {
    console.error('CLI 执行异常:', err);
    process.exit(1);
  });
}
