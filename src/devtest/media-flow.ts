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
  projectId: number;
  csrfToken?: string;
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  serviceline?: string;
  extraParams?: Record<string, string>;
  alias?: string;
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

export async function fetchCsrfToken(baseUrl: string, cookies: string): Promise<string> {
  const url = new URL('/ajax/refreshtoken', baseUrl).toString();
  const response = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Cookie: cookies,
        'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
    },
    1,
  );

  if (!response.ok) {
    throw new Error(`CSRF_REQUEST_FAILED: HTTP ${response.status} ${response.statusText}`);
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('CSRF_RESPONSE_NOT_JSON: /ajax/refreshtoken 响应非有效 JSON');
  }

  const token = data?.data?.__token__ || data?.data?.token || data?.__token__;
  if (!token || typeof token !== 'string') {
    throw new Error('CSRF_TOKEN_MISSING: /ajax/refreshtoken 返回结构中未提取到有效 token');
  }

  return token;
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
  if (!session.base_url || !session.cookie_string)
    throw new Error('SESSION_INCOMPLETE: 会话缺失 base_url 或 cookie_string');
  return session;
}

export const RESERVED_SUBMIT_FIELDS = new Set([
  '__token__',
  'project_id',
  'row[name]',
  'row[type]',
  'row[selmodelsId]',
  'row[extra][selmodels]',
  'row[extra][task_type]',
  'row[extra][cueword]',
  'row[extra][prompt]',
  'row[extra][duration]',
  'row[extra][video_resolution]',
  'row[extra][video_aspect_ratio]',
  'row[extra][resolution]',
  'row[extra][serviceline]',
]);

