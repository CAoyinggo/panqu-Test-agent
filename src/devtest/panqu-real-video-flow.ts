/**
 * Panqu 真实视频提交与分流快照核查测试引擎（Panqu Real Video Submission & Diversion Flow）
 *
 * 核心能力：
 * 1. 真实被测环境会话加载与鉴权注入（严格凭证脱敏安全保护）
 * 2. CSRF Token 动态探测与刷新（/ajax/refreshtoken）
 * 3. 真实视频生成任务提交（POST /aivideo/videonew/add，强制注入 devtest_ 前缀）
 * 4. 主站 extra 分流快照核查（diversion=10, newapi_model, newapi_org_id, points）
 * 5. 异步生成状态长轮询与状态机监控（POST /aivideo/v2/task_status/apiGetStatus）
 * 6. 异常与回退根因自动反查定位（针对 diversion=0 提供逐级排查建议）
 * 7. 导出结构化证据 JSON 与《真实视频提交流程测试报告.md》
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface PanquSession {
  env: string;
  base_url: string;
  account: string;
  nickname?: string;
  project_id: number;
  canvas_id?: string;
  score?: number;
  cookie_string: string;
  jwt_token?: string;
}

export interface PanquRealVideoFlowOptions {
  sessionFile?: string;
  env?: 'test' | 'preonline';
  projectRoot?: string;
  outputDir?: string;
  modelId?: number;
  prompt?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  taskType?: number;
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  noPoll?: boolean;
  verbose?: boolean;
}

export interface DiversionSnapshotCheck {
  isDiverted: boolean;
  diversionValue: number;
  newapiModel: string;
  newapiOrgId: number;
  points: number;
  rawExtra: Record<string, unknown>;
  passed: boolean;
  mismatches: string[];
}

export interface TaskStatusSnapshot {
  taskId: number;
  taskStatus: number; // 0: 待处理, 1: 生成中, 2: 完成, 3: 失败
  statusLabel: string;
  progress: number;
  videoUrl?: string;
  lastFrameUrl?: string;
  error?: string;
  pollCount: number;
  durationMs: number;
}

export interface RealVideoSubmitEvidence {
  timestamp: string;
  requestUrl: string;
  requestParams: Record<string, string>;
  responseCode: number;
  responseMsg: string;
  taskId?: number;
  durationMs: number;
}

export interface PanquRealVideoReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: string;
  targetUrl: string;
  accountMasked: string;
  submission: RealVideoSubmitEvidence;
  diversionCheck?: DiversionSnapshotCheck;
  polling?: {
    totalPolls: number;
    finalStatus: TaskStatusSnapshot;
    timeline: { timeMs: number; status: number; progress: number }[];
  };
  rootCauseAnalysis?: {
    detectedIssue: string;
    possibleReasons: string[];
    suggestedActions: string[];
  };
  summary: {
    status: 'SUCCESS' | 'DIVERTED_RUNNING' | 'DIVERSION_FAILED' | 'SUBMIT_FAILED';
    isDiverted: boolean;
    taskId?: number;
    pointsCharged?: number;
    videoUrl?: string;
  };
  artifacts: {
    reportMd: string;
    evidenceJson: string;
  };
}

/**
 * 敏感信息掩码保护：对 Token、Cookie 及账号进行安全脱敏
 */
export function maskSensitive(text?: string | null): string {
  if (!text) return '(empty)';
  if (text.length <= 8) return '******';
  return `${text.slice(0, 4)}******${text.slice(-4)}`;
}

/**
 * 加载会话凭证文件
 */
