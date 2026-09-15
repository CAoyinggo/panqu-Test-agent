/**
 * Panqu AI DevTest 纯净媒体流执行器 (Media Flow)
 * 视频/生图/画布媒体流 5 合 1 极致收敛：底层 HTTP POST 提交与 `/task_status` 轮询。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface PanquSession {
  env: string;
  base_url: string;
  cookie_string: string;
  csrf_token?: string;
  project_id?: number;
  user_id?: number;
}

export interface SubmitMediaTaskOptions {
  baseUrl: string;
  cookies: string;
  mediaType: 'video' | 'image';
  modelId: number;
  prompt?: string;
  projectId?: number;
  csrfToken?: string;
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  serviceline?: string;
  extraParams?: Record<string, string>;
}

export interface SubmitMediaTaskResult {
  ok: boolean;
  taskId: number;
  message: string;
  durationMs: number;
  rawResponse?: Record<string, unknown>;
}

export interface TaskStatusSnapshot {
  taskId: number;
  taskStatus: number; // 1: 排队, 2: 成功, 3: 失败, 4: 异常
  statusLabel: string;
  progress: number;
  videoUrl?: string;
  imageUrl?: string;
  error?: string;
  pollCount: number;
  durationMs: number;
}

export interface PollTaskStatusOptions {
  baseUrl: string;
  cookies: string;
  mediaType?: 'video' | 'image';
  pollTimeoutSec?: number;
  pollIntervalMs?: number;
  onProgress?: (snapshot: TaskStatusSnapshot) => void;
}

export async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  const headers = { Connection: 'close', ...((options.headers as Record<string, string>) || {}) };
  let lastError: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fetch(url, { ...options, headers });
    } catch (err) {
      lastError = err;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  throw lastError;
}

export async function loadPanquSession(sessionFilePath?: string, targetEnv = 'test'): Promise<PanquSession> {
  const resolvedPath = sessionFilePath || process.env.PANQU_SESSION_COOKIES_FILE;
  if (!resolvedPath) throw new Error('SESSION_CONFIG_REQUIRED: 请显式提供会话文件路径或 PANQU_SESSION_COOKIES_FILE');
  if (!existsSync(resolvedPath)) throw new Error(`SESSION_CONFIG_NOT_FOUND: 无法找到会话配置文件: ${resolvedPath}`);

  const raw = await readFile(resolvedPath, 'utf8');
  let config: { sessions?: PanquSession[] };
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SESSION_CONFIG_INVALID: 解析 JSON 失败: ${(err as Error).message}`);
  }
  const session = config.sessions?.find((s) => s.env === targetEnv);
  if (!session) throw new Error(`SESSION_ENV_NOT_FOUND: 在配置中未找到 env='${targetEnv}' 的可用会话`);
  if (!session.base_url || !session.cookie_string) throw new Error('SESSION_INCOMPLETE: 会话缺失 base_url 或 cookie_string');
  return session;
}

export async function submitMediaTask(options: SubmitMediaTaskOptions): Promise<SubmitMediaTaskResult> {
  const { baseUrl, cookies, mediaType, modelId } = options;
  const startTime = Date.now();
  const safePrompt = options.prompt || (mediaType === 'video' ? 'devtest_sample_video' : 'devtest_sample_image');
  const taskName = `devtest_${mediaType}_${Date.now()}`;
  const bodyParams = new URLSearchParams();
  bodyParams.set('__token__', options.csrfToken ?? '');
  bodyParams.set('project_id', String(options.projectId ?? 10));
  bodyParams.set('row[name]', taskName);

  let submitUrl = '';
  if (mediaType === 'video') {
    submitUrl = new URL('/aivideo/v2/generate/video', baseUrl).toString();
    bodyParams.set('row[type]', '6');
    bodyParams.set('row[selmodelsId]', String(modelId));
    bodyParams.set('row[extra][selmodels]', `${modelId}-Wan3.0`);
    bodyParams.set('row[extra][cueword]', safePrompt);
    bodyParams.set('row[extra][duration]', String(options.duration ?? 4));
    bodyParams.set('row[extra][video_resolution]', options.resolution || '720p');
    bodyParams.set('row[extra][video_aspect_ratio]', options.aspectRatio || '16:9');
  } else {
    submitUrl = new URL('/aivideo/v2/generate/submit_picture_custom_size', baseUrl).toString();
    bodyParams.set('row[selmodelsId]', String(modelId));
    bodyParams.set('row[extra][prompt]', safePrompt);
    bodyParams.set('row[extra][resolution]', options.resolution || '1k');
    bodyParams.set('row[extra][serviceline]', options.serviceline || 'r');
  }

  if (options.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) bodyParams.set(k, v);
  }

  const response = await fetchWithRetry(submitUrl, {
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
  let jsonResp: { code?: number; msg?: string; data?: { id?: number } | number };
  try {
    jsonResp = JSON.parse(rawText);
  } catch {
    throw new Error(`SUBMIT_RESPONSE_NOT_JSON: HTTP ${response.status} 响应非 JSON: ${rawText.slice(0, 200)}`);
  }

  const taskId = typeof jsonResp.data === 'number' ? jsonResp.data : (jsonResp.data?.id ?? 0);
  const ok = jsonResp.code === 1 && taskId > 0;
  return { ok, taskId, message: jsonResp.msg || (ok ? '提交成功' : '提交失败'), durationMs, rawResponse: jsonResp as Record<string, unknown> };
}

export async function pollTaskStatus(
  taskId: number,
  options: PollTaskStatusOptions
): Promise<{ finalSnapshot: TaskStatusSnapshot; totalPolls: number; timeline: { timeMs: number; status: number; progress: number }[] }> {
  const { baseUrl, cookies } = options;
  const timeoutMs = (options.pollTimeoutSec ?? 30) * 1000;
  const intervalMs = options.pollIntervalMs ?? 3000;
  const startTime = Date.now();
  const timeline: { timeMs: number; status: number; progress: number }[] = [];
  const statusMap: Record<number, string> = { 1: '排队中 (Queued)', 2: '成功 (Success)', 3: '失败 (Failed)', 4: '异常 (Error)' };

  let pollCount = 0;
  let latestSnapshot: TaskStatusSnapshot = { taskId, taskStatus: 0, statusLabel: '待处理 (Pending)', progress: 0, pollCount: 0, durationMs: 0 };
  const statusUrl = new URL('/aivideo/v2/task_status/apiGetStatus', baseUrl).toString();

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    const form = new URLSearchParams();
    form.set('type', options.mediaType === 'image' ? 'scene' : 'video');
    form.set('ids', String(taskId));

    try {
      const res = await fetchWithRetry(statusUrl, {
        method: 'POST',
        headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0' },
        body: form.toString(),
      });

      if (res.ok) {
        const body = (await res.json()) as any;
        const taskObj = Array.isArray(body?.data) ? body.data.find((item: any) => Number(item.id) === taskId) : (body?.data?.[taskId] ?? body?.data);
        if (taskObj) {
          const taskStatus = Number(taskObj.task_status ?? taskObj.status ?? 0);
          latestSnapshot = {
            taskId,
            taskStatus,
            statusLabel: statusMap[taskStatus] ?? `未知状态 (${taskStatus})`,
            progress: Number(taskObj.progress ?? (taskStatus === 2 ? 100 : 0)),
            videoUrl: taskObj.video_url,
            imageUrl: taskObj.pic_url || taskObj.image_url,
            error: taskObj.err || taskObj.error,
            pollCount,
            durationMs: Date.now() - startTime,
          };
          timeline.push({ timeMs: latestSnapshot.durationMs, status: latestSnapshot.taskStatus, progress: latestSnapshot.progress });
          if (options.onProgress) options.onProgress(latestSnapshot);
          if (taskStatus === 2 || taskStatus === 3 || taskStatus === 4) break;
        }
      }
    } catch { /* 容忍单次轮询网络抖动 */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { finalSnapshot: latestSnapshot, totalPolls: pollCount, timeline };
}