export async function submitMediaTask(options: SubmitMediaTaskOptions): Promise<SubmitMediaTaskResult> {
  const { baseUrl, cookies, mediaType, modelId } = options;
  const startTime = Date.now();

  // 1. Project ID 校验与装载（来自 Session，禁止静默回退默认值，缺失/非法直接阻断且零网络请求）
  if (
    options.projectId === undefined ||
    options.projectId === null ||
    typeof options.projectId !== 'number' ||
    !Number.isInteger(options.projectId) ||
    options.projectId <= 0
  ) {
    return {
      ok: false,
      taskId: 0,
      message: 'project_id 必须为有效正整数 [BLOCKED]',
      durationMs: Date.now() - startTime,
    };
  }

  // 2. 视频模型别名校验（发生在任何网络请求包括 CSRF 刷新之前）
  let videoAlias: string | undefined;
  if (mediaType === 'video') {
    const rawAlias = typeof options.alias === 'string' ? options.alias.trim() : undefined;
    videoAlias = rawAlias && rawAlias.length > 0 ? rawAlias : modelId === 84 ? 'Wan3.0' : undefined;
    if (!videoAlias) {
      return {
        ok: false,
        taskId: 0,
        message: `未知视频模型 #${modelId} 缺少显式别名 (alias)，禁止默认回退为 Wan3.0 [BLOCKED_MISSING_INPUT]`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // 3. extraParams 保留字段门禁（必须在 CSRF GET 和任务 POST 之前 fail-closed，禁止覆盖安全字段）
  if (options.extraParams) {
    const forbiddenKeys = Object.keys(options.extraParams).filter((k) => RESERVED_SUBMIT_FIELDS.has(k));
    if (forbiddenKeys.length > 0) {
      return {
        ok: false,
        taskId: 0,
        message: `extraParams 包含禁止覆盖的保留参数 [${forbiddenKeys.join(', ')}] [BLOCKED_RESERVED_EXTRA_PARAM]`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // 4. CSRF Token 获取与 Fail-closed 保护（视频接口必须具备有效 CSRF Token）
  let csrfToken = options.csrfToken;
  if (!csrfToken && mediaType === 'video') {
    try {
      csrfToken = await fetchCsrfToken(baseUrl, cookies);
    } catch (err) {
      return {
        ok: false,
        taskId: 0,
        message: `CSRF 获取失败: ${err instanceof Error ? err.message : String(err)} [BLOCKED]`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  const safePrompt = options.prompt || (mediaType === 'video' ? 'devtest_sample_video' : 'devtest_sample_image');
  const taskName = `devtest_${mediaType}_${Date.now()}`;
  const bodyParams = new URLSearchParams();
  bodyParams.set('__token__', csrfToken || '');
  bodyParams.set('project_id', String(options.projectId));
  bodyParams.set('row[name]', taskName);

  let submitUrl = '';
  if (mediaType === 'video') {
    submitUrl = new URL('/aivideo/videonew/add', baseUrl).toString();
    bodyParams.set('row[type]', '6');
    bodyParams.set('row[selmodelsId]', String(modelId));
    bodyParams.set('row[extra][selmodels]', `${modelId}-${videoAlias}`);
    bodyParams.set('row[extra][task_type]', '28');
    bodyParams.set('row[extra][cueword]', safePrompt);
    bodyParams.set('row[extra][duration]', String(options.duration ?? 4));
    bodyParams.set('row[extra][video_resolution]', options.resolution || '720p');
    bodyParams.set('row[extra][video_aspect_ratio]', options.aspectRatio || '16:9');
  } else {
    // 图片真实提交端点 = /aivideo/goods/add（控制器 application/admin/controller/aivideo/Goods.php::add；
    // v2/Goods 经 __call 委派同源）。add() 从 GET 读取 project_id（$this->request->get("project_id")），
    // 故拼进查询串；提示词字段是 extra.cueword（add() 校验其非空）；模型走 extra.selmodels（可 '12-alias' 或 '12'）；
    // 成功回 {code:1, data:{id}}（$this->success(..., ['id'=>goodsId])）。
    const imageSelmodels = options.alias && options.alias.length > 0 ? `${modelId}-${options.alias}` : String(modelId);
    submitUrl = new URL(
      `/aivideo/goods/add?project_id=${encodeURIComponent(String(options.projectId))}`,
      baseUrl,
    ).toString();
    bodyParams.set('row[type]', '1'); // type=1 = AI 生图分支（add() 全部生图逻辑都在 $params['type']==1 内）
    bodyParams.set('row[extra][selmodels]', imageSelmodels);
    bodyParams.set('row[extra][cueword]', safePrompt);
    bodyParams.set('row[extra][serviceline]', options.serviceline || 'r');
    bodyParams.set('row[extra][size_type]', 'resolution');
    bodyParams.set('row[extra][resolution]', options.resolution || '1K');
    if (options.aspectRatio) bodyParams.set('row[extra][pixels]', options.aspectRatio);
  }

  if (options.extraParams) {
    for (const [k, v] of Object.entries(options.extraParams)) bodyParams.set(k, v);
  }

  const response = await fetchWithRetry(
    submitUrl,
    {
      method: 'POST',
      headers: {
        Cookie: cookies,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: bodyParams.toString(),
    },
    1,
  );

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
  return {
    ok,
    taskId,
    message: jsonResp.msg || (ok ? '提交成功' : '提交失败'),
    durationMs,
    rawResponse: jsonResp as Record<string, unknown>,
  };
}

export async function pollTaskStatus(
  taskId: number,
  options: PollTaskStatusOptions,
): Promise<{
  finalSnapshot: TaskStatusSnapshot;
  totalPolls: number;
  timeline: { timeMs: number; status: number; progress: number }[];
}> {
  const { baseUrl, cookies } = options;
  const timeoutMs = (options.pollTimeoutSec ?? 30) * 1000;
  const intervalMs = options.pollIntervalMs ?? 3000;
  const startTime = Date.now();
  const timeline: { timeMs: number; status: number; progress: number }[] = [];
  const statusMap: Record<number, string> = {
    1: '排队中 (Queued)',
    2: '成功 (Success)',
    3: '失败 (Failed)',
    4: '异常 (Error)',
  };

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
    // 轮询 type 必须与提交模式一致：图片经 /aivideo/goods/add 提交(goods 模式)，故查 type='goods'。
    // （各图片源表 id 空间独立且重叠，用 'scene' 会误查 scene 表的同 id 任务 → 证据张冠李戴。）
    form.set('type', options.mediaType === 'image' ? 'goods' : 'video');
    form.set('ids', String(taskId));

    try {
      const res = await fetchWithRetry(statusUrl, {
        method: 'POST',
        headers: {
          Cookie: cookies,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 PanquDevTestAgent/1.0',
        },
        body: form.toString(),
      });

      if (res.ok) {
        const body = (await res.json()) as any;
        const taskObj = Array.isArray(body?.data)
          ? body.data.find((item: any) => Number(item.id) === taskId)
          : (body?.data?.[taskId] ?? body?.data);
        if (taskObj) {
          const statusObj = typeof taskObj.status === 'object' && taskObj.status !== null ? taskObj.status : taskObj;
          const taskStatus = Number(statusObj.task_status ?? (typeof taskObj.status === 'number' ? taskObj.status : 0));
          latestSnapshot = {
            taskId,
            taskStatus,
            statusLabel: statusMap[taskStatus] ?? `未知状态 (${taskStatus})`,
            progress: Number(statusObj.progress ?? taskObj.progress ?? (taskStatus === 2 ? 100 : 0)),
            videoUrl: statusObj.video_url || taskObj.video_url,
            imageUrl: statusObj.pic_url || statusObj.image_url || taskObj.pic_url || taskObj.image_url,
            error: statusObj.err || statusObj.error || taskObj.err || taskObj.error,
            pollCount,
            durationMs: Date.now() - startTime,
          };
          timeline.push({
            timeMs: latestSnapshot.durationMs,
            status: latestSnapshot.taskStatus,
            progress: latestSnapshot.progress,
          });
          if (options.onProgress) options.onProgress(latestSnapshot);
          if (taskStatus === 2 || taskStatus === 3 || taskStatus === 4) break;
        }
      }
    } catch {
      /* 容忍单次轮询网络抖动 */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { finalSnapshot: latestSnapshot, totalPolls: pollCount, timeline };
}

export type BillingQueryStatus = 'QUERY_SUCCESS' | 'QUERY_ERROR' | 'QUERY_TIMEOUT' | 'AUTH_FAILED' | 'PARSE_ERROR';

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
  options: { timeoutMs?: number } = {},
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
      baseUrl,
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
        2,
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
          let rows = body.rows;
          if (rows.length === 0) {
            // 在视频生成业务中，FastAdmin AdminScore 将视频 ID (前台 taskId) 记录在 source_id 字段
            try {
              const filterSource = JSON.stringify({ source_id: taskId });
              const opSource = JSON.stringify({ source_id: '=' });
              const sourceUrl = new URL(
                `/auth/adminscore/index?filter=${encodeURIComponent(filterSource)}&op=${encodeURIComponent(opSource)}`,
                baseUrl,
              ).toString();
              const sourceRes = await fetchWithRetry(
                sourceUrl,
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
                2,
              );
              if (sourceRes.ok) {
                const sourceBody = (await sourceRes.json()) as any;
                if (sourceBody && Array.isArray(sourceBody.rows) && sourceBody.rows.length > 0) {
                  rows = sourceBody.rows;
                }
              }
            } catch {
              /* 忽略 source_id 回退错误 */
            }
          }

          const matchedLogs: ScoreLogEntry[] = rows.map((r: any) => {
            const hasTaskId = r.task_id !== undefined && r.task_id !== null && r.task_id !== '';
            const isSourceIdMatch = r.source_id !== undefined && r.source_id !== null && Number(r.source_id) === taskId;
            const memoStr = String(r.remark || r.source_name || r.memo || '');
            const parsedTaskId = isSourceIdMatch
              ? taskId
              : hasTaskId
                ? Number(r.task_id)
                : memoStr.includes(String(taskId))
                  ? taskId
                  : undefined;
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
            total: rows.length,
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
      baseUrl,
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
        2,
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
          const parsedTaskId = hasTaskId ? Number(r.task_id) : memoStr.includes(String(taskId)) ? taskId : undefined;
          return {
            id: r.id,
            task_id: parsedTaskId,
            type: Number(r.record_type ?? r.type ?? 2),
            score: Number(r.points !== undefined ? Math.abs(r.points) : (r.score ?? 0)),
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

export interface EndpointQueryRecord {
  urlType: 'getEditData' | 'retrylog' | 'exceptionaltask';
  url: string;
  httpStatus?: number;
  queryStatus: 'SUCCESS' | 'FAILED' | 'ERROR' | 'UNVERIFIED_MISSING_PROJECT_ID';
  dataSource: string;
  error?: string;
  missingFields?: string[];
  data?: Record<string, unknown>;
}

export interface TaskRuntimeDetails {
  extra?: Record<string, unknown>;
  extraSource?: 'HTTP_API:getEditData' | 'HTTP_API:exceptional-task';
  backendTaskId?: number;
  actualChannelId?: number;
  actualChannelName?: string;
  fallbackChannel?: string;
  retryProvider?: string;
  videoProvider?: string;
  volcRouteProvider?: string;
  newapiStatus?: string;
  rawEditData?: Record<string, unknown>;
  rawRetryLog?: Record<string, unknown>;
  rawExceptionalTask?: Record<string, unknown>;
  endpoints: Record<'getEditData' | 'retrylog' | 'exceptionaltask', EndpointQueryRecord>;
  source?: string;
}

/**
 * 真实只读查询任务运行时流转明细 (Runtime Details: extra / retrylog / exceptionaltask)
 * 严格零副作用：仅发起只读 GET 请求，绝不执行任何写操作（无提交、无扣费、无退款、无重试）。
 */
export async function queryTaskRuntimeDetails(
  taskId: number,
  session: PanquSession,
  options: { projectId?: number; timeoutMs?: number } = {},
): Promise<TaskRuntimeDetails> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const baseUrl = session.base_url;
  const cookies = session.cookie_string;
  const projectId = options.projectId ?? session.project_id;

  const endpoints: Record<'getEditData' | 'retrylog' | 'exceptionaltask', EndpointQueryRecord> = {
    getEditData: {
      urlType: 'getEditData',
      url: '',
      queryStatus: 'FAILED',
      dataSource: 'HTTP_API:getEditData',
    },
    retrylog: {
      urlType: 'retrylog',
      url: '',
      queryStatus: 'FAILED',
      dataSource: 'HTTP_API:retrylog',
    },
    exceptionaltask: {
      urlType: 'exceptionaltask',
      url: '',
      queryStatus: 'FAILED',
      dataSource: 'HTTP_API:exceptional-task',
    },
  };

  const result: TaskRuntimeDetails = {
    endpoints,
  };

  // 1. 查询 /aivideo/v2/video/getEditData?project_id=<projectId>&video_id=<taskId>
  if (!projectId || projectId <= 0) {
    endpoints.getEditData = {
      urlType: 'getEditData',
      url: new URL(`/aivideo/v2/video/getEditData?project_id=MISSING&video_id=${taskId}`, baseUrl).toString(),
      queryStatus: 'UNVERIFIED_MISSING_PROJECT_ID',
      dataSource: 'HTTP_API:getEditData',
      error: '缺少 projectId，无法查询 /aivideo/v2/video/getEditData 接口 [UNVERIFIED_MISSING_PROJECT_ID]',
      missingFields: ['projectId'],
    };
  } else {
    const editUrl = new URL(
      `/aivideo/v2/video/getEditData?project_id=${projectId}&video_id=${taskId}`,
      baseUrl,
    ).toString();
    endpoints.getEditData.url = editUrl;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchWithRetry(
          editUrl,
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
          1,
        );
        endpoints.getEditData.httpStatus = res.status;
        const text = await res.text();
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          endpoints.getEditData.queryStatus = 'FAILED';
          endpoints.getEditData.error = `响应非有效 JSON (HTTP ${res.status}): ${text.slice(0, 100)}`;
        }

        if (body) {
          if (res.ok && body.code === 1 && body.data) {
            endpoints.getEditData.queryStatus = 'SUCCESS';
            endpoints.getEditData.data = body.data;
            result.rawEditData = body.data;
            if (body.data.extra) {
              const parsedExtra = typeof body.data.extra === 'string' ? JSON.parse(body.data.extra) : body.data.extra;
              result.extra = parsedExtra;
              result.extraSource = 'HTTP_API:getEditData';
            }
          } else {
            endpoints.getEditData.queryStatus = 'FAILED';
            endpoints.getEditData.error = body.msg || `code=${body.code}`;
          }
        }
      } catch (reqErr: any) {
        endpoints.getEditData.queryStatus = 'ERROR';
        endpoints.getEditData.error = reqErr?.message || String(reqErr);
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      endpoints.getEditData.queryStatus = 'ERROR';
      endpoints.getEditData.error = err?.message || String(err);
    }
  }

  // 2. 查询 /aivideo/diversion/retrylog?filter={"source_id":taskId}&op={"source_id":"="}
  const filterParam = JSON.stringify({ source_id: taskId });
  const opParam = JSON.stringify({ source_id: '=' });
  const retryLogUrl = new URL(
    `/aivideo/diversion/retrylog?filter=${encodeURIComponent(filterParam)}&op=${encodeURIComponent(opParam)}`,
    baseUrl,
  ).toString();
  endpoints.retrylog.url = retryLogUrl;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchWithRetry(
        retryLogUrl,
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
        1,
      );
      endpoints.retrylog.httpStatus = res.status;
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        endpoints.retrylog.queryStatus = 'FAILED';
        endpoints.retrylog.error = `响应非有效 JSON (HTTP ${res.status}): ${text.slice(0, 100)}`;
      }

      if (body) {
        if (res.ok) {
          endpoints.retrylog.queryStatus = 'SUCCESS';
          const row = body?.rows?.[0];
          if (row) {
            endpoints.retrylog.data = row;
            result.rawRetryLog = row;
            if (row.newapi_channel_id !== undefined && row.newapi_channel_id !== null) {
              result.actualChannelId = Number(row.newapi_channel_id);
            }
            if (row.newapi_provider_name) {
              result.actualChannelName = String(row.newapi_provider_name);
            }
            if (row.fallback_channel) {
              result.fallbackChannel = String(row.fallback_channel);
            }
            if (row.task_id) {
              result.backendTaskId = Number(row.task_id);
            }
            if (row.newapi_status) {
              result.newapiStatus = String(row.newapi_status);
            }
          } else {
            endpoints.retrylog.missingFields = ['rows[0]'];
          }
        } else {
          endpoints.retrylog.queryStatus = 'FAILED';
          endpoints.retrylog.error = `HTTP ${res.status}`;
        }
      }
    } catch (reqErr: any) {
      endpoints.retrylog.queryStatus = 'ERROR';
      endpoints.retrylog.error = reqErr?.message || String(reqErr);
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    endpoints.retrylog.queryStatus = 'ERROR';
    endpoints.retrylog.error = err?.message || String(err);
  }

  // 3. 查询 /aivideo/exceptionaltaskdata/index?filter={"source_id":taskId}&op={"source_id":"="}
  const expUrl = new URL(
    `/aivideo/exceptionaltaskdata/index?filter=${encodeURIComponent(filterParam)}&op=${encodeURIComponent(opParam)}`,
    baseUrl,
  ).toString();
  endpoints.exceptionaltask.url = expUrl;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchWithRetry(
        expUrl,
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
        1,
      );
      endpoints.exceptionaltask.httpStatus = res.status;
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        endpoints.exceptionaltask.queryStatus = 'FAILED';
        endpoints.exceptionaltask.error = `响应非有效 JSON (HTTP ${res.status}): ${text.slice(0, 100)}`;
      }

      if (body) {
        if (res.ok) {
          endpoints.exceptionaltask.queryStatus = 'SUCCESS';
          const row = body?.rows?.[0];
          if (row) {
            endpoints.exceptionaltask.data = row;
            result.rawExceptionalTask = row;
            if (!result.backendTaskId && row.id) {
              result.backendTaskId = Number(row.id);
            }
            const rowExtra = typeof row.extra === 'string' ? JSON.parse(row.extra) : row.extra;
            if (rowExtra?.retry_provider) {
              result.retryProvider = String(rowExtra.retry_provider);
            }
            if (rowExtra?.video_provider) {
              result.videoProvider = String(rowExtra.video_provider);
            }
            if (rowExtra?.volc_route_provider) {
              result.volcRouteProvider = String(rowExtra.volc_route_provider);
            }
            if (!result.actualChannelName && row.line_name) {
              result.actualChannelName = String(row.line_name);
            }

            // 若 getEditData 未取得 extra，但 exceptionaltask 有 extra，记录来源为 HTTP_API:exceptional-task
            if (!result.extra && rowExtra) {
              result.extra = rowExtra;
              result.extraSource = 'HTTP_API:exceptional-task';
            }
          } else {
            endpoints.exceptionaltask.missingFields = ['rows[0]'];
          }
        } else {
          endpoints.exceptionaltask.queryStatus = 'FAILED';
          endpoints.exceptionaltask.error = `HTTP ${res.status}`;
        }
      }
    } catch (reqErr: any) {
      endpoints.exceptionaltask.queryStatus = 'ERROR';
      endpoints.exceptionaltask.error = reqErr?.message || String(reqErr);
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    endpoints.exceptionaltask.queryStatus = 'ERROR';
    endpoints.exceptionaltask.error = err?.message || String(err);
  }

  return result;
}