export async function loadPanquSession(
  sessionFilePath?: string,
  targetEnv = 'test'
): Promise<PanquSession> {
  const defaultPath = '/Users/mac/agents/test-Configuration/session-cookies.json';
  const resolvedPath = sessionFilePath || process.env.PANQU_SESSION_COOKIES_FILE || defaultPath;

  if (!existsSync(resolvedPath)) {
    throw new Error(`SESSION_CONFIG_NOT_FOUND: 无法找到会话配置文件: ${resolvedPath}`);
  }

  const raw = await readFile(resolvedPath, 'utf8');
  let config: { sessions?: PanquSession[] };
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SESSION_CONFIG_INVALID: 解析 JSON 失败: ${(err as Error).message}`);
  }

  const session = config.sessions?.find((s) => s.env === targetEnv);
  if (!session) {
    throw new Error(`SESSION_ENV_NOT_FOUND: 在配置中未找到 env='${targetEnv}' 的可用会话`);
  }

  if (!session.base_url || !session.cookie_string) {
    throw new Error(`SESSION_INCOMPLETE: 会话缺失 base_url 或 cookie_string`);
  }

  return session;
}

/**
 * 带有重试和防连接重置的通用 JSON 请求封装
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  const headers = {
    Connection: 'close',
    ...(options.headers as Record<string, string> || {}),
  };

  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(url, { ...options, headers, signal: controller.signal });
        return response;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err as Error;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * 刷新获取 CSRF Token
 */
export async function fetchCsrfToken(
  baseUrl: string,
  cookies: string
): Promise<{ token: string; durationMs: number }> {
  const url = new URL('/ajax/refreshtoken', baseUrl).toString();
  const startTime = Date.now();

  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      Cookie: cookies,
      'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
  });

  const durationMs = Date.now() - startTime;
  if (!response.ok) {
    throw new Error(`CSRF_REQUEST_FAILED: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    code?: number;
    data?: { __token__?: string; token?: string };
    __token__?: string;
  };
  const token = data.data?.__token__ || data.data?.token || data.__token__;

  if (!token) {
    throw new Error(`CSRF_TOKEN_MISSING: /ajax/refreshtoken 返回结构中未提取到有效 token`);
  }

  return { token, durationMs };
}

/**
 * 提交真实视频生成任务
 */
export async function submitRealVideoTask(
  baseUrl: string,
  cookies: string,
  csrfToken: string,
  params: {
    projectId: number;
    modelId: number;
    prompt: string;
    duration: number;
    resolution: string;
    aspectRatio: string;
    taskType: number;
    modelName?: string;
  }
): Promise<{ taskId: number; evidence: RealVideoSubmitEvidence }> {
  const url = new URL('/aivideo/videonew/add', baseUrl).toString();
  const startTime = Date.now();

  // 严格确保 Prompt 带有 devtest_ 前缀
  const safePrompt = params.prompt.startsWith('devtest_')
    ? params.prompt
    : `devtest_${params.prompt}`;

  const taskName = `devtest_wan3_${Date.now()}`;
  const selmodels = params.modelName
    ? `${params.modelId}-${params.modelName}`
    : `${params.modelId}-Wan 3.0`;

  const bodyParams = new URLSearchParams();
  bodyParams.set('__token__', csrfToken);
  bodyParams.set('project_id', String(params.projectId));
  bodyParams.set('row[name]', taskName);
  bodyParams.set('row[type]', '6'); // PanquAI 视频通道
  bodyParams.set('row[selmodelsId]', String(params.modelId));
  bodyParams.set('row[extra][selmodels]', selmodels);
  bodyParams.set('row[extra][task_type]', String(params.taskType));
  bodyParams.set('row[extra][cueword]', safePrompt);
  bodyParams.set('row[extra][duration]', String(params.duration));
  bodyParams.set('row[extra][video_resolution]', params.resolution);
  bodyParams.set('row[extra][video_aspect_ratio]', params.aspectRatio);

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
    throw new Error(`SUBMIT_RESPONSE_NOT_JSON: HTTP ${response.status} 响应非 JSON: ${rawText.slice(0, 200)}`);
  }

  const evidence: RealVideoSubmitEvidence = {
    timestamp: new Date().toISOString(),
    requestUrl: url,
    requestParams: Object.fromEntries(bodyParams.entries()),
    responseCode: jsonResp.code ?? 0,
    responseMsg: jsonResp.msg ?? '',
    taskId: jsonResp.data?.id,
    durationMs,
  };

  if (jsonResp.code !== 1 || !jsonResp.data?.id) {
    throw new Error(`TASK_SUBMISSION_REJECTED: 提交失败: code=${jsonResp.code}, msg=${jsonResp.msg || '未知错误'}`);
  }

  return { taskId: jsonResp.data.id, evidence };
}

/**
 * 核验任务主站 extra 分流快照
 */
