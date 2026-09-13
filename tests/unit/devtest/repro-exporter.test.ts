import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ReproExporter } from '../../../src/devtest/repro-exporter.js';

describe('ReproExporter - 缺陷一键复现包导出器', () => {
  it('针对账单资损违背生成 P0 严重度复现包 (含 cURL, Playwright 脚本与 Markdown 模版)', async () => {
    const outDir = path.resolve('devtest-results/test-repro');
    const result = await ReproExporter.generatePackage({
      caseId: 'CASE-FAIL-DOUBLE-BILLING-001',
      failureCategory: 'BILLING_ANOMALY',
      taskInfo: {
        taskId: 9001,
        modelId: 84,
        mediaType: 'video',
        duration: 4,
        resolution: '720p',
        env: 'test',
      },
      expected: { expectedPoints: 56, netDeductedPoints: 56 },
      actual: { netDeductedPoints: 112 },
      reasons: ['检测到同一 clientToken 重复扣除预扣积分'],
      violatedInvariants: ['ANTI_DOUBLE_BILLING'],
      scoreLogs: [
        { type: 2, score: -56, memo: '预扣 1' },
        { type: 2, score: -56, memo: '重复预扣 2' },
      ],
      outputDir: outDir,
    });

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('P0');
    expect(result.title).toContain('P0');
    expect(result.title).toContain('ANTI_DOUBLE_BILLING');

    // 验证 cURL 包含端点与必要参数
    expect(result.curlCommand).toContain('/aivideo/videonew/add');
    expect(result.curlCommand).toContain('row[extra][selmodels]');
    expect(result.curlCommand).toContain('720p');

    // 验证 Playwright 脚本包含独立测试与断言
    expect(result.playwrightScript).toContain('@playwright/test');
    expect(result.playwrightScript).toContain('/aivideo/videonew/add');

    // 验证导出的文件存在且内容完整
    expect(result.savedFiles).toBeDefined();
    if (result.savedFiles) {
      const md = await readFile(result.savedFiles.markdownPath, 'utf8');
      expect(md).toContain('ANTI_DOUBLE_BILLING');
      expect(md).toContain('重复扣除预扣积分');
      expect(md).toContain('curl -X POST');
    }
  });

  it('针对非资损的普通失败生成 P1 级别复现包', async () => {
    const result = await ReproExporter.generatePackage({
      caseId: 'CASE-FAIL-TIMEOUT-002',
      failureCategory: 'TASK_FAILED',
      taskInfo: {
        modelId: 201,
        mediaType: 'image',
        env: 'test',
      },
      expected: '任务生成成功并返回图片 URL',
      actual: '任务超时 (TASK_STATUS=3)',
      reasons: ['上游供应商接口超时 60s'],
    });

    expect(result.ok).toBe(true);
    expect(result.severity).toBe('P1');
    expect(result.curlCommand).toContain('/aivideo/v2/image/generate');
  });
});
