/** Acceptance 结果 → DevTest 根因问题。这里只归一/聚合，不执行第二套测试逻辑。 */

import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { ContractPreflight } from '../contracts/contract-gate.js';
import { devTestDimensionOf } from './dimension-selector.js';
import type {
  DevTestDimensionStat,
  DevTestFeatureResult,
  DevTestProblem,
  DevTestProblemDimension,
  DevTestProblemSeverity,
  DevTestProblemType,
  DevTestUiExecutionResult,
  DevTestFailureClass,
  DevTestEnvironmentPreflight,
  DevTestProblemJudgement,
  DevTestOracleResult,
  DevTestReliabilitySummary,
} from './types.js';

const SEVERITY_ORDER: Record<DevTestProblemSeverity, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

export function suggestionForReasonCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    SAFE_MODE_MUTATION_HOLD: '保持 SAFE，或在本机 Sandbox/隔离测试租户配置 Cleanup 后显式确认写操作。',
    LIVE_APPROVAL_REQUIRED: '提供可审计的 approvalId、预算与回滚方案后再申请 LIVE。',
    UI_EXECUTOR_UNAVAILABLE: '接入 Browser Processor 与页面状态观察器；当前只能保留为 DESIGNED_ONLY。',
    DATA_EXECUTOR_UNAVAILABLE: '接入独立 State/Data Observer 和双 Actor 隔离 Fixture。',
    EXPECTED_OUTCOME_UNKNOWN: '在 Requirement/Contract 中补充确定性预期，禁止由系统猜测。',
    AUTH_POLICY_UNKNOWN: '明确 AUTH_REQUIRED/AUTH_NOT_REQUIRED 及 Actor 凭据引用。',
    EXECUTION_ACTION_UNAVAILABLE: '在权威 Contract 中提供可绑定的 Method + Path。',
    CLEANUP_POLICY_REQUIRED: '为写路径配置 Cleanup/Rollback；仅本机 loopback Sandbox 可显式豁免。',
    REQUIREMENT_CONTRACT_INCOMPLETE: '补齐冲突或缺失的 Requirement Fact/Contract 后重跑。',
    PROCESSOR_MISSING: '注册支持该 canonical operation/scene 的 Processor。',
    ASSERTION_MISSING: '补充来自 Requirement/Contract 的确定性断言。',
    EVIDENCE_MISSING: '接入独立 Observer，补齐 Request/Response/State/Side Effect 证据。',
    NETWORK_UNREACHABLE: '启动本地被测服务，或用 --base-url 指向可访问的 local/test 环境后重跑。',
    ENVIRONMENT_NOT_PROVIDED_STATIC_ONLY: '提供 --base-url，或在项目/环境配置中声明可审计的测试地址后重跑真实执行。',
    AMBIGUOUS_ENVIRONMENT: '用 --base-url 显式选择唯一被测环境后重跑。',
    AUTH_CONTEXT_INCOMPLETE: '提供至少两个隔离测试身份的 actorHeaders/Token Ref 后重跑权限场景。',
  };
  return map[code];
}

function reasonCodeOf(reason: string | undefined): string | undefined {
  const genericStatuses = new Set(['BLOCKED', 'NOT_EXECUTED', 'FAIL', 'ERROR', 'TIMEOUT', 'CANCELLED']);
  return reason?.match(/[A-Z][A-Z0-9_]{2,}/g)?.find((candidate) => !genericStatuses.has(candidate));
}

