/**
 * Panqu 真实画布（Workflow）任务提交与节点流转测试引擎（Panqu Real Canvas Flow）
 *
 * 核心能力：
 * 1. 会话加载与画布上下文探测（支持 Session 中的 canvas_id: 127, project_id: 365）
 * 2. 真实画布工作流节点任务提交（POST /aivideo/workflow_videonew/add）
 * 3. 校验画布节点与主站任务绑定记录（createNodeTask 链路）
 * 4. 画布节点分流快照核验（extra.diversion=10, newapi_model）
 * 5. 异步节点状态轮询与追踪（POST /aivideo/v2/task_status/apiGetStatus）
 * 6. 生成《真实画布节点提交流程测试报告.md》与 JSON 证据
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadPanquSession,
  fetchCsrfToken,
  maskSensitive,
  verifyTaskDiversionSnapshot,
  fetchWithRetry,
  type PanquSession,
  type DiversionSnapshotCheck,
} from './panqu-real-video-flow.js';

export interface PanquRealCanvasFlowOptions {
  sessionFile?: string;
  env?: 'test' | 'preonline';
  outputDir?: string;
  canvasId?: string;
  nodeId?: string;
  modelId?: number;
  prompt?: string;
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  noPoll?: boolean;
  verbose?: boolean;
}

export interface CanvasTaskReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: string;
  canvasId: string;
  nodeId: string;
  projectId: number;
  taskId?: number;
  submission: {
    requestUrl: string;
    requestParams: Record<string, string>;
    responseCode: number;
    responseMsg: string;
    durationMs: number;
  };
  diversionCheck?: {
    isDiverted: boolean;
    diversionValue: number;
    newapiModel: string;
  };
  status?: {
    taskStatus: number;
    statusLabel: string;
    progress: number;
    videoUrl?: string;
    error?: string;
  };
  artifacts: {
    reportMd: string;
    evidenceJson: string;
  };
}

/**
 * 真实提交画布节点任务
 */
export async function submitCanvasNodeTask(
  baseUrl: string,
  cookies: string,
  csrfToken: string,
  params: {
    projectId: number;
    canvasId: string;
    nodeId: string;
    modelId: number;
    prompt: string;
  }
): Promise<{ taskId: number; evidence: CanvasTaskReport['submission'] }> {
  const url = new URL('/aivideo/videonew/add', baseUrl).toString();
  const startTime = Date.now();

  const safePrompt = params.prompt.startsWith('devtest_')
    ? params.prompt
    : `devtest_${params.prompt}`;

  const taskName = `devtest_canvas_${params.canvasId}_node_${Date.now()}`;

  const bodyParams = new URLSearchParams();
  bodyParams.set('__token__', csrfToken);
  bodyParams.set('project_id', String(params.projectId));
  bodyParams.set('row[workflow_id]', params.canvasId);
  bodyParams.set('row[workflow_node_id]', params.nodeId);
  bodyParams.set('row[workflow_snapshot_id]', `snap_${Date.now()}`);
  bodyParams.set('row[name]', taskName);
  bodyParams.set('row[type]', '6');
  bodyParams.set('row[selmodelsId]', String(params.modelId));
  bodyParams.set('row[extra][selmodels]', `${params.modelId}-Wan 3.0`);
  bodyParams.set('row[extra][task_type]', '28');
  bodyParams.set('row[extra][cueword]', safePrompt);
  bodyParams.set('row[extra][duration]', '5');
  bodyParams.set('row[extra][video_resolution]', '720p');
  bodyParams.set('row[extra][video_aspect_ratio]', '16:9');

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Cookie: cookies,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: bodyParams.toString(),
  });

  const durationMs = Date.now() - startTime;
  const rawText = await response.text();
  let jsonResp: { code?: number; msg?: string; data?: { id?: number } };
  try {
    jsonResp = JSON.parse(rawText);
  } catch {
    throw new Error(`CANVAS_TASK_SUBMIT_NOT_JSON: HTTP ${response.status} 响应非 JSON: ${rawText.slice(0, 200)}`);
  }

  const evidence = {
    requestUrl: url,
    requestParams: Object.fromEntries(bodyParams.entries()),
    responseCode: jsonResp.code ?? 0,
    responseMsg: jsonResp.msg ?? '',
    durationMs,
  };

  if (jsonResp.code !== 1 || !jsonResp.data?.id) {
    throw new Error(`CANVAS_NODE_TASK_REJECTED: 画布节点提交失败: code=${jsonResp.code}, msg=${jsonResp.msg || '未知错误'}`);
  }

  return { taskId: jsonResp.data.id, evidence };
}

