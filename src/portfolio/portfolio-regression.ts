// Portfolio → Regression 接入层（Phase 23.2）
// 把「变更影响 + Test Portfolio 组合策略」转换为 Regression Plan。
// 流程：Change → Impact（受影响判定）→ Portfolio 分类 → 组合策略选择 → Regression Plan。
// 确定性：受影响判定（changeTags 匹配变更关键词）+ Portfolio 分类 + 组合策略选择，全程可解释。
// 关键约束：默认不执行全量（未受影响的纯 Regression 用例不进入计划，除非 fullRegression 显式开启）。

import { generateRunId, type ChangeEvent } from '../regression/regression-schema.js';
import type { AutonomousCase } from '../autonomous/autonomous-schema.js';
import {
  DEFAULT_PORTFOLIO_POLICY,
  type PortfolioCase,
  type PortfolioCaseInput,
  type PortfolioCategory,
  type PortfolioPolicy,
} from './portfolio-schema.js';
import { buildPortfolio } from './portfolio-engine.js';

/** Regression Plan 输入 */
export interface RegressionPlanInput {
  /** 变更事件（受影响判定依据） */
  change: ChangeEvent;
  /** 全部候选用例（如 100 个 TestCase） */
  cases: PortfolioCaseInput[];
  /** Portfolio 策略（缺省用默认值） */
  policy?: Partial<PortfolioPolicy>;
  /** 是否显式要求 Full Regression（默认 false → 只执行受影响 + Portfolio 兜底） */
  fullRegression?: boolean;
  /** 自定义 runId（缺省自动生成） */
  runId?: string;
}

/** Portfolio → Regression 计划输出 */
export interface PortfolioRegressionPlan {
  runId: string;
  change: ChangeEvent;
  policy: PortfolioPolicy;
  /** 是否全量回归 */
  fullRegression: boolean;
  totalCases: number;
  /** 受影响用例（变更影响命中） */
  affectedCaseIds: string[];
  affectedCount: number;
  /** 全部用例的 Portfolio 分类 */
  portfolio: PortfolioCase[];
  /** 分类统计 */
  categoryStats: Record<PortfolioCategory, number>;
  /** 最终 Regression Plan（用例 id） */
  selectedCaseIds: string[];
  /** 选中用例详情 */
  selected: PortfolioCase[];
  /** 未选中用例 + 原因 */
  skipped: Array<{ caseId: string; reason: string }>;
  /** 执行比例（≤ 1，证明未执行全量） */
  executionRate: number;
  /** 决策证据（为什么选这些 / 为什么没选其他） */
  evidence: string[];
  createdAt: string;
}

