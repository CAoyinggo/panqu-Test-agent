import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fetchWithRetry,
  loadPanquSession,
  submitMediaTask,
  pollTaskStatus,
  queryTaskBillingLogs,
} from '../../../src/devtest/media-flow.js';

describe('media-flow - 媒体流执行器真实高价值契约测试', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 一、submitMediaTask
  // ==========================================================================
  describe('1. submitMediaTask 任务提交与参数构造', () => {
    it('视频任务提交：正确构造 FastAdmin URL、视频 row[...] 字段并提取 taskId', async () => {
      let recordedUrl = '';
      let recordedMethod = '';
      let recordedHeaders: Record<string, string> = {};
      let recordedBody = '';

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        recordedUrl = String(url);
        recordedMethod = init?.method || '';
        recordedHeaders = (init?.headers as Record<string, string>) || {};
        recordedBody = String(init?.body || '');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 1, msg: 'ok', data: { id: 88801 } }),
        } as unknown as Response;
      });

      const res = await submitMediaTask({
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=session_video_123',
        csrfToken: 'token_csrf_456',
        mediaType: 'video',
        modelId: 84,
        prompt: '测试生视频 prompt',
        resolution: '720p',
        aspectRatio: '16:9',
        duration: 5,
        projectId: 10,
      });

      expect(recordedUrl).toBe('https://test.panqu.com/aivideo/v2/generate/video');
      expect(recordedMethod).toBe('POST');
      expect(recordedHeaders.Cookie).toBe('PHPSESSID=session_video_123');
      expect(recordedHeaders['Content-Type']).toContain('application/x-www-form-urlencoded');

      const params = new URLSearchParams(recordedBody);
      expect(params.get('__token__')).toBe('token_csrf_456');
      expect(params.get('project_id')).toBe('10');
      expect(params.get('row[type]')).toBe('6');
      expect(params.get('row[selmodelsId]')).toBe('84');
      expect(params.get('row[extra][selmodels]')).toBe('84-Wan3.0');
      expect(params.get('row[extra][cueword]')).toBe('测试生视频 prompt');
      expect(params.get('row[extra][duration]')).toBe('5');
      expect(params.get('row[extra][video_resolution]')).toBe('720p');
      expect(params.get('row[extra][video_aspect_ratio]')).toBe('16:9');

      expect(res.ok).toBe(true);
      expect(res.taskId).toBe(88801);
      expect(res.message).toBe('ok');
    });

    it('图片任务提交：正确构造生图专用 URL 与 extra 字段 (支持 data 直接为数字)', async () => {
      let recordedUrl = '';
      let recordedBody = '';

      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        recordedUrl = String(url);
        recordedBody = String(init?.body || '');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 1, msg: '提交成功', data: 99902 }),
        } as unknown as Response;
      });

      const res = await submitMediaTask({
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=session_img_123',
        mediaType: 'image',
        modelId: 201,
        resolution: '2k',
        serviceline: 'r',
      });

      expect(recordedUrl).toBe('https://test.panqu.com/aivideo/v2/generate/submit_picture_custom_size');
      const params = new URLSearchParams(recordedBody);
      expect(params.get('row[selmodelsId]')).toBe('201');
      expect(params.get('row[extra][prompt]')).toBe('devtest_sample_image');
      expect(params.get('row[extra][resolution]')).toBe('2k');
      expect(params.get('row[extra][serviceline]')).toBe('r');

      expect(res.ok).toBe(true);
      expect(res.taskId).toBe(99902);
      expect(res.message).toBe('提交成功');
    });

    it('服务端业务失败：code=0 响应准确解析为 ok=false 且保留服务端错误信息', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, msg: '当前账户积分余额不足，请充值后再试' }),
      } as unknown as Response));

      const res = await submitMediaTask({
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=session_fail_123',
        mediaType: 'video',
        modelId: 84,
      });

      expect(res.ok).toBe(false);
      expect(res.taskId).toBe(0);
      expect(res.message).toBe('当前账户积分余额不足，请充值后再试');
    });

    it('非 JSON 响应：HTTP 502/网关 HTML 页面抛出规范 SUBMIT_RESPONSE_NOT_JSON 异常', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 502,
        text: async () => '<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>',
      } as unknown as Response));

      await expect(
        submitMediaTask({
          baseUrl: 'https://test.panqu.com',
          cookies: 'PHPSESSID=session_error_123',
          mediaType: 'video',
          modelId: 84,
        })
      ).rejects.toThrow('SUBMIT_RESPONSE_NOT_JSON: HTTP 502 响应非 JSON');
    });

    it('参数透传与默认 Prompt：未传 prompt 时使用默认值，支持 extraParams 扩展字段', async () => {
      let recordedBody = '';
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        recordedBody = String(init?.body || '');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 1, data: 12345 }),
        } as unknown as Response;
      });

      const res = await submitMediaTask({
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=test',
        mediaType: 'video',
        modelId: 50,
        extraParams: { custom_tag: 'vip_user', scene_id: '99' },
      });

      const params = new URLSearchParams(recordedBody);
      expect(params.get('row[extra][cueword]')).toBe('devtest_sample_video');
      expect(params.get('custom_tag')).toBe('vip_user');
      expect(params.get('scene_id')).toBe('99');
      expect(res.ok).toBe(true);
      expect(res.taskId).toBe(12345);
    });
  });

  // ==========================================================================
  // 二、pollTaskStatus
  // ==========================================================================
  describe('2. pollTaskStatus 状态机与轮询控制', () => {
    it('SUCCESS (task_status=2)：正确结束轮询并提取产物地址与 100% 进度', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        callCount++;
        const params = new URLSearchParams(String(init?.body || ''));
        expect(params.get('type')).toBe('video');
        expect(params.get('ids')).toBe('77701');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 1,
            data: [{ id: 77701, task_status: 2, video_url: 'https://cdn.panqu.com/video_77701.mp4' }],
          }),
        } as unknown as Response;
      });

      const { finalSnapshot, totalPolls } = await pollTaskStatus(77701, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 1,
        pollIntervalMs: 10,
      });

      expect(callCount).toBe(1);
      expect(totalPolls).toBe(1);
      expect(finalSnapshot.taskStatus).toBe(2);
      expect(finalSnapshot.statusLabel).toBe('成功 (Success)');
      expect(finalSnapshot.videoUrl).toBe('https://cdn.panqu.com/video_77701.mp4');
      expect(finalSnapshot.progress).toBe(100);
    });

    it('FAILED (task_status=3)：正确结束轮询并提取服务端 error 字段', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: [{ id: 77702, task_status: 3, err: 'GPU 算力节点渲染异常', progress: 45 }],
        }),
      } as unknown as Response));

      const { finalSnapshot } = await pollTaskStatus(77702, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 1,
        pollIntervalMs: 10,
      });

      expect(finalSnapshot.taskStatus).toBe(3);
      expect(finalSnapshot.statusLabel).toBe('失败 (Failed)');
      expect(finalSnapshot.error).toBe('GPU 算力节点渲染异常');
      expect(finalSnapshot.progress).toBe(45);
    });

    it('ERROR / ABNORMAL (task_status=4)：正确标记状态并结束轮询', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: [{ id: 77703, task_status: 4, error: '任务超时被系统撤销' }],
        }),
      } as unknown as Response));

      const { finalSnapshot } = await pollTaskStatus(77703, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 1,
        pollIntervalMs: 10,
      });

      expect(finalSnapshot.taskStatus).toBe(4);
      expect(finalSnapshot.statusLabel).toBe('异常 (Error)');
      expect(finalSnapshot.error).toBe('任务超时被系统撤销');
    });

    it('PENDING → SUCCESS：排队中 (status=1) 触发 onProgress，下一轮成功并退出', async () => {
      let pollIndex = 0;
      const progressSnapshots: number[] = [];

      global.fetch = vi.fn().mockImplementation(async () => {
        pollIndex++;
        if (pollIndex === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: 1,
              data: [{ id: 77704, task_status: 1, progress: 30 }],
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 1,
            data: [{ id: 77704, task_status: 2, progress: 100, pic_url: 'https://cdn.panqu.com/img_77704.png' }],
          }),
        } as unknown as Response;
      });

      const { finalSnapshot, totalPolls } = await pollTaskStatus(77704, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'image',
        pollTimeoutSec: 2,
        pollIntervalMs: 15,
        onProgress: (snap) => progressSnapshots.push(snap.progress),
      });

      expect(pollIndex).toBe(2);
      expect(totalPolls).toBe(2);
      expect(progressSnapshots).toEqual([30, 100]);
      expect(finalSnapshot.taskStatus).toBe(2);
      expect(finalSnapshot.imageUrl).toBe('https://cdn.panqu.com/img_77704.png');
    });

    it('data 字典/对象结构兼容：后端返回以 taskId 为 key 的字典格式亦能正常解析', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: {
            '77705': {
              id: 77705,
              status: 2,
              video_url: 'https://cdn.panqu.com/dict_video.mp4',
            },
          },
        }),
      } as unknown as Response));

      const { finalSnapshot } = await pollTaskStatus(77705, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 1,
        pollIntervalMs: 10,
      });

      expect(finalSnapshot.taskStatus).toBe(2);
      expect(finalSnapshot.videoUrl).toBe('https://cdn.panqu.com/dict_video.mp4');
    });

    it('polling timeout：任务持续保持 status=1 直到超时退出，返回最新快照且不抛未捕获异常', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: [{ id: 77706, task_status: 1, progress: 10 }],
        }),
      } as unknown as Response));

      const startTime = Date.now();
      const { finalSnapshot, totalPolls } = await pollTaskStatus(77706, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 0.06,
        pollIntervalMs: 15,
      });
      const elapsed = Date.now() - startTime;

      expect(finalSnapshot.taskStatus).toBe(1);
      expect(finalSnapshot.statusLabel).toBe('排队中 (Queued)');
      expect(totalPolls).toBeGreaterThanOrEqual(1);
      expect(elapsed).toBeLessThan(1000); // 确保在受控超时内退出，绝不无限循环
    });

    it('单次轮询网络抖动容忍：首次 poll 网络异常不中断流程，下一次轮询恢复并返回结果', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network glitch');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 1,
            data: [{ id: 77707, task_status: 2, progress: 100 }],
          }),
        } as unknown as Response;
      });

      const { finalSnapshot } = await pollTaskStatus(77707, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 1,
        pollIntervalMs: 10,
      });

      expect(callCount).toBe(2);
      expect(finalSnapshot.taskStatus).toBe(2);
      expect(finalSnapshot.statusLabel).toBe('成功 (Success)');
    });

    it('未知状态码兼容：遇到未定义状态码回退为未知状态标签', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: [{ id: 77708, task_status: 99, progress: 50 }],
        }),
      } as unknown as Response));

      const { finalSnapshot } = await pollTaskStatus(77708, {
        baseUrl: 'https://test.panqu.com',
        cookies: 'PHPSESSID=poll_test',
        mediaType: 'video',
        pollTimeoutSec: 0.05,
        pollIntervalMs: 10,
      });

      expect(finalSnapshot.taskStatus).toBe(99);
      expect(finalSnapshot.statusLabel).toBe('未知状态 (99)');
    });
  });

  // ==========================================================================
  // 三、loadPanquSession
  // ==========================================================================
  describe('3. loadPanquSession 真实凭据加载与多环境防御', () => {
    let tmpDir: string;

    it('正常 session：正确读取指定文件并返回匹配 targetEnv 的 PanquSession', async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'devtest-session-test-'));
      const filePath = path.join(tmpDir, 'valid_session.json');
      await writeFile(
        filePath,
        JSON.stringify({
          sessions: [
            { env: 'preonline', base_url: 'https://pre.panqu.com', cookie_string: 'PHPSESSID=pre_123' },
            { env: 'test', base_url: 'https://test.panqu.com', cookie_string: 'PHPSESSID=test_456', csrf_token: 'csrf_789', project_id: 12 },
          ],
        }),
        'utf8'
      );

      const session = await loadPanquSession(filePath, 'test');
      expect(session.env).toBe('test');
      expect(session.base_url).toBe('https://test.panqu.com');
      expect(session.cookie_string).toBe('PHPSESSID=test_456');
      expect(session.csrf_token).toBe('csrf_789');
      expect(session.project_id).toBe(12);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('没有 session 配置：未传参数且环境变量未设置时抛出 SESSION_CONFIG_REQUIRED', async () => {
      const oldEnv = process.env.PANQU_SESSION_COOKIES_FILE;
      delete process.env.PANQU_SESSION_COOKIES_FILE;

      try {
        await expect(loadPanquSession()).rejects.toThrow('SESSION_CONFIG_REQUIRED');
      } finally {
        if (oldEnv) process.env.PANQU_SESSION_COOKIES_FILE = oldEnv;
      }
    });

    it('文件不存在：传入不存在的路径抛出 SESSION_CONFIG_NOT_FOUND', async () => {
      const nonExistent = path.join(os.tmpdir(), 'non_existent_session_99999.json');
      await expect(loadPanquSession(nonExistent)).rejects.toThrow('SESSION_CONFIG_NOT_FOUND');
    });

    it('JSON 损坏：文件内容非合法 JSON 抛出 SESSION_CONFIG_INVALID', async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'devtest-corrupted-json-'));
      const filePath = path.join(tmpDir, 'broken.json');
      await writeFile(filePath, '{ "sessions": [ invalid json }', 'utf8');

      try {
        await expect(loadPanquSession(filePath)).rejects.toThrow('SESSION_CONFIG_INVALID');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('env 不匹配：文件合法但不存在 targetEnv 会话抛出 SESSION_ENV_NOT_FOUND', async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'devtest-env-miss-'));
      const filePath = path.join(tmpDir, 'env_miss.json');
      await writeFile(
        filePath,
        JSON.stringify({ sessions: [{ env: 'prod', base_url: 'https://panqu.com', cookie_string: 'PHPSESSID=p' }] }),
        'utf8'
      );

      try {
        await expect(loadPanquSession(filePath, 'test')).rejects.toThrow("SESSION_ENV_NOT_FOUND: 在配置中未找到 env='test' 的可用会话");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('Session 不完整：缺少 base_url 或 cookie_string 抛出 SESSION_INCOMPLETE', async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'devtest-incomplete-'));
      const filePath = path.join(tmpDir, 'incomplete.json');
      await writeFile(
        filePath,
        JSON.stringify({ sessions: [{ env: 'test', base_url: 'https://test.panqu.com' }] }), // 缺少 cookie_string
        'utf8'
      );

      try {
        await expect(loadPanquSession(filePath, 'test')).rejects.toThrow('SESSION_INCOMPLETE: 会话缺失 base_url 或 cookie_string');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ==========================================================================
  // 四、fetchWithRetry
  // ==========================================================================
  describe('4. fetchWithRetry 网络重试契约', () => {
    it('第一次请求成功：直接返回且只发起 1 次 fetch', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return { ok: true, status: 200 } as unknown as Response;
      });

      const res = await fetchWithRetry('https://test.panqu.com/api', { method: 'GET' }, 3);
      expect(res.ok).toBe(true);
      expect(callCount).toBe(1);
    });

    it('重试成功：第一次网络抖动抛错，第二次重试成功', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNRESET');
        }
        return { ok: true, status: 200 } as unknown as Response;
      });

      const startTime = Date.now();
      const res = await fetchWithRetry('https://test.panqu.com/api', { method: 'GET' }, 2);
      const elapsed = Date.now() - startTime;

      expect(res.ok).toBe(true);
      expect(callCount).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(350); // 经历了 400ms 退避
    });

    it('重试耗尽：连续网络异常耗尽指定 retries 次数后抛出最后一次错误', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error(`Connection failed attempt ${callCount}`);
      });

      await expect(
        fetchWithRetry('https://test.panqu.com/api', { method: 'GET' }, 2)
      ).rejects.toThrow('Connection failed attempt 2');

      expect(callCount).toBe(2);
    });
  });

  // ==========================================================================
  // 五、queryTaskBillingLogs 降级分支与全链路契约
  // ==========================================================================
  describe('5. queryTaskBillingLogs 账单流水只读查询契约', () => {
    const session = {
      env: 'test',
      base_url: 'https://test.panqu.com',
      cookie_string: 'PHPSESSID=session_billing_123',
    };

    it('首选端点命中：AdminScore 端点成功直接返回 QUERY_SUCCESS 与 source=auth_adminscore', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              total: 1,
              rows: [
                {
                  id: 9901,
                  task_id: '88801',
                  score: 40,
                  remark: 'FastAdmin 任务扣费',
                  createtime: 1726500000,
                  type: 2,
                },
              ],
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      });

      const result = await queryTaskBillingLogs(88801, session);
      expect(result.status).toBe('QUERY_SUCCESS');
      expect(result.source).toBe('auth_adminscore');
      expect(result.scoreLogs).toHaveLength(1);
      expect(result.scoreLogs[0].id).toBe(9901);
      expect(result.scoreLogs[0].task_id).toBe(88801);
      expect(result.scoreLogs[0].score).toBe(40);
      expect(result.scoreLogs[0].memo).toBe('FastAdmin 任务扣费');
    });

    it('首选端点异常平滑降级：AdminScore 500 异常时自动回退至备用 apiPersonalRecords 端点', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          } as unknown as Response;
        }
        if (url.includes('/aivideo/v2/billing/apiPersonalRecords')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              code: 1,
              data: {
                total: 1,
                rows: [
                  {
                    id: 6601,
                    task_id: 88899,
                    type: 2,
                    points: -56,
                    type_text: '视频生成任务预扣',
                    time: '2026-09-17 12:00:00',
                  },
                ],
              },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      });

      const result = await queryTaskBillingLogs(88899, session);
      expect(result.status).toBe('QUERY_SUCCESS');
      expect(result.source).toBe('billing_personal_records');
      expect(result.scoreLogs).toHaveLength(1);
      expect(result.scoreLogs[0].task_id).toBe(88899);
      expect(result.scoreLogs[0].score).toBe(56);
      expect(result.scoreLogs[0].memo).toBe('视频生成任务预扣');
    });

    it('鉴权失效感知：端点返回 401/403 准确识别为 AUTH_FAILED', async () => {
      global.fetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as unknown as Response));

      const result = await queryTaskBillingLogs(88899, session);
      expect(result.status).toBe('AUTH_FAILED');
      expect(result.error).toContain('AUTH_FAILED');
    });

    it('业务未登录感知：备用端点返回 code=0 且提示登录失效时转换为 AUTH_FAILED', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, msg: '用户未登录或 token 已过期' }),
        } as unknown as Response;
      });

      const result = await queryTaskBillingLogs(88899, session);
      expect(result.status).toBe('AUTH_FAILED');
      expect(result.error).toContain('AUTH_FAILED');
    });

    it('普通业务错误：备用端点返回 code=0 且非登录问题时判定为 QUERY_ERROR', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, msg: '内部服务限流，请稍后' }),
        } as unknown as Response;
      });

      const result = await queryTaskBillingLogs(88899, session);
      expect(result.status).toBe('QUERY_ERROR');
      expect(result.error).toContain('内部服务限流');
    });

    it('HTML/网关错误响应防御：非有效 JSON 响应准确识别为 PARSE_ERROR', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => '<html><body>504 Gateway Time-out</body></html>',
        } as unknown as Response;
      });

      const result = await queryTaskBillingLogs(88899, session);
      expect(result.status).toBe('PARSE_ERROR');
      expect(result.error).toContain('PARSE_ERROR');
    });

    it('超时控制契约：触发 AbortController 超时中止时准确识别为 QUERY_TIMEOUT', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/auth/adminscore/index')) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const result = await queryTaskBillingLogs(88899, session, { timeoutMs: 50 });
      expect(result.status).toBe('QUERY_TIMEOUT');
      expect(result.error).toContain('QUERY_TIMEOUT');
    });
  });
});

