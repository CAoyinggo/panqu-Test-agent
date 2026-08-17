// 断言可视化引擎：将断言失败 / 历史 Metrics / 套件断言矩阵转化为前端可视化 JSON 数据
// 输出用于渲染：失败断言 Diff 视图、历史趋势图、断言热力图
// 纯函数实现，无外部依赖，可独立单元测试
//
// 三大协议：
//   1. Diff View：JSON/Object → 节点级 ADDED/REMOVED/MODIFIED（含 JSON Path）
//                 TEXT → 字符/行级差异 + 偏移量
//                 NUMERIC → absoluteDiff / relativeDiff
//   2. History Trend：通过率、平均耗时、首次失败基线、并发联动
//   3. Assertion Heatmap：热度权重（0 绿 / 1-3 黄橙 / 4-5 红）+ Flakiness Index

// ── 输入类型 ──

/** 当前断言失败详情（源自 CheckResult 或断言引擎输出） */
export interface AssertionFailure {
  operator: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
  message?: string;
}

/** 单次历史运行记录 */
export interface HistoryRun {
  runId?: string;
  timestamp: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  /** 该批次执行时的并发数（用于评估失败是否由高并发引起） */
  concurrency?: number;
  /** 该次运行的失败断言数 */
  failedAssertions?: number;
}

/** 套件断言矩阵节点（历史执行与失败频次统计） */
export interface SuiteAssertionNode {
  assertionId?: string;
  name?: string;
  target?: string;
  path?: string;
  operator?: string;
  failureCount: number;
  totalRuns: number;
}

/** 可视化引擎总输入 */
export interface VisualizerInput {
  assertion_failure: AssertionFailure;
  history_metrics: HistoryRun[];
  suite_assertion_matrix: SuiteAssertionNode[];
  module_name?: string;
}

// ── 输出类型 ──

export type DiffDataType = 'JSON' | 'TEXT' | 'NUMERIC' | 'BOOLEAN' | 'SCHEMA';
export type ChangeType = 'MODIFIED' | 'ADDED' | 'REMOVED' | 'UNCHANGED';

export interface DiffDetail {
  path: string;
  change_type: ChangeType;
  expected: unknown;
  actual: unknown;
  /** 数值类型：绝对偏差 |expected - actual| */
  absoluteDiff?: number;
  /** 数值类型：相对百分比偏差 |expected - actual| / |expected| */
  relativeDiff?: number;
  /** 附加说明（如文本偏移量、schema 错误） */
  hint?: string;
}

export interface DiffView {
  data_type: DiffDataType;
  summary: string;
  diff_details: DiffDetail[];
}

export interface HistoryTrend {
  time_range: string;
  metrics: {
    pass_rate: number;
    avg_duration_ms: number;
    first_failed_at: string | null;
  };
  timeline: Array<{
    run_id: string;
    timestamp: string;
    status: 'PASSED' | 'FAILED' | 'SKIPPED';
    concurrency?: number;
    failed_assertion_count: number;
  }>;
}

export interface HeatmapCell {
  assertion_id: string;
  assertion_name: string;
  target?: string;
  path?: string;
  operator?: string;
  weight: number;
  failure_count: number;
  total_runs: number;
  failure_rate: number;
}

export interface AssertionHeatmap {
  module_name: string;
  flakiness_index: number;
  matrix: HeatmapCell[];
}

export interface VisualizationOutput {
  diff_view: DiffView;
  history_trend: HistoryTrend;
  assertion_heatmap: AssertionHeatmap;
}

// ── 辅助工具 ──