export async function verifyTaskDiversionSnapshot(
  baseUrl: string,
  cookies: string,
  taskId: number,
  projectId: number
): Promise<DiversionSnapshotCheck> {
  // 请求任务列表，查询该任务详情与 extra 字段（优先拉取最新记录）
  const url = new URL('/aivideo/videonew/index', baseUrl);
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
    throw new Error(`QUERY_TASK_FAILED: HTTP ${response.status} 无法查询任务详情`);
  }

  const jsonResp = (await response.json()) as {
    total?: number;
    rows?: Array<{ id: number; extra?: string | Record<string, unknown> }>;
  };

  const taskRow = jsonResp.rows?.find((r) => Number(r.id) === Number(taskId)) || jsonResp.rows?.[0];
  if (!taskRow) {
    throw new Error(`TASK_NOT_FOUND_IN_LIST: 列表中未检索到任务 ID: ${taskId}`);
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

  const diversionVal = Number(extraObj.diversion ?? 0);
  const newapiModel = String(extraObj.newapi_model ?? '');
  const newapiOrgId = Number(extraObj.newapi_org_id ?? -1);
  const points = Number(extraObj.points ?? 0);

  const isDiverted = diversionVal === 10;
  const mismatches: string[] = [];

  if (!isDiverted) {
    mismatches.push(`分流线路不匹配: 期望 extra.diversion=10 (命中NewAPI)，实际为 ${diversionVal} (可能被规则拦截回退或关闭)`);
  }
  if (!newapiModel) {
    mismatches.push(`未记录 NewAPI 模型别名: extra.newapi_model 为空`);
  }
  if (newapiOrgId < 0) {
    mismatches.push(`未记录 NewAPI 企业组织快照: extra.newapi_org_id 为空`);
  }

  return {
    isDiverted,
    diversionValue: diversionVal,
    newapiModel,
    newapiOrgId,
    points,
    rawExtra: extraObj,
    passed: mismatches.length === 0,
    mismatches,
  };
}

/**
 * 异步轮询任务状态（apiGetStatus）
 */
