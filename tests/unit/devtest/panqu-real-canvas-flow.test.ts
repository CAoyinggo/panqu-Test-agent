import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  submitCanvasNodeTask,
  runPanquRealCanvasFlow,
} from '../../../src/devtest/panqu-real-canvas-flow.js';

describe('PanquRealCanvasFlow Unit Tests', () => {
  const mockBaseUrl = 'https://test.panqu.com';
  const mockCookies = 'PHPSESSID=mock_session_id; auth=%7B%22user%22%3A%7B%22id%22%3A1%7D%7D';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-CANVAS-01: submitCanvasNodeTask 应向 /aivideo/videonew/add 发送正确的画布与节点参数', async () => {
    let capturedBody = '';
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = options.body;
      return {
        ok: true,
        text: async () => JSON.stringify({
          code: 1,
          msg: 'Workflow video added',
          data: { id: 556677 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await submitCanvasNodeTask(mockBaseUrl, mockCookies, 'mock_token', {
      projectId: 365,
      canvasId: '127',
      nodeId: 'node_canvas_test_1',
      modelId: 84,
      prompt: 'a scenic fly-over mountain shot',
    });

    expect(res.taskId).toBe(556677);
    expect(capturedBody).toContain('row%5Bworkflow_id%5D=127');
    expect(capturedBody).toContain('row%5Bworkflow_node_id%5D=node_canvas_test_1');
    expect(capturedBody).toContain('row%5BselmodelsId%5D=84');
    expect(capturedBody).toContain('devtest_a+scenic+fly-over+mountain+shot');
  });

  it('TC-CANVAS-02: submitCanvasNodeTask 失败时抛出异常', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'Workflow node locked',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      submitCanvasNodeTask(mockBaseUrl, mockCookies, 'mock_token', {
        projectId: 365,
        canvasId: '127',
        nodeId: 'node_err',
        modelId: 84,
        prompt: 'test prompt',
      })
    ).rejects.toThrow('CANVAS_NODE_TASK_REJECTED');
  });
});
