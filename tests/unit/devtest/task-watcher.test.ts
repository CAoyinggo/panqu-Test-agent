import { describe, expect, it } from 'vitest';
import { TaskWatcher, type TaskProgressEvent } from '../../../src/devtest/task-watcher.js';

describe('TaskWatcher - 长任务流式监视与断点对账器', () => {
  it('成功完成视频长任务流：状态依次流转，产物 MP4 Box 解码有效，扣费核销达标', async () => {
    const events: TaskProgressEvent[] = [];
    const result = await TaskWatcher.watch({
      taskId: 95271,
      modelId: 84,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      mock: true,
      onProgress: (ev) => events.push(ev),
    });

    expect(result.ok).toBe(true);
    expect(result.finalStatus).toBe('COMPLETED');
    expect(result.taskId).toBe(95271);
    expect(result.modelId).toBe(84);

    // 验证事件流转完整性 (SUBMITTED -> QUEUED -> PROCESSING -> COMPLETED)
    expect(events.length).toBe(4);
    expect(events.map((e) => e.status)).toEqual(['SUBMITTED', 'QUEUED', 'PROCESSING', 'COMPLETED']);
    expect(events[events.length - 1].progress).toBe(100);

    // 验证介质检查
    expect(result.mediaInspection).toBeDefined();
    expect(result.mediaInspection?.decodable).toBe(true);
    expect(result.mediaInspection?.format).toContain('mp4');

    // 验证账单对账 (Wan 3.0 720p 4s = 56 pt)
    expect(result.billingReconciliation).toBeDefined();
    expect(result.billingReconciliation?.passed).toBe(true);
    expect(result.billingReconciliation?.expectedPoints).toBe(56);
    expect(result.billingReconciliation?.netDeductedPoints).toBe(56);
  });

  it('模拟生成异常失败分支：流转至 FAILED 终态，全额退款核销 (净扣 0 pt) 并导出复现包', async () => {
    const result = await TaskWatcher.watch({
      taskId: 95272,
      modelId: 84,
      mediaType: 'video',
      mock: true,
      simulateFailure: true,
    });

    expect(result.ok).toBe(true);
    expect(result.finalStatus).toBe('FAILED');

    // 验证退款净扣归零
    expect(result.billingReconciliation).toBeDefined();
    expect(result.billingReconciliation?.passed).toBe(true);
    expect(result.billingReconciliation?.netDeductedPoints).toBe(0);
    expect(result.billingReconciliation?.netChargeZero).toBe(true);

    // 验证复现包自动产出
    expect(result.reproPackage).toBeDefined();
    expect(result.reproPackage?.ok).toBe(true);
  });
});
