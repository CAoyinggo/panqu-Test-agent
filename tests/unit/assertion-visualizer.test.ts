import { describe, it, expect } from 'vitest';
import {
  buildDiffView,
  buildHistoryTrend,
  buildAssertionHeatmap,
  computeWeight,
  classifyDataType,
  deepDiffValues,
  visualizeAssertion,
  type DiffDetail,
  type HistoryRun,
  type SuiteAssertionNode,
} from '../../src/utils/assertion-visualizer.js';

// ════════════════════════════════════════════════════════════
// 协议 1：Diff View
// ════════════════════════════════════════════════════════════

describe('buildDiffView - JSON/Object', () => {
  it('detects MODIFIED nested field', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.user',
      expected: { id: 1, role: 'admin', name: 'Alice' },
      actual: { id: 1, role: 'guest', name: 'Alice' },
    });
    expect(view.data_type).toBe('JSON');
    expect(view.diff_details).toHaveLength(1);
    expect(view.diff_details[0].path).toBe('json.data.user.role');
    expect(view.diff_details[0].change_type).toBe('MODIFIED');
    expect(view.diff_details[0].expected).toBe('admin');
    expect(view.diff_details[0].actual).toBe('guest');
  });

  it('detects ADDED and REMOVED fields', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data',
      expected: { a: 1, b: 2 },
      actual: { a: 1, c: 3 },
    });
    const types = view.diff_details.map((d) => d.change_type).sort();
    expect(types).toEqual(['ADDED', 'REMOVED']);
    expect(view.diff_details.find((d) => d.change_type === 'ADDED')?.path).toBe('json.data.c');
    expect(view.diff_details.find((d) => d.change_type === 'REMOVED')?.path).toBe('json.data.b');
  });

  it('handles array index differences', () => {
    const view = buildDiffView({
      operator: 'deepEquals',
      path: 'json.data',
      expected: { items: [1, 2, 3] },
      actual: { items: [1, 2, 4, 5] },
    });
    const paths = view.diff_details.map((d) => d.path);
    expect(paths).toContain('json.data.items[2]'); // MODIFIED 3→4
    expect(paths).toContain('json.data.items[3]'); // ADDED 5
  });

  it('reports UNCHANGED-equivalent empty diff for equal objects', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data',
      expected: { a: 1 },
      actual: { a: 1 },
    });
    expect(view.diff_details).toHaveLength(0);
    expect(view.summary).toContain('无字段级差异');
  });

  it('builds JSON path with array index in base path', () => {
    const details: DiffDetail[] = [];
    deepDiffValues(
      { user: { profile: { age: 30 } } },
      { user: { profile: { age: 31 } } },
      'body.data[0]',
      details,
    );
    expect(details[0].path).toBe('body.data[0].user.profile.age');
    expect(details[0].change_type).toBe('MODIFIED');
  });

  it('classifies plain objects as JSON', () => {
    expect(classifyDataType({ a: 1 }, { a: 2 })).toBe('JSON');
    expect(classifyDataType([1], [2])).toBe('JSON');
  });
});

describe('buildDiffView - TEXT', () => {
  it('reports character-level offset for string difference', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.text',
      expected: 'hello world',
      actual: 'hello there',
    });
    expect(view.data_type).toBe('TEXT');
    const d = view.diff_details[0];
    expect(d.path).toBe('json.data.text');
    expect(d.change_type).toBe('MODIFIED');
    expect(d.hint).toContain('偏移');
    expect(view.summary).toContain('首个差异偏移 6');
  });

  it('reports prefix difference', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.text',
      expected: 'apple',
      actual: 'banana',
    });
    expect(view.summary).toContain('首个差异偏移 0');
  });

  it('handles empty vs non-empty string', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.text',
      expected: 'content',
      actual: '',
    });
    expect(view.data_type).toBe('TEXT');
    expect(view.diff_details[0].hint).toContain('实际为空');
  });

  it('classifies strings as TEXT', () => {
    expect(classifyDataType('a', 'b')).toBe('TEXT');
  });
});