/** 提取变更关键词（target 分段 + from/to） */
function changeKeywords(change: ChangeEvent): string[] {
  const parts = change.target
    .split(/[/:@\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const kw = new Set(parts);
  if (change.from) kw.add(change.from.toLowerCase());
  if (change.to) kw.add(change.to.toLowerCase());
  return [...kw];
}

/** 用例是否受变更影响：changeTags 命中变更关键词或变更类型 */
function isAffected(c: PortfolioCaseInput, kws: string[], type: string): boolean {
  const tags = (c.changeTags ?? []).map((t) => t.toLowerCase());
  if (tags.length === 0) return false;
  return tags.some((t) => t === type.toLowerCase() || kws.some((k) => k === t || k.includes(t) || t.includes(k)));
}

/** 类别 → 自治用例优先级映射（接入 Autonomous Regression 用） */
export const CATEGORY_TO_PRIORITY: Record<PortfolioCategory, AutonomousCase['priority']> = {
  Core: 'P0',
  Risk: 'P1',
  Change: 'P1',
  Historical: 'P2',
  Exploration: 'P3',
  Regression: 'P3',
  Flaky: 'P2',
};

/**
 * 构建 Regression Plan（Portfolio 接入 Regression Controller）。
 * 选择逻辑（确定性、可解释）：
 * 1) 受影响用例：全部进入计划（变更影响，任何类别都优先）。
 * 2) 未受影响用例：按 Portfolio 策略兜底补充 —— Core(P0) / Risk / Historical Top N / Exploration 预算 / Flaky（可选）。
 *    Change / Regression 类未受影响默认不选 → 避免全量回归。
 * 3) fullRegression=true 时全部进入（策略显式要求全量）。
 */
export function buildRegressionPlan(input: RegressionPlanInput): PortfolioRegressionPlan {
  const policy: PortfolioPolicy = { ...DEFAULT_PORTFOLIO_POLICY, ...(input.policy ?? {}) };
  const fullRegression = input.fullRegression ?? false;
  const kws = changeKeywords(input.change);
  const evidence: string[] = [];

  // 1) 受影响判定
  const affectedCaseIds = input.cases
    .filter((c) => isAffected(c, kws, input.change.type))
    .map((c) => c.caseId)
    .sort();
  const affectedSet = new Set(affectedCaseIds);
  if (affectedCaseIds.length) {
    evidence.push(
      `变更 ${input.change.type}:${input.change.target} → 受影响用例 ${affectedCaseIds.length}/${input.cases.length} 个（关键词：${kws.join('、')}）`,
    );
  } else {
    evidence.push(`变更 ${input.change.type}:${input.change.target} → 未命中任何用例标签，需依赖 Portfolio 兜底或全量策略`);
  }

  // 2) Portfolio 分类
  const portfolio = buildPortfolio(input.cases);
  const byCat = new Map<PortfolioCategory, PortfolioCase[]>();
  for (const p of portfolio) {
    const list = byCat.get(p.category) ?? [];
    list.push(p);
    byCat.set(p.category, list);
  }
  const categoryStats = Object.fromEntries(
    (['Core', 'Risk', 'Change', 'Historical', 'Exploration', 'Regression', 'Flaky'] as PortfolioCategory[]).map(
      (c) => [c, byCat.get(c)?.length ?? 0],
    ),
  ) as Record<PortfolioCategory, number>;

  // 3) 选择
  const selected = new Map<string, PortfolioCase>();
  const skippedSet = new Set<string>();
  const skipped: Array<{ caseId: string; reason: string }> = [];
  const add = (p: PortfolioCase): void => {
    if (!selected.has(p.caseId)) selected.set(p.caseId, p);
  };
  const skip = (caseId: string, reason: string): void => {
    if (!skippedSet.has(caseId)) {
      skippedSet.add(caseId);
      skipped.push({ caseId, reason });
    }
  };

  if (fullRegression) {
    for (const p of portfolio) add(p);
    evidence.push('fullRegression=true：策略显式要求 Full Regression，全部用例进入计划');
  } else {
    // 受影响用例：全部进入
    for (const id of affectedCaseIds) {
      const p = portfolio.find((x) => x.caseId === id);
      if (p) add(p);
    }

    // 未受影响用例：Portfolio 兜底
    const notAffected = (cat: PortfolioCategory): PortfolioCase[] =>
      (byCat.get(cat) ?? []).filter((p) => !selected.has(p.caseId));

    // Core(P0)：coreRate（默认 100%）
    const core = notAffected('Core').slice(0, Math.round(notAffected('Core').length * policy.coreRate));
    for (const p of core) add(p);

    // Risk：riskRate（默认 100%）
    const risk = notAffected('Risk').slice(0, Math.round(notAffected('Risk').length * policy.riskRate));
    for (const p of risk) add(p);

    // Historical Top N
    const historical = notAffected('Historical').slice(0, policy.historicalTopN);
    for (const p of historical) add(p);

    // Exploration 预算 %（有探索候选且预算率 > 0 时至少 1 个，保证探索能力不因取整归零）
    const exploreCandidates = notAffected('Exploration');
    const exploreBudget =
      exploreCandidates.length > 0 && policy.explorationBudgetRate > 0
        ? Math.max(1, Math.min(exploreCandidates.length, Math.round(exploreCandidates.length * policy.explorationBudgetRate)))
        : 0;
    const exploration = exploreCandidates.slice(0, exploreBudget);
    for (const p of exploration) add(p);

    // Flaky：excludeQuarantinedFlaky=true → 隔离排除；false → 一并纳入
    const flaky = notAffected('Flaky');
    if (policy.excludeQuarantinedFlaky) {
      for (const p of flaky) skip(p.caseId, '隔离的不稳定用例（Flaky），已排除出主回归');
    } else {
      for (const p of flaky) add(p);
    }

    // Change / Regression 未受影响：默认不选（避免全量回归）
    for (const p of [...notAffected('Change'), ...notAffected('Regression')]) {
      skip(p.caseId, '未受影响且不在组合兜底范围（避免全量回归）');
    }

    const affectedCount = affectedCaseIds.length;
    if (affectedCount) evidence.push(`受影响用例 ${affectedCount} 个全部进入计划`);
    const bonus = selected.size - affectedCount;
    if (bonus > 0) evidence.push(`Portfolio 兜底补充 ${bonus} 个（Core/Risk/Historical/Exploration/Flaky）`);
  }

  // 其余未选中：给原因
  for (const p of portfolio) {
    if (!selected.has(p.caseId)) {
      const catList = byCat.get(p.category) ?? [];
      const idx = catList.findIndex((c) => c.caseId === p.caseId);
      const reason =
        p.category === 'Historical'
          ? 'Historical 超出 Top N（历史问题按前 N 选择）'
          : p.category === 'Exploration'
            ? 'Exploration 超出探索预算比例'
            : p.category === 'Flaky'
              ? '隔离的不稳定用例（Flaky）'
              : '未受影响且不在组合兜底范围（避免全量回归）';
      skip(p.caseId, `${reason}（第 ${idx + 1} 个，共 ${catList.length} 个）`);
    }
  }

  const selectedCaseIds = [...selected.values()].sort((a, b) => a.caseId.localeCompare(b.caseId)).map((p) => p.caseId);
  const executionRate = input.cases.length ? selectedCaseIds.length / input.cases.length : 0;

  return {
    runId: input.runId ?? generateRunId(),
    change: input.change,
    policy,
    fullRegression,
    totalCases: input.cases.length,
    affectedCaseIds,
    affectedCount: affectedCaseIds.length,
    portfolio,
    categoryStats,
    selectedCaseIds,
    selected: [...selected.values()].sort((a, b) => a.caseId.localeCompare(b.caseId)),
    skipped,
    executionRate,
    evidence,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 把 Regression Plan 的选中用例映射为自治回归用例（接入 Autonomous Regression Controller）。
 * 类别 → 优先级映射：Core→P0、Risk/Change→P1、Historical/Flaky→P2、Exploration/Regression→P3。
 */
export function portfolioToAutonomousCases(
  plan: PortfolioRegressionPlan,
  inputs: PortfolioCaseInput[],
): AutonomousCase[] {
  const byId = new Map(inputs.map((i) => [i.caseId, i]));
  return plan.selectedCaseIds.map((id) => {
    const pc = plan.selected.find((p) => p.caseId === id)!;
    const src = byId.get(id);
    return {
      caseId: id,
      priority: CATEGORY_TO_PRIORITY[pc.category],
      changeTags: src?.changeTags,
      riskScore: src?.riskScore,
      modelRisk: (src?.changeTags ?? []).some((t) => t.toLowerCase().includes('model')) ? 0.6 : undefined,
      historicalSamples: undefined,
      executedOnCurrentVersion: undefined,
    };
  });
}