function classify(code: string, message: string): {
  type: DevTestProblemType;
  dimension?: DevTestProblemDimension;
} {
  const value = `${code} ${message}`.toUpperCase();
  if (value.includes('CONTRACT_DRIFT') || value.includes('FINGERPRINT')) return { type: 'CONTRACT_DRIFT', dimension: 'CONTRACT' };
  if (value.includes('CONTRACT') && (value.includes('STALE') || value.includes('EXPIRED'))) {
    return { type: 'STALE_CONTRACT', dimension: 'CONTRACT' };
  }
  if (value.includes('CONFLICT')) return { type: 'REQUIREMENT_CONFLICT', dimension: 'CONTRACT' };
  if (value.includes('UNKNOWN_CONTRACT') || value.includes('CONTRACT_UNKNOWN')
    || value.includes('CONTRACT_GATE') || value.includes('MISSING_CONTRACT')
    || value.includes('CONTRACT_MISSING')) {
    return { type: 'UNKNOWN_CONTRACT', dimension: 'CONTRACT' };
  }
  if (value.includes('PROCESSOR')) return { type: 'PROCESSOR_MISSING', dimension: 'EXECUTION' };
  if (value.includes('ASSERTION')) return { type: 'ASSERTION_MISSING', dimension: 'EXECUTION' };
  if (value.includes('EVIDENCE') || value.includes('OBSERVER') || value.includes('OBSERVABILITY')) return { type: 'EVIDENCE_MISSING' };
  if (value.includes('AUTH') || value.includes('ACTOR_CONTEXT') || value.includes('CREDENTIAL')
    || value.includes('TOKEN') || value.includes('SESSION')) return { type: 'AUTH_MISSING', dimension: 'API' };
  if (value.includes('ENVIRONMENT') || value.includes('BASE_URL') || value.includes('ORIGIN')) return { type: 'ENVIRONMENT_MISSING', dimension: 'EXECUTION' };
  if (value.includes('FETCH FAILED') || value.includes('ECONNREFUSED') || value.includes('ENOTFOUND')
    || value.includes('NETWORK_UNREACHABLE')) return { type: 'ENVIRONMENT_MISSING', dimension: 'EXECUTION' };
  if (value.includes('DATA_PREP') || value.includes('TEST_DATA') || value.includes('CLEANUP')) return { type: 'DATA_PREP_FAILED', dimension: 'EXECUTION' };
  if (value.includes('SAFE') || value.includes('MUTATION') || value.includes('APPROVAL')
    || value.includes('BUDGET') || value.includes('COST') || value.includes('BILLABLE')
    || value.includes('EXTERNAL_SIDE_EFFECT') || value.includes('OPERATION_EFFECT_BLOCKED')) {
    return { type: 'SAFE_BLOCKED', dimension: 'EXECUTION' };
  }
  if (value.includes('API_') || value.includes('BINDING') || value.includes('OPERATION')) return { type: 'API_MISSING', dimension: 'API' };
  return { type: 'DISCOVERY_FAILED' };
}

interface DraftProblem extends Omit<DevTestProblem, 'id'> {}

function developerCategory(problem: DraftProblem): NonNullable<DevTestProblem['category']> {
  const value = `${problem.type} ${problem.reasonCode ?? ''} ${problem.message}`.toUpperCase();
  if (problem.type === 'REQUIREMENT_CONFLICT') return 'Requirement Conflict';
  if (problem.type === 'REQUIREMENT_QUALITY') return 'Requirement Quality';
  if (problem.type === 'FLAKY_TEST' || problem.type === 'TEST_POLLUTION') return 'Test Reliability';
  if (problem.type === 'DATA_CONSISTENCY_BUG' || problem.type === 'FEATURE_BUG' || problem.type === 'BUSINESS_RULE_BUG'
    || problem.type === 'REGRESSION_BUG') return 'State Error';
  if (problem.dimension === 'UI') return 'UI Behavior Error';
  if (problem.dimension === 'DATA_ISOLATION' || value.includes('ISOLATION')) return 'Data Isolation Error';
  if (value.includes('PERMISSION') || value.includes('AUTHORIZATION')) return 'Permission Error';
  if (problem.dimension === 'PARAMETER_VALIDATION') return 'Parameter Validation Error';
  if (value.includes('BILL') || value.includes('CHARGE') || value.includes('COST')) return 'Billing Error';
  if (value.includes('PROVIDER') || value.includes('EXTERNAL')) return 'Provider Error';
  if (value.includes('STATE')) return 'State Error';
  if (problem.type === 'TEST_FAILED' && problem.dimension === 'API') return 'API Behavior Error';
  if (problem.dimension === 'API' || problem.dimension === 'CONTRACT') return 'API Contract Error';
  if (problem.dimension === 'EXECUTION' || problem.type === 'ENVIRONMENT_MISSING' || problem.type === 'SAFE_BLOCKED') return 'Environment Block';
  return 'Unknown';
}

function failureClass(problem: DraftProblem): DevTestFailureClass {
  const value = `${problem.type} ${problem.reasonCode ?? ''} ${problem.message}`.toUpperCase();
  if (problem.type === 'TEST_FAILED' || ['FEATURE_BUG', 'BUSINESS_RULE_BUG', 'DATA_CONSISTENCY_BUG', 'REGRESSION_BUG'].includes(problem.type)
    || value.includes('UI_ASSERTION_FAILED')) return 'PRODUCT_BUG';
  if (problem.type === 'REQUIREMENT_CONFLICT' || ['UNKNOWN_CONTRACT', 'CONTRACT_DRIFT', 'STALE_CONTRACT', 'API_MISSING'].includes(problem.type)) return 'CONTRACT_ISSUE';
  if (problem.type === 'AUTH_MISSING' || value.includes('AUTH_CONTEXT')) return 'AUTH_ISSUE';
  if (problem.type === 'DATA_PREP_FAILED') return 'DATA_ISSUE';
  if (problem.type === 'ENVIRONMENT_MISSING' || problem.type === 'SAFE_BLOCKED' || value.includes('ENVIRONMENT') || value.includes('NETWORK')) return 'ENVIRONMENT_ISSUE';
  if (problem.type === 'PROCESSOR_MISSING' || problem.type === 'ASSERTION_MISSING' || problem.type === 'EVIDENCE_MISSING') return 'TEST_ISSUE';
  if (problem.type === 'FLAKY_TEST' || problem.type === 'TEST_POLLUTION') return 'TEST_ISSUE';
  if (problem.type === 'REQUIREMENT_QUALITY') return 'REQUIREMENT_ISSUE';
  return 'UNSUPPORTED';
}

