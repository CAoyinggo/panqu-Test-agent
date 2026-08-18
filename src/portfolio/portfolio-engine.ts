// Test Portfolio Engine：测试组合引擎（Phase 22 通用）
// 1) categorizeCase：确定性分类（优先级：Core > Flaky > Historical > Risk > Change > Exploration > Regression）。
// 2) buildPortfolio：批量分类。
// 3) selectPortfolio：按组合策略选择（Core/Risk/Change/Regression 100%、Historical Top N、Exploration 预算 %）。

import {
  DEFAULT_PORTFOLIO_RULES,
  type PortfolioCase,
  type PortfolioCaseInput,
  type PortfolioCategory,
  type PortfolioSelectionRules,
} from './portfolio-schema.js';

/** 高风险阈值（riskScore ≥ 0.5 → Risk） */
export const RISK_THRESHOLD = 0.5;
/** 历史失败阈值（≥ 3 次 → Historical） */
export const HISTORY_FAILURE_THRESHOLD = 3;

/** 单一用例分类（确定性优先级） */
export function categorizeCase(input: PortfolioCaseInput): PortfolioCase {
  if (input.priority === 'P0') return { caseId: input.caseId, category: 'Core', reasons: ['P0 基础测试'] };
  if (input.flaky) return { caseId: input.caseId, category: 'Flaky', reasons: ['不稳定用例，隔离执行'] };
  if (input.knownIssue || (input.historicalFailures ?? 0) >= HISTORY_FAILURE_THRESHOLD) {
    return { caseId: input.caseId, category: 'Historical', reasons: [input.knownIssue ? '已知问题' : `历史失败 ${input.historicalFailures} 次`] };
  }
  if ((input.riskScore ?? 0) >= RISK_THRESHOLD) return { caseId: input.caseId, category: 'Risk', reasons: [`风险分 ${input.riskScore}`] };
  if (input.changeTags && input.changeTags.length > 0) return { caseId: input.caseId, category: 'Change', reasons: [`变更相关（${input.changeTags.join('、')}）`] };
  if (input.coverageGap) return { caseId: input.caseId, category: 'Exploration', reasons: ['覆盖缺口，探索未知风险'] };
  return { caseId: input.caseId, category: 'Regression', reasons: ['常规回归'] };
}

/** 批量分类 */
export function buildPortfolio(cases: PortfolioCaseInput[]): PortfolioCase[] {
  return cases.map(categorizeCase).sort((a, b) => a.caseId.localeCompare(b.caseId));
}

/** 分类统计 */
export function portfolioStats(portfolio: PortfolioCase[]): Record<PortfolioCategory, number> {
  const out = Object.fromEntries(
    (['Core', 'Risk', 'Change', 'Historical', 'Exploration', 'Regression', 'Flaky'] as PortfolioCategory[]).map((c) => [c, 0]),
  ) as Record<PortfolioCategory, number>;
  for (const p of portfolio) out[p.category] += 1;
  return out;
}

/** 按组合策略选择（返回选中用例 + 跳过原因，全部可解释） */
export function selectPortfolio(
  cases: PortfolioCaseInput[],
  rules: Partial<PortfolioSelectionRules> = {},
): { selected: PortfolioCase[]; skipped: Array<{ caseId: string; reason: string }> } {
  const r: PortfolioSelectionRules = { ...DEFAULT_PORTFOLIO_RULES, ...rules };
  const portfolio = buildPortfolio(cases);
  const byCat = new Map<PortfolioCategory, PortfolioCase[]>();
  for (const p of portfolio) {
    const list = byCat.get(p.category) ?? [];
    list.push(p);
    byCat.set(p.category, list);
  }

  const pick = (cat: PortfolioCategory, ratio: number): PortfolioCase[] => {
    const list = byCat.get(cat) ?? [];
    const count = Math.round(list.length * ratio);
    return list.slice(0, count);
  };

  const selected = new Map<string, PortfolioCase>();
  const skipped: Array<{ caseId: string; reason: string }> = [];
  const add = (items: PortfolioCase[], reasonPrefix = ''): void => {
    for (const it of items) {
      if (!selected.has(it.caseId)) selected.set(it.caseId, it);
    }
  };

  // Core / Risk / Change / Regression 100%
  add(pick('Core', r.coreRatio));
  add(pick('Risk', r.riskRatio));
  add(pick('Change', r.changeRatio));
  add(pick('Regression', r.regressionRatio));

  // Historical Top N（确定性：caseId 字典序取前 N）
  const historical = (byCat.get('Historical') ?? [])
    .slice()
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .slice(0, r.historicalTopN);
  add(historical);

  // Exploration 预算 %
  add(pick('Exploration', r.explorationRatio));

  // Flaky 隔离执行
  add(byCat.get('Flaky') ?? []);

  // 未选中的给出原因
  for (const p of portfolio) {
    if (!selected.has(p.caseId)) {
      const catList = byCat.get(p.category) ?? [];
      const idx = catList.findIndex((c) => c.caseId === p.caseId);
      const reason =
        p.category === 'Historical'
          ? 'Historical 超出 Top N（历史问题按前 N 选择）'
          : p.category === 'Exploration'
            ? 'Exploration 超出探索预算比例'
            : `${p.category} 未进入组合选择范围`;
      skipped.push({ caseId: p.caseId, reason: `${reason}（第 ${idx + 1} 个，共 ${catList.length} 个）` });
    }
  }

  return { selected: [...selected.values()].sort((a, b) => a.caseId.localeCompare(b.caseId)), skipped };
}