describe('buildDiffView - NUMERIC', () => {
  it('computes absolute and relative diff', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.status',
      expected: 200,
      actual: 500,
    });
    expect(view.data_type).toBe('NUMERIC');
    const d = view.diff_details[0];
    expect(d.absoluteDiff).toBe(300);
    expect(d.relativeDiff).toBe(1.5); // 300 / 200
    expect(view.summary).toContain('绝对偏差 300');
    expect(view.summary).toContain('相对偏差 150.00%');
  });

  it('handles zero expected (relative diff undefined safe)', () => {
    const view = buildDiffView({
      operator: 'gt',
      path: 'json.data.count',
      expected: 0,
      actual: 5,
    });
    expect(view.diff_details[0].relativeDiff).toBe(0);
  });

  it('classifies numbers as NUMERIC', () => {
    expect(classifyDataType(1, 2)).toBe('NUMERIC');
  });
});

describe('buildDiffView - BOOLEAN', () => {
  it('produces boolean diff', () => {
    const view = buildDiffView({
      operator: 'equals',
      path: 'json.data.enabled',
      expected: true,
      actual: false,
    });
    expect(view.data_type).toBe('BOOLEAN');
    expect(view.summary).toContain('布尔值不一致');
    expect(view.diff_details[0].expected).toBe(true);
    expect(view.diff_details[0].actual).toBe(false);
  });
});

describe('buildDiffView - SCHEMA', () => {
  it('parses ajv error message into structured details', () => {
    const view = buildDiffView({
      operator: 'jsonSchema',
      path: 'json.data',
      expected: { type: 'object' },
      actual: { text: 123 },
      message: 'JSON Schema validation failed: /text: must be string; /tokens: must be >= 0',
    });
    expect(view.data_type).toBe('SCHEMA');
    expect(view.diff_details.length).toBe(2);
    expect(view.diff_details[0].path).toBe('/text');
    expect(view.diff_details[0].actual).toBe('must be string');
    expect(view.diff_details[1].path).toBe('/tokens');
    expect(view.diff_details[1].actual).toBe('must be >= 0');
  });

  it('falls back to single MODIFIED detail without message', () => {
    const view = buildDiffView({
      operator: 'jsonSchema',
      path: 'json.data',
      expected: { type: 'string' },
      actual: 123,
    });
    expect(view.data_type).toBe('SCHEMA');
    expect(view.diff_details).toHaveLength(1);
    expect(view.diff_details[0].change_type).toBe('MODIFIED');
  });
});

// ════════════════════════════════════════════════════════════
// 协议 2：History Trend
// ════════════════════════════════════════════════════════════

describe('buildHistoryTrend', () => {
  const history: HistoryRun[] = [
    { runId: 'build-101', timestamp: '2026-08-01T08:00:00Z', status: 'PASSED', durationMs: 100, concurrency: 5, failedAssertions: 0 },
    { runId: 'build-102', timestamp: '2026-08-05T08:00:00Z', status: 'FAILED', durationMs: 200, concurrency: 5, failedAssertions: 2 },
    { runId: 'build-103', timestamp: '2026-08-10T14:20:00Z', status: 'PASSED', durationMs: 150, concurrency: 4, failedAssertions: 0 },
    { runId: 'build-104', timestamp: '2026-08-14T08:00:00Z', status: 'FAILED', durationMs: 250, concurrency: 4, failedAssertions: 1 },
    { runId: 'build-105', timestamp: '2026-08-17T08:00:00Z', status: 'SKIPPED', durationMs: 0, concurrency: 5, failedAssertions: 0 },
  ];

  it('computes pass rate over total runs', () => {
    const trend = buildHistoryTrend(history);
    expect(trend.metrics.pass_rate).toBe(0.4); // 2/5
  });

  it('computes average duration', () => {
    const trend = buildHistoryTrend(history);
    // (100+200+150+250+0)/5 = 140
    expect(trend.metrics.avg_duration_ms).toBe(140);
  });

  it('marks first failure baseline', () => {
    const trend = buildHistoryTrend(history);
    expect(trend.metrics.first_failed_at).toBe('2026-08-05T08:00:00Z');
  });

  it('generates timeline with run ids, status, concurrency and failure counts', () => {
    const trend = buildHistoryTrend(history);
    expect(trend.timeline).toHaveLength(5);
    expect(trend.timeline[0].run_id).toBe('build-101');
    expect(trend.timeline[0].status).toBe('PASSED');
    expect(trend.timeline[0].concurrency).toBe(5);
    expect(trend.timeline[1].failed_assertion_count).toBe(2);
    expect(trend.timeline[4].status).toBe('SKIPPED');
  });

  it('falls back to generated run ids when runId missing', () => {
    const trend = buildHistoryTrend([
      { timestamp: '2026-08-01T00:00:00Z', status: 'PASSED', durationMs: 10 },
    ]);
    expect(trend.timeline[0].run_id).toBe('run-001');
  });

  it('handles empty history gracefully', () => {
    const trend = buildHistoryTrend([]);
    expect(trend.metrics.pass_rate).toBe(0);
    expect(trend.metrics.avg_duration_ms).toBe(0);
    expect(trend.metrics.first_failed_at).toBeNull();
    expect(trend.timeline).toHaveLength(0);
    expect(trend.time_range).toContain('0 次');
  });

  it('uses custom time range label', () => {
    const trend = buildHistoryTrend(history, '最近 30 天');
    expect(trend.time_range).toBe('最近 30 天');
  });
});

