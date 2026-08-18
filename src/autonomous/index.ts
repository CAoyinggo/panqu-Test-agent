// Autonomous 模块统一导出（Phase 22.6）
export {
  type AutonomousMode,
  type AutonomousBudget,
  type AutonomousCase,
  type AutonomousDecision,
  type AutonomousRunOptions,
  type AutonomousRunResult,
  type ReplanEvent,
  DEFAULT_AUTONOMOUS_BUDGET,
} from './autonomous-schema.js';

export {
  checkAutonomousBudget,
  BUDGET_LIMIT_NAMES,
  type AutonomousBudgetUsage,
  type AutonomousBudgetCheck,
} from './autonomous-budget.js';

export { runAutonomousRegression } from './autonomous-regression.js';

export {
  runAutonomousPipeline,
  writeAutonomousOutputs,
  type AutonomousPipelineInput,
  type AutonomousPipelineResult,
  type AutonomousPipelineSignals,
  type AutonomousPipelineExplorationInput,
  type PipelineDefect,
  type PipelineTracePlan,
  type RunSummary,
} from './autonomous-pipeline.js';

export { renderAutonomousReportHtml } from './autonomous-report.js';

export {
  AUTONOMOUS_SCENARIOS,
  runScenario,
  runAllScenarios,
  type AutonomousScenario,
} from './simulation.js';
