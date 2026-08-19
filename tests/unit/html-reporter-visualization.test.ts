// 单元测试：HTML 报告器断言可视化集成（DEBT-05，Phase 34）
// 验证 assertion-visualizer 三协议（diff_view / assertion_heatmap）已接入 buildReport
// 的「4.4 断言可视化」小节：失败断言输出节点级 Diff 视图，套件输出热力图与 Flakiness Index。
import { describe, it, expect } from 'vitest';
import { buildReport } from '../../src/reports/html-reporter.js';
import type { ReportData, CheckResult } from '../../src/core/types.js';

function baseReport(checks: CheckResult[]): ReportData {
  return {
    title: '可视化集成测试报告',
    env: 'test',
    submit: { status: 'PASS', taskId: 1 },
    taskDef: { name: 'wan3 视频生成', scene: 'video', project_id: 1 },
    checks,
    billingData: {},
    impact: [],
    responses: [],
    manual: [],
    issues: [],
    passRate: 100,
    assetInfo: { exists: false, resolved: [] },
  } as unknown as ReportData;
}

describe('HTML 报告器断言可视化（4.4）', () => {
  it('失败断言输出 Diff 视图（节点级差异：路径/变更/期望/实际/说明）', () => {
    const checks: CheckResult[] = [
      {
        name: '响应 JSON 字段核对',
        pass: false,
        detail: '响应中不包含目标字段',
        assertionType: 'response',
        path: 'data.result',
        operator: 'deepEquals',
        expected: { code: 0, data: { status: 'ready' } },
        actual: { code: 0, data: { status: 'pending' } },
        durationMs: 12,
      },
      {
        name: 'HTTP 状态码',
        pass: true,
        detail: '200 OK',
        assertionType: 'response',
        path: 'status',
        operator: 'equals',
        expected: 200,
        actual: 200,
        durationMs: 3,
      },
    ];
    const html = buildReport(baseReport(checks));
    expect(html).toContain('4.4 断言可视化');
    expect(html).toContain('响应 JSON 字段核对');
    expect(html).toContain('Flakiness Index');
    // 失败断言 diff：期望/实际是对象时走 JSON 深比较节点级差异
    expect(html).toContain('deepEquals');
    expect(html).toContain('期望值');
  });

  it('全通过时：无失败差异视图，但仍输出热力图（权重 0 / 失败率 0.0%）', () => {
    const checks: CheckResult[] = [
      {
        name: 'HTTP 状态码',
        pass: true,
        detail: '200 OK',
        assertionType: 'response',
        path: 'status',
        operator: 'equals',
        expected: 200,
        actual: 200,
        durationMs: 3,
      },
    ];
    const html = buildReport(baseReport(checks));
    expect(html).toContain('4.4 断言可视化');
    expect(html).toContain('全部断言通过，无失败差异视图');
    expect(html).toContain('HTTP 状态码');
    expect(html).toContain('0.0%');
  });

  it('无声明式断言时：无差异视图且无可视化数据', () => {
    const html = buildReport(baseReport([]));
    expect(html).toContain('4.4 断言可视化');
    expect(html).toContain('全部断言通过，无失败差异视图');
    expect(html).toContain('无可视化数据');
  });

  it('期望/实际值 HTML 特殊字符被转义（防注入）', () => {
    const checks: CheckResult[] = [
      {
        name: 'HTML 转义',
        pass: false,
        detail: 'detail <b>xx</b>',
        assertionType: 'custom',
        path: 'a.b',
        operator: 'equals',
        expected: '<script>alert(1)</script>',
        actual: 'plain',
        durationMs: 1,
      },
    ];
    const html = buildReport(baseReport(checks));
    // 原始注入片段不得出现
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('detail &lt;b&gt;xx&lt;/b&gt;');
  });
});
