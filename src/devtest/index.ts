/**
 * DevTest 公共 API。
 * 业务与测试只允许从本 barrel 引入；内部文件结构可能调整。
 */

export { runDevTest } from './devtest-runner.js';
export { buildDevTestProblems, deriveDevTestConclusion, suggestionForReasonCode } from './problem-engine.js';
export {
  SafeMutationHoldProcessor,
  buildOperationPolicies,
  caseHttpMethod,
  heldMutationResult,
  isMutatingMethod,
} from './safe-mode.js';
export {
  DEVTEST_REPORT_SCHEMA,
  buildDevTestReportEnvelope,
  renderCasesCsv,
  renderDevTestHtml,
  renderProblemsMarkdown,
  type DevTestRenderInput,
  type DevTestRenderMeta,
} from './artifacts.js';
export { fetchFeishuDoc, loadFeishuCredentials, parseFeishuUrl } from './feishu-fetch.js';
export type {
  DevTestArtifacts,
  DevTestConclusion,
  DevTestDimensionStat,
  DevTestOptions,
  DevTestProblem,
  DevTestProblemCategory,
  DevTestProblemSeverity,
  DevTestRunResult,
} from './types.js';