function isPrimitive(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== 'object';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function truncate(v: unknown, maxLen = 80): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ════════════════════════════════════════════════════════════
// 协议 1：失败断言 Diff 视图
// ════════════════════════════════════════════════════════════

/**
 * 根据断言失败详情生成结构化 Diff 视图。
 * 依据 expected/actual 的数据类型自动选择对比策略。
 */
export function buildDiffView(failure: AssertionFailure): DiffView {
  const { operator, path, expected, actual, message } = failure;
  const basePath = path && path.length > 0 ? path : '/';

  // Schema 操作符 → 解析 ajv 错误消息
  if (operator === 'jsonSchema' || operator === 'schema' || operator === 'matches' && message?.includes('JSON Schema')) {
    return buildSchemaDiff(basePath, expected, actual, message);
  }

  const dataType = classifyDataType(expected, actual);
  switch (dataType) {
    case 'JSON':
      return buildJsonDiff(basePath, expected, actual);
    case 'TEXT':
      return buildTextDiff(basePath, expected, actual);
    case 'NUMERIC':
      return buildNumericDiff(basePath, expected, actual);
    case 'BOOLEAN':
      return buildBooleanDiff(basePath, expected, actual);
    default:
      return buildJsonDiff(basePath, expected, actual);
  }
}

/** 依据 expected/actual 类型判定 Diff 数据类型 */
export function classifyDataType(expected: unknown, actual: unknown): DiffDataType {
  if (isPlainObject(expected) || isPlainObject(actual)) return 'JSON';
  if (Array.isArray(expected) || Array.isArray(actual)) return 'JSON';
  if (typeof expected === 'number' && typeof actual === 'number') return 'NUMERIC';
  if (typeof expected === 'boolean' || typeof actual === 'boolean') return 'BOOLEAN';
  if (typeof expected === 'string' || typeof actual === 'string') return 'TEXT';
  return 'JSON';
}

/** 递归对象对比：定位节点增/删/改，导出 JSON Path */
export function deepDiffValues(
  expected: unknown,
  actual: unknown,
  basePath: string,
  out: DiffDetail[],
  depth = 0,
): void {
  if (depth > 10) {
    out.push({ path: basePath, change_type: 'MODIFIED', expected, actual });
    return;
  }

  // 两侧均为原始值
  if (isPrimitive(expected) && isPrimitive(actual)) {
    if (!deepEqual(expected, actual)) {
      out.push({ path: basePath, change_type: 'MODIFIED', expected, actual });
    }
    return;
  }

  // 数组对比
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const eArr = Array.isArray(expected) ? expected : [];
    const aArr = Array.isArray(actual) ? actual : [];
    const maxLen = Math.max(eArr.length, aArr.length);
    for (let i = 0; i < maxLen; i++) {
      const p = `${basePath}[${i}]`;
      if (i >= eArr.length) {
        out.push({ path: p, change_type: 'ADDED', expected: undefined, actual: aArr[i] });
      } else if (i >= aArr.length) {
        out.push({ path: p, change_type: 'REMOVED', expected: eArr[i], actual: undefined });
      } else {
        deepDiffValues(eArr[i], aArr[i], p, out, depth + 1);
      }
    }
    return;
  }

  // 对象对比
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const p = basePath === '/' ? key : `${basePath}.${key}`;
      if (!(key in expected)) {
        out.push({ path: p, change_type: 'ADDED', expected: undefined, actual: actual[key] });
      } else if (!(key in actual)) {
        out.push({ path: p, change_type: 'REMOVED', expected: expected[key], actual: undefined });
      } else {
        deepDiffValues(expected[key], actual[key], p, out, depth + 1);
      }
    }
    return;
  }

  // 类型不匹配
  if (!deepEqual(expected, actual)) {
    out.push({ path: basePath, change_type: 'MODIFIED', expected, actual });
  }
}

function buildJsonDiff(path: string, expected: unknown, actual: unknown): DiffView {
  const details: DiffDetail[] = [];
  deepDiffValues(expected, actual, path, details);
  const summary = details.length
    ? `${details.length} 处字段差异：${truncate(expected)} vs ${truncate(actual)}`
    : `无字段级差异（值本身不一致，可能为类型/序列化差异）：${truncate(expected)} vs ${truncate(actual)}`;
  return { data_type: 'JSON', summary, diff_details: details };
}

