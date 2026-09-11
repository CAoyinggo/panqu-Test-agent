import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  submitRealImageTask,
  verifyImageDiversionSnapshot,
  pollImageTaskStatus,
  renderRealImageReportMarkdown,
  type PanquRealImageReport,
} from '../../../src/devtest/panqu-real-image-flow.js';

describe('PanquRealImageFlow Unit Tests', () => {
  const mockBaseUrl = 'https://test.panqu.com';
  const mockCookies = 'PHPSESSID=mock_session_id; auth=%7B%22user%22%3A%7B%22id%22%3A1%7D%7D';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-IMAGE-01: submitRealImageTask 应注入 devtest_ 前缀与 r 线路参数', async () => {
    let capturedBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options.body;
      return {
        ok: true,
        text: async () => JSON.stringify({
          code: 1,
          msg: 'Scene added successfully',
          data: { id: 778899 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitRealImageTask(mockBaseUrl, mockCookies, 'mock_token', {
      projectId: 365,
      modelId: 201,
      prompt: 'a futuristic cyberpunk skyline',
      resolution: '2K',
      serviceline: 'r',
    });

    expect(res.taskId).toBe(778899);
    expect(capturedBody).toContain('row%5Bextra%5D%5Bserviceline%5D=r');
    expect(capturedBody).toContain('devtest_a+futuristic+cyberpunk+skyline');
    expect(capturedBody).toContain('row%5Bextra%5D%5BselmodelsId%5D=201');
  });

  it('TC-IMAGE-02: verifyImageDiversionSnapshot 命中分流时应准确识别 extra.newapi_image=1', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        rows: [
          {
            id: 778899,
            extra: JSON.stringify({
              serviceline: 'r',
              newapi_image: 1,
              newapi_model: 'nano-banana-pro',
              newapi_org_id: 10,
              newapi_group: 'vip',
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const check = await verifyImageDiversionSnapshot(mockBaseUrl, mockCookies, 778899, 365);
    expect(check.isDiverted).toBe(true);
    expect(check.newapiImageFlag).toBe(1);
    expect(check.newapiModel).toBe('nano-banana-pro');
    expect(check.passed).toBe(true);
    expect(check.mismatches).toHaveLength(0);
  });

  it('TC-IMAGE-03: verifyImageDiversionSnapshot 未命中分流时应记录排查异常', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        rows: [
          {
            id: 778899,
            extra: JSON.stringify({
              serviceline: 'local',
              newapi_image: 0,
            }),
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const check = await verifyImageDiversionSnapshot(mockBaseUrl, mockCookies, 778899, 365);
    expect(check.isDiverted).toBe(false);
    expect(check.passed).toBe(false);
    expect(check.mismatches.some((m) => m.includes('extra.newapi_image=1'))).toBe(true);
  });

  it('TC-IMAGE-04: pollImageTaskStatus 应以 type=scene 轮询任务完成并返回成图 URL', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      callCount++;
      expect(options.body).toContain('type=scene');
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            code: 1,
            data: [{ id: 778899, status: { id: 778899, task_status: 1, progress: 50 } }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          code: 1,
          data: [{
            id: 778899,
            status: {
              id: 778899,
              task_status: 2,
              progress: 100,
              pic_url: 'https://img.panqu.com/scene/output.jpg',
            },
          }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const pollRes = await pollImageTaskStatus(mockBaseUrl, mockCookies, 778899, {
      pollTimeoutSec: 5,
      pollIntervalMs: 10,
    });

    expect(pollRes.finalSnapshot.taskStatus).toBe(2);
    expect(pollRes.finalSnapshot.statusLabel).toBe('生成完成 (Success)');
    expect(pollRes.finalSnapshot.picUrl).toBe('https://img.panqu.com/scene/output.jpg');
    expect(pollRes.totalPolls).toBe(2);
  });

  it('TC-IMAGE-05: renderRealImageReportMarkdown 生成格式完备的生图报告', () => {
    const dummyReport: PanquRealImageReport = {
      runId: 'real-image-123456',
      startedAt: '2026-09-11T10:00:00.000Z',
      finishedAt: '2026-09-11T10:00:05.000Z',
      environment: 'test',
      targetUrl: 'https://test.panqu.com',
      accountMasked: 'DEL0******_439',
      submission: {
        timestamp: '2026-09-11T10:00:01.000Z',
        requestUrl: 'https://test.panqu.com/aivideo/scene/add',
        requestParams: {
          'row[selmodelsId]': '201',
          'row[extra][serviceline]': 'r',
          'row[extra][cueword]': 'devtest_cyberpunk',
          'row[extra][resolution]': '2K',
        },
        responseCode: 1,
        responseMsg: 'Scene added successfully',
        taskId: 778899,
        durationMs: 280,
      },
      diversionCheck: {
        isDiverted: true,
        newapiImageFlag: 1,
        newapiModel: 'nano-banana-pro',
        newapiOrgId: 1,
        newapiGroup: 'default',
        rawExtra: {},
        passed: true,
        mismatches: [],
      },
      polling: {
        totalPolls: 1,
        finalStatus: {
          taskId: 778899,
          taskStatus: 2,
          statusLabel: '生成完成 (Success)',
          progress: 100,
          picUrl: 'https://img.panqu.com/scene/output.jpg',
          pollCount: 1,
          durationMs: 500,
        },
        timeline: [],
      },
      summary: {
        status: 'SUCCESS',
        isDiverted: true,
        taskId: 778899,
        picUrl: 'https://img.panqu.com/scene/output.jpg',
      },
      artifacts: {
        reportMd: '/tmp/report.md',
        evidenceJson: '/tmp/report.json',
      },
    };

    const markdown = renderRealImageReportMarkdown(dummyReport);
    expect(markdown).toContain('# 真实生图提交与分流验证自测报告');
    expect(markdown).toContain('extra.newapi_image');
    expect(markdown).toContain('nano-banana-pro');
    expect(markdown).toContain('https://img.panqu.com/scene/output.jpg');
  });
});