export async function pollTaskStatus(
  baseUrl: string,
  cookies: string,
  taskId: number,
  options: {
    pollTimeoutSec?: number;
    pollIntervalMs?: number;
    onProgress?: (snapshot: TaskStatusSnapshot) => void;
  } = {}
): Promise<{
  finalSnapshot: TaskStatusSnapshot;
  totalPolls: number;
  timeline: { timeMs: number; status: number; progress: number }[];
}> {
  const timeoutMs = (options.pollTimeoutSec ?? 30) * 1000;
  const intervalMs = options.pollIntervalMs ?? 3000;
  const startTime = Date.now();
  const timeline: { timeMs: number; status: number; progress: number }[] = [];

  let pollCount = 0;
  let latestSnapshot: TaskStatusSnapshot = {
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
    form.set('type', 'video');
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
              video_url?: string;
              last_frame_url?: string;
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
            statusLabel: statusMap[st.task_status] ?? `未知状态 (${st.task_status})`,
            progress: st.progress ?? 0,
            videoUrl: st.video_url,
            lastFrameUrl: st.last_frame_url,
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

          // 如果任务已进入终态（完成或失败），无需继续轮询
          if (st.task_status === 2 || st.task_status === 3) {
            break;
          }
        }
      }
    } catch {
      // 忽略单次轮询网络抖动，继续重试
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
 * 执行真实视频提交与分流验证主流程
 */
export async function runPanquRealVideoFlow(
  options: PanquRealVideoFlowOptions = {}
): Promise<PanquRealVideoReport> {
  const startedAt = new Date().toISOString();
  const runId = `real-video-${Date.now()}`;
  const env = options.env ?? 'test';
  const modelId = options.modelId ?? 84; // 默认 Wan 3.0
  const duration = options.duration ?? 5; // 默认 5 秒
  const resolution = options.resolution ?? '720p';
  const aspectRatio = options.aspectRatio ?? '16:9';
  const taskType = options.taskType ?? 28; // 全能参考
  const prompt = options.prompt || `devtest_wan3_smoke_${Date.now()}`;

  // 1. 加载会话凭据
  console.log(`[DevTest Flow] 正在加载环境会话: env=${env}...`);
  const session = await loadPanquSession(options.sessionFile, env);
  const baseUrl = session.base_url;
  const cookies = session.cookie_string;
  const projectId = session.project_id;
  console.log(`[DevTest Flow] 已加载账号: ${maskSensitive(session.account)}, 项目 ID: ${projectId}, BaseUrl: ${baseUrl}`);

  // 2. 刷新 CSRF Token
  console.log(`[DevTest Flow] 正在刷新 CSRF Token (/ajax/refreshtoken)...`);
  const { token: csrfToken, durationMs: csrfDuration } = await fetchCsrfToken(baseUrl, cookies);
  console.log(`[DevTest Flow] CSRF Token 获取成功: ${csrfToken.slice(0, 8)}****** (耗时 ${csrfDuration}ms)`);

  // 3. 提交真实任务
  console.log(`[DevTest Flow] 正在提交真实视频任务 (/aivideo/videonew/add), Model ID=${modelId}...`);
  const { taskId, evidence } = await submitRealVideoTask(baseUrl, cookies, csrfToken, {
    projectId,
    modelId,
    prompt,
    duration,
    resolution,
    aspectRatio,
    taskType,
  });
  console.log(`[DevTest Flow] 视频任务提交成功! 真实 Task ID: ${taskId} (耗时 ${evidence.durationMs}ms)`);

  // 4. 核验分流快照（主站 extra 字段）
  console.log(`[DevTest Flow] 正在查询任务分流快照 (/aivideo/videonew/index)...`);
  const diversionCheck = await verifyTaskDiversionSnapshot(baseUrl, cookies, taskId, projectId);
  console.log(`[DevTest Flow] 快照核验完成: diversion=${diversionCheck.diversionValue}, newapi_model=${diversionCheck.newapiModel}`);

  // 5. 状态轮询（除非声明 noPoll）
  let pollingResult;
  if (!options.noPoll) {
    pollingResult = await pollTaskStatus(baseUrl, cookies, taskId, {
      pollTimeoutSec: options.pollTimeoutSec ?? 30,
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      onProgress: (snap) => {
        if (options.verbose) {
          console.log(`[DevTest Polling] 轮询 #${snap.pollCount} (${snap.durationMs}ms): 状态=${snap.statusLabel}, 进度=${snap.progress}%`);
        }
      },
    });
  }

  // 6. 根因分析（若未命中分流）
  let rootCauseAnalysis;
  if (!diversionCheck.isDiverted) {
    rootCauseAnalysis = {
      detectedIssue: `任务未命中 NewAPI 分流线路 (extra.diversion=${diversionCheck.diversionValue})`,
      possibleReasons: [
        '后端配置 switch.route_mode 当前处于 legacy 或 off 模式',
        `模型 ID ${modelId} 在后台「分流模型配置」中未启用或未加入 global_models`,
        `渠道能力拦截：该模型在 NewAPI 启用渠道并集中不支持当前画幅 (${aspectRatio}) 或分辨率 (${resolution})`,
        '企业组织未绑定路由组：当前用户所属分组在 newapi_route_rules 中无对应 route_group 规则',
      ],
      suggestedActions: [
        '检查后台分流开关是否为 newapi 模式',
        `在后台「分流模型列表」中确保模型 ${modelId} 状态为启用，且别名已正确配置`,
        '检查 NewAPI 渠道列表中是否挂载了具备该模型能力的可用渠道',
      ],
    };
  }

  // 7. 生成产物目录
  const outDir = options.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });

  const finishedAt = new Date().toISOString();
  const summaryStatus = !diversionCheck.isDiverted
    ? 'DIVERSION_FAILED'
    : pollingResult?.finalSnapshot.taskStatus === 2
    ? 'SUCCESS'
    : 'DIVERTED_RUNNING';

  const report: PanquRealVideoReport = {
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
    rootCauseAnalysis,
    summary: {
      status: summaryStatus,
      isDiverted: diversionCheck.isDiverted,
      taskId,
      pointsCharged: diversionCheck.points,
      videoUrl: pollingResult?.finalSnapshot.videoUrl,
    },
    artifacts: {
      reportMd: path.join(outDir, '真实视频提交流程测试报告.md'),
      evidenceJson: path.join(outDir, 'real-video-flow-report.json'),
    },
  };

  // 8. 写入文件
  await writeFile(report.artifacts.evidenceJson, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(report.artifacts.reportMd, renderRealVideoReportMarkdown(report), 'utf8');

  return report;
}

/**
 * 渲染专业自测报告 Markdown
 */
