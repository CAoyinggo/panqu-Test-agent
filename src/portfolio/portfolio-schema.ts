// Test Portfolio Schema：测试组合数据模型（Phase 22 通用）
// 把测试用例分成 Core / Risk / Change / Historical / Exploration / Regression / Flaky 七类，
// 每次回归按组合策略选择（Core 100% / Risk 100% / Change 100% / Historical Top N / Exploration 预算 %）。

/** 组合类别 */
export type PortfolioCategory =
  | 'Core'
  | 'Risk'
  | 'Change'
  | 'Historical'
  | 'Exploration'
  | 'Regression'
  | 'Flaky';

export const PORTFOLIO_CATEGORIES: readonly PortfolioCategory[] = [
  'Core', 'Risk', 'Change', 'Historical', 'Exploration', 'Regression', 'Flaky',
];

/** 用例输入（分类依据） */
export interface PortfolioCaseInput {
  caseId: string;
  /** 基础优先级（P0 → Core） */
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  /** 风险分 0~1（≥ 阈值 → Risk） */
  riskScore?: number;
  /** 变更相关标签（非空 → Change） */
  changeTags?: string[];
  /** 历史失败次数（→ Historical） */
  historicalFailures?: number;
  /** 已知问题标记（→ Historical） */
  knownIssue?: boolean;
  /** 不稳定标记（→ Flaky） */
  flaky?: boolean;
  /** 覆盖缺口标记（→ Exploration） */
  coverageGap?: boolean;
}

/** 分类结果 */
export interface PortfolioCase {
  caseId: string;
  category: PortfolioCategory;
  /** 分类理由 */
  reasons: string[];
}

/** 组合选择策略 */
export interface PortfolioSelectionRules {
  /** Core 选择比例（默认 1 = 100%） */
  coreRatio: number;
  /** Risk 选择比例（默认 1） */
  riskRatio: number;
  /** Change 选择比例（默认 1） */
  changeRatio: number;
  /** Historical 取 Top N（默认 10） */
  historicalTopN: number;
  /** Exploration 预算比例（默认 0.2 = 20%） */
  explorationRatio: number;
  /** Regression 选择比例（默认 1） */
  regressionRatio: number;
}

export const DEFAULT_PORTFOLIO_RULES: PortfolioSelectionRules = {
  coreRatio: 1,
  riskRatio: 1,
  changeRatio: 1,
  historicalTopN: 10,
  explorationRatio: 0.2,
  regressionRatio: 1,
};

/** Portfolio 策略（Phase 23.2，接入 Regression Controller 的配置接口） */
export interface PortfolioPolicy {
  /** Core 选择率（默认 1 = 100%） */
  coreRate: number;
  /** Risk 选择率（默认 1） */
  riskRate: number;
  /** Change 选择率（默认 1） */
  changeRate: number;
  /** Regression 选择率（默认 1） */
  regressionRate: number;
  /** Historical Top N（默认 10） */
  historicalTopN: number;
  /** Exploration 预算率（默认 0.2 = 20%） */
  explorationBudgetRate: number;
  /** 是否排除隔离的不稳定用例（默认 true） */
  excludeQuarantinedFlaky: boolean;
}

export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  coreRate: 1,
  riskRate: 1,
  changeRate: 1,
  regressionRate: 1,
  historicalTopN: 10,
  explorationBudgetRate: 0.2,
  excludeQuarantinedFlaky: true,
};
