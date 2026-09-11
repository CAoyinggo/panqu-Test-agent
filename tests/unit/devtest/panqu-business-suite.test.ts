import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  runPanquBusinessSuite,
  renderBusinessSuiteReportMarkdown,
  type PanquBusinessSuiteReport,
} from '../../../src/devtest/panqu-business-suite.js';
import * as videoFlow from '../../../src/devtest/panqu-real-video-flow.js';
import * as imageFlow from '../../../src/devtest/panqu-real-image-flow.js';
import * as canvasFlow from '../../../src/devtest/panqu-real-canvas-flow.js';
import * as diversionFlow from '../../../src/devtest/panqu-diversion-flow.js';

describe('PanquBusinessSuite Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-SUITE-01: runPanquBusinessSuite 应支持单模块调度', async () => {
    const mockImageReport: any = {
      runId: 'image-1',
      summary: { status: 'SUCCESS', isDiverted: true, taskId: 123 },
      diversionCheck: { isDiverted: true, newapiImageFlag: 1, newapiModel: 'nano' },
      submission: { durationMs: 100 },
      artifacts: { reportMd: 'report.md', evidenceJson: 'report.json' },
    };
    vi.spyOn(imageFlow, 'runPanquRealImageFlow').mockResolvedValue(mockImageReport);

    const suiteReport = await runPanquBusinessSuite({
      module: 'image',
      env: 'test',
      outputDir: '/tmp/suite-test',
    });

    expect(suiteReport.targetModule).toBe('image');
    expect(suiteReport.summary.total).toBe(1);
    expect(suiteReport.summary.passed).toBe(1);
    expect(suiteReport.summary.overallStatus).toBe('ALL_PASSED');
    expect(imageFlow.runPanquRealImageFlow).toHaveBeenCalled();
  });

  it('TC-SUITE-02: renderBusinessSuiteReportMarkdown 应正确生成全模块对比总结表格', () => {
    const dummySuiteReport: PanquBusinessSuiteReport = {
      suiteId: 'suite-9988',
      startedAt: '2026-09-11T10:00:00.000Z',
      finishedAt: '2026-09-11T10:00:10.000Z',
      environment: 'test',
      targetModule: 'all',
      summary: {
        total: 4,
        passed: 4,
        failed: 0,
        passRate: '100.0%',
        overallStatus: 'ALL_PASSED',
      },
      modules: {},
      moduleSummaries: [
        {
          name: 'diversion',
          title: '分流全量用例矩阵推演',
          executed: true,
          passed: true,
          durationMs: 300,
          diversionResult: '20/20 通过',
          details: '覆盖率 100%',
        },
        {
          name: 'video',
          title: '真实视频生成与分流快照',
          executed: true,
          passed: true,
          durationMs: 500,
          taskId: 239183,
          diversionResult: '✅ 命中 extra.diversion=10',
          details: '模型: wan3.0-video',
        },
      ],
      artifacts: {
        reportMd: '/tmp/suite.md',
        evidenceJson: '/tmp/suite.json',
      },
    };

    const md = renderBusinessSuiteReportMarkdown(dummySuiteReport);
    expect(md).toContain('# 业务全模块自动化自测综合报告');
    expect(md).toContain('ALL PASSED');
    expect(md).toContain('239183');
    expect(md).toContain('wan3.0-video');
    expect(md).toContain('领先单一 Skill 文件的四大代差架构落地说明');
  });
});
