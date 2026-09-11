/**
 * Panqu 真实生图提交与分流快照核查测试引擎（Panqu Real Image Submission & Diversion Flow）
 *
 * 核心能力：
 * 1. 真实被测环境会话加载与 CSRF Token 获取
 * 2. 真实生图任务提交（POST /aivideo/scene/add，自动注入 devtest_ 前缀与 r 线路参数）
 * 3. 真实核验 extra 分流快照（newapi_image=1, newapi_model, newapi_org_id, newapi_group）
 * 4. 异步生图状态轮询监控（POST /aivideo/v2/task_status/apiGetStatus, type=scene）
 * 5. 产出自测测试报告与结构化证据 JSON
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadPanquSession,
  fetchCsrfToken,
  maskSensitive,
  fetchWithRetry,
  type PanquSession,
} from './panqu-real-video-flow.js';

export interface PanquRealImageFlowOptions {
  sessionFile?: string;
  env?: 'test' | 'preonline';
  projectRoot?: string;
  outputDir?: string;
  modelId?: number;
  prompt?: string;
  resolution?: string;
  serviceline?: string; // 必须为 'r' 才能命中分流
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  noPoll?: boolean;
  verbose?: boolean;
}

export interface ImageDiversionSnapshotCheck {
  isDiverted: boolean;
  newapiImageFlag: number;
  newapiModel: string;
  newapiOrgId: number;
  newapiGroup: string;
  rawExtra: Record<string, unknown>;
  passed: boolean;
  mismatches: string[];
}

export interface ImageTaskStatusSnapshot {
  taskId: number;
  taskStatus: number;
  statusLabel: string;
  progress: number;
  picUrl?: string;
  error?: string;
  pollCount: number;
  durationMs: number;
}

export interface PanquRealImageReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: string;
  targetUrl: string;
  accountMasked: string;
  submission: {
    timestamp: string;
    requestUrl: string;
    requestParams: Record<string, string>;
    responseCode: number;
    responseMsg: string;
    taskId?: number;
    durationMs: number;
  };
  diversionCheck?: ImageDiversionSnapshotCheck;
  polling?: {
    totalPolls: number;
    finalStatus: ImageTaskStatusSnapshot;
    timeline: { timeMs: number; status: number; progress: number }[];
  };
  summary: {
    status: 'SUCCESS' | 'DIVERTED_RUNNING' | 'DIVERSION_FAILED' | 'SUBMIT_FAILED';
    isDiverted: boolean;
    taskId?: number;
    picUrl?: string;
  };
  artifacts: {
    reportMd: string;
    evidenceJson: string;
  };
}

/**
 * 提交真实生图任务（Scene 生图）
 */
export async function submitRealImageTask(
  baseUrl: string,
  cookies: string,
  csrfToken: string,
  params: {
    projectId: number;
    modelId: number;
    prompt: string;
    resolution: string;
    serviceline: string;
    modelName?: string;
  }
): Promise<{ taskId: number; evidence: PanquRealImageReport['submission'] }> {
  const url = new URL('/aivideo/scene/add', baseUrl).toString();
  const startTime = Date.now();

  const safePrompt = params.prompt.startsWith('devtest_')
    ? params.prompt
    : `devtest_${params.prompt}`;

  const taskName = `devtest_scene_${Date.now()}`;
  const selmodels = params.modelName
    ? `${params.modelId}-${params.modelName}`
    : `${params.modelId}-Nano Banana Pro`;

  const bodyParams = new URLSearchParams();
  bodyParams.set('__token__', csrfToken);
  bodyParams.set('project_id', String(params.projectId));
  bodyParams.set('row[name]', taskName);
  bodyParams.set('row[type]', '1');
  bodyParams.set('row[extra][selmodels]', selmodels);
  bodyParams.set('row[extra][selmodelsId]', String(params.modelId));
  bodyParams.set('row[extra][serviceline]', params.serviceline); // 'r' 触发分流
  bodyParams.set('row[extra][cueword]', safePrompt);
  bodyParams.set('row[extra][size_type]', 'resolution');
  bodyParams.set('row[extra][resolution]', params.resolution);
  bodyParams.set('row[extra][channel]', 'Third-party');

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
    throw new Error(`SUBMIT_IMAGE_NOT_JSON: HTTP ${response.status} 响应非 JSON: ${rawText.slice(0, 200)}`);
  }

  const evidence = {
    timestamp: new Date().toISOString(),
    requestUrl: url,
    requestParams: Object.fromEntries(bodyParams.entries()),
    responseCode: jsonResp.code ?? 0,
    responseMsg: jsonResp.msg ?? '',
    taskId: jsonResp.data?.id,
    durationMs,
  };

  if (jsonResp.code !== 1 || !jsonResp.data?.id) {
    throw new Error(`IMAGE_SUBMISSION_REJECTED: 提交生图失败: code=${jsonResp.code}, msg=${jsonResp.msg || '未知错误'}`);
  }

  return { taskId: jsonResp.data.id, evidence };
}