function calibratedConfidence(problem: DraftProblem, context: {
  contract: number;
  environment: number;
}): { score: number; factors: NonNullable<DevTestProblem['confidenceFactors']>; judgement: DevTestProblemJudgement; why: string } {
  const hasRequest = problem.request !== undefined;
  const hasResponse = problem.response !== undefined;
  const evidenceItems = Array.isArray(problem.evidence) ? problem.evidence.length : problem.evidence ? 1 : 0;
  const businessEvidence = ['FEATURE_BUG', 'BUSINESS_RULE_BUG', 'DATA_CONSISTENCY_BUG', 'REGRESSION_BUG'].includes(problem.type);
  const execution = hasRequest && hasResponse ? 1 : businessEvidence && evidenceItems > 0 ? (problem.reproducible ? 1 : 0.9)
    : problem.reproducible ? 0.85 : 0.25;
  const assertion = (problem.type === 'TEST_FAILED' || businessEvidence) && evidenceItems > 0 ? 1
    : ['ASSERTION_MISSING', 'EVIDENCE_MISSING', 'PROCESSOR_MISSING'].includes(problem.type) ? 0.9 : 0.55;
  const evidence = hasRequest && hasResponse && evidenceItems > 0 ? 1 : businessEvidence && evidenceItems > 0 ? 1
    : evidenceItems > 0 ? 0.65 : 0.2;
  const reproducibility = problem.reproducible ? 1 : 0.25;
  const factors = { execution, assertion, evidence, contract: context.contract,
    environment: context.environment, reproducibility };
  const score = Math.round((execution * 0.20 + assertion * 0.20 + evidence * 0.20
    + context.contract * 0.15 + context.environment * 0.10 + reproducibility * 0.15) * 100) / 100;
  const failure = problem.failureClass ?? failureClass(problem);
  const confirmed = failure === 'PRODUCT_BUG' && execution >= 0.9 && assertion >= 0.9
    && evidence >= 0.9 && context.contract >= 0.75 && context.environment >= 0.7 && reproducibility >= 0.9;
  const judgement: DevTestProblemJudgement = confirmed ? 'CONFIRMED_BUG'
    : failure === 'PRODUCT_BUG' ? 'LIKELY_BUG'
      : failure === 'TEST_ISSUE' ? 'TEST_ISSUE'
        : failure === 'REQUIREMENT_ISSUE' ? 'REQUIREMENT_ISSUE'
        : failure === 'ENVIRONMENT_ISSUE' || failure === 'AUTH_ISSUE' || failure === 'DATA_ISSUE' ? 'ENVIRONMENT_ISSUE'
          : failure === 'CONTRACT_ISSUE' ? 'CONTRACT_ISSUE' : 'UNKNOWN';
  return {
    score,
    factors,
    judgement,
    why: `Execution ${execution.toFixed(2)} + Assertion ${assertion.toFixed(2)} + Evidence ${evidence.toFixed(2)} + Contract ${context.contract.toFixed(2)} + Environment ${context.environment.toFixed(2)} + Reproducibility ${reproducibility.toFixed(2)}`,
  };
}

function rootCauseOf(problem: DraftProblem): string {
  if (problem.rootCause) return problem.rootCause;
  const value = `${problem.dimension} ${problem.category ?? ''} ${problem.reasonCode ?? ''} ${JSON.stringify(problem.evidence ?? '')}`.toUpperCase();
  if (/AUTH|PERMISSION|ISOLATION|403|401/.test(value)) return 'AUTHORIZATION_POLICY';
  if (/STATUS_CODE.*EXPECTED.?400/.test(value)) return 'PARAMETER_REJECTION';
  if (/STATE|MUTATION|UNCHANGED/.test(value)) return 'STATE_INVARIANT';
  if (/CONTRACT|FINGERPRINT/.test(value)) return 'CONTRACT_RESOLUTION';
  if (/NETWORK|ECONN|TIMEOUT|ENVIRONMENT/.test(value)) return 'ENVIRONMENT_CONNECTIVITY';
  return `${problem.failureClass ?? failureClass(problem)}:${problem.reasonCode ?? problem.type}`;
}

