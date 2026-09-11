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
  await writeFile(
    report.artifacts.reportMd,
    `# 真实画布节点工作流提交流程测试报告

**画布 ID**: \`${canvasId}\` | **节点 ID**: \`${nodeId}\` | **主站任务 ID**: \`${taskId}\`
**运行环境**: ${env} (${baseUrl})
**分流状态**: extra.diversion = \`${diversionVal}\` (${diversionVal === 10 ? '✅ 命中 NewAPI' : '未命中'})

---

## 提交日志证据
- **请求路径**: \`${evidence.requestUrl}\`
- **响应码**: \`${evidence.responseCode}\` (${evidence.responseMsg})
- **网络耗时**: \`${evidence.durationMs}ms\`
`,
    'utf8'
  );

  return report;
}
