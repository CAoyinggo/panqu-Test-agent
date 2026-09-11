import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  maskSensitive,
  fetchCsrfToken,
  submitRealVideoTask,
  verifyTaskDiversionSnapshot,
  pollTaskStatus,
  renderRealVideoReportMarkdown,
  type PanquRealVideoReport,
} from '../../../src/devtest/panqu-real-video-flow.js';

describe('PanquRealVideoFlow Unit Tests', () => {
  const mockBaseUrl = 'https://test.panqu.com';
  const mockCookies = 'PHPSESSID=mock_session_id; auth=%7B%22user%22%3A%7B%22id%22%3A1%7D%7D';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-REAL-01: maskSensitive 应对敏感凭据进行不可逆掩码且不泄露明文', () => {
    expect(maskSensitive('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz')).toBe('eyJh******.xyz');
    expect(maskSensitive('13800138000')).toBe('1380******8000');
    expect(maskSensitive('short')).toBe('******');
    expect(maskSensitive('')).toBe('(empty)');
    expect(maskSensitive(null)).toBe('(empty)');
  });

  it('TC-REAL-02: fetchCsrfToken 应从 /ajax/refreshtoken 提取 __token__', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 1,
        msg: '',
        data: { __token__: 'mock_csrf_token_abcdef123456' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchCsrfToken(mockBaseUrl, mockCookies);
    expect(res.token).toBe('mock_csrf_token_abcdef123456');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.panqu.com/ajax/refreshtoken',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: mockCookies,
          'X-Requested-With': 'XMLHttpRequest',
        }),
      })
    );
  });

  it('TC-REAL-03: submitRealVideoTask 应强制注入 devtest_ 前缀并正确提交参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        code: 1,
        msg: 'Video added successfully',
        data: { id: 998877 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { taskId, evidence } = await submitRealVideoTask(
      mockBaseUrl,
      mockCookies,
      'token_123',
      {
        projectId: 365,
        modelId: 84,
        prompt: 'user_prompt_without_prefix', // 未带前缀
        duration: 5,
        resolution: '720p',
        aspectRatio: '16:9',
        taskType: 28,
        modelName: 'Wan 3.0',
      }
    );

    expect(taskId).toBe(998877);
    expect(evidence.responseCode).toBe(1);
    expect(evidence.requestParams['row[selmodelsId]']).toBe('84');
    expect(evidence.requestParams['row[extra][selmodels]']).toBe('84-Wan 3.0');
    // 断言必须强制注入 devtest_ 前缀
    expect(evidence.requestParams['row[extra][cueword]']).toBe('devtest_user_prompt_without_prefix');
    expect(evidence.requestParams['__token__']).toBe('token_123');
    expect(evidence.requestParams['project_id']).toBe('365');
  });

  it('TC-REAL-04: verifyTaskDiversionSnapshot 应严格核验 extra.diversion=10 及模型别名', async () => {
    // 模拟主站接口返回 extra 包含 diversion=10
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        rows: [
          {
            id: 998877,
            extra: JSON.stringify({
              selmodelsId: '84',
              diversion: 10,
              newapi_model: 'wan3.0-video',
              newapi_org_id: 0,
              points: 12,
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const check = await verifyTaskDiversionSnapshot(mockBaseUrl, mockCookies, 998877, 365);
    expect(check.isDiverted).toBe(true);
    expect(check.diversionValue).toBe(10);
    expect(check.newapiModel).toBe('wan3.0-video');
    expect(check.newapiOrgId).toBe(0);
    expect(check.points).toBe(12);
    expect(check.passed).toBe(true);
    expect(check.mismatches).toHaveLength(0);
  });

  it('TC-REAL-05: verifyTaskDiversionSnapshot 在 diversion=0 时应判定未命中并记录排查项', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        rows: [
          {
            id: 998877,
            extra: JSON.stringify({
              selmodelsId: '84',
              diversion: 0, // 未命中分流
              newapi_model: '',
              newapi_org_id: -1,
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const check = await verifyTaskDiversionSnapshot(mockBaseUrl, mockCookies, 998877, 365);
    expect(check.isDiverted).toBe(false);
    expect(check.diversionValue).toBe(0);
    expect(check.passed).toBe(false);
    expect(check.mismatches.some((m) => m.includes('期望 extra.diversion=10'))).toBe(true);
  });

  it('TC-REAL-06: pollTaskStatus 应轮询 apiGetStatus 并在遇到终态时及时返回', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            code: 1,
            data: [
              {
                id: 998877,
                status: {
                  id: 998877,
                  task_status: 1, // 生成中
                  progress: 45,
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          code: 1,
          data: [
            {
              id: 998877,
              status: {
                id: 998877,
                task_status: 2, // 生成完成
                progress: 100,
                video_url: 'https://vod.panqu.com/video/devtest_result.mp4',
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const pollRes = await pollTaskStatus(mockBaseUrl, mockCookies, 998877, {
      pollTimeoutSec: 5,
      pollIntervalMs: 10,
    });

    expect(pollRes.finalSnapshot.taskStatus).toBe(2);
    expect(pollRes.finalSnapshot.statusLabel).toBe('生成完成 (Success)');
    expect(pollRes.finalSnapshot.progress).toBe(100);
    expect(pollRes.finalSnapshot.videoUrl).toBe('https://vod.panqu.com/video/devtest_result.mp4');
    expect(pollRes.totalPolls).toBe(2);
  });

  it('TC-REAL-07: renderRealVideoReportMarkdown 生成的报告应包含分流核验与审计表格', () => {
    const dummyReport: PanquRealVideoReport = {
      runId: 'real-video-123456',
      startedAt: '2026-09-11T10:00:00.000Z',
      finishedAt: '2026-09-11T10:00:05.000Z',
      environment: 'test',
      targetUrl: 'https://test.panqu.com',
      accountMasked: 'DEL0******_439',
      submission: {
        timestamp: '2026-09-11T10:00:01.000Z',
        requestUrl: 'https://test.panqu.com/aivideo/videonew/add',
        requestParams: {
          'row[selmodelsId]': '84',
          'row[extra][cueword]': 'devtest_test_prompt',
          'row[extra][video_resolution]': '720p',
          'row[extra][video_aspect_ratio]': '16:9',
        },
        responseCode: 1,
        responseMsg: 'Video added successfully',
        taskId: 998877,
        durationMs: 320,
      },
      diversionCheck: {
        isDiverted: true,
        diversionValue: 10,
        newapiModel: 'wan3.0-video',
        newapiOrgId: 0,
        points: 15,
        rawExtra: {},
        passed: true,
        mismatches: [],
      },
      summary: {
        status: 'SUCCESS',
        isDiverted: true,
        taskId: 998877,
        pointsCharged: 15,
      },
      artifacts: {
        reportMd: '/tmp/report.md',
        evidenceJson: '/tmp/report.json',
      },
    };

    const markdown = renderRealVideoReportMarkdown(dummyReport);
    expect(markdown).toContain('# 真实视频提交与分流验证自测报告');
    expect(markdown).toContain('extra.diversion');
    expect(markdown).toContain('wan3.0-video');
    expect(markdown).toContain('devtest_test_prompt');
    expect(markdown).toContain('DEL0******_439');
  });
});
