// Test Selection Analyzer：确定性测试选择（规则优先，AI 只在解释层介入）
// 原则（任务书第 21 节：Deterministic First）：选择规则完全确定，LLM 只补充理由。
// 策略：
// - P0 全量执行（冒烟必测）
// - P1 全量执行（业务核心）
// - P2/P3 按「参数覆盖 + 风险命中」抽样（保证每个 requirement 输入取值至少被一个已选用例覆盖）
// - 历史高失败 Case 提升优先级（提优 + 理由）
// - 历史 flaky Case 保留但标记（enableRetry 由 Execution 处理）
// - 预算 maxCases 超限时从最低优先级非风险用例裁剪
import { Requirement } from '../requirement/requirement-schema.js';
import { TestCase, TestPriority } from '../test-design/testcase-schema.js';
import { RiskAssessment } from '../risk/risk-schema.js';
import { buildSelection, TestSelection, SelectionStatistics } from './selection-schema.js';

/** 历史执行上下文（供选择决策） */
export interface SelectionHistory {
  /** 历史失败用例 ID */
  failedCaseIds?: string[];
  /** 历史 flaky 用例 ID */
  flakyCaseIds?: string[];
  /** 上次执行整体结果 */
  lastRunResult?: 'pass' | 'fail' | 'partial';
}

/** 选择输入 */
export interface TestSelectionInput {
  requirement: Requirement;
  testCases: TestCase[];
  riskAssessment?: RiskAssessment;
  history?: SelectionHistory;
  options?: {
    /** 预算：最大用例数（超出则裁剪） */
    maxCases?: number;
    /** 预算：最大并发 */
    maxConcurrency?: number;
    /** 是否纳入 flaky 用例（默认 true，执行层负责重试） */
    includeFlaky?: boolean;
  };
}

/** 从风险项收集受影响用例（含整体高风险维度 → 相关 tags 用例） */
function collectRiskAffected(input: TestSelectionInput, cases: TestCase[]): Set<string> {
  const affected = new Set<string>();
  const risk = input.riskAssessment;
  if (!risk) return affected;

  for (const item of risk.risks) {
    for (const cid of item.affectedCases ?? []) {
      affected.add(cid);
    }
    // 高风险维度：匹配用例 tags 中对应风险标签
    if (item.level === 'high' || item.level === 'medium') {
      for (const c of cases) {
        if (c.tags.some((t) => t.toLowerCase() === item.category.toLowerCase() || t.includes(item.category))) {
          affected.add(c.id);
        }
      }
    }
  }
  return affected;
}

/** 覆盖值归一化：统一单位与大小写（5s/5秒/5 → 5；720P/720p → 720p） */
function normalizeCoverageValue(v: unknown): string {
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^([\d.]+)(s|秒|sec|seconds|ms|分钟|min)?$/);
  if (m) return m[1];
  return s.replace(/[_\-\s]+/g, '');
}

/** 收集已选用例已覆盖的输入取值集合（用于 P2/P3 参数覆盖抽样） */
function collectCoveredValues(cases: TestCase[], selectedIds: Set<string>): Set<string> {
  const covered = new Set<string>();
  for (const c of cases) {
    if (!selectedIds.has(c.id)) continue;
    for (const step of c.steps) {
      for (const v of Object.values(step.input ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          covered.add(normalizeCoverageValue(v));
        }
      }
    }
    for (const v of Object.values(c.data ?? {})) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        covered.add(normalizeCoverageValue(v));
      }
    }
  }
  return covered;
}