function dedupe(drafts: DraftProblem[], context: { contract: number; environment: number }): DevTestProblem[] {
  const merged = new Map<string, DraftProblem>();
  for (const draft of drafts) {
    const rootCause = rootCauseOf(draft);
    const failure = draft.failureClass ?? failureClass(draft);
    // Product assertion failures may fan out across many Cases but share one implementation root cause.
    // Contract/environment/test issues retain their semantic type so UNKNOWN_CONTRACT is not hidden by a conflict.
    const key = failure === 'PRODUCT_BUG' ? `${failure}::${rootCause}` : `${failure}::${rootCause}::${draft.type}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...draft, rootCause, affectedCases: [...draft.affectedCases] });
      continue;
    }
    existing.affectedCases = [...new Set([...existing.affectedCases, ...draft.affectedCases])];
    if (SEVERITY_ORDER[draft.severity] < SEVERITY_ORDER[existing.severity]) existing.severity = draft.severity;
    if (Array.isArray(existing.evidence) && Array.isArray(draft.evidence)) {
      existing.evidence = [...new Set([...existing.evidence, ...draft.evidence])].slice(0, 10);
    }
  }
  return [...merged.values()]
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
      || left.type.localeCompare(right.type))
    .map((problem, index) => {
      const failure = problem.failureClass ?? failureClass(problem);
      const calibrated = calibratedConfidence({ ...problem, failureClass: failure }, context);
      const confidence = calibrated.score;
      return {
        ...problem,
        id: `P${String(index + 1).padStart(3, '0')}`,
        category: problem.category ?? developerCategory(problem),
        confidence,
        confidenceLabel: calibrated.judgement === 'CONFIRMED_BUG' ? 'CONFIRMED'
          : confidence >= 0.55 ? 'LIKELY' : 'UNKNOWN',
        affectedFeature: problem.affectedFeature ?? '当前 Requirement 功能',
        reproduction: problem.reproduction ?? (problem.affectedCases.length
          ? ['执行 DevTest', `重跑关联 Case：${problem.affectedCases.join(', ')}`, '查看对应 Evidence 与实际结果']
          : ['执行 DevTest', '查看该根因对应的 Contract/Environment Evidence']),
        expected: problem.expected ?? 'Requirement、Contract 与安全门禁要求全部满足',
        actual: problem.actual ?? problem.message,
        failureClass: failure,
        reproducible: problem.reproducible ?? false,
        judgement: calibrated.judgement,
        confidenceFactors: calibrated.factors,
        why: calibrated.why,
        rootCause: problem.rootCause ?? rootCauseOf(problem),
        minimalReproduction: {
          preconditions: problem.reproduction?.slice(0, 1) ?? [],
          request: problem.request,
          input: problem.request && typeof problem.request === 'object'
            ? { body: (problem.request as Record<string, unknown>).body, query: (problem.request as Record<string, unknown>).query } : undefined,
          actor: problem.request && typeof problem.request === 'object' ? (problem.request as Record<string, unknown>).actor : undefined,
          expected: problem.expected,
          actual: problem.actual,
          evidence: problem.evidence,
        },
      };
    });
}

function severityFor(type: DevTestProblemType, allBlocked: boolean): DevTestProblemSeverity {
  if (type === 'CONTRACT_DRIFT' || type === 'REQUIREMENT_CONFLICT' || type === 'TEST_FAILED') return 'CRITICAL';
  if (['UNKNOWN_CONTRACT', 'STALE_CONTRACT', 'PROCESSOR_MISSING', 'ASSERTION_MISSING'].includes(type)) return 'HIGH';
  if (allBlocked || ['EVIDENCE_MISSING', 'AUTH_MISSING', 'DATA_PREP_FAILED'].includes(type)) return 'HIGH';
  if (type === 'SAFE_BLOCKED' || type === 'API_MISSING' || type === 'ENVIRONMENT_MISSING') return 'MEDIUM';
  return 'LOW';
}

export interface DevTestProblemInput {
  report: AcceptanceReport;
  contracts?: ContractPreflight;
  results: Array<{
    caseId: string;
    status?: string;
    executed?: boolean;
    priority?: string;
    processor?: string;
    processorInvoked?: boolean;
    assertions?: number;
    error?: string;
    attribution?: { reason?: string };
    evidence?: { assertions?: Array<{ pass?: boolean; detail?: string; expected?: unknown; actual?: unknown }>; request?: unknown; response?: unknown };
  }>;
  requirementWarnings: Array<{ code?: string; message?: string; blocking?: boolean }>;
  syntheticBlocks?: Array<{ code: string; message: string; affectedCases?: string[]; dimension?: DevTestProblemDimension }>;
  uiResults?: readonly DevTestUiExecutionResult[];
  environment?: { name?: string; baseUrl?: string };
  environmentPreflight?: DevTestEnvironmentPreflight;
  preflightOnly?: boolean;
  reproductionRun?: boolean;
  oracleResults?: readonly DevTestOracleResult[];
  reliability?: DevTestReliabilitySummary;
  pollutedCaseIds?: ReadonlySet<string>;
}

export function buildDevTestProblems(input: DevTestProblemInput): {
  problems: DevTestProblem[];
  dimensionStats: DevTestDimensionStat[];
} {
  const dimensionByCase = new Map(input.report.cases.map((item) => [item.caseId, devTestDimensionOf(item.testType)]));
  const drafts: DraftProblem[] = [];
  const oracleByCase = new Map((input.oracleResults ?? []).map((item) => [item.caseId, item]));
  const reliabilityByCase = new Map((input.reliability?.cases ?? []).map((item) => [item.caseId, item]));
  const allBlocked = input.report.summary.designed > 0 && input.report.summary.executed === 0;

  for (const resolution of input.contracts?.resolutions ?? []) {
    if (resolution.status === 'RESOLVED') continue;
    const contractId = resolution.query.id ?? resolution.query.subject ?? 'unknown-contract';
    const classified = classify(`CONTRACT_${resolution.status}`, resolution.reason ?? 'Contract 未解析');
    drafts.push({
      type: classified.type,
      severity: severityFor(classified.type, allBlocked),
      dimension: 'CONTRACT',
      message: `${contractId}：${resolution.reason ?? resolution.status}`,
      evidence: resolution.sources,
      remediation: suggestionForReasonCode('REQUIREMENT_CONTRACT_INCOMPLETE'),
      affectedCases: input.report.cases.map((item) => item.caseId),
      reasonCode: `CONTRACT_${resolution.status}`,
    });
  }
  const hasResolutionRoot = (input.contracts?.resolutions ?? []).some((resolution) => resolution.status !== 'RESOLVED');
  // BLOCKED/STALE 通常只是上面各 Contract resolution 的汇总，不能再制造一个重复 Root Problem。
  // Fingerprint Drift 可能发生在 RESOLVED Contract 上，必须保留独立 Gate 根因。
  if (input.contracts && input.contracts.validation.status !== 'VALID'
    && (input.contracts.validation.status === 'CONTRACT_DRIFT' || !hasResolutionRoot)) {
    const code = `CONTRACT_GATE_${input.contracts.validation.status}`;
    const classified = classify(code, input.contracts.validation.reasons.join('；'));
    drafts.push({
      type: classified.type,
      severity: severityFor(classified.type, true),
      dimension: 'CONTRACT',
      message: input.contracts.validation.reasons.join('；') || code,
      evidence: input.contracts.validation.dependencies,
      remediation: suggestionForReasonCode('REQUIREMENT_CONTRACT_INCOMPLETE'),
      affectedCases: input.report.cases.map((item) => item.caseId),
      reasonCode: code,
    });
  }

  for (const warning of input.requirementWarnings.filter((item) => item.blocking)) {
    const code = warning.code ?? 'REQUIREMENT_CONFLICT';
    const classified = classify(code, warning.message ?? 'Requirement 不完整');
    drafts.push({
      type: classified.type === 'DISCOVERY_FAILED' ? 'REQUIREMENT_CONFLICT' : classified.type,
      severity: 'HIGH',
      dimension: 'CONTRACT',
      message: warning.message ?? code,
      evidence: [warning.message ?? code],
      remediation: suggestionForReasonCode('REQUIREMENT_CONTRACT_INCOMPLETE'),
      affectedCases: input.report.cases.map((item) => item.caseId),
      reasonCode: code,
    });
  }

  for (const block of input.syntheticBlocks ?? []) {
    const classified = classify(block.code, block.message);
    drafts.push({
      type: classified.type,
      severity: severityFor(classified.type, true),
      dimension: block.dimension ?? classified.dimension ?? 'EXECUTION',
      message: block.message,
      evidence: [block.code],
      remediation: suggestionForReasonCode(block.code),
      affectedCases: block.affectedCases ?? input.report.cases.map((item) => item.caseId),
      reasonCode: block.code,
    });
  }

  for (const result of input.results) {
    const dimension = dimensionByCase.get(result.caseId) ?? 'EXECUTION';
    // UI 有独立 Browser 执行结果时，Acceptance API 的 DESIGNED_ONLY/NOT_EXECUTED
    // 只是路由占位，不得再生成第二个“未执行”问题。
    if (dimension === 'UI' && input.uiResults?.some((item) => item.caseId === result.caseId)) continue;
    const oracle = oracleByCase.get(result.caseId);
    // HTTP assertions 可以通过，但独立状态/差分快照仍可能证明副作用违反 Expected。
    // 这种失败必须消费统一 Oracle，不能被 raw PASS 分支吞掉。
    if (result.status !== 'FAIL' && oracle?.verdict === 'FAIL' && oracle.evidence.complete) {
      drafts.push({
        type: 'TEST_FAILED', severity: result.priority === 'P0' ? 'CRITICAL' : 'HIGH', dimension,
        caseId: result.caseId, message: oracle.reason, evidence: [oracle.actual],
        remediation: '根据独立 Observer/Snapshot 证据修复状态或副作用，再以相同输入复测。',
        affectedCases: [result.caseId], reasonCode: 'ORACLE_STATE_MISMATCH', failureClass: 'PRODUCT_BUG',
        reproducible: input.reproductionRun === true,
        reproduction: ['使用报告中的 Actor、Request 与前置快照执行 Case', '比较 BEFORE 与 AFTER_EXECUTE', `重跑 Case：${result.caseId}`],
        request: result.evidence?.request, response: result.evidence?.response, environment: input.environment,
        expected: JSON.stringify(oracle.expected), actual: JSON.stringify(oracle.actual),
      });
      continue;
    }
    if (result.status === 'FAIL') {
      const details = (result.evidence?.assertions ?? []).filter((item) => item.pass === false)
        .map((item) => item.detail ?? `expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}`);
      const errorText = `${result.error ?? ''} ${details.join(' ')}`;
      const reliability = reliabilityByCase.get(result.caseId);
      const environmentFailure = /timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(errorText)
        || ['HTTP_5XX', 'TIMEOUT', 'SLOW_RESPONSE', 'BROWSER_ERROR', 'ENVIRONMENT'].includes(oracle?.transientSignal ?? '');
      const provenAssertion = result.executed === true && details.length > 0
        && result.evidence?.request !== undefined && result.evidence?.response !== undefined;
      const polluted = input.pollutedCaseIds?.has(result.caseId) === true;
      const flaky = reliability?.status === 'FLAKY';
      const oracleProvesProduct = oracle ? oracle.verdict === 'FAIL' && oracle.evidence.complete : provenAssertion;
      const failure: DevTestFailureClass = polluted || flaky ? 'TEST_ISSUE'
        : environmentFailure ? 'ENVIRONMENT_ISSUE' : oracleProvesProduct ? 'PRODUCT_BUG' : 'TEST_ISSUE';
      drafts.push({
        type: polluted ? 'TEST_POLLUTION' : flaky ? 'FLAKY_TEST' : environmentFailure ? 'ENVIRONMENT_MISSING'
          : oracle?.verdict === 'UNKNOWN' ? 'EVIDENCE_MISSING' : 'TEST_FAILED',
        severity: polluted || flaky ? 'MEDIUM' : result.priority === 'P0' ? 'CRITICAL' : 'HIGH', dimension,
        caseId: result.caseId, message: polluted ? '前序 Case 污染了当前 Case，禁止归因产品 Bug'
          : flaky ? `Case 历史结果波动（flakeRate=${reliability.flakeRate.toFixed(2)}），转入 Test Reliability`
            : oracle?.reason ?? result.error?.replace(/^FAIL[:：]\s*/, '') ?? '确定性断言失败',
        evidence: details, remediation: '修复产品/环境根因后单独重跑该 Case，并保留执行证据。',
        affectedCases: [result.caseId], reasonCode: polluted ? 'TEST_POLLUTION' : flaky ? 'FLAKY_TEST'
          : environmentFailure ? oracle?.transientSignal ?? 'NETWORK_UNREACHABLE' : oracle?.verdict === 'UNKNOWN' ? 'ORACLE_INCOMPLETE' : 'TEST_FAILED',
        failureClass: failure,
        reproducible: Boolean(oracleProvesProduct && input.reproductionRun && !polluted && !flaky && !environmentFailure),
        reproduction: ['使用报告中的 Environment 与 Request 发起请求', '比较实际 Response 与确定性 Assertion', `重跑 Case：${result.caseId}`],
        request: result.evidence?.request,
        response: result.evidence?.response,
        environment: input.environment,
        expected: oracle ? JSON.stringify(oracle.expected) : details.join('；') || '所有确定性断言通过',
        actual: result.error ?? '断言失败',
      });
      continue;
    }
    if (result.status === 'PASS') {
      if (result.executed !== true || result.processorInvoked !== true || !result.processor?.trim()) {
        drafts.push({ type: 'PROCESSOR_MISSING', severity: 'HIGH', dimension, caseId: result.caseId,
          message: 'PASS 缺少真实 Processor 执行证明', evidence: [result], remediation: suggestionForReasonCode('PROCESSOR_MISSING'),
          affectedCases: [result.caseId], reasonCode: 'PROCESSOR_MISSING' });
      }
      if ((result.assertions ?? result.evidence?.assertions?.length ?? 0) < 1) {
        drafts.push({ type: 'ASSERTION_MISSING', severity: 'HIGH', dimension, caseId: result.caseId,
          message: 'PASS 没有有效断言', evidence: [result], remediation: suggestionForReasonCode('ASSERTION_MISSING'),
          affectedCases: [result.caseId], reasonCode: 'ASSERTION_MISSING' });
      }
      if (!result.evidence?.request || !result.evidence?.response || !result.evidence?.assertions?.length) {
        drafts.push({ type: 'EVIDENCE_MISSING', severity: 'HIGH', dimension, caseId: result.caseId,
          message: 'PASS 缺少 Required Evidence', evidence: [result], remediation: suggestionForReasonCode('EVIDENCE_MISSING'),
          affectedCases: [result.caseId], reasonCode: 'EVIDENCE_MISSING' });
      }
      continue;
    }
    if (!['BLOCKED', 'NOT_EXECUTED', 'TIMEOUT', 'CANCELLED'].includes(result.status ?? '')) continue;
    // Acceptance 的 Pipeline Gate 在 attribution 中保留的是稳定的阶段描述，
    // 具体 fail-closed reasonCode 位于 error（例如 MUTATION_POLICY_BLOCKED）。
    // DevTest 必须优先保留具体根因，否则高风险阻断会退化成笼统 DISCOVERY_FAILED。
    const message = result.error ?? result.attribution?.reason ?? result.status ?? 'NOT_EXECUTED';
    if (input.preflightOnly && /DRY_RUN|NOT_EXECUTED/i.test(message)) continue;
    const code = reasonCodeOf(message)
      ?? (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message) ? 'NETWORK_UNREACHABLE' : String(result.status));
    const classified = classify(code, message);
    drafts.push({
      type: classified.type,
      severity: severityFor(classified.type, allBlocked),
      dimension: classified.dimension ?? dimension,
      caseId: result.caseId,
      message,
      evidence: [message],
      remediation: suggestionForReasonCode(code),
      affectedCases: [result.caseId],
      reasonCode: code,
      failureClass: classified.type === 'AUTH_MISSING' ? 'AUTH_ISSUE'
        : classified.type === 'DATA_PREP_FAILED' ? 'DATA_ISSUE'
          : classified.type === 'ENVIRONMENT_MISSING' ? 'ENVIRONMENT_ISSUE' : 'UNSUPPORTED',
      reproducible: false,
      request: result.evidence?.request,
      response: result.evidence?.response,
      environment: input.environment,
    });
  }

  for (const result of input.uiResults ?? []) {
    const oracle = oracleByCase.get(result.caseId);
    if (result.status === 'PASS' && oracle?.verdict === 'PASS' && oracle.evidence.complete) continue;
    const failed = result.status === 'FAIL' && result.executed && result.assertions.some((assertion) => !assertion.pass)
      && oracle?.verdict === 'FAIL' && oracle.evidence.complete;
    const evidenceIncomplete = result.status === 'PASS' && !failed;
    drafts.push({
      type: failed ? 'TEST_FAILED' : evidenceIncomplete ? 'EVIDENCE_MISSING'
        : result.classification === 'ENVIRONMENT_ISSUE' ? 'ENVIRONMENT_MISSING' : 'DISCOVERY_FAILED',
      severity: failed || evidenceIncomplete ? 'HIGH' : 'MEDIUM', dimension: 'UI', caseId: result.caseId,
      message: evidenceIncomplete ? oracle?.reason ?? 'UI PASS 缺少完整确定性 Evidence' : result.error ?? `UI ${result.status}`,
      evidence: result.evidence,
      remediation: failed ? '根据稳定 Locator 修复缺失元素或错误页面状态后，用 --rerun 精确复测。'
        : result.classification === 'ENVIRONMENT_ISSUE' ? suggestionForReasonCode('NETWORK_UNREACHABLE') : suggestionForReasonCode('UI_EXECUTOR_UNAVAILABLE'),
      affectedCases: [result.caseId], reasonCode: failed ? 'UI_ASSERTION_FAILED'
        : evidenceIncomplete ? 'EVIDENCE_MISSING' : result.error?.split('：')[0] ?? 'UI_BLOCKED',
      failureClass: failed ? 'PRODUCT_BUG' : evidenceIncomplete ? 'TEST_ISSUE' : result.classification ?? 'UNSUPPORTED',
      reproducible: failed && input.reproductionRun === true,
      reproduction: result.steps,
      request: { url: result.url, steps: result.steps },
      response: result.assertions,
      environment: input.environment,
      expected: result.assertions.map((item) => item.expected).join('；') || '页面与 Requirement 绑定状态可观察',
      actual: result.assertions.map((item) => item.actual).join('；') || result.error,
    });
  }

  for (const issue of input.report.bindingIssues) {
    const classified = classify(issue.code, issue.message);
    drafts.push({
      type: classified.type === 'DISCOVERY_FAILED' ? 'API_MISSING' : classified.type,
      severity: 'HIGH', dimension: 'API', message: issue.message, evidence: [issue],
      remediation: '补齐权威 Method + Path + Request/Response Contract 后重跑。',
      affectedCases: issue.sourceTestPointId
        ? input.report.cases.filter((item) => item.evidence.testPointId === issue.sourceTestPointId).map((item) => item.caseId)
        : [],
      reasonCode: issue.code,
    });
  }
  for (const gap of input.report.observationGaps) {
    if (devTestDimensionOf(gap.testType) === 'UI'
      && gap.caseIds.length > 0
      && gap.caseIds.every((caseId) => input.uiResults?.some((result) => result.caseId === caseId && result.status === 'PASS'))) continue;
    drafts.push({
      type: 'EVIDENCE_MISSING', severity: 'HIGH', dimension: devTestDimensionOf(gap.testType),
      message: gap.missingObservation, evidence: [gap], remediation: `接入 ${gap.requiredCapability}`,
      affectedCases: gap.caseIds, reasonCode: 'EVIDENCE_MISSING',
    });
  }

  const contractConfidence = input.contracts?.validation.status === 'VALID' ? 1
    : input.contracts?.validation.status === 'CONTRACT_DRIFT' ? 0.3 : input.contracts ? 0.55 : 0.5;
  const environmentConfidence = input.environmentPreflight?.status === 'READY' ? 1
    : input.environmentPreflight?.status === 'PARTIAL' ? 0.7
      : input.environmentPreflight?.status === 'BLOCKED' ? 0.2 : 0.6;
  const problems = dedupe(drafts, { contract: contractConfidence, environment: environmentConfidence });
  const stats = new Map<string, DevTestDimensionStat>();
  for (const dimension of ['API', 'FUNCTIONAL', 'UI', 'DATA_ISOLATION', 'PARAMETER_VALIDATION'] as const) {
    stats.set(dimension, { dimension, total: 0, executable: 0, passed: 0, failed: 0, blocked: 0, notExecuted: 0 });
  }
  const resultByCase = new Map(input.results.map((result) => [result.caseId, result]));
  for (const item of input.report.cases) {
    const stat = stats.get(devTestDimensionOf(item.testType))!;
    stat.total += 1;
    if (item.executionMode === 'EXECUTABLE') stat.executable += 1;
    const status = resultByCase.get(item.caseId)?.status ?? item.executionStatus;
    if (status === 'PASS') stat.passed += 1;
    else if (status === 'FAIL') stat.failed += 1;
    else if (status === 'BLOCKED') stat.blocked += 1;
    else stat.notExecuted += 1;
  }
  return { problems, dimensionStats: [...stats.values()] };
}

/** P0 和 Required Evidence 是权威；BLOCKED 不能被 PASS 数量平均掉。 */
export function deriveDevTestConclusion(
  report: AcceptanceReport,
  problems: readonly DevTestProblem[] = [],
  statusOverrides: ReadonlyMap<string, string> = new Map(),
  core?: { caseIds: readonly string[]; verifiedCaseIds: ReadonlySet<string>; trustedBaselinePassIds?: ReadonlySet<string> },
): DevTestFeatureResult {
  const p0 = report.cases.filter((item) => item.priority === 'P0');
  const executionByCase = new Map(report.executions.map((item) => [item.caseId, item]));
  if (p0.some((item) => {
    const execution = executionByCase.get(item.caseId);
    return (statusOverrides.get(item.caseId) ?? execution?.status) === 'FAIL' && (execution?.executed === true || statusOverrides.has(item.caseId));
  })) return 'NOT_READY';
  const observedProductFailure = problems.some((problem) => problem.judgement === 'CONFIRMED_BUG'
    || problem.judgement === 'LIKELY_BUG' || problem.failureClass === 'PRODUCT_BUG');
  if (observedProductFailure) return 'NOT_READY';
  const statusOf = (caseId: string, fallback: string): string => statusOverrides.get(caseId) ?? fallback;
  const coreIds = core?.caseIds.length ? core.caseIds : p0.map((item) => item.caseId);
  const reportByCase = new Map(report.cases.map((item) => [item.caseId, item]));
  const coreIncomplete = coreIds.some((caseId) => {
    if (core?.trustedBaselinePassIds?.has(caseId)) return false;
    const item = reportByCase.get(caseId);
    if (!item || statusOf(caseId, item.executionStatus) !== 'PASS') return true;
    if (core) return !core.verifiedCaseIds.has(caseId);
    return false;
  });
  if (!coreIds.length || coreIncomplete) return 'BLOCKED';
  const criticalUnknown = problems.some((problem) => problem.failureClass !== 'PRODUCT_BUG'
    && (problem.severity === 'CRITICAL' || problem.severity === 'HIGH'));
  if (criticalUnknown) return 'BLOCKED';
  return 'READY';
}