/**
 * 核验生图任务 extra 中的分流快照
 */
export async function verifyImageDiversionSnapshot(
  baseUrl: string,
  cookies: string,
  taskId: number,
  projectId: number
): Promise<ImageDiversionSnapshotCheck> {
  const url = new URL('/aivideo/scene/index', baseUrl);
  url.searchParams.set('project_id', String(projectId));
  url.searchParams.set('sort', 'id');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', '10');

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      Cookie: cookies,
      'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });

  if (!response.ok) {
    throw new Error(`QUERY_SCENE_TASK_FAILED: HTTP ${response.status} 无法查询场景生图任务`);
  }

  const jsonResp = (await response.json()) as {
    total?: number;
    rows?: Array<{ id: number; extra?: string | Record<string, unknown> }>;
  };

  const taskRow = jsonResp.rows?.find((r) => Number(r.id) === Number(taskId)) || jsonResp.rows?.[0];
  if (!taskRow) {
    throw new Error(`SCENE_TASK_NOT_FOUND: 列表中未找到生图任务 ID: ${taskId}`);
  }

  let extraObj: Record<string, unknown> = {};
  if (typeof taskRow.extra === 'string') {
    try {
      extraObj = JSON.parse(taskRow.extra);
    } catch {
      extraObj = {};
    }
  } else if (typeof taskRow.extra === 'object' && taskRow.extra !== null) {
    extraObj = taskRow.extra as Record<string, unknown>;
  }

  const newapiImageFlag = Number(extraObj.newapi_image ?? 0);
  const newapiModel = String(extraObj.newapi_model ?? '');
  const newapiOrgId = Number(extraObj.newapi_org_id ?? -1);
  const newapiGroup = String(extraObj.newapi_group ?? '');

  const isDiverted = newapiImageFlag === 1;
  const mismatches: string[] = [];

  if (!isDiverted) {
    mismatches.push(`生图分流标记未写入: 期望 extra.newapi_image=1, 实际为 ${newapiImageFlag}`);
  }
  if (!newapiModel) {
    mismatches.push(`NewAPI 生图客户端别名为空: extra.newapi_model 未记录`);
  }

  return {
    isDiverted,
    newapiImageFlag,
    newapiModel,
    newapiOrgId,
    newapiGroup,
    rawExtra: extraObj,
    passed: mismatches.length === 0,
    mismatches,
  };
}

/**
 * 轮询生图状态
 */