// ════════════════════════════════════════════════════════════
// 协议 3：Assertion Heatmap
// ════════════════════════════════════════════════════════════

describe('computeWeight', () => {
  it('returns 0 for zero failure rate (green)', () => {
    expect(computeWeight(0)).toBe(0);
    expect(computeWeight(-0.1)).toBe(0);
  });

  it('returns 1-3 for flaky range (0%, 15%]', () => {
    expect(computeWeight(0.01)).toBe(1);
    expect(computeWeight(0.05)).toBe(1);
    expect(computeWeight(0.08)).toBe(2);
    expect(computeWeight(0.10)).toBe(2);
    expect(computeWeight(0.12)).toBe(3);
    expect(computeWeight(0.15)).toBe(3);
  });

  it('returns 4-5 for persistent failure range (>15%)', () => {
    expect(computeWeight(0.16)).toBe(4);
    expect(computeWeight(0.3)).toBe(4);
    expect(computeWeight(0.5)).toBe(4);
    expect(computeWeight(0.51)).toBe(5);
    expect(computeWeight(0.8)).toBe(5);
    expect(computeWeight(1)).toBe(5);
  });
});

describe('buildAssertionHeatmap', () => {
  const matrix: SuiteAssertionNode[] = [
    { assertionId: 'AST-001', name: 'Status Code is 200', target: 'response', path: 'status', operator: 'equals', failureCount: 0, totalRuns: 30 },
    { assertionId: 'AST-002', name: 'Response Body Schema Check', target: 'response', path: 'json.data.token', operator: 'exists', failureCount: 8, totalRuns: 30 },
    { assertionId: 'AST-003', name: 'Timeout Threshold', target: 'metrics', path: 'durationMs', operator: 'lte', failureCount: 20, totalRuns: 30 },
  ];

  it('maps failure counts to correct weights', () => {
    const heatmap = buildAssertionHeatmap('user-service', matrix);
    expect(heatmap.module_name).toBe('user-service');
    expect(heatmap.matrix[0].weight).toBe(0); // 0/30
    expect(heatmap.matrix[1].weight).toBe(4); // 8/30 ≈ 0.267 > 15%
    expect(heatmap.matrix[2].weight).toBe(5); // 20/30 ≈ 0.667 > 50%
  });

  it('computes failure_rate per cell', () => {
    const heatmap = buildAssertionHeatmap('user-service', matrix);
    expect(heatmap.matrix[1].failure_rate).toBe(0.27); // 8/30 rounded
    expect(heatmap.matrix[1].failure_count).toBe(8);
    expect(heatmap.matrix[1].total_runs).toBe(30);
  });

  it('computes flakiness index as average failure rate', () => {
    const heatmap = buildAssertionHeatmap('user-service', matrix);
    // (0 + 0.2667 + 0.6667) / 3 ≈ 0.31
    expect(heatmap.flakiness_index).toBeGreaterThan(0.3);
    expect(heatmap.flakiness_index).toBeLessThan(0.32);
  });

  it('keeps target/path/operator metadata in cells', () => {
    const heatmap = buildAssertionHeatmap('user-service', matrix);
    expect(heatmap.matrix[0].target).toBe('response');
    expect(heatmap.matrix[0].path).toBe('status');
    expect(heatmap.matrix[0].operator).toBe('equals');
  });

  it('generates default assertion ids and names when missing', () => {
    const heatmap = buildAssertionHeatmap('mod', [
      { failureCount: 1, totalRuns: 10 },
    ]);
    expect(heatmap.matrix[0].assertion_id).toBe('AST-001');
    expect(heatmap.matrix[0].assertion_name).toBe('AST-001');
  });

  it('derives assertion name from target.path', () => {
    const heatmap = buildAssertionHeatmap('mod', [
      { target: 'response', path: 'status', operator: 'equals', failureCount: 0, totalRuns: 5 },
    ]);
    expect(heatmap.matrix[0].assertion_name).toBe('response.status');
  });

  it('returns zero flakiness for empty matrix', () => {
    const heatmap = buildAssertionHeatmap('empty-module', []);
    expect(heatmap.flakiness_index).toBe(0);
    expect(heatmap.matrix).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// 主入口：visualizeAssertion
// ════════════════════════════════════════════════════════════

describe('visualizeAssertion', () => {
  it('produces complete Output Schema', () => {
    const output = visualizeAssertion({
      module_name: 'user-service',
      assertion_failure: {
        operator: 'equals',
        path: 'json.data.status',
        expected: 200,
        actual: 500,
      },
      history_metrics: [
        { runId: 'run-1', timestamp: '2026-08-17T08:00:00Z', status: 'FAILED', durationMs: 120, concurrency: 5, failedAssertions: 1 },
        { runId: 'run-2', timestamp: '2026-08-17T09:00:00Z', status: 'PASSED', durationMs: 90, concurrency: 5, failedAssertions: 0 },
      ],
      suite_assertion_matrix: [
        { assertionId: 'AST-001', name: 'Status Code', target: 'response', path: 'status', operator: 'equals', failureCount: 0, totalRuns: 30 },
        { assertionId: 'AST-002', name: 'Token Exists', target: 'response', path: 'json.data.token', operator: 'exists', failureCount: 8, totalRuns: 30 },
      ],
    });

    // diff_view
    expect(output.diff_view.data_type).toBe('NUMERIC');
    expect(output.diff_view.summary).toContain('json.data.status');
    expect(output.diff_view.diff_details[0].absoluteDiff).toBe(300);

    // history_trend
    expect(output.history_trend.metrics.pass_rate).toBe(0.5);
    expect(output.history_trend.metrics.avg_duration_ms).toBe(105);
    expect(output.history_trend.metrics.first_failed_at).toBe('2026-08-17T08:00:00Z');
    expect(output.history_trend.timeline).toHaveLength(2);

    // assertion_heatmap
    expect(output.assertion_heatmap.module_name).toBe('user-service');
    expect(output.assertion_heatmap.matrix).toHaveLength(2);
    expect(output.assertion_heatmap.matrix[0].weight).toBe(0);
    expect(output.assertion_heatmap.matrix[1].weight).toBe(4);
    expect(output.assertion_heatmap.flakiness_index).toBeGreaterThan(0);
  });

  it('uses default module name when omitted', () => {
    const output = visualizeAssertion({
      assertion_failure: { operator: 'equals', expected: 1, actual: 2 },
      history_metrics: [],
      suite_assertion_matrix: [],
    });
    expect(output.assertion_heatmap.module_name).toBe('default-module');
  });

  it('output is JSON-serializable', () => {
    const output = visualizeAssertion({
      module_name: 'mod',
      assertion_failure: { operator: 'contains', path: 'json.data.text', expected: '完成', actual: '处理中' },
      history_metrics: [{ timestamp: '2026-08-01T00:00:00Z', status: 'PASSED', durationMs: 10 }],
      suite_assertion_matrix: [{ failureCount: 0, totalRuns: 10 }],
    });
    expect(() => JSON.stringify(output)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed).toHaveProperty('diff_view');
    expect(parsed).toHaveProperty('history_trend');
    expect(parsed).toHaveProperty('assertion_heatmap');
  });
});