/** 文本对比：定位字符/行级差异与偏移量 */
export function buildTextDiff(path: string, expected: unknown, actual: unknown): DiffView {
  const e = String(expected ?? '');
  const a = String(actual ?? '');

  // 公共前缀 / 公共后缀 → 差异区域偏移
  let prefix = 0;
  const minLen = Math.min(e.length, a.length);
  while (prefix < minLen && e[prefix] === a[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < e.length - prefix &&
    suffix < a.length - prefix &&
    e[e.length - 1 - suffix] === a[a.length - 1 - suffix]
  ) {
    suffix++;
  }

  const eStart = prefix;
  const eEnd = e.length - suffix;
  const aStart = prefix;
  const aEnd = a.length - suffix;
  const changedE = e.slice(eStart, eEnd);
  const changedA = a.slice(aStart, aEnd);

  // 行级差异（将变更区域按行拆分）
  const lineDiff = lineLevelDiff(changedE, changedA);

  const hint = `字符级差异：预期偏移 [${eStart},${eEnd})，实际偏移 [${aStart},${aEnd})；${lineDiff}`;
  const details: DiffDetail[] = [
    {
      path,
      change_type: 'MODIFIED',
      expected,
      actual,
      hint,
    },
  ];

  const summary = `文本不一致：预期 ${e.length} 字符，实际 ${a.length} 字符（首个差异偏移 ${prefix}）`;
  return { data_type: 'TEXT', summary, diff_details: details };
}

/** 将文本变更区域按行展开为简明描述 */
function lineLevelDiff(e: string, a: string): string {
  const eLines = e.length ? e.split('\n') : [];
  const aLines = a.length ? a.split('\n') : [];
  const parts: string[] = [];
  if (eLines.length !== aLines.length) {
    parts.push(`行数不同（预期 ${eLines.length}，实际 ${aLines.length}）`);
  }
  if (eLines.length <= 5 && aLines.length <= 5) {
    if (e.length && a.length) {
      if (e !== a) parts.push(`预期片段: "${e.slice(0, 60)}"`);
      parts.push(`实际片段: "${a.slice(0, 60)}"`);
    } else if (e.length) {
      parts.push('实际为空');
    } else {
      parts.push('预期为空');
    }
  }
  return parts.join('；') || '片段内容不同';
}

/** 数值/边界对比：计算绝对偏差与相对偏差 */
export function buildNumericDiff(path: string, expected: unknown, actual: unknown): DiffView {
  const e = Number(expected);
  const a = Number(actual);
  const absoluteDiff = Math.abs(e - a);
  const relativeDiff = e !== 0 ? Math.abs(absoluteDiff / e) : 0;

  const details: DiffDetail[] = [
    {
      path,
      change_type: 'MODIFIED',
      expected: e,
      actual: a,
      absoluteDiff: round(absoluteDiff, 4),
      relativeDiff: round(relativeDiff, 4),
    },
  ];

  const summary = `数值不一致：path '${path}' 预期为 ${e}，实际为 ${a}（绝对偏差 ${round(absoluteDiff, 4)}，相对偏差 ${(relativeDiff * 100).toFixed(2)}%）`;
  return { data_type: 'NUMERIC', summary, diff_details: details };
}

function buildBooleanDiff(path: string, expected: unknown, actual: unknown): DiffView {
  const details: DiffDetail[] = [
    { path, change_type: 'MODIFIED', expected, actual },
  ];
  const summary = `布尔值不一致：path '${path}' 预期为 ${String(expected)}，实际为 ${String(actual)}`;
  return { data_type: 'BOOLEAN', summary, diff_details: details };
}

/** Schema 对比：解析 ajv 校验错误消息为结构化明细 */
export function buildSchemaDiff(path: string, expected: unknown, actual: unknown, message?: string): DiffView {
  const details: DiffDetail[] = [];
  const summaryBase = `JSON Schema 校验失败`;

  if (message) {
    // 期望格式：JSON Schema validation failed: /text: must be string; /tokens: must be >= 0
    const m = message.match(/validation failed:\s*(.*)/);
    if (m) {
      const parts = m[1].split('; ').filter(Boolean);
      for (const part of parts) {
        const idx = part.indexOf(':');
        if (idx > 0) {
          const p = part.slice(0, idx).trim() || '/';
          const desc = part.slice(idx + 1).trim();
          details.push({
            path: p,
            change_type: 'MODIFIED',
            expected: '(schema 要求)',
            actual: desc,
            hint: desc,
          });
        }
      }
    }
  }

  if (details.length === 0) {
    details.push({ path: path || '/', change_type: 'MODIFIED', expected, actual });
  }

  const summary = `${summaryBase}：${message || `${truncate(expected)} 与数据 ${truncate(actual)} 不匹配`}`;
  return { data_type: 'SCHEMA', summary, diff_details: details };
}

// ════════════════════════════════════════════════════════════
// 协议 2：历史趋势数据
// ════════════════════════════════════════════════════════════

/**
 * 分析历史运行记录，生成轻量化趋势图数据。
 * 计算通过率、平均耗时、首次失败基线，并附带并发联动。
 */
export function buildHistoryTrend(history: HistoryRun[], timeRange?: string): HistoryTrend {
  const total = history.length;
  const passed = history.filter((r) => r.status === 'PASSED').length;
  const passRate = total ? passed / total : 0;

  const withDuration = history.filter((r) => typeof r.durationMs === 'number');
  const avgDuration = withDuration.length
    ? withDuration.reduce((s, r) => s + r.durationMs, 0) / withDuration.length
    : 0;

  const firstFailed = history.find((r) => r.status === 'FAILED');

  const timeline = history.map((r, i) => ({
    run_id: r.runId || `run-${String(i + 1).padStart(3, '0')}`,
    timestamp: r.timestamp,
    status: r.status,
    concurrency: r.concurrency,
    failed_assertion_count: r.failedAssertions ?? (r.status === 'FAILED' ? 1 : 0),
  }));

  return {
    time_range: timeRange || `最近 ${total} 次运行`,
    metrics: {
      pass_rate: round(passRate),
      avg_duration_ms: Math.round(avgDuration),
      first_failed_at: firstFailed ? firstFailed.timestamp : null,
    },
    timeline,
  };
}

// ════════════════════════════════════════════════════════════
// 协议 3：断言热力图
// ════════════════════════════════════════════════════════════

/**
 * 热度权重计算：
 *   - 失效率 = 0%          → weight 0（绿，绝对稳定）
 *   - 0% < 失效率 ≤ 15%    → weight 1-3（黄/橙，飘忽断言）
 *   - 失效率 > 15%         → weight 4-5（红，高频阻断性断言）
 */
export function computeWeight(failureRate: number): number {
  if (failureRate <= 0) return 0;
  if (failureRate <= 0.05) return 1;
  if (failureRate <= 0.10) return 2;
  if (failureRate <= 0.15) return 3;
  if (failureRate <= 0.5) return 4;
  return 5;
}

/**
 * 将套件断言矩阵转化为热力图矩阵数据，并计算模块 Flakiness Index。
 * Flakiness Index = 全部断言节点失效率的均值（0.0 ~ 1.0）。
 */
export function buildAssertionHeatmap(moduleName: string, matrix: SuiteAssertionNode[]): AssertionHeatmap {
  const cells: HeatmapCell[] = matrix.map((node, idx) => {
    const failureRate = node.totalRuns > 0 ? node.failureCount / node.totalRuns : 0;
    const assertionId = node.assertionId || `AST-${String(idx + 1).padStart(3, '0')}`;
    const nameParts = [node.target, node.path].filter(Boolean).join('.');
    const assertionName = node.name || nameParts || assertionId;
    return {
      assertion_id: assertionId,
      assertion_name: assertionName,
      target: node.target,
      path: node.path,
      operator: node.operator,
      weight: computeWeight(failureRate),
      failure_count: node.failureCount,
      total_runs: node.totalRuns,
      failure_rate: round(failureRate),
    };
  });

  const flakiness = cells.length
    ? cells.reduce((s, c) => s + c.failure_rate, 0) / cells.length
    : 0;

  return {
    module_name: moduleName,
    flakiness_index: round(flakiness),
    matrix: cells,
  };
}

// ════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════

/**
 * 将断言失败 + 历史 Metrics + 套件断言矩阵转化为前端可视化 JSON 数据。
 * 严格遵循 Output Schema：
 *   { diff_view, history_trend, assertion_heatmap }
 */
export function visualizeAssertion(input: VisualizerInput): VisualizationOutput {
  return {
    diff_view: buildDiffView(input.assertion_failure),
    history_trend: buildHistoryTrend(input.history_metrics),
    assertion_heatmap: buildAssertionHeatmap(
      input.module_name || 'default-module',
      input.suite_assertion_matrix,
    ),
  };
}