/** 确定性测试选择主入口 */
export function selectTestCases(input: TestSelectionInput): TestSelection {
  const cases = input.testCases ?? [];
  const requirement = input.requirement;
  const history = input.history ?? {};
  const options = input.options ?? {};
  const maxCases = options.maxCases;
  const includeFlaky = options.includeFlaky ?? true;

  const riskAffected = collectRiskAffected(input, cases);
  const failedIds = new Set(history.failedCaseIds ?? []);
  const flakyIds = new Set(history.flakyCaseIds ?? []);

  const reasons: Record<string, string> = {};
  const selected = new Set<string>();
  const skipped: string[] = [];
  const priorityBuckets: Record<string, string[]> = { P0: [], P1: [], P2: [], P3: [] };

  const pOrder: TestPriority[] = ['P0', 'P1', 'P2', 'P3'];
  for (const c of cases) {
    const isRisk = riskAffected.has(c.id);
    const isFailed = failedIds.has(c.id);
    const isFlaky = flakyIds.has(c.id) && !isFailed;

    if (c.priority === 'P0' || c.priority === 'P1') {
      // 核心用例全量
      selected.add(c.id);
      priorityBuckets[c.priority].push(c.id);
      reasons[c.id] = isFailed
        ? 'P0/P1 核心用例必测，且历史失败需优先回归'
        : isRisk
          ? 'P0/P1 核心用例，且命中风险维度'
          : 'P0/P1 核心用例必测';
    } else {
      // P2/P3：风险命中 或 flaky(历史已暴露) 直接选；其余进入抽样候选
      if (isRisk || isFailed || (isFlaky && includeFlaky)) {
        selected.add(c.id);
        priorityBuckets[c.priority].push(c.id);
        reasons[c.id] = isFailed
          ? '历史失败，需回归验证'
          : isRisk
            ? '命中风险维度，提高执行优先级'
            : '历史 flaky，纳入并开启重试';
      }
      // 其余 P2/P3 暂不选，进入参数覆盖抽样补选
    }
  }

  // P2/P3 参数覆盖抽样：保证 requirement 每个输入取值至少被覆盖一次
  let covered = collectCoveredValues(cases, selected);
  const p2p3Candidates = cases.filter((c) => (c.priority === 'P2' || c.priority === 'P3') && !selected.has(c.id));
  const requiredValues = new Set<string>();
  for (const item of requirement.requirements ?? []) {
    for (const v of item.values ?? []) requiredValues.add(normalizeCoverageValue(v));
  }
  for (const v of requiredValues) {
    if (covered.has(v)) continue;
    const candidate = p2p3Candidates.find((c) => {
      const vals = c.steps.flatMap((s) => Object.values(s.input ?? {})).map(normalizeCoverageValue);
      return vals.includes(v) && (maxCases === undefined || selected.size < maxCases);
    });
    if (candidate && !selected.has(candidate.id)) {
      selected.add(candidate.id);
      priorityBuckets[candidate.priority].push(candidate.id);
      reasons[candidate.id] = `参数覆盖：补充覆盖输入取值 "${v}"`;
      covered = collectCoveredValues(cases, selected);
    }
  }

  // 历史失败提优：把 failed 用例挪到对应优先级桶最前
  let historyBoosted = 0;
  for (const bucket of pOrder) {
    const boosted = priorityBuckets[bucket].filter((id) => failedIds.has(id));
    const rest = priorityBuckets[bucket].filter((id) => !failedIds.has(id));
    if (boosted.length) {
      priorityBuckets[bucket] = [...boosted, ...rest];
      historyBoosted += boosted.length;
    }
  }

  // 预算裁剪：超出 maxCases 时，从 P3 → P2 反向裁剪（跳过风险命中的优先保）
  let budgetTrimmed = 0;
  if (maxCases !== undefined && selected.size > maxCases) {
    for (const bucket of ['P3', 'P2'] as const) {
      const keep: string[] = [];
      for (const id of priorityBuckets[bucket]) {
        if (selected.size <= maxCases) break;
        if (riskAffected.has(id) || failedIds.has(id)) {
          keep.push(id);
        } else {
          selected.delete(id);
          skipped.push(id);
          reasons[id] = `${reasons[id] ?? ''}；超出预算 ${maxCases}，裁剪`.trim();
          budgetTrimmed++;
        }
      }
      priorityBuckets[bucket] = keep;
    }
  }

  // 汇总 skipped（未选中的用例）
  for (const c of cases) {
    if (!selected.has(c.id)) {
      skipped.push(c.id);
      if (!reasons[c.id]) reasons[c.id] = '低优先级 P2/P3，未命中风险与参数缺口，按抽样策略跳过';
    }
  }

  const priorityOrder = [...priorityBuckets.P0, ...priorityBuckets.P1, ...priorityBuckets.P2, ...priorityBuckets.P3];
  const selectedCases = priorityOrder.filter((id) => selected.has(id));
  const stats: SelectionStatistics = {
    total: cases.length,
    selected: selectedCases.length,
    skipped: skipped.length,
    riskAffected: cases.filter((c) => selected.has(c.id) && riskAffected.has(c.id)).length,
    historyBoosted,
    flakyMarked: cases.filter((c) => selected.has(c.id) && flakyIds.has(c.id)).length,
    budgetTrimmed,
  };

  return buildSelection({
    feature: requirement.feature,
    selectedCases,
    skippedCases: [...new Set(skipped)],
    priorityOrder,
    reasons,
    statistics: stats,
    budget: options.maxCases !== undefined || options.maxConcurrency !== undefined
      ? { maxCases: options.maxCases, maxConcurrency: options.maxConcurrency }
      : undefined,
    confidence: 0.95,
  });
}
