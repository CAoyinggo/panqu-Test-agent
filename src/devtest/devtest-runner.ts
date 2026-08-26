/** DevTest thin adapter：两次都调用 Acceptance Pipeline，第一次规划，第二次按授权子集执行。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAcceptancePipeline } from '../acceptance/acceptance-pipeline.js';
import { parseAcceptanceRequirement } from '../acceptance/requirement-parser.js';
import type { AcceptanceExecutionSafetyPolicy } from '../acceptance/acceptance-safety-policy.js';
import { createPhase1ContractResolver } from '../contracts/seed-contracts.js';
import { contractDependency } from '../contracts/dependency-index.js';
import { resolveDiscoveredOperations } from '../discovery/api/api-discovery.js';
import {
  buildDevTestReportEnvelope,
  buildDevTestUnknowns,
  renderCasesCsv,
  renderDevTestHtml,
  renderProblemsMarkdown,
  renderAcceptanceSummary,
} from './artifacts.js';
import { devTestDimensionOf, selectDevTestCases } from './dimension-selector.js';
import { discoverReferencedContractDependencies } from './contract-dependencies.js';
import { buildDevTestFeatureModel } from './feature-model.js';
import { appendDiscoveredContracts, discoverDevTestProject, discoverParameterContractConflicts } from './project-discovery.js';
import { buildBaselineDiff, loadDevTestBaseline, reconcileDevTestProblems, rerunCaseIds, saveDevTestBaseline } from './baseline.js';
import { discoverDevTestEnvironment } from './environment-discovery.js';
import { executeDevTestUiCases } from './ui-executor.js';
import {
  analyzeDevTestImpact,
  buildDevTestPlan,
  contractPlanFingerprint,
  readDevTestAssetCache,
  requirementPlanFingerprint,
  writeDevTestAssetCache,
} from './planning.js';
import { fetchFeishuDoc, loadFeishuCredentials } from './feishu-fetch.js';
import { buildDevTestProblems, deriveDevTestConclusion } from './problem-engine.js';
import { SafeMutationHoldProcessor, buildOperationPolicies } from './safe-mode.js';
import { buildDevTestInvariants, buildRequirementCoverageMatrix, extendedDimensionsOf } from './requirement-intelligence.js';
import { buildVersionComparison, computeDevConfidence } from './final-assessment.js';
import { buildBusinessFlowGraph, buildBusinessLevelProblems, evaluateBusinessFlows, evaluateCrossCaseInvariants } from './business-flow-engine.js';
import { buildExecutionEstimate, buildRegressionGuard, buildRegressionProblem, evaluateRegressionGuard,
  relatedRegressionCaseIds } from './acceptance-governance.js';
import { buildTestOracleResults } from './oracle-engine.js';
import { buildTestReliability } from './reliability-engine.js';
import { SnapshottingProcessor, buildPollutionProblems, detectTestPollution } from './pollution-engine.js';
import { adaptiveScore, assessRequirementQuality, buildNegativeIntelligence, buildPermissionMatrix,
  buildRequirementQualityProblems, buildRootCauseGraph } from './test-intelligence.js';
import { readDiscoveryStageCache, workspaceCacheFingerprint, writeDiscoveryStageCache } from './stage-cache.js';
import {
  buildDevTestAcceptanceTraces,
  buildDevTestDeliveryCoverage,
  buildDevTestRequirementModel,
} from './delivery-acceptance.js';
import type { DevTestEnvironmentSnapshot, DevTestMode, DevTestOptions, DevTestRunResult } from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_ENVIRONMENT = 'local';
const DEFAULT_MAX_CASES = 20;

async function resolveMarkdown(options: DevTestOptions): Promise<{ markdown: string; docSource: string }> {
  if (options.markdown !== undefined) {
    if (!options.markdown.trim()) throw new Error('DEVTEST_INPUT_EMPTY：markdown 输入为空');
    return { markdown: options.markdown, docSource: options.documentId ?? 'inline-markdown' };
  }
  if (options.docPath !== undefined) {
    let content: string;
    try {
      content = await readFile(options.docPath, 'utf8');
    } catch (error) {
      throw new Error(`DEVTEST_REQUIREMENT_NOT_FOUND：无法读取 ${options.docPath}：${(error as Error).message}`);
    }
    if (!content.trim()) throw new Error(`DEVTEST_INPUT_EMPTY：文档为空：${options.docPath}`);
    return { markdown: content, docSource: options.docPath };
  }
  if (options.feishuUrl !== undefined) {
    const credentials = await loadFeishuCredentials(options.feishuCredentialsPath);
    return { markdown: await fetchFeishuDoc(options.feishuUrl, credentials), docSource: options.feishuUrl };
  }
  throw new Error('DEVTEST_INPUT_MISSING：必须提供 Requirement 文件、飞书链接或 markdown');
}

function normalizeMode(options: DevTestOptions): DevTestMode {
  if (options.dryRun === true) return 'DRY_RUN';
  return options.mode ?? 'SAFE';
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value ?? process.env.TESTFLOW_BASE_URL ?? DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('必须是无凭据、Path、Query、Fragment 的 HTTP(S) Origin');
    }
    return parsed.origin;
  } catch (error) {
    throw new Error(`DEVTEST_BASE_URL_INVALID：${raw}：${(error as Error).message}`);
  }
}

function liveApprovalPolicies(
  policies: AcceptanceExecutionSafetyPolicy['operationPolicies'],
  mode: DevTestMode,
  approvalId: string | undefined,
): AcceptanceExecutionSafetyPolicy['operationPolicies'] {
  if (mode !== 'LIVE' || approvalId?.trim()) return policies;
  return Object.fromEntries(Object.keys(policies).map((key) => [key, {
    effect: 'UNKNOWN' as const,
    reason: 'LIVE_APPROVAL_REQUIRED：未提供可审计 approvalId，禁止真实执行',
  }]));
}

export async function runDevTest(options: DevTestOptions): Promise<DevTestRunResult> {
  const startedAt = new Date().toISOString();
  const resolvedInput = await resolveMarkdown(options);
  const originalMarkdown = resolvedInput.markdown;
  const docSource = resolvedInput.docSource;
  const explicitRequirement = parseAcceptanceRequirement(originalMarkdown, { documentId: options.documentId });
  const mode = normalizeMode(options);
  if (options.final && (mode !== 'SAFE' || options.plan || options.preflight || options.rerun || options.reproProblemId)) {
    throw new Error('DEVTEST_FINAL_CONFLICT：--final 必须执行完整 SAFE 验收，不能与 plan/preflight/rerun/repro/LIVE/DRY_RUN 组合');
  }
  const environment = (options.environment ?? DEFAULT_ENVIRONMENT).trim().toLowerCase();
  const explicitBaseUrl = options.baseUrl === undefined ? undefined : normalizeBaseUrl(options.baseUrl);
  const project = options.project ?? 'devtest';
  const projectRoot = options.projectRoot ?? process.cwd();
  const outDir = options.outDir ?? 'devtest-results';
  const requirementFingerprint = requirementPlanFingerprint(originalMarkdown);
  const workspaceFingerprint = await workspaceCacheFingerprint(projectRoot);
  const discoveryCache = await readDiscoveryStageCache({ outDir, sourceKey: docSource,
    requirementFingerprint, workspaceFingerprint });
  const maxCases = options.maxCases ?? DEFAULT_MAX_CASES;
  const contractResolver = options.contractResolver ?? createPhase1ContractResolver();
  const discovery = discoveryCache.discovery ?? await discoverDevTestProject({ projectRoot,
    requirement: explicitRequirement, enabled: options.discoverProject });
  const markdown = appendDiscoveredContracts(originalMarkdown, discovery, explicitRequirement.apis.length > 0);
  const requirement = parseAcceptanceRequirement(markdown, { documentId: options.documentId });
  const environmentPreflight = await discoverDevTestEnvironment({
    explicitBaseUrl,
    environment,
    projectRoot,
    requirement,
    actorHeaders: options.actorHeaders,
    fetchImpl: options.fetchImpl,
    probeNetwork: mode !== 'DRY_RUN',
  });
  const baseUrl = environmentPreflight.selectedBaseUrl ?? explicitBaseUrl ?? DEFAULT_BASE_URL;
  const resolvedDiscovery = resolveDiscoveredOperations(discovery.mappedOperations, contractResolver, environment);
  const additionalContractDependencies = [
    ...discoverReferencedContractDependencies(originalMarkdown, contractResolver),
    ...resolvedDiscovery.flatMap((item) => item.resolution.contract ? [contractDependency(item.resolution.contract)] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.contractId === item.contractId
    && candidate.version === item.version && candidate.fingerprint === item.fingerprint) === index);
  let featureModel = discoveryCache.featureModel ?? buildDevTestFeatureModel(requirement, discovery);
  const parameterContractConflicts = discoverParameterContractConflicts(requirement, discovery);
  const previousBaseline = await loadDevTestBaseline(outDir, originalMarkdown, docSource);

  // Preview authorizes the exact canonical plan and exposes all candidates for risk-first selection.
  const preview = await runAcceptancePipeline({
    markdown, project, documentId: options.documentId, baseUrl, environment,
    mode: 'dry-run', contractResolver, signal: options.signal, additionalContractDependencies,
  });
  const contractFingerprint = contractPlanFingerprint(preview.testCases);
  const impact = await analyzeDevTestImpact({
    projectRoot,
    testCases: preview.testCases,
    discovery,
    hasBaseline: Boolean(previousBaseline),
  });
  const contractDriftForSelection = Boolean(previousBaseline?.contractVersion
    && previousBaseline.contractVersion !== contractFingerprint);
  const candidateAdaptiveScores = Object.fromEntries(preview.testCases.map((testCase) => [testCase.id, adaptiveScore({
    testCase, baseline: previousBaseline, changedCaseIds: impact.affectedCaseIds, contractDrift: contractDriftForSelection,
  })]));
  const selection = selectDevTestCases(preview.testCases, {
    maxCases,
    enabledDimensions: options.enabledDimensions,
    deep: options.deep,
    adaptiveScores: candidateAdaptiveScores,
  });
  const preliminaryCoverage = buildRequirementCoverageMatrix({ requirement, testCases: selection.selected, profiles: selection.profiles });
  const preliminaryInvariants = buildDevTestInvariants({ requirement, testCases: selection.selected });
  const extendedDimensions = extendedDimensionsOf(requirement, preliminaryInvariants, selection.selected);
  const preliminaryFlowGraph = buildBusinessFlowGraph({ featureModel, testCases: selection.selected,
    profiles: selection.profiles, invariants: preliminaryInvariants });
  const normalSelectedCaseIds = selection.selected.map((testCase) => testCase.id);
  const reproProblemId = options.reproProblemId?.toUpperCase();
  const requestedRerunCaseIds = reproProblemId
    ? rerunCaseIds(previousBaseline, preview.testCases, reproProblemId)
    : options.rerun ? rerunCaseIds(previousBaseline, preview.testCases, options.rerunTarget) : [];
  const rerunScope = new Set(requestedRerunCaseIds);
  const matchedRerunCaseIds = preview.testCases.map((testCase) => testCase.id).filter((caseId) => rerunScope.has(caseId));
  const initialRegressionGuard = buildRegressionGuard({
    target: options.rerun ? options.rerunTarget : undefined,
    baseline: previousBaseline,
    testCases: selection.selected,
    graph: preliminaryFlowGraph,
    invariants: preliminaryInvariants,
  });
  const confirmedMutation = mode === 'LIVE'
    ? Boolean(options.approvalId?.trim())
    : options.confirmMutations === true && (options.sandbox === true || Boolean(options.lifecycleCleanup));
  const cache = await readDevTestAssetCache({
    outDir,
    sourceKey: docSource,
    requirementFingerprint,
    contractFingerprint,
    codeFingerprint: impact.codeFingerprint,
  });
  if (cache.status === 'HIT' && cache.record) featureModel = cache.record.featureModel;
  const impactRelations = relatedRegressionCaseIds({ seedCaseIds: impact.affectedCaseIds,
    testCases: selection.selected, graph: preliminaryFlowGraph, invariants: preliminaryInvariants });
  const impactExpandedCaseIds = impact.applied ? impactRelations.all : normalSelectedCaseIds;
  // 没有历史失败时仍执行当前高价值集，避免把“无 Case”误报为复测成功。
  const selectedCaseIds = reproProblemId && previousBaseline ? matchedRerunCaseIds
    : options.rerun && previousBaseline ? (initialRegressionGuard.enabled
      ? normalSelectedCaseIds.filter((caseId) => initialRegressionGuard.selectedCaseIds.includes(caseId)) : matchedRerunCaseIds)
    : impact.applied ? normalSelectedCaseIds.filter((caseId) => impactExpandedCaseIds.includes(caseId))
      : normalSelectedCaseIds;
  const selectedForEstimate = selection.selected.filter((testCase) => selectedCaseIds.includes(testCase.id));
  const executionEstimate = buildExecutionEstimate({ testCases: selectedForEstimate, timeoutMs: options.timeoutMs ?? 10_000,
    maxRuntimeMs: options.maxRuntimeMs, budget: options.budget });
  const syntheticBlocks: Array<{ code: string; message: string; affectedCases?: string[]; dimension?: 'DATA_ISOLATION' | 'EXECUTION' }> = [];
  syntheticBlocks.push(...parameterContractConflicts);
  for (const behavior of preliminaryCoverage.behaviors.filter((item) => item.missingAssertions.includes('MISSING_POST_STATE_ASSERTION'))) {
    syntheticBlocks.push({
      code: 'MISSING_POST_STATE_ASSERTION',
      message: `${behavior.acId} 只验证响应，缺少失败/拒绝后的 Non-Mutation 状态证据；已补充设计断言但 Observer 不可用`,
      affectedCases: behavior.linkedCaseIds,
      dimension: 'EXECUTION',
    });
  }
  for (const behavior of preliminaryCoverage.behaviors.filter((item) => item.status === 'UNCOVERED')) syntheticBlocks.push({
    code: 'ASSERTION_MISSING_AC', message: `${behavior.acId} 未映射到任何 Case：${behavior.statement}`,
    affectedCases: [], dimension: 'EXECUTION',
  });
  if (!selectedCaseIds.length) syntheticBlocks.push({
    code: 'DEVTEST_NO_APPLICABLE_CASE',
    message: '没有可追溯且已启用的 DevTest Case；系统没有为满足数量要求而猜测用例',
  });
  if (executionEstimate.exceeded.length) syntheticBlocks.push({
    code: 'DEVTEST_BUDGET_EXCEEDED',
    message: `执行估算超过限制：${executionEstimate.exceeded.join(', ')}；estimatedRuntime=${executionEstimate.estimatedRuntimeMs}ms estimatedCost=${executionEstimate.estimatedCost}`,
    affectedCases: selectedCaseIds,
    dimension: 'EXECUTION',
  });
  if (mode === 'LIVE' && !options.approvalId?.trim()) syntheticBlocks.push({
    code: 'LIVE_APPROVAL_REQUIRED',
    message: 'LIVE 请求缺少可审计 approvalId，已在任何 Data Prepare/HTTP 调用前阻断',
  });
  if (options.rerun && !previousBaseline) syntheticBlocks.push({
    code: 'RERUN_BASELINE_MISSING',
    message: '没有找到同一 Requirement 的历史 Baseline；本次已按首次 DevTest 执行并建立 Baseline',
  });
  if (options.rerun && previousBaseline && !selectedCaseIds.length) syntheticBlocks.push({
    code: 'RERUN_NO_TARGETS',
    message: 'Baseline 没有 FAILED/BLOCKED/受影响 Case；本次未回退执行全量 Case',
  });
  if (reproProblemId && !previousBaseline) syntheticBlocks.push({
    code: 'REPRO_BASELINE_MISSING',
    message: `无法复现 ${reproProblemId}：没有同一 Requirement 的历史 Baseline`,
  });
  if (reproProblemId && previousBaseline && !previousBaseline.problems.some((problem) => problem.id.toUpperCase() === reproProblemId)) syntheticBlocks.push({
    code: 'REPRO_PROBLEM_NOT_FOUND',
    message: `Baseline 中不存在问题 ${reproProblemId}；未执行其他 Case`,
  });
  if (mode !== 'DRY_RUN' && environmentPreflight.status === 'BLOCKED') syntheticBlocks.push({
    code: environmentPreflight.ambiguous ? 'AMBIGUOUS_ENVIRONMENT' : 'NETWORK_UNREACHABLE',
    message: environmentPreflight.reason ?? '环境 Preflight 阻断真实执行',
  });
  if (environmentPreflight.checks.authentication === 'BLOCKED') syntheticBlocks.push({
    code: 'AUTH_CONTEXT_INCOMPLETE',
    message: 'Requirement 需要认证/多身份，但没有可用 actorHeaders；权限与数据隔离保持 BLOCKED',
    affectedCases: preview.testCases.filter((testCase) => devTestDimensionOf(testCase.testType) === 'DATA_ISOLATION').map((testCase) => testCase.id),
    dimension: 'DATA_ISOLATION',
  });

  const rawPolicies = buildOperationPolicies(requirement.apis, markdown);
  const safetyPolicy: AcceptanceExecutionSafetyPolicy = {
    environment,
    allowedOrigins: environment === 'local' ? undefined : [new URL(baseUrl).origin],
    operationPolicies: liveApprovalPolicies(rawPolicies, mode, options.approvalId),
    // local 仅允许管线到达 Case 级 SAFE Guard；普通 Mutation 仍需下方 sandbox/cleanup + confirm 双门禁。
    allowNoCleanup: environment === 'local',
  };
  const pipelineMode = mode === 'DRY_RUN' || options.preflight === true || options.plan === true
    || environmentPreflight.status === 'BLOCKED' || !selectedCaseIds.length || executionEstimate.exceeded.length > 0 ? 'dry-run' : 'execute';
  const environmentSnapshots: DevTestEnvironmentSnapshot[] = [];
  const safeProcessor = pipelineMode === 'dry-run'
    ? undefined
    : new SafeMutationHoldProcessor({
      confirmMutations: confirmedMutation,
      inner: options.processor ?? undefined,
    });
  const processor = safeProcessor && options.caseSnapshotObserver ? new SnapshottingProcessor({
    inner: safeProcessor,
    observer: options.caseSnapshotObserver,
    records: environmentSnapshots,
    prepare: options.casePrepare,
    cleanup: options.caseCleanup,
  }) : safeProcessor;

  const selectedCases = selection.selected.filter((testCase) => selectedCaseIds.includes(testCase.id));
  const hasMutation = selectedCases.some((testCase) => testCase.steps.some((step) =>
    step.type === 'HTTP_REQUEST' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(step.method ?? '')));
  let prepareStatus: DevTestRunResult['dataLifecycle']['prepareStatus'] = hasMutation ? 'NOT_CONFIGURED' : 'NOT_REQUIRED';
  let cleanupStatus: DevTestRunResult['dataLifecycle']['cleanupStatus'] = hasMutation ? 'NOT_CONFIGURED' : 'NOT_REQUIRED';
  const wrappedPrepare = options.lifecyclePrepare ? async (): Promise<void> => {
    try { await options.lifecyclePrepare!(); prepareStatus = 'READY'; }
    catch (error) { prepareStatus = 'FAILED'; throw error; }
  } : undefined;
  const wrappedCleanup = options.lifecycleCleanup ? async (): Promise<void> => {
    try { await options.lifecycleCleanup!(); cleanupStatus = 'CLEANED'; }
    catch (error) { cleanupStatus = 'FAILED'; throw error; }
  } : undefined;
  if (options.sandbox && hasMutation) {
    if (!wrappedPrepare) prepareStatus = 'NOT_REQUIRED';
    if (!wrappedCleanup) cleanupStatus = 'NOT_REQUIRED';
  }

  const result = selectedCaseIds.length
    ? await runAcceptancePipeline({
      markdown, project, documentId: options.documentId, baseUrl, environment,
      safetyPolicy, mode: pipelineMode, processor,
      actorHeaders: options.actorHeaders, maxCases,
      caseIds: selectedCaseIds,
      expectedExecutionPlan: pipelineMode === 'execute' ? preview.executionPlan : undefined,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
      deadlineMs: options.maxRuntimeMs,
      concurrency: options.caseSnapshotObserver ? 1 : options.concurrency ?? 4,
      failFast: options.failFast !== false,
      lifecycle: wrappedPrepare || wrappedCleanup ? {
        prepare: wrappedPrepare,
        cleanup: wrappedCleanup,
      } : undefined,
      contractResolver,
      additionalContractDependencies,
    })
    : preview;

  if ((cleanupStatus as DevTestRunResult['dataLifecycle']['cleanupStatus']) === 'FAILED') syntheticBlocks.push({
    code: 'CLEANUP_FAILED', message: '测试数据 Cleanup 失败；可能残留测试资源，禁止静默通过', dimension: 'EXECUTION',
  });

  const uiExecutions = options.preflight || options.plan ? [] : await executeDevTestUiCases({
    testCases: result.testCases,
    requirement,
    discovery,
    environment: environmentPreflight,
    mode,
    signal: options.signal,
    allowActions: confirmedMutation,
  });
  const uiByCase = new Map(uiExecutions.map((item) => [item.caseId, item.status]));
  const coreCaseIds = Object.values(selection.profiles).filter((profile) => profile.core).map((profile) => profile.caseId);
  const partialExecution = Boolean(options.rerun || reproProblemId || impact.applied);
  const trustedBaselinePassIds = new Set(partialExecution
    ? (previousBaseline?.cases ?? []).filter((item) => item.status === 'PASS' && item.verified === true
      && item.evidenceComplete === true && !impactExpandedCaseIds.includes(item.caseId)).map((item) => item.caseId)
    : []);
  let requirementCoverage = buildRequirementCoverageMatrix({
    requirement,
    testCases: selection.selected,
    profiles: selection.profiles,
    results: result.results,
    uiResults: uiExecutions,
  });
  const designedInvariants = buildDevTestInvariants({ requirement, testCases: selection.selected, results: result.results });
  const flowEvaluation = await evaluateBusinessFlows({
    graph: preliminaryFlowGraph,
    testCases: selection.selected,
    results: result.results,
    uiResults: uiExecutions,
    invariants: designedInvariants,
    stateObserver: options.stateObserver,
  });
  const reliability = buildTestReliability({ baseline: previousBaseline, results: result.results });
  const trustedFlakyCaseIds = new Set(reliability.cases.filter((candidate) => candidate.status === 'FLAKY'
    && previousBaseline?.cases.find((item) => item.caseId === candidate.caseId)?.verified === true).map((item) => item.caseId));
  const pollutionFindings = detectTestPollution({ snapshots: environmentSnapshots, results: result.results,
    testCases: selection.selected.filter((item) => selectedCaseIds.includes(item.id)), graph: flowEvaluation.graph,
    cleanupConfigured: Boolean(options.caseCleanup) });
  const pollutedCaseIds = new Set(pollutionFindings.filter((item) => item.classification === 'TEST_POLLUTION'
    || item.classification === 'SHARED_STATE').map((item) => item.caseId));
  const oracleResults = buildTestOracleResults({ testCases: selection.selected, results: result.results,
    invariants: designedInvariants, consistency: flowEvaluation.consistency, uiResults: uiExecutions,
    snapshots: environmentSnapshots, baseline: previousBaseline });
  const oracleByCase = new Map(oracleResults.map((item) => [item.caseId, item]));
  // 已复现产品问题的定向修复复测建立新的可靠性 epoch：目标 Case 的完整 Oracle PASS
  // 用于 FIXED 判定；同 Contract/Flow 的其他 Flaky Case 仍保持阻断。
  const fixVerificationPassIds = new Set(initialRegressionGuard.fixedCaseIds.filter((caseId) => {
    const oracle = oracleByCase.get(caseId);
    return options.rerun === true && oracle?.verdict === 'PASS' && oracle.evidence.complete;
  }));
  flowEvaluation.graph.flows = flowEvaluation.graph.flows.map((flow) => {
    const caseIds = flow.steps.flatMap((step) => step.caseIds);
    const failedCaseId = caseIds.find((caseId) => oracleByCase.get(caseId)?.verdict === 'FAIL'
      && oracleByCase.get(caseId)?.evidence.complete);
    if (failedCaseId) {
      const failedStep = flow.steps.find((step) => step.caseIds.includes(failedCaseId));
      return { ...flow, status: 'FAIL' as const, failedStepId: failedStep?.id,
        reason: `BUSINESS_FLOW_FAILED：${failedCaseId} 已由统一 Oracle 确认` };
    }
    const incompleteCaseId = caseIds.find((caseId) => oracleByCase.get(caseId)?.verdict !== 'PASS'
      || oracleByCase.get(caseId)?.evidence.complete !== true);
    if (incompleteCaseId) return { ...flow, status: 'BLOCKED' as const,
      reason: `BUSINESS_FLOW_BLOCKED：${incompleteCaseId} 未获得完整 Oracle PASS` };
    return flow;
  }).map((flow) => {
    const failedStep = flow.steps.find((step) => step.id === flow.failedStepId);
    return flow.status === 'FAIL' && failedStep?.caseIds.some((caseId) => trustedFlakyCaseIds.has(caseId))
      ? { ...flow, status: 'BLOCKED' as const, reason: 'FLAKY_CASE_CURRENT_FAILURE：本次失败进入 Test Reliability，不能沿用历史 PASS' } : flow;
  });
  flowEvaluation.graph.coverage = flowEvaluation.graph.flows.length
    ? Math.round(flowEvaluation.graph.flows.filter((flow) => flow.status === 'PASS').length / flowEvaluation.graph.flows.length * 100) : 0;
  const invariants = evaluateCrossCaseInvariants({ invariants: designedInvariants, testCases: selection.selected,
    results: result.results, consistency: flowEvaluation.consistency, oracleResults }).map((invariant) => invariant.status === 'FAILED'
      && invariant.failedCaseIds?.every((caseId) => trustedFlakyCaseIds.has(caseId))
      ? { ...invariant, status: 'BLOCKED' as const } : invariant);
  requirementCoverage = buildRequirementCoverageMatrix({ requirement, testCases: selection.selected,
    profiles: selection.profiles, results: result.results, uiResults: uiExecutions, oracleResults });
  const verifiedCaseIds = new Set(oracleResults.filter((item) => item.verdict === 'PASS' && item.evidence.complete)
    .map((item) => item.caseId));
  const requirementQuality = assessRequirementQuality({ requirement, matrix: requirementCoverage, model: featureModel });
  const negativeChecks = buildNegativeIntelligence({ requirementText: originalMarkdown, testCases: selection.selected,
    mutationSafe: confirmedMutation, observerAvailable: Boolean(options.caseSnapshotObserver || options.stateObserver) });
  const permissionMatrix = buildPermissionMatrix(selection.selected, featureModel);
  const problemBuild = buildDevTestProblems({
    report: result.report,
    contracts: result.contracts,
    results: result.results,
    requirementWarnings: result.requirement.warnings,
    syntheticBlocks,
    uiResults: uiExecutions,
    environment: { name: environment, baseUrl },
    environmentPreflight,
    preflightOnly: options.preflight === true || options.plan === true,
    reproductionRun: Boolean(reproProblemId),
    oracleResults,
    reliability,
    pollutedCaseIds,
  });
  const { dimensionStats } = problemBuild;
  const uiStat = dimensionStats.find((item) => item.dimension === 'UI');
  if (uiStat && uiExecutions.length) {
    uiStat.passed = uiExecutions.filter((item) => item.status === 'PASS').length;
    uiStat.failed = uiExecutions.filter((item) => item.status === 'FAIL').length;
    uiStat.blocked = uiExecutions.filter((item) => item.status === 'BLOCKED').length;
    uiStat.notExecuted = uiExecutions.filter((item) => item.status === 'NOT_EXECUTED').length;
  }
  const unreliableCaseIds = new Set([
    ...pollutedCaseIds,
    ...reliability.cases.filter((item) => item.status === 'FLAKY' && !fixVerificationPassIds.has(item.caseId)).map((item) => item.caseId),
  ]);
  const effectiveCaseStatuses = result.report.cases.map((item) => {
    const oracle = oracleByCase.get(item.caseId);
    const verified = oracle?.evidence.complete === true && (oracle.verdict === 'PASS' || oracle.verdict === 'FAIL')
      && !unreliableCaseIds.has(item.caseId);
    return {
      caseId: item.caseId,
      status: verified ? oracle!.verdict : 'BLOCKED',
      durationMs: result.results.find((execution) => execution.caseId === item.caseId)?.durationMs ?? 0,
      verified,
      evidenceComplete: oracle?.evidence.complete === true,
      oracleVerdict: oracle?.verdict,
    };
  });
  const regressionGuard = evaluateRegressionGuard(initialRegressionGuard, effectiveCaseStatuses);
  const regressionProblem = buildRegressionProblem(regressionGuard);
  const businessProblems = buildBusinessLevelProblems({ graph: flowEvaluation.graph, invariants,
    consistency: flowEvaluation.consistency, reproductionRun: Boolean(reproProblemId) });
  const hiddenSideEffectCaseIds = new Set(pollutionFindings.filter((item) => item.classification === 'UNEXPECTED_SIDE_EFFECT')
    .map((item) => item.caseId));
  const problems = reconcileDevTestProblems([
    ...problemBuild.problems.filter((problem) => !(problem.reasonCode === 'ORACLE_STATE_MISMATCH'
      && problem.affectedCases.some((caseId) => hiddenSideEffectCaseIds.has(caseId)))),
    ...businessProblems,
    ...buildPollutionProblems(pollutionFindings, { reproductionRun: Boolean(reproProblemId) }),
    ...buildRequirementQualityProblems(requirementQuality),
    ...(regressionProblem ? [regressionProblem] : []),
  ], previousBaseline, reproProblemId);
  const rootCauseGraph = buildRootCauseGraph(problems, selection.selected, flowEvaluation.graph);
  for (const node of rootCauseGraph) for (const problem of problems.filter((item) => node.problemIds.includes(item.id))) {
    problem.benefitScore = node.benefitScore;
    problem.affectedContracts = node.affectedContracts;
    problem.affectedScenarios = node.affectedScenarios;
    problem.affectedBusinessFlows = node.affectedBusinessFlows;
  }
  const requirementModel = buildDevTestRequirementModel(requirement);
  const acceptanceTraces = buildDevTestAcceptanceTraces({
    requirementModel,
    testCases: selection.candidates,
    results: result.results,
    uiResults: uiExecutions,
    oracleResults,
    observations: flowEvaluation.observations,
    snapshots: environmentSnapshots,
    problems,
    selectedCaseIds,
    unselected: selection.unselected,
  });
  const classificationRank = ['PRODUCT_BUG', 'REQUIREMENT_GAP', 'TEST_DESIGN_ERROR', 'ENVIRONMENT_ERROR', 'EXECUTION_ERROR', 'NOT_TESTED'] as const;
  for (const problem of problems) {
    problem.issueClassification = classificationRank.find((classification) => acceptanceTraces.some((trace) =>
      trace.problemIds.includes(problem.id) && trace.classification === classification))
      ?? (problem.failureClass === 'PRODUCT_BUG' ? 'PRODUCT_BUG'
        : problem.failureClass === 'REQUIREMENT_ISSUE' || problem.failureClass === 'CONTRACT_ISSUE' ? 'REQUIREMENT_GAP'
          : problem.failureClass === 'TEST_ISSUE' ? 'TEST_DESIGN_ERROR'
            : ['ENVIRONMENT_ISSUE', 'AUTH_ISSUE', 'DATA_ISSUE'].includes(problem.failureClass ?? '') ? 'ENVIRONMENT_ERROR'
              : 'EXECUTION_ERROR');
  }
  const deliveryCoverage = buildDevTestDeliveryCoverage({ requirementModel, traces: acceptanceTraces });
  for (const stat of dimensionStats) {
    const traces = acceptanceTraces.filter((trace) => trace.testModel.dimension === stat.dimension);
    stat.total = traces.length;
    stat.executable = traces.filter((trace) => trace.executableTest.status === 'READY').length;
    stat.passed = traces.filter((trace) => trace.result === 'PASS').length;
    stat.failed = traces.filter((trace) => trace.result === 'FAIL').length;
    stat.blocked = traces.filter((trace) => trace.result === 'BLOCKED').length;
    stat.notExecuted = traces.filter((trace) => trace.result === 'NOT_TESTED').length;
  }
  const conclusionOverrides = new Map(uiByCase);
  for (const oracle of oracleResults.filter((item) => item.verdict === 'UNKNOWN' || item.verdict === 'BLOCKED')) {
    conclusionOverrides.set(oracle.caseId, 'BLOCKED');
  }
  for (const item of reliability.cases.filter((candidate) => candidate.status === 'FLAKY')) {
    if (!fixVerificationPassIds.has(item.caseId)) conclusionOverrides.set(item.caseId, 'BLOCKED');
  }
  for (const trace of acceptanceTraces) {
    conclusionOverrides.set(trace.caseId, trace.result === 'NOT_TESTED' ? 'NOT_EXECUTED' : trace.result);
  }
  let conclusion = deriveDevTestConclusion(result.report, problems, conclusionOverrides, {
    caseIds: coreCaseIds,
    verifiedCaseIds,
    trustedBaselinePassIds,
  });
  const requirementIncomplete = requirementCoverage.uncoveredAc.length > 0
    || requirementCoverage.ambiguousAc.length > 0 || requirementCoverage.blockedAc.length > 0;
  const invariantIncomplete = invariants.some((invariant) => invariant.status === 'BLOCKED' || invariant.status === 'FAILED');
  const coreFlowFailed = flowEvaluation.graph.flows.some((flow) => flow.core && flow.status === 'FAIL');
  const coreFlowBlocked = flowEvaluation.graph.flows.some((flow) => flow.core && flow.status !== 'PASS' && flow.status !== 'FAIL');
  const selectedAcceptanceTraces = acceptanceTraces.filter((trace) => trace.testModel.selection === 'SELECTED');
  const acceptanceFailed = selectedAcceptanceTraces.some((trace) => trace.result === 'FAIL');
  const acceptanceIncomplete = selectedAcceptanceTraces.length === 0
    || selectedAcceptanceTraces.some((trace) => trace.result === 'BLOCKED' || trace.result === 'NOT_TESTED');
  if (acceptanceFailed || coreFlowFailed || regressionGuard.status === 'FAIL') conclusion = 'NOT_READY';
  else if (conclusion !== 'NOT_READY' && (requirementIncomplete || invariantIncomplete || coreFlowBlocked
    || regressionGuard.status === 'BLOCKED' || acceptanceIncomplete)) conclusion = 'BLOCKED';
  const pendingMutationCaseIds = result.results
    .filter((item) => item.attribution?.reason?.includes('SAFE_MODE_MUTATION_HOLD'))
    .map((item) => item.caseId);
  const finishedAt = new Date().toISOString();
  const baseline = buildBaselineDiff({
    baseline: previousBaseline,
    currentRunId: result.runId,
    cases: effectiveCaseStatuses,
    problems,
    rerunCaseIds: options.rerun ? selectedCaseIds : matchedRerunCaseIds,
    rerunTarget: options.rerunTarget ?? reproProblemId,
    scopeCaseIds: selectedCaseIds,
  });
  const targetStatuses = effectiveCaseStatuses.filter((item) => matchedRerunCaseIds.includes(item.caseId));
  const reproduction = reproProblemId ? {
    problemId: reproProblemId,
    status: problems.some((problem) => problem.id.toUpperCase() === reproProblemId && problem.failureClass === 'PRODUCT_BUG')
      ? 'REPRODUCED' as const
      : !matchedRerunCaseIds.length || targetStatuses.some((item) => ['BLOCKED', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED'].includes(item.status))
        ? 'BLOCKED' as const : 'NOT_REPRODUCED' as const,
    caseIds: matchedRerunCaseIds,
  } : undefined;
  const versionComparison = buildVersionComparison({
    requirementVersion: requirementFingerprint,
    codeVersion: impact.codeFingerprint,
    contractVersion: contractFingerprint,
    acIds: requirement.acceptanceCriteria.map((criterion) => criterion.criterionId),
    caseIds: selection.selected.map((testCase) => testCase.id),
    contractDrift: result.contracts.validation.status !== 'VALID'
      || result.contracts.resolutions.some((resolution) => ['CONFLICT', 'STALE', 'INVALID'].includes(resolution.status)),
    baseline: previousBaseline,
    newProblems: baseline.newProblems,
    fixedProblems: baseline.resolvedProblems,
    regressions: baseline.regressions,
  });
  const devConfidence = computeDevConfidence({ conclusion, matrix: requirementCoverage, report: result.report, problems });
  const primaryActor = featureModel.actors[0];
  const dataLifecycle: DevTestRunResult['dataLifecycle'] = {
    runId: result.runId,
    owner: primaryActor?.role ?? primaryActor?.id,
    tenant: featureModel.tenants[0],
    project,
    resource: featureModel.resources[0],
    createdBy: options.lifecyclePrepare ? 'DEVTEST' : options.sandbox ? 'EXISTING_FIXTURE' : 'UNKNOWN',
    prepareStatus,
    cleanupStatus,
    traceable: Boolean(project && featureModel.resources[0] && (primaryActor || featureModel.tenants[0])),
  };
  const plannedCases = selection.selected.filter((testCase) => selectedCaseIds.includes(testCase.id));
  const affectedFlowIds = preliminaryFlowGraph.flows.filter((flow) => flow.steps.some((step) =>
    step.caseIds.some((caseId) => impact.affectedCaseIds.includes(caseId)))).map((flow) => flow.id);
  const plan = buildDevTestPlan({
    feature: featureModel.feature.name,
    selected: plannedCases,
    decisions: selection.decisions,
    scores: selection.scores,
    profiles: Object.fromEntries(Object.entries(selection.profiles).filter(([caseId]) => selectedCaseIds.includes(caseId))),
    deduplication: selection.deduplication,
    environment: environmentPreflight,
    mutationAuthorized: confirmedMutation,
    impact,
    cache: { status: cache.status === 'HIT' && discoveryCache.status === 'HIT' ? 'HIT'
      : cache.status === 'INVALIDATED' || discoveryCache.status === 'INVALIDATED' ? 'INVALIDATED' : 'MISS',
    reason: `Requirement/Feature/Contract/Discovery/Scenario assets: ${cache.status}; discovery: ${discoveryCache.status}. ${cache.reason}` },
    extendedDimensions,
    concurrency: options.concurrency ?? 4,
    businessFlowIds: preliminaryFlowGraph.flows.map((flow) => flow.id),
    regressionGuardCaseIds: regressionGuard.selectedCaseIds,
    estimate: executionEstimate,
    impactFlowIds: affectedFlowIds,
    impactExpandedCaseIds,
    adaptiveScores: selection.adaptiveScores,
    deep: options.deep,
  });
  const renderInput = {
    runId: result.runId,
    meta: { docSource, baseUrl, environment, mode, project, startedAt, finishedAt },
    conclusion,
    report: result.report,
    results: result.results,
    testCases: selection.candidates,
    contracts: result.contracts,
    problems,
    dimensionStats,
    dimensionApplicability: selection.decisions,
    featureModel,
    discovery,
    testValueScores: selection.scores,
    caseProfiles: selection.profiles,
    plan,
    baseline,
    reproduction,
    environmentPreflight,
    uiExecutions,
    pendingMutationCaseIds,
    requirementCoverage,
    invariants,
    devConfidence,
    versionComparison,
    dataLifecycle,
    businessFlowGraph: flowEvaluation.graph,
    stateConsistency: flowEvaluation.consistency,
    regressionGuard,
    executionEstimate,
    oracleResults,
    adaptiveScores: selection.adaptiveScores,
    negativeChecks,
    permissionMatrix,
    pollutionFindings,
    reliability,
    requirementQuality,
    rootCauseGraph,
    requirementModel,
    acceptanceTraces,
    deliveryCoverage,
  };

  const dir = path.join(outDir, result.runId);
  await mkdir(dir, { recursive: true });
  const artifacts = {
    dir,
    reportHtml: path.join(dir, 'report.html'),
    reportJson: path.join(dir, 'report.json'),
    casesCsv: path.join(dir, 'cases.csv'),
    problemsMd: path.join(dir, 'problems.md'),
    acceptanceSummaryMd: path.join(dir, 'acceptance-summary.md'),
  };
  const unknowns = buildDevTestUnknowns(result.report);
  await Promise.all([
    writeFile(artifacts.reportHtml, renderDevTestHtml(renderInput), 'utf8'),
    writeFile(artifacts.reportJson, `${JSON.stringify(buildDevTestReportEnvelope(renderInput), null, 2)}\n`, 'utf8'),
    writeFile(artifacts.casesCsv, renderCasesCsv(renderInput), 'utf8'),
    writeFile(artifacts.problemsMd, renderProblemsMarkdown(problems, { conclusion, unknowns }), 'utf8'),
    writeFile(artifacts.acceptanceSummaryMd, renderAcceptanceSummary(renderInput), 'utf8'),
  ]);
  if (!options.preflight && !options.plan && (!reproduction || reproduction.status === 'REPRODUCED')) {
    await saveDevTestBaseline({
      outDir,
      markdown: originalMarkdown,
      sourceKey: docSource,
      runId: result.runId,
      cases: effectiveCaseStatuses,
      problems,
      testCases: result.testCases,
      baselineDiff: baseline,
      previousBaseline,
      scopeCaseIds: selectedCaseIds,
      requirementAcIds: requirement.acceptanceCriteria.map((criterion) => criterion.criterionId),
      codeVersion: impact.codeFingerprint,
      contractVersion: contractFingerprint,
    });
  }
  if (!options.preflight) await writeDevTestAssetCache({
    outDir,
    sourceKey: docSource,
    requirementFingerprint,
    contractFingerprint,
    codeFingerprint: impact.codeFingerprint,
    featureModel,
    selectedCaseIds: normalSelectedCaseIds,
  });
  if (!options.preflight) await writeDiscoveryStageCache({ outDir, sourceKey: docSource,
    requirementFingerprint, workspaceFingerprint, discovery, featureModel });

  return {
    runId: result.runId,
    conclusion,
    mode,
    pendingMutationCaseIds,
    problems,
    dimensionStats,
    dimensionApplicability: selection.decisions,
    featureModel,
    discovery,
    testValueScores: selection.scores,
    caseProfiles: selection.profiles,
    plan,
    requirementCoverage,
    invariants,
    devConfidence,
    versionComparison,
    dataLifecycle,
    businessFlowGraph: flowEvaluation.graph,
    stateConsistency: flowEvaluation.consistency,
    regressionGuard,
    executionEstimate,
    oracleResults,
    adaptiveScores: selection.adaptiveScores,
    negativeChecks,
    permissionMatrix,
    pollutionFindings,
    reliability,
    requirementQuality,
    rootCauseGraph,
    requirementModel,
    acceptanceTraces,
    deliveryCoverage,
    baseline,
    reproduction,
    environmentPreflight,
    uiExecutions,
    artifacts,
    pipeline: {
      summary: result.report.summary,
      trust: result.report.trust,
      mode: pipelineMode,
      report: result.report,
      contracts: result.contracts,
    },
  };
}
