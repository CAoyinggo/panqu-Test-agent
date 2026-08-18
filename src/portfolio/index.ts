// Test Portfolio 模块统一导出（Phase 22 通用 + Phase 23.2 Portfolio → Regression）
export {
  PORTFOLIO_CATEGORIES,
  DEFAULT_PORTFOLIO_RULES,
  DEFAULT_PORTFOLIO_POLICY,
  type PortfolioCategory,
  type PortfolioCaseInput,
  type PortfolioCase,
  type PortfolioSelectionRules,
  type PortfolioPolicy,
} from './portfolio-schema.js';

export {
  categorizeCase,
  buildPortfolio,
  portfolioStats,
  selectPortfolio,
  RISK_THRESHOLD,
  HISTORY_FAILURE_THRESHOLD,
} from './portfolio-engine.js';

export {
  buildRegressionPlan,
  portfolioToAutonomousCases,
  type PortfolioRegressionPlan,
  type RegressionPlanInput,
} from './portfolio-regression.js';