export async function pollImageTaskStatus(
  baseUrl: string,
  cookies: string,
  taskId: number,
  options: {
    pollTimeoutSec?: number;
    pollIntervalMs?: number;
    onProgress?: (snapshot: ImageTaskStatusSnapshot) => void;
  } = {}
): Promise<{
  finalSnapshot: ImageTaskStatusSnapshot;
  totalPolls: number;
  timeline: { timeMs: number; status: number; progress: number }[];
}> {
  const timeoutMs = (options.pollTimeoutSec ?? 30) * 1000;
  const intervalMs = options.pollIntervalMs ?? 3000;
  const startTime = Date.now();
  const timeline: { timeMs: number; status: number; progress: number }[] = [];

  let pollCount = 0;
  let latestSnapshot: ImageTaskStatusSnapshot = {
    taskId,
    taskStatus: 0,
    statusLabel: '待处理 (Pending)',
    progress: 0,
    pollCount: 0,
    durationMs: 0,
  };

  const statusUrl = new URL('/aivideo/v2/task_status/apiGetStatus', baseUrl).toString();

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    const form = new URLSearchParams();
    form.set('type', 'scene');
    form.set('ids', String(taskId));

    try {
      const resp = await fetchWithRetry(statusUrl, {
        method: 'POST',
        headers: {
          Cookie: cookies,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body: form.toString(),
      });

      if (resp.ok) {
        const data = (await resp.json()) as {
          code: number;
          data?: Array<{
            id: number;
            status: {
              id: number;
              task_status: number;
              progress: number;
              err?: string;
              pic_url?: string;
            };
          }>;
        };

        const item = data.data?.find((d) => Number(d.id) === Number(taskId)) || data.data?.[0];
        if (item?.status) {
          const st = item.status;
          const statusMap: Record<number, string> = {
            0: '待处理 (Pending)',
            1: '生成中 (Processing)',
            2: '生成完成 (Success)',
            3: '生成失败 (Failed)',
          };

          latestSnapshot = {
            taskId,
            taskStatus: st.task_status,
            statusLabel: statusMap[st.task_status] ?? `状态 (${st.task_status})`,
            progress: st.progress ?? 0,
            picUrl: st.pic_url,
            error: st.err,
            pollCount,
            durationMs: Date.now() - startTime,
          };

          timeline.push({
            timeMs: latestSnapshot.durationMs,
            status: latestSnapshot.taskStatus,
            progress: latestSnapshot.progress,
          });

          if (options.onProgress) {
            options.onProgress(latestSnapshot);
          }

          if (st.task_status === 2 || st.task_status === 3) {
            break;
          }
        }
      }
    } catch {
      // 容错重试
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    finalSnapshot: latestSnapshot,
    totalPolls: pollCount,
    timeline,
  };
}

/**
 * 执行真实生图提交流程
 */
export async function runPanquRealImageFlow(
  options: PanquRealImageFlowOptions = {}
): Promise<PanquRealImageReport> {
  const startedAt = new Date().toISOString();
  const runId = `real-image-${Date.now()}`;
  const env = options.env ?? 'test';
  const modelId = options.modelId ?? 12; // 默认 Nano Banana Pro (ID 12)
  const resolution = options.resolution ?? '2K';
  const serviceline = options.serviceline ?? 'r'; // 必须为 r 才能触发分流
  const prompt = options.prompt || `devtest_scene_prompt_${Date.now()}`;

  const session = await loadPanquSession(options.sessionFile, env);
  const baseUrl = session.base_url;
  const cookies = session.cookie_string;
  const projectId = session.project_id;

  const { token: csrfToken } = await fetchCsrfToken(baseUrl, cookies);

  const { taskId, evidence } = await submitRealImageTask(baseUrl, cookies, csrfToken, {
    projectId,
    modelId,
    prompt,
    resolution,
    serviceline,
  });

  const diversionCheck = await verifyImageDiversionSnapshot(baseUrl, cookies, taskId, projectId);

  let pollingResult;
  if (!options.noPoll) {
    pollingResult = await pollImageTaskStatus(baseUrl, cookies, taskId, {
      pollTimeoutSec: options.pollTimeoutSec ?? 30,
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      onProgress: (snap) => {
        if (options.verbose) {
          console.log(`[DevTest Polling] 生图轮询 #${snap.pollCount} (${snap.durationMs}ms): 状态=${snap.statusLabel}`);
        }
      },
    });
  }

  const outDir = options.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });

  const finishedAt = new Date().toISOString();
  const summaryStatus = !diversionCheck.isDiverted
    ? 'DIVERSION_FAILED'
    : pollingResult?.finalSnapshot.taskStatus === 2
    ? 'SUCCESS'
    : 'DIVERTED_RUNNING';

  const report: PanquRealImageReport = {
    runId,
    startedAt,
    finishedAt,
    environment: env,
    targetUrl: baseUrl,
    accountMasked: maskSensitive(session.account),
    submission: evidence,
    diversionCheck,
    polling: pollingResult
      ? {
          totalPolls: pollingResult.totalPolls,
          finalStatus: pollingResult.finalSnapshot,
          timeline: pollingResult.timeline,
        }
      : undefined,
    summary: {
      status: summaryStatus,
      isDiverted: diversionCheck.isDiverted,
      taskId,
      picUrl: pollingResult?.finalSnapshot.picUrl,
    },
    artifacts: {
      reportMd: path.join(outDir, '真实生图提交流程测试报告.md'),
      evidenceJson: path.join(outDir, 'real-image-flow-report.json'),
    },
  };

  await writeFile(report.artifacts.evidenceJson, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(report.artifacts.reportMd, renderRealImageReportMarkdown(report), 'utf8');

  return report;
}