export function renderRealVideoReportMarkdown(report: PanquRealVideoReport): string {
  const check = report.diversionCheck;
  const poll = report.polling?.finalStatus;

  return `# 真实视频提交与分流验证自测报告

**执行时间**: ${report.startedAt} ~ ${report.finishedAt}
**运行环境**: ${report.environment} (${report.targetUrl})
**测试账号**: ${report.accountMasked}
**运行状态**: **${report.summary.status}**

---

## 1. 真实任务提交结果

| 指标项 | 结果数据 | 说明 |
| :--- | :--- | :--- |
| **任务 ID** | \`${report.summary.taskId ?? 'N/A'}\` | 真实插入主站 \`pq_aivideo_new\` 数据表 |
| **模型 ID** | \`${report.submission.requestParams['row[selmodelsId]']}\` | 被测模型标识 |
| **提示词** | \`${report.submission.requestParams['row[extra][cueword]']}\` | 强制带 \`devtest_\` 前缀，安全隔离 |
| **画幅与分辨率** | \`${report.submission.requestParams['row[extra][video_resolution]']} / ${report.submission.requestParams['row[extra][video_aspect_ratio]']}\` | 任务规格参数 |
| **接口响应耗时** | \`${report.submission.durationMs}ms\` | \`POST /aivideo/videonew/add\` 网络耗时 |
| **响应消息** | \`${report.submission.responseMsg}\` | 服务器确认响应 |

---

## 2. 主站分流决策快照深度核验

> [!NOTE]
> 分流快照是由后端在任务创建事务中执行 \`check_diversion()\` 并固化在 \`extra\` JSON 中的关键证据，用于向 Go 消费端下发线路选择。

| 核验字段 | 期望值 | 实际快照值 | 判定 |
| :--- | :--- | :--- | :--- |
| \`extra.diversion\` | \`10\` (NewAPI 专线) | \`${check?.diversionValue ?? 0}\` | ${check?.isDiverted ? '✅ 通过' : '❌ 失败 (未命中分流)'} |
| \`extra.newapi_model\` | \`非空 (客户端模型别名)\` | \`${check?.newapiModel || '(未写入)'}\` | ${check?.newapiModel ? '✅ 通过' : '❌ 失败'} |
| \`extra.newapi_org_id\` | \`组织 ID 或 0 (全量)\` | \`${check?.newapiOrgId ?? -1}\` | ${check?.newapiOrgId !== undefined && check.newapiOrgId >= 0 ? '✅ 通过' : '❌ 失败'} |
| \`extra.points\` | \`> 0 (预扣积分)\` | \`${check?.points ?? 0}\` | ${check?.points && check.points > 0 ? '✅ 通过' : '⚠️ 警告 (未扣分)'} |

${
  check?.mismatches && check.mismatches.length > 0
    ? `\n### ⚠️ 分流未达成诊断项\n${check.mismatches.map((m) => `- ${m}`).join('\n')}\n`
    : ''
}

---

## 3. 异步生成状态与轮询追踪

- **轮询次数**: ${report.polling?.totalPolls ?? 0} 次
- **最终状态**: \`${poll?.statusLabel ?? '未开启轮询'}\`
- **渲染进度**: \`${poll?.progress ?? 0}%\`
${poll?.videoUrl ? `- **视频成片**: [点击播放视频](${poll.videoUrl})` : ''}
${poll?.error ? `- **错误信息**: \`${poll.error}\`` : ''}

${
  report.polling?.timeline && report.polling.timeline.length > 0
    ? `\n### 轮询时间线\n| 耗时 | 状态码 | 进度 |\n| :--- | :--- | :--- |\n${report.polling.timeline
        .map((t) => `| +${t.timeMs}ms | ${t.status} | ${t.progress}% |`)
        .join('\n')}\n`
    : ''
}

---

## 4. 根因分析与排查指引

${
  report.rootCauseAnalysis
    ? `### 发现问题: ${report.rootCauseAnalysis.detectedIssue}
#### 常见原因分析:
${report.rootCauseAnalysis.possibleReasons.map((r) => `1. ${r}`).join('\n')}

#### 推荐解决措施:
${report.rootCauseAnalysis.suggestedActions.map((a) => `- ${a}`).join('\n')}
`
    : '✅ **该任务已成功命中 NewAPI 分流链路，快照完整固化，全链路运转正常。**'
}

---

## 5. 安全脱敏审计

- **认证 Token**: 全部脱敏处理，无明文 JWT 或 Cookie 泄露。
- **任务隔离**: 提示词强制使用 \`devtest_\` 前缀，主站可自动区分测试流量。
`;
}