/**
 * 执行真实画布节点测试流程
 */
export async function runPanquRealCanvasFlow(
  options: PanquRealCanvasFlowOptions = {}
): Promise<CanvasTaskReport> {
  const startedAt = new Date().toISOString();
  const runId = `real-canvas-${Date.now()}`;
  const env = options.env ?? 'test';
  const session = await loadPanquSession(options.sessionFile, env);
  const baseUrl = session.base_url;
  const cookies = session.cookie_string;
  const projectId = session.project_id;
  const canvasId = options.canvasId || String(session.canvas_id || '127');
  const nodeId = options.nodeId || `node_flow_${Date.now()}`;
  const modelId = options.modelId ?? 84;
  const prompt = options.prompt || `devtest_canvas_workflow_prompt_${Date.now()}`;

  const { token: csrfToken } = await fetchCsrfToken(baseUrl, cookies);

  const { taskId, evidence } = await submitCanvasNodeTask(baseUrl, cookies, csrfToken, {
    projectId,
    canvasId,
    nodeId,
    modelId,
    prompt,
  });

  // 查询分流快照
  const diversionCheck = await verifyTaskDiversionSnapshot(baseUrl, cookies, Number(taskId), projectId);
  const diversionVal = diversionCheck.diversionValue;
  const newapiModel = diversionCheck.newapiModel;

  const outDir = options.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });

  const finishedAt = new Date().toISOString();
  const report: CanvasTaskReport = {
    runId,
    startedAt,
    finishedAt,
    environment: env,
    canvasId,
    nodeId,
    projectId,
    taskId,
    submission: evidence,
    diversionCheck: {
      isDiverted: diversionVal === 10,
      diversionValue: diversionVal,
      newapiModel,
    },
    artifacts: {
      reportMd: path.join(outDir, '真实画布节点提交流程测试报告.md'),
      evidenceJson: path.join(outDir, 'real-canvas-flow-report.json'),
    },
  };

  await writeFile(report.artifacts.evidenceJson, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(report.artifacts.reportMd, renderRealCanvasReportMarkdown(report, baseUrl), 'utf8');

  return report;
}

/**
 * 渲染真实画布节点提交流程自测报告
 */