export function renderRealImageReportMarkdown(report: PanquRealImageReport): string {
  const check = report.diversionCheck;
  const poll = report.polling?.finalStatus;

  return `# 真实生图提交与分流验证自测报告

**执行时间**: ${report.startedAt} ~ ${report.finishedAt}
**运行环境**: ${report.environment} (${report.targetUrl})
**测试账号**: ${report.accountMasked}
**运行状态**: **${report.summary.status}**

---

## 1. 真实生图任务提交结果

| 指标项 | 结果数据 | 说明 |
| :--- | :--- | :--- |
| **任务 ID** | \`${report.summary.taskId ?? 'N/A'}\` | 插入主站 \`pq_aivideo_scene\` 表 |
| **模型 ID** | \`${report.submission.requestParams['row[extra][selmodelsId]'] || report.submission.requestParams['row[selmodelsId]'] || '12'}\` | 生图模型标识 |
| **服务线路** | \`${report.submission.requestParams['row[extra][serviceline]']}\` | 必须为 \`r\` (RunningHub) 触发分流 |
| **提示词** | \`${report.submission.requestParams['row[extra][cueword]']}\` | 自动带 \`devtest_\` 前缀 |
| **分辨率** | \`${report.submission.requestParams['row[extra][resolution]']}\` | 画质规格 |
| **响应耗时** | \`${report.submission.durationMs}ms\` | \`POST /aivideo/scene/add\` 耗时 |

---

## 2. 生图分流快照核验

| 核验字段 | 期望值 | 实际值 | 判定 |
| :--- | :--- | :--- | :--- |
| \`extra.newapi_image\` | \`1\` (命中图片分流) | \`${check?.newapiImageFlag ?? 0}\` | ${check?.isDiverted ? '✅ 通过' : '❌ 失败'} |
| \`extra.newapi_model\` | \`非空 (客户端模型别名)\` | \`${check?.newapiModel || '(未写入)'}\` | ${check?.newapiModel ? '✅ 通过' : '❌ 失败'} |
| \`extra.newapi_org_id\` | \`组织 ID\` | \`${check?.newapiOrgId ?? -1}\` | ${check?.newapiOrgId !== undefined ? '✅ 通过' : '❌ 失败'} |

---

## 3. 异步状态与成片追踪

- **状态**: \`${poll?.statusLabel ?? '未轮询'}\`
- **成片地址**: ${poll?.picUrl ? `[点击查看图片](${poll.picUrl})` : '暂无'}
- **错误信息**: \`${poll?.error || '无'}\`
`;
}
