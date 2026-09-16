/**
 * Panqu AI DevTest 纯净媒体流执行器 (Media Flow)
 * 视频/生图/画布媒体流 5 合 1 极致收敛：底层 HTTP POST 提交与 `/task_status` 轮询。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ScoreLogEntry } from './billing.js';

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

export type BillingQueryStatus =
  | 'QUERY_SUCCESS'
  | 'QUERY_ERROR'
  | 'QUERY_TIMEOUT'
  | 'AUTH_FAILED'
  | 'PARSE_ERROR';

export interface BillingQueryResult {
  status: BillingQueryStatus;
  scoreLogs: ScoreLogEntry[];
  source: string;
  total?: number;
  error?: string;
}

/**
 * 真实只读查询任务积分流水 (Billing Logs)
 * 严格零副作用：仅发起 GET 请求查询后台账单或 AdminScore 记录，绝不执行任何写操作（无提交、无扣费、无退款）。
 *
 * 严格区分状态：
 * - QUERY_SUCCESS + records > 0 / = 0
 * - QUERY_ERROR
 * - QUERY_TIMEOUT
 * - AUTH_FAILED
 * - PARSE_ERROR
 */
export async function queryTaskBillingLogs(
  taskId: number,
  session: PanquSession,
  options: { timeoutMs?: number } = {}
): Promise<BillingQueryResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const baseUrl = session.base_url;
  const cookies = session.cookie_string;

  let lastStatus: BillingQueryStatus = 'QUERY_ERROR';
  let lastError: string = '无法通过已知账单端点获取流水';
  let lastSource = 'unknown';

  // 1. 优先尝试 FastAdmin 原生 AdminScore 控制器（以 task_id 精确过滤）
  try {
    const filterParam = JSON.stringify({ task_id: taskId });
    const opParam = JSON.stringify({ task_id: '=' });
    const adminScoreUrl = new URL(
      `/auth/adminscore/index?filter=${encodeURIComponent(filterParam)}&op=${encodeURIComponent(opParam)}`,
      baseUrl
    ).toString();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchWithRetry(
        adminScoreUrl,
        {
          method: 'GET',
          headers: {
            Cookie: cookies,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
          },
          signal: ctrl.signal,
        },
        2
      );

      if (res.status === 401 || res.status === 403) {
        lastStatus = 'AUTH_FAILED';
        lastError = `HTTP ${res.status}: FastAdmin 鉴权失败或 Session 会话已失效 [AUTH_FAILED]`;
        lastSource = 'auth_adminscore';
      } else if (!res.ok) {
        lastStatus = 'QUERY_ERROR';
        lastError = `HTTP ${res.status}: ${res.statusText} [QUERY_ERROR]`;
        lastSource = 'auth_adminscore';
      } else {
        const text = await res.text();
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          lastStatus = 'PARSE_ERROR';
          lastError = 'FastAdmin AdminScore 响应非有效 JSON 文本 [PARSE_ERROR]';
          lastSource = 'auth_adminscore';
        }

        if (body && Array.isArray(body.rows)) {
          const matchedLogs: ScoreLogEntry[] = body.rows.map((r: any) => {
            const hasTaskId = r.task_id !== undefined && r.task_id !== null && r.task_id !== '';
            const memoStr = String(r.remark || r.source_name || r.memo || '');
            const parsedTaskId = hasTaskId ? Number(r.task_id) : (memoStr.includes(String(taskId)) ? taskId : undefined);
            return {
              id: r.id,
              task_id: parsedTaskId,
              type: Number(r.type ?? 2),
              score: Number(r.score ?? 0),
              memo: r.remark || r.source_name || r.memo,
              createtime: r.createtime,
            };
          });
          return {
            status: 'QUERY_SUCCESS',
            scoreLogs: matchedLogs,
            total: body.total ?? matchedLogs.length,
            source: 'auth_adminscore',
          };
        }
      }
    } catch (innerErr) {
      const errStr = String(innerErr);
      if (innerErr instanceof Error && innerErr.name === 'AbortError') {
        lastStatus = 'QUERY_TIMEOUT';
        lastError = `FastAdmin AdminScore 请求超时 (${timeoutMs}ms) [QUERY_TIMEOUT]`;
      } else {
        lastStatus = 'QUERY_ERROR';
        lastError = `网络请求异常: ${errStr} [QUERY_ERROR]`;
      }
      lastSource = 'auth_adminscore';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 准备进入备用端点
  }

  // 2. 备用端点：请求 /aivideo/v2/billing/apiPersonalRecords
  try {
    const recordsUrl = new URL(
      `/aivideo/v2/billing/apiPersonalRecords?page=1&limit=100&days=30&keyword=${encodeURIComponent(String(taskId))}`,
      baseUrl
    ).toString();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchWithRetry(
        recordsUrl,
        {
          method: 'GET',
          headers: {
            Cookie: cookies,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
          },
          signal: ctrl.signal,
        },
        2
      );

      if (res.status === 401 || res.status === 403) {
        return {
          status: 'AUTH_FAILED',
          scoreLogs: [],
          source: 'billing_personal_records',
          error: `HTTP ${res.status}: 个人账单端点鉴权失败或 Session 已失效 [AUTH_FAILED]`,
        };
      }

      if (!res.ok) {
        return {
          status: 'QUERY_ERROR',
          scoreLogs: [],
          source: 'billing_personal_records',
          error: `HTTP ${res.status}: ${res.statusText} [QUERY_ERROR]`,
        };
      }

      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        return {
          status: 'PARSE_ERROR',
          scoreLogs: [],
          source: 'billing_personal_records',
          error: '个人账单端点响应非有效 JSON 文本 [PARSE_ERROR]',
        };
      }

      if (body && body.code === 1 && body.data && Array.isArray(body.data.rows)) {
        const matchedLogs: ScoreLogEntry[] = body.data.rows.map((r: any) => {
          const hasTaskId = r.task_id !== undefined && r.task_id !== null && r.task_id !== '';
          const memoStr = String(r.type_text || r.model || r.project || '');
          const parsedTaskId = hasTaskId ? Number(r.task_id) : (memoStr.includes(String(taskId)) ? taskId : undefined);
          return {
            id: r.id,
            task_id: parsedTaskId,
            type: Number(r.record_type ?? r.type ?? 2),
            score: Number(r.points !== undefined ? Math.abs(r.points) : r.score ?? 0),
            memo: r.type_text || r.model || r.project,
            createtime: r.time || r.createtime,
          };
        });

        return {
          status: 'QUERY_SUCCESS',
          scoreLogs: matchedLogs,
          total: body.data.total ?? matchedLogs.length,
          source: 'billing_personal_records',
        };
      } else if (body && body.code === 0) {
        const msg = body.msg || 'API returned code 0';
        const isAuthMsg = msg.includes('登录') || msg.includes('login') || msg.includes('token');
        return {
          status: isAuthMsg ? 'AUTH_FAILED' : 'QUERY_ERROR',
          scoreLogs: [],
          source: 'billing_personal_records',
          error: `${msg} [${isAuthMsg ? 'AUTH_FAILED' : 'QUERY_ERROR'}]`,
        };
      }
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.name === 'AbortError') {
        return {
          status: 'QUERY_TIMEOUT',
          scoreLogs: [],
          source: 'billing_personal_records',
          error: `个人账单端点请求超时 (${timeoutMs}ms) [QUERY_TIMEOUT]`,
        };
      }
      return {
        status: 'QUERY_ERROR',
        scoreLogs: [],
        source: 'billing_personal_records',
        error: `${innerErr instanceof Error ? innerErr.message : String(innerErr)} [QUERY_ERROR]`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      status: 'QUERY_ERROR',
      scoreLogs: [],
      source: 'network_error',
      error: `${err instanceof Error ? err.message : String(err)} [QUERY_ERROR]`,
    };
  }

  return {
    status: lastStatus,
    scoreLogs: [],
    source: lastSource,
    error: lastError,
  };
}