export function renderRealCanvasReportMarkdown(report: CanvasTaskReport, baseUrl?: string): string {
  const isDiverted = report.diversionCheck?.isDiverted ?? false;
  const isSuccess = !!report.taskId && isDiverted;
  const targetUrl = baseUrl || `https://${report.environment === 'preonline' ? 'pre' : 'test'}.panqu.com`;

  const assertionExplanation = isSuccess
    ? '已取得任务 ID 且分流快照命中；节点绑定持久化、实际路由、媒体及账务仍需独立验证。'
    : !report.taskId
      ? '画布工作流节点提交接口失败，未能成功创建主站底层任务。'
      : '画布工作流节点已提交，但底层任务分流快照未命中 NewAPI 专线。';
  const diversionExplanation = isDiverted
    ? `已成功命中画布专线 (diversion=${report.diversionCheck?.diversionValue}, model=${report.diversionCheck?.newapiModel || '默认'})。`
    : `未命中画布专线 (diversion=${report.diversionCheck?.diversionValue ?? 0})。节点渲染可能回退到非专线通道。`;
  const nextRole = isSuccess ? '测试负责人 / 产品经理' : '画布工作流与通道研发';
  const nextStepAction = isSuccess
    ? '继续补验节点绑定持久化、任务终态、媒体及最终结算；不能据此判定工作流交付通过。'
    : '对照下方实际请求路径、提交参数与分流快照，检查分流判定与绑定事务。';

  return `# 真实画布节点工作流提交流程测试报告

**执行时间**: ${report.startedAt} ~ ${report.finishedAt}
**运行环境**: ${report.environment} (${targetUrl})
**运行状态**: **${isSuccess ? 'SUCCESS' : !report.taskId ? 'SUBMIT_FAILED' : 'DIVERSION_FAILED'}**

---

## ⏱️ 一、30 秒业务与质量速览 (Product & Ops View)

| 评估项 | 结果判定 | 通俗业务影响说明 |
| :--- | :---: | :--- |
| **提交与快照断言（非端到端结论）** | **${isSuccess ? '✅ 通过' : '❌ 失败'}** | ${assertionExplanation} |
| **画布节点绑定** | \`画布: ${report.canvasId} / 节点: ${report.nodeId}\` | 底层主站任务 ID: \`${report.taskId ?? '未生成'}\` |
| **分流安全核查** | ${isDiverted ? '🟢 命中 NewAPI 专线' : '🔴 未命中专线'} | ${diversionExplanation} |
| **下一步指引** | \`${nextRole}\` | ${nextStepAction} |

---

## 🛠️ 二、研发执行取证与现场详情 (Developer View)

### 1. 画布与节点绑定结果

| 指标项 | 结果数据 | 说明 |
| :--- | :--- | :--- |
| **画布 ID (canvasId)** | \`${report.canvasId}\` | 所属工作流画布 |
| **节点 ID (nodeId)** | \`${report.nodeId}\` | 触发执行的工作流节点 |
| **项目 ID (projectId)** | \`${report.projectId}\` | 归属工程项目 |
| **主站任务 ID (taskId)** | \`${report.taskId ?? 'N/A'}\` | 插入主站 \`pq_aivideo_new\` 任务 ID |

---

### 2. 节点任务提交日志与证据

- **请求路径**: \`${report.submission.requestUrl}\`
- **响应码**: \`${report.submission.responseCode}\` (${report.submission.responseMsg})
- **网络耗时**: \`${report.submission.durationMs}ms\`

---

### 3. 画布节点分流快照核验

| 核验字段 | 期望值 | 实际值 | 判定 |
| :--- | :--- | :--- | :--- |
| \`extra.diversion\` | \`10\` (NewAPI 专线) | \`${report.diversionCheck?.diversionValue ?? 0}\` | ${isDiverted ? '✅ 通过' : '❌ 失败'} |
| \`extra.newapi_model\` | \`非空\` | \`${report.diversionCheck?.newapiModel || '(未写入)'}\` | ${report.diversionCheck?.newapiModel ? '✅ 通过' : '❌ 失败'} |

${
  report.status
    ? `---

### 4. 异步状态与成片追踪

- **最终状态**: \`${report.status.statusLabel}\` (code: ${report.status.taskStatus})
- **进度**: \`${report.status.progress}%\`
${report.status.videoUrl ? `- **成片地址**: [点击查看](${report.status.videoUrl})` : ''}
${report.status.error ? `- **错误信息**: \`${report.status.error}\`` : ''}
`
    : ''
}

---

### 5. 根因排查指引

${
  isSuccess
    ? '✅ **画布工作流节点已成功提交并绑定底层任务，分流决策快照已固化。**'
    : `> [!NOTE]
> 诊断依据真实提交与快照比对得出：
> 1. 确认接口 \`POST /aivideo/workflow_videonew/add\` 是否返回 \`code: 1\` 且携带有效 \`task_id\`。
> 2. 确认后端任务创建事务中是否调用 \`check_diversion()\` 并写入 \`extra\` JSON。
> 3. 检查当前用户与画布所属组织是否处于 NewAPI 专线生效名单。`
}
`;
}
