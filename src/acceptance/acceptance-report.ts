import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DefectDraft } from '../agents/defect/defect-schema.js';
import {
  isDesignedOnlyCase,
  type TestCase,
  type TestType,
} from '../agents/test-design/testcase-schema.js';
import { redactSensitive, redactSensitiveText } from '../core/redact.js';
import type {
  AcceptanceCaseExecutionResult,
  AcceptanceExecutionClassification,
  AcceptanceExecutionEvidence,
} from './api-processor.js';
import type {
  AcceptanceRequirement,
  ApiBindingIssue,
  RequirementFact,
  RequirementFactCategory,
  RequirementFactStatus,
  RequirementSourceSpan,
} from './requirement-ir.js';
import type { TestPoint } from './test-point.js';
import type {
  TestDimension,
  TestDimensionDecision,
  TestObjective,
  TestScenario,
} from './test-objective.js';
import {
  AcceptanceRegressionError,
  buildFactBasedRegressionPlan,
  type FactBasedRegressionPlan,
} from './acceptance-regression.js';
import type { TestCaseQualityGateResult } from './test-case-quality-gate.js';
import { buildBusinessModelProjection } from './business-model.js';

/** INITIAL_VALIDATION 的总体结论；不等同于正式验收或发布证明。 */
export type AcceptanceConclusion = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL';
export type AcceptanceResultStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED' | 'TIMEOUT' | 'CANCELLED';
export type AcceptanceCoverageValue = number | 'NOT_AVAILABLE';

export interface AcceptanceBusinessCoverage {
  total: number;
  generated: AcceptanceCoverageValue;
  executable: AcceptanceCoverageValue;
  executed: AcceptanceCoverageValue;
  verified: AcceptanceCoverageValue;
}

export interface AcceptanceTypeStatistics {
  total: number;
  executable: number;
  designedOnly: number;
  passed: number;
  failed: number;
  blocked: number;
  notExecuted: number;
  timedOut: number;
  cancelled: number;
}

export interface AcceptanceCriteriaResult {
  criterionId: string;
  objective: string;
  testPointIds: string[];
  testCaseIds: string[];
  results: AcceptanceResultStatus[];
}

export interface AcceptanceRisk {
  caseId: string;
  status: string;
  classification:
    | AcceptanceExecutionClassification
    | 'REQUIREMENT_WARNING'
    | 'REQUIREMENT_FACT'
    | 'DATA_LIFECYCLE'
    | 'BINDING'
    | 'RESULT_INTEGRITY';
  description: string;
}

export interface NotTestedItem {
  caseId: string;
  testType?: TestType;
  reason: string;
  suggestion?: string;
}

export interface AcceptanceObservationGap {
  id: string;
  status: 'PARTIALLY_VERIFIED' | 'UNVERIFIED';
  testType: TestType;
  factIds: string[];
  objectiveIds: string[];
  caseIds: string[];
  requirement: string[];
  currentlyVerified: string;
  missingObservation: string;
  requiredCapability: string;
  impact: string;
}

export interface AcceptanceCaseReportItem {
  caseId: string;
  schemaVersion?: TestCase['schemaVersion'];
  testType: TestType;
  testAspects: NonNullable<TestCase['testAspects']>;
  priority: TestCase['priority'];
  requirementStatus?: TestCase['requirementStatus'];
  scenario: string;
  businessScenario?: TestCase['businessScenario'];
  preconditions: string[];
  preconditionPlan: NonNullable<TestCase['preconditionPlan']>;
  actor: TestCase['actor'] | null;
  input: unknown;
  testData: NonNullable<TestCase['testData']>;
  steps: TestCase['steps'];
  assertions: TestCase['assertions'];
  expected?: TestCase['expected'];
  expectedResult: string;
  evidenceRequirements: NonNullable<TestCase['evidenceRequirements']>;
  oracle?: TestCase['oracle'];
  prepare: NonNullable<TestCase['prepare']>;
  cleanup: NonNullable<TestCase['cleanup']>;
  dependencies: NonNullable<TestCase['dependencies']>;
  readiness?: TestCase['readiness'];
  sourceFactIds: string[];
  sourceObjectiveIds: string[];
  executionMode: TestCase['executionMode'];
  executionStatus: AcceptanceResultStatus;
  qualityStatus: 'READY' | 'DESIGNED_ONLY' | 'BLOCKED' | 'NOT_AVAILABLE';
  qualityIssues: string[];
  evidence: AcceptanceExecutionEvidence;
}

export interface AcceptanceCoreIssue {
  id: string;
  severity: 'P0' | 'P1' | 'P2';
  kind: 'DEFECT' | 'RISK' | 'OBSERVATION_GAP';
  title: string;
  description: string;
  impact: string;
  affectedFactIds: string[];
  affectedObjectiveIds: string[];
  affectedCaseIds: string[];
}

export interface RequirementFactReportItem {
  id: string;
  category: RequirementFactCategory;
  statement: string;
  status: RequirementFactStatus;
  provenance: RequirementFact['provenance'];
  source: RequirementSourceSpan;
  linkedObjectiveIds: string[];
  reason?: string;
  suggestion: string;
}

export interface AcceptanceReportDefect extends DefectDraft {
  classification: 'PRODUCT_DEFECT' | 'ENVIRONMENT_FAILURE' | 'TEST_DATA_FAILURE' | 'REQUIREMENT_AMBIGUITY' | 'UNVERIFIED';
  requirementFactIds: string[];
  requirementStatements: string[];
  affectedFactIds: string[];
  affectedObjectiveIds: string[];
  affectedCaseIds: string[];
  suspectedLayer: string;
}

export interface AcceptanceReport {
  runId: string;
  parentRunId?: string;
  project: string;
  environment: string;
  mode: 'execute' | 'dry-run';
  validationStage: 'INITIAL_VALIDATION';
  generatedAt: string;
  requirement: {
    id: string;
    title: string;
    documentId?: string;
    acceptanceCriteria: number;
  };
  requirementUnderstanding: {
    facts: {
      total: number;
      normative: number;
      consumed: number;
      unverified: number;
      blocked: number;
      nonNormative: number;
    };
    byCategory: Partial<Record<RequirementFactCategory, number>>;
    ledger: RequirementFactReportItem[];
  };
  scope: {
    pages: string[];
    apis: string[];
    dimensions: TestDimension[];
    factIds: string[];
    objectiveIds: string[];
    scenarioIds: string[];
    testPointIds: string[];
    testCaseIds: string[];
  };
  testDesign: {
    summary: {
      objectives: number;
      scenarios: number;
      hybridScenarios: number;
      cases: number;
      executable: number;
      designedOnly: number;
    };
    dimensionDecisions: TestDimensionDecision[];
    objectives: TestObjective[];
    scenarios: TestScenario[];
  };
  caseQuality: {
    generated: number;
    retained: number;
    deduplicated: number;
    ready: number;
    designedOnly: number;
    blocked: number;
    businessChecks?: TestCaseQualityGateResult['businessChecks'];
  };
  summary: {
    /** 兼容 CLI/既有消费方；等于 designed。 */
    total: number;
    designed: number;
    executable: number;
    designedOnly: number;
    executed: number;
    passed: number;
    failed: number;
    blocked: number;
    notExecuted: number;
    timedOut: number;
    cancelled: number;
    /** 未验证的规范性 Requirement Fact 数；不与 Case 数混加。 */
    unverified: number;
  };
  /**
   * Case PASS 只表示已声明的 Operation Contract 证据通过；即使总体 INITIAL_VALIDATION
   * 为 PASS，也不宣称完成正式验收。
   */
  trust: {
    resultScope: 'OPERATION_CONTRACT';
    requirementVerification: 'NOT_VERIFIED';
    businessSemantics: 'UNVERIFIED' | 'PARTIALLY_VERIFIED';
    evidenceQuality: 'COMPLETE' | 'PARTIAL' | 'NONE';
    interpretation: string;
  };
  coverage: {
    /** 已进入 Requirement-derived Objective 的 normative Fact / all normative Fact。 */
    factCoverage: AcceptanceCoverageValue;
    /** 已闭合到可判定 Case/Assertion 的 CONSUMED normative Fact / all normative Fact。 */
    factVerificationCoverage: AcceptanceCoverageValue;
    /** 已生成 Case 的 Objective / all Objective。 */
    objectiveCoverage: AcceptanceCoverageValue;
    /** 同时具有 Fact 与 Objective trace 的 Case / all designed Case。 */
    caseCoverage: AcceptanceCoverageValue;
    /** 真实执行 Case / all designed Case。 */
    executionCoverage: AcceptanceCoverageValue;
    /** 具有 Request、Response、Assertion 的 Case / all designed Case。 */
    evidenceCoverage: AcceptanceCoverageValue;
    /** Binding + Request + Response + Assertion / executable HTTP Case。 */
    operationContractEvidenceCoverage: AcceptanceCoverageValue;
    uncoveredFacts: RequirementFactReportItem[];
    unverifiedFacts: RequirementFactReportItem[];
  };
  businessCoverage: {
    businessFlowCoverage: AcceptanceBusinessCoverage;
    stateCoverage: AcceptanceBusinessCoverage;
    permissionCoverage: AcceptanceBusinessCoverage;
    isolationCoverage: AcceptanceBusinessCoverage;
    sideEffectCoverage: AcceptanceBusinessCoverage;
  };
  /** 兼容已有消费者；新增类型使用 camelCase key。 */
  byType: Record<string, number>;
  typeResults: Record<string, AcceptanceTypeStatistics>;
  acceptanceCriteriaResults: AcceptanceCriteriaResult[];
  executions: Array<{
    caseId: string;
    name: string;
    testType: TestType;
    executionMode: TestCase['executionMode'];
    status: AcceptanceResultStatus;
    /** Runner 原始状态与报告归一状态不一致时保留，供审计上游契约缺陷。 */
    rawStatus?: string;
    executed: boolean;
    timestamp?: string;
    durationMs?: number;
    requestId?: string;
    error?: string;
    blockedReason?: AcceptanceCaseExecutionResult['blockedReason'];
    classification: AcceptanceExecutionClassification;
    attribution: AcceptanceCaseExecutionResult['attribution'];
    evidence: AcceptanceExecutionEvidence;
  }>;
  cases: AcceptanceCaseReportItem[];
  defects: AcceptanceReportDefect[];
  coreIssues: AcceptanceCoreIssue[];
  observationGaps: AcceptanceObservationGap[];
  regression: {
    available: boolean;
    reason?: string;
    plan?: FactBasedRegressionPlan;
  };
  risks: AcceptanceRisk[];
  notTested: NotTestedItem[];
  warnings: AcceptanceRequirement['warnings'];
  bindingIssues: ApiBindingIssue[];
  /** 仅针对 executable HTTP Operation 的结论。 */
  operationContractConclusion: AcceptanceConclusion;
  /** Requirement → Design → Initial Execution 的总体结论。 */
  conclusion: AcceptanceConclusion;
}

const TEST_TYPES: readonly TestType[] = [
  'FUNCTIONAL', 'API', 'UI', 'PARAMETER', 'AUTH', 'PERMISSION', 'DATA_ISOLATION',
  'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'SECURITY', 'COMPATIBILITY',
  'PERFORMANCE', 'SIDE_EFFECT', 'CLEANUP', 'HYBRID',
];

function typeKey(type: TestType): string {
  return type.toLowerCase().replace(/_([a-z])/g, (_match, character: string) => character.toUpperCase());
}

function reportDesignedOnly(testCase: TestCase | undefined): boolean {
  return Boolean(testCase && isDesignedOnlyCase(testCase));
}

function v2EvidenceIntegrityProblems(result: AcceptanceCaseExecutionResult, testCase: TestCase | undefined): string[] {
  if (testCase?.schemaVersion !== 'TEST_CASE_V2') return [];
  const problems: string[] = [];
  const observedAssertionIds = new Set(result.evidence?.assertions?.map((item) => item.assertionId).filter(Boolean));
  const requirements = new Map((testCase.evidenceRequirements ?? []).map((item) => [item.id, item]));
  for (const evidenceId of testCase.oracle?.evidenceRequirementIds ?? []) {
    const requirement = requirements.get(evidenceId);
    if (!requirement) {
      problems.push(`Oracle Evidence ${evidenceId} 未定义`);
      continue;
    }
    const observed = requirement.channel === 'API_REQUEST' ? Boolean(result.evidence?.request)
      : requirement.channel === 'API_RESPONSE' ? Boolean(result.evidence?.response) : false;
    if (!observed) problems.push(`required Evidence ${evidenceId}/${requirement.channel} 未采集`);
  }
  for (const assertionId of testCase.oracle?.assertionIds ?? []) {
    if (!observedAssertionIds.has(assertionId)) problems.push(`Oracle Assertion ${assertionId} 无执行证据`);
  }
  return problems;
}

function passIntegrityProblems(result: AcceptanceCaseExecutionResult, testCase?: TestCase): string[] {
  if (result.status !== 'PASS') return [];
  const problems: string[] = [];
  if (reportDesignedOnly(testCase)) problems.push('Case 标记为 DESIGNED_ONLY/DESCRIPTIVE_ONLY');
  if (result.executed !== true) problems.push('executed 不为 true');
  if (!result.processor?.trim()) problems.push('processor 为空');
  if (result.processorInvoked !== true) problems.push('processorInvoked 不为 true');
  if (result.evidence?.binding?.valid !== true) problems.push('Binding Gate 证据缺失或无效');
  if (!result.evidence?.request) problems.push('Request 证据缺失');
  if (!result.evidence?.response) problems.push('Response 证据缺失');
  if ((result.assertions ?? result.evidence?.assertions?.length ?? 0) < 1) problems.push('有效断言计数为 0');
  if (!result.evidence?.assertions?.length) problems.push('有效断言证据为空');
  else if (result.evidence.assertions.some((assertion) => assertion.pass !== true)) problems.push('存在未通过断言');
  if (testCase?.schemaVersion === 'TEST_CASE_V2') {
    if (testCase.requirementStatus !== 'CONFIRMED') problems.push('Requirement 未确认');
    if (testCase.readiness?.status !== 'READY') problems.push('Readiness 未就绪');
    if (testCase.oracle?.status !== 'READY') problems.push('Oracle 未就绪');
    if (testCase.steps.some((step) => step.execution !== 'EXECUTABLE')) problems.push('存在 PLANNED 步骤');
    const runtimeAssertionIds = testCase.assertions.filter((assertion) => assertion.type !== 'DESIGN_EXPECTATION')
      .map((assertion) => assertion.id).filter((id): id is string => Boolean(id));
    const requiredEvidenceIds = (testCase.evidenceRequirements ?? []).filter((evidence) => evidence.required)
      .map((evidence) => evidence.id).filter((id): id is string => Boolean(id));
    const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
      && new Set(left).size === left.length && left.every((id) => right.includes(id));
    if (!testCase.oracle || !sameIds(testCase.oracle.assertionIds, runtimeAssertionIds)
      || !sameIds(testCase.oracle.evidenceRequirementIds, requiredEvidenceIds)) {
      problems.push('Oracle mode=ALL 未覆盖全部 Runtime Assertion/required Evidence');
    }
    problems.push(...v2EvidenceIntegrityProblems(result, testCase));
  }
  return problems;
}

function reportStatus(result: AcceptanceCaseExecutionResult | undefined, testCase?: TestCase): AcceptanceResultStatus {
  if (testCase && caseQuality(testCase).status === 'BLOCKED') return 'BLOCKED';
  if (reportDesignedOnly(testCase)) return 'NOT_EXECUTED';
  if (!result) return 'NOT_EXECUTED';
  if (result.status === 'PASS') {
    if (result.executed !== true) return 'NOT_EXECUTED';
    return passIntegrityProblems(result, testCase).length ? 'BLOCKED' : 'PASS';
  }
  if (result.status === 'FAIL' || result.status === 'NOT_EXECUTED'
    || result.status === 'TIMEOUT' || result.status === 'CANCELLED') return result.status;
  return 'BLOCKED';
}

function integrityDescription(result: AcceptanceCaseExecutionResult, testCase?: TestCase): string {
  return `RESULT_INTEGRITY_VIOLATION：Runner 返回 PASS，但${passIntegrityProblems(result, testCase).join('；')}`;
}

function percentage(part: number, total: number): AcceptanceCoverageValue {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 'NOT_AVAILABLE';
}

function factSuggestion(
  fact: RequirementFact,
  objectives: TestObjective[],
  testCases: TestCase[],
): string {
  if (fact.status === 'BLOCKED') return '先澄清冲突或缺失的需求契约，再重新生成测试设计。';
  const linkedObjectives = objectives.filter((objective) => objective.factIds.includes(fact.id) && objective.sourceType !== 'HEURISTIC');
  if (!linkedObjectives.length) return '补充可判定预期，并为该 Fact 建立 Requirement-derived Test Objective。';
  if (linkedObjectives.some((objective) => objective.outcomeStatus === 'UNKNOWN')) {
    return '补充明确期望结果、错误语义或业务后置状态，禁止由测试系统猜测。';
  }
  const objectiveIds = new Set(linkedObjectives.map((objective) => objective.id));
  const linkedCases = testCases.filter((testCase) => testCase.source?.objectiveIds?.some((id) => objectiveIds.has(id)));
  if (!linkedCases.length) return '为已建立的 Test Objective 生成可追溯 Test Case。';
  if (linkedCases.every((testCase) => reportDesignedOnly(testCase))) {
    return '测试设计已保留；提供对应 Processor、身份、数据上下文或确定性执行契约后执行。';
  }
  return '补齐 Fact-aware Assertion 或执行证据后重新进行初步验证。';
}

function factReportItem(fact: RequirementFact, objectives: TestObjective[], testCases: TestCase[]): RequirementFactReportItem {
  return {
    id: fact.id,
    category: fact.category,
    statement: fact.statement,
    status: fact.status,
    provenance: fact.provenance,
    source: fact.source,
    linkedObjectiveIds: fact.linkedObjectiveIds ?? [],
    reason: fact.statusReason,
    suggestion: factSuggestion(fact, objectives, testCases),
  };
}

export function redactAcceptanceArtifact(value: unknown): unknown {
  let redacted = redactSensitive(value);
  const opaqueSystemValue = (item: unknown): item is string => typeof item === 'string'
    && (/^(?:CASE|FACT|OBJ|SCN|REQ|RUN|API|TP|INV|FLOW|FLOWSTEP|P)-[A-Z0-9]+$/i.test(item)
      || /^[a-f0-9]{64}$/i.test(item));
  // 哈希/ULID 可能偶然包含 11 位手机号或 13-19 位卡号形状。它们是系统生成的
  // 不透明标识，不是用户数据；若被通用文本规则改写，会破坏 Case/Execution Plan Identity。
  const restoreOpaqueSystemValues = (source: unknown, target: unknown): unknown => {
    if (opaqueSystemValue(source)) return source;
    if (Array.isArray(source) && Array.isArray(target)) {
      return target.map((item, index) => restoreOpaqueSystemValues(source[index], item));
    }
    if (source && target && typeof source === 'object' && typeof target === 'object') {
      const sourceRecord = source as Record<string, unknown>;
      return Object.fromEntries(Object.entries(target as Record<string, unknown>)
        .map(([key, item]) => [key, restoreOpaqueSystemValues(sourceRecord[key], item)]));
    }
    return target;
  };
  redacted = restoreOpaqueSystemValues(value, redacted);
  // `AUTH` is a sensitive field name in arbitrary payloads, but in the fixed
  // report schema it is also a test dimension/category. Restore only the
  // closed, numeric statistics shapes; never restore arbitrary auth content.
  if (value && redacted && typeof value === 'object' && typeof redacted === 'object') {
    const source = value as Record<string, unknown>;
    const target = redacted as Record<string, unknown>;
    const sourceTypeResults = source.typeResults as Record<string, unknown> | undefined;
    const targetTypeResults = target.typeResults as Record<string, unknown> | undefined;
    const authStats = sourceTypeResults?.AUTH;
    const statKeys = ['total', 'executable', 'designedOnly', 'passed', 'failed', 'blocked', 'notExecuted', 'timedOut', 'cancelled'] as const;
    if (authStats && typeof authStats === 'object'
      && statKeys.every((key) => typeof (authStats as Record<string, unknown>)[key] === 'number')
      && targetTypeResults) {
      targetTypeResults.AUTH = Object.fromEntries(statKeys.map((key) => [key, (authStats as Record<string, unknown>)[key]]));
    }
    const sourceByType = source.byType as Record<string, unknown> | undefined;
    const targetByType = target.byType as Record<string, unknown> | undefined;
    if (typeof sourceByType?.auth === 'number' && targetByType) targetByType.auth = sourceByType.auth;
    const sourceUnderstanding = source.requirementUnderstanding as Record<string, unknown> | undefined;
    const targetUnderstanding = target.requirementUnderstanding as Record<string, unknown> | undefined;
    const sourceByCategory = sourceUnderstanding?.byCategory as Record<string, unknown> | undefined;
    const targetByCategory = targetUnderstanding?.byCategory as Record<string, unknown> | undefined;
    if (typeof sourceByCategory?.AUTH === 'number' && targetByCategory) targetByCategory.AUTH = sourceByCategory.AUTH;
  }
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => {
        if (/^(?:userId|tenantId|phone|mobile|email)$/i.test(key)) return [key, '***'];
        if (/url$/i.test(key) && typeof child === 'string') return [key, sanitizeUrl(child)];
        return [key, visit(child)];
      }));
    }
    if (typeof item === 'string') {
      if (opaqueSystemValue(item)) return item;
      return redactSensitiveText(item)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***@***')
        .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '***');
    }
    return item;
  };
  return visit(redacted);
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const safePath = parsed.pathname.replace(/\/(?:user|tenant)-[A-Za-z0-9_-]+/gi, '/[REDACTED_RESOURCE_ID]');
    for (const [name, queryValue] of parsed.searchParams) {
      if (/(?:token|key|secret|auth|cookie|session|password|email|phone|mobile|user|tenant|account)/i.test(name)) {
        parsed.searchParams.set(name, '***');
      } else {
        parsed.searchParams.set(name, redactSensitiveText(queryValue));
      }
    }
    return `[CONFIGURED_BASE_URL]${redactSensitiveText(safePath)}${parsed.search}`;
  } catch {
    return value;
  }
}

function sanitizeEvidence(evidence: AcceptanceExecutionEvidence): AcceptanceExecutionEvidence {
  const safe = redactAcceptanceArtifact(evidence) as AcceptanceExecutionEvidence;
  if (safe.request?.url) safe.request.url = sanitizeUrl(safe.request.url);
  return safe;
}

function stableReportId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function caseQuality(testCase: TestCase): {
  status: AcceptanceCaseReportItem['qualityStatus'];
  issues: string[];
} {
  const quality = testCase.metadata?.caseQuality;
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) {
    return { status: 'NOT_AVAILABLE', issues: [] };
  }
  const record = quality as { status?: unknown; issues?: unknown };
  const status = ['READY', 'DESIGNED_ONLY', 'BLOCKED'].includes(String(record.status))
    ? String(record.status) as 'READY' | 'DESIGNED_ONLY' | 'BLOCKED'
    : 'NOT_AVAILABLE';
  const issues = Array.isArray(record.issues)
    ? record.issues.map((issue) => {
      if (!issue || typeof issue !== 'object') return String(issue);
      const value = issue as { code?: unknown; message?: unknown };
      return `${String(value.code ?? 'CASE_QUALITY')}：${String(value.message ?? '质量门未提供说明')}`;
    })
    : [];
  return { status, issues };
}

const OBSERVATION_CAPABILITIES: Readonly<Partial<Record<TestType, {
  capability: string;
  missing: string;
  impact: string;
}>>> = {
  UI: {
    capability: 'UI/BROWSER_EXECUTOR',
    missing: '页面元素、交互状态与用户可见结果',
    impact: '接口响应不能证明页面行为满足需求',
  },
  DATA_ISOLATION: {
    capability: 'DATA_STATE_OBSERVER',
    missing: '目标资源的归属、可见性或写入前后状态',
    impact: '仅有 HTTP 状态无法证明跨范围数据未泄露或未被修改',
  },
  BUSINESS_RULE: {
    capability: 'BUSINESS_STATE_OBSERVER',
    missing: '业务实体及参与项的最终一致状态',
    impact: 'Operation 成功或失败不能证明业务规则成立',
  },
  STATE: {
    capability: 'STATE_OBSERVER',
    missing: '业务状态转换前后的持久化状态',
    impact: '响应状态不能单独证明状态机转换正确',
  },
  SIDE_EFFECT: {
    capability: 'SIDE_EFFECT_OBSERVER',
    missing: '下游服务、消息、库存、扣费、文件或第三方状态',
    impact: '主请求证据不能证明真实副作用已发生且只发生一次',
  },
  CLEANUP: {
    capability: 'DATA_LIFECYCLE_OBSERVER',
    missing: '测试数据清理后的残留状态',
    impact: '无法证明测试没有污染后续运行',
  },
  HYBRID: {
    capability: 'MULTI_CHANNEL_OBSERVER',
    missing: 'UI、API 与数据通道之间的一致结果',
    impact: '单通道证据不能证明端到端业务闭环',
  },
};

function buildObservationGaps(input: {
  testCases: TestCase[];
  facts: RequirementFact[];
  resultByCase: Map<string, AcceptanceCaseExecutionResult>;
}): AcceptanceObservationGap[] {
  const factById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const groups = new Map<string, AcceptanceObservationGap>();
  for (const testCase of input.testCases) {
    const testType = testCase.testType ?? 'FUNCTIONAL';
    const capability = OBSERVATION_CAPABILITIES[testType];
    if (!capability || !reportDesignedOnly(testCase) || caseQuality(testCase).status === 'BLOCKED') continue;
    const factIds = [...new Set(testCase.source?.factIds ?? [])].sort();
    const objectiveIds = [...new Set(testCase.source?.objectiveIds ?? [])].sort();
    const groupKey = `${testType}:${capability.capability}:${factIds.join(',')}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.caseIds.push(testCase.id);
      existing.objectiveIds = [...new Set([...existing.objectiveIds, ...objectiveIds])].sort();
      continue;
    }
    const linkedResults = input.testCases
      .filter((candidate) => (candidate.source?.factIds ?? []).some((id) => factIds.includes(id)))
      .map((candidate) => input.resultByCase.get(candidate.id))
      .filter((result): result is AcceptanceCaseExecutionResult => Boolean(result?.executed));
    const operationObserved = linkedResults.some((result) => result.evidence.request
      && result.evidence.response
      && result.evidence.assertions.some((assertion) => assertion.pass
        && ((assertion.factIds ?? []).some((id) => factIds.includes(id))
          || (assertion.objectiveIds ?? []).some((id) => objectiveIds.includes(id)))));
    groups.set(groupKey, {
      id: stableReportId('GAP', groupKey),
      status: operationObserved ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED',
      testType,
      factIds,
      objectiveIds,
      caseIds: [testCase.id],
      requirement: factIds.map((id) => factById.get(id)?.statement).filter((value): value is string => Boolean(value)),
      currentlyVerified: operationObserved ? '已获得关联 HTTP Operation 证据' : '当前没有真实执行证据',
      missingObservation: capability.missing,
      requiredCapability: capability.capability,
      impact: capability.impact,
    });
  }
  return [...groups.values()].map((gap) => ({ ...gap, caseIds: [...new Set(gap.caseIds)].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function expectedResult(testCase: TestCase): string {
  const value = testCase.design?.expectedOutcome
    ?? testCase.expected?.description
    ?? (testCase.expected?.status !== undefined ? `Status ${testCase.expected.status}` : undefined)
    ?? testCase.assertions.map((assertion) => assertion.description
      ?? `${assertion.type ?? assertion.target ?? 'ASSERT'} = ${JSON.stringify(assertion.expected)}`).join('；');
  return value || 'UNVERIFIED：没有明确 Expected Result';
}

function operationConclusion(
  operationCases: TestCase[],
  resultByCase: Map<string, AcceptanceCaseExecutionResult>,
  lifecycleBlocked: boolean,
): AcceptanceConclusion {
  if (lifecycleBlocked) return 'BLOCKED';
  if (!operationCases.length) return 'BLOCKED';
  const statuses = operationCases.map((testCase) => reportStatus(resultByCase.get(testCase.id), testCase));
  if (statuses.includes('FAIL')) return 'FAIL';
  const passed = statuses.filter((status) => status === 'PASS').length;
  if (passed === statuses.length) return 'PASS';
  if (passed > 0) return 'PARTIAL';
  return 'BLOCKED';
}

function overallConclusion(input: {
  testCases: TestCase[];
  objectives: TestObjective[];
  facts: RequirementFact[];
  summary: AcceptanceReport['summary'];
  risks: AcceptanceRisk[];
  operationContractConclusion: AcceptanceConclusion;
  lifecycleBlocked: boolean;
}): AcceptanceConclusion {
  if (input.lifecycleBlocked || input.facts.some((fact) => fact.status === 'BLOCKED')) return 'BLOCKED';
  if (input.risks.some((risk) => risk.classification === 'REQUIREMENT_WARNING'
    || risk.classification === 'RESULT_INTEGRITY')) return 'BLOCKED';
  if (input.summary.failed > 0) return 'FAIL';
  // BLOCKED 表示执行或证据完整性门禁没有通过；不能被其他已通过 Case 稀释成 PARTIAL。
  if (input.summary.blocked > 0 || input.summary.timedOut > 0 || input.summary.cancelled > 0) return 'BLOCKED';
  if (!input.testCases.length || !input.objectives.length
    || !input.facts.some((fact) => fact.normativity === 'NORMATIVE')) return 'BLOCKED';
  if (input.summary.executable > 0 && input.summary.executed === 0) return 'BLOCKED';
  const incomplete = input.summary.designedOnly > 0
    || input.facts.some((fact) => fact.status === 'UNVERIFIED')
    || input.operationContractConclusion !== 'PASS'
    || input.risks.length > 0;
  return incomplete ? 'PARTIAL' : 'PASS';
}

export function buildAcceptanceReport(input: {
  runId?: string;
  parentRunId?: string;
  project: string;
  environment?: string;
  mode?: 'execute' | 'dry-run';
  requirement: AcceptanceRequirement;
  /** 兼容旧的独立报告调用；核心 Pipeline 必须传入完整 Test Design。 */
  objectives?: TestObjective[];
  dimensionDecisions?: TestDimensionDecision[];
  scenarios?: TestScenario[];
  testPoints: TestPoint[];
  testCases: TestCase[];
  results: AcceptanceCaseExecutionResult[];
  defects: DefectDraft[];
  caseQuality?: TestCaseQualityGateResult;
  /** 归档失败 Run 计算出的回归上下文；修复后即使全部通过也必须保留影响范围。 */
  regressionPlan?: FactBasedRegressionPlan;
  externalRisks?: AcceptanceRisk[];
}): AcceptanceReport {
  const objectives = input.objectives ?? [];
  const dimensionDecisions = input.dimensionDecisions ?? [];
  const scenarios = input.scenarios ?? [];
  const resultByCase = new Map(input.results.map((result) => [result.caseId, result]));
  const caseById = new Map(input.testCases.map((testCase) => [testCase.id, testCase]));
  const executableCases = input.testCases.filter((testCase) => !reportDesignedOnly(testCase));
  const designedOnlyCases = input.testCases.filter(reportDesignedOnly);
  const totals: AcceptanceReport['summary'] = {
    total: input.testCases.length,
    designed: input.testCases.length,
    executable: executableCases.length,
    designedOnly: designedOnlyCases.length,
    executed: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    notExecuted: 0,
    timedOut: 0,
    cancelled: 0,
    unverified: 0,
  };
  for (const testCase of input.testCases) {
    const result = resultByCase.get(testCase.id);
    if (!reportDesignedOnly(testCase) && result?.executed === true) totals.executed++;
    const status = reportStatus(result, testCase);
    if (status === 'PASS') totals.passed++;
    else if (status === 'FAIL') totals.failed++;
    else if (status === 'NOT_EXECUTED') totals.notExecuted++;
    else if (status === 'TIMEOUT') totals.timedOut++;
    else if (status === 'CANCELLED') totals.cancelled++;
    else totals.blocked++;
  }

  const normativeFacts = input.requirement.factLedger.filter((fact) => fact.normativity === 'NORMATIVE');
  const normativeFactIds = new Set(normativeFacts.map((fact) => fact.id));
  const designedFactIds = new Set(objectives
    .filter((objective) => objective.sourceType !== 'HEURISTIC')
    .flatMap((objective) => objective.factIds)
    .filter((factId) => normativeFactIds.has(factId)));
  const factItems = input.requirement.factLedger.map((fact) => factReportItem(fact, objectives, input.testCases));
  const uncoveredFacts = factItems.filter((fact) => fact.status !== 'CONSUMED' && fact.status !== 'NON_NORMATIVE');
  const unverifiedFacts = factItems.filter((fact) => fact.status === 'UNVERIFIED');
  totals.unverified = unverifiedFacts.length;

  const byCategory: Partial<Record<RequirementFactCategory, number>> = {};
  for (const fact of input.requirement.factLedger) byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;

  const byType: Record<string, number> = {};
  const typeResults = Object.fromEntries(TEST_TYPES.map((type) => [type, {
    total: 0, executable: 0, designedOnly: 0, passed: 0, failed: 0, blocked: 0, notExecuted: 0, timedOut: 0, cancelled: 0,
  }])) as Record<string, AcceptanceTypeStatistics>;
  for (const testCase of input.testCases) {
    const type = testCase.testType ?? 'FUNCTIONAL';
    const key = typeKey(type);
    byType[key] = (byType[key] ?? 0) + 1;
    const stats = typeResults[type] ??= {
      total: 0, executable: 0, designedOnly: 0, passed: 0, failed: 0, blocked: 0, notExecuted: 0, timedOut: 0, cancelled: 0,
    };
    stats.total++;
    if (reportDesignedOnly(testCase)) stats.designedOnly++;
    else stats.executable++;
    const status = reportStatus(resultByCase.get(testCase.id), testCase);
    if (status === 'PASS') stats.passed++;
    else if (status === 'FAIL') stats.failed++;
    else if (status === 'NOT_EXECUTED') stats.notExecuted++;
    else if (status === 'TIMEOUT') stats.timedOut++;
    else if (status === 'CANCELLED') stats.cancelled++;
    else stats.blocked++;
  }

  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  const factIds = new Set(input.requirement.factLedger.map((fact) => fact.id));
  const coveredObjectives = new Set(input.testCases.flatMap((testCase) => testCase.source?.objectiveIds ?? [])
    .filter((id) => objectiveIds.has(id)));
  const traceableCases = input.testCases.filter((testCase) => {
    const sourceObjectiveIds = testCase.source?.objectiveIds ?? [];
    const sourceFactIds = testCase.source?.factIds ?? [];
    return sourceObjectiveIds.some((id) => objectiveIds.has(id)) && sourceFactIds.some((id) => factIds.has(id));
  });
  const executedResults = input.results.filter((result) => {
    const testCase = caseById.get(result.caseId);
    return result.executed === true && !reportDesignedOnly(testCase);
  });
  const evidenceResults = executedResults.filter((result) => result.evidence.request
    && result.evidence.response
    && result.evidence.assertions.length > 0
    && v2EvidenceIntegrityProblems(result, caseById.get(result.caseId)).length === 0);
  const operationCases = executableCases.filter((testCase) => testCase.protocol === 'HTTP'
    || testCase.steps.some((step) => step.type === 'HTTP_REQUEST'));
  const operationCaseIds = new Set(operationCases.map((testCase) => testCase.id));
  const operationEvidenceResults = evidenceResults.filter((result) => operationCaseIds.has(result.caseId)
    && result.evidence.binding?.valid === true);
  const evidenceQuality: AcceptanceReport['trust']['evidenceQuality'] = evidenceResults.length === input.testCases.length && input.testCases.length > 0
    ? 'COMPLETE'
    : evidenceResults.length > 0 ? 'PARTIAL' : 'NONE';

  const businessModel = buildBusinessModelProjection(input.requirement);
  const verifiedCaseIds = new Set(input.testCases.flatMap((testCase) => {
    const result = resultByCase.get(testCase.id);
    return reportStatus(result, testCase) === 'PASS' && result?.executed === true
      && passIntegrityProblems(result, testCase).length === 0 ? [testCase.id] : [];
  }));
  const stageCoverage = (
    targets: readonly string[],
    matches: (testCase: TestCase, target: string) => boolean,
  ): AcceptanceBusinessCoverage => {
    const covered = (predicate: (testCase: TestCase) => boolean): number => targets.filter((target) =>
      input.testCases.some((testCase) => matches(testCase, target) && predicate(testCase))).length;
    return {
      total: targets.length,
      generated: percentage(covered(() => true), targets.length),
      executable: percentage(covered((testCase) => !reportDesignedOnly(testCase)), targets.length),
      executed: percentage(covered((testCase) => resultByCase.get(testCase.id)?.executed === true), targets.length),
      verified: percentage(covered((testCase) => verifiedCaseIds.has(testCase.id)), targets.length),
    };
  };
  const factTargets = (categories: readonly RequirementFactCategory[], extra?: (fact: RequirementFact) => boolean): string[] =>
    normativeFacts.filter((fact) => categories.includes(fact.category) || extra?.(fact)).map((fact) => fact.id);
  const factMatch = (testCase: TestCase, factId: string): boolean => testCase.source?.factIds?.includes(factId) === true;
  const businessCoverage: AcceptanceReport['businessCoverage'] = {
    businessFlowCoverage: stageCoverage(businessModel.flows.map((flow) => flow.id),
      (testCase, flowId) => testCase.businessScenario?.flow.id === flowId
        || businessModel.flows.find((flow) => flow.id === flowId)?.factIds.some((id) => testCase.source?.factIds?.includes(id)) === true),
    stateCoverage: stageCoverage(factTargets(['STATE']), factMatch),
    permissionCoverage: stageCoverage(factTargets(['AUTH', 'PERMISSION']), factMatch),
    isolationCoverage: stageCoverage(factTargets(['DATA_ISOLATION']), factMatch),
    sideEffectCoverage: stageCoverage(factTargets(['SIDE_EFFECT'], (fact) => fact.canonical.sideEffects.length > 0), factMatch),
  };

  const acceptanceCriteriaResults = input.requirement.acceptanceCriteria.map((criterion) => {
    const points = input.testPoints.filter((point) => point.acceptanceCriteriaIds.includes(criterion.criterionId));
    const cases = input.testCases.filter((testCase) => testCase.source?.acceptanceCriteriaIds.includes(criterion.criterionId));
    return {
      criterionId: criterion.criterionId,
      objective: criterion.objective,
      testPointIds: points.map((point) => point.id),
      testCaseIds: cases.map((testCase) => testCase.id),
      results: cases.map((testCase) => reportStatus(resultByCase.get(testCase.id), testCase)),
    };
  });

  const risks: AcceptanceRisk[] = input.results
    .filter((result) => reportStatus(result, caseById.get(result.caseId)) === 'BLOCKED')
    .map((result) => ({
      caseId: result.caseId,
      status: result.status ?? 'BLOCKED',
      classification: result.classification,
      description: result.error ?? '执行被阻塞',
    }));
  risks.push(...input.results
    .filter((result) => result.status === 'PASS' && passIntegrityProblems(result, caseById.get(result.caseId)).length > 0)
    .map((result) => ({
      caseId: result.caseId,
      status: 'RESULT_INTEGRITY_VIOLATION',
      classification: 'RESULT_INTEGRITY' as const,
      description: integrityDescription(result, caseById.get(result.caseId)),
    })));
  risks.push(...input.results
    .filter((result) => result.status === 'FAIL' && result.classification !== 'PRODUCT_FAILURE')
    .map((result) => ({
      caseId: result.caseId,
      status: 'FAIL',
      classification: result.classification,
      description: result.error ?? '失败归因尚未确认',
    })));
  const bindingIssues = input.testPoints.flatMap((point) => point.bindingIssue ? [point.bindingIssue] : []);
  risks.push(...bindingIssues.map((bindingIssue) => ({
    caseId: bindingIssue.sourceTestPointId,
    status: bindingIssue.code,
    classification: 'BINDING' as const,
    description: bindingIssue.message,
  })));
  risks.push(...input.requirement.factLedger
    .filter((fact) => fact.status === 'BLOCKED')
    .map((fact) => ({
      caseId: fact.id,
      status: 'FACT_BLOCKED',
      classification: 'REQUIREMENT_FACT' as const,
      description: `${fact.statement}：${fact.statusReason ?? '需求事实存在冲突或缺失'}`,
    })));
  risks.push(...input.requirement.warnings
    .filter((warning) => warning.blocking)
    .map((warning) => ({
      caseId: `requirement:${warning.source?.line ?? 'unknown'}`,
      status: warning.code,
      classification: 'REQUIREMENT_WARNING' as const,
      description: warning.message,
    })));
  risks.push(...(input.externalRisks ?? []));

  const notTested: NotTestedItem[] = [];
  for (const testCase of input.testCases) {
    const result = resultByCase.get(testCase.id);
    if (!result || reportStatus(result, testCase) === 'NOT_EXECUTED') {
      notTested.push({
        caseId: testCase.id,
        testType: testCase.testType,
        reason: testCase.design?.reason
          ?? (result?.status === 'PASS' ? integrityDescription(result, testCase) : result?.error)
          ?? (reportDesignedOnly(testCase) ? 'DESIGNED_ONLY：当前没有可验证的执行契约' : '未进入 Runner，未产生执行结果'),
        suggestion: reportDesignedOnly(testCase)
          ? '保留设计结果；补充对应 Processor、配置或测试数据后执行。'
          : '检查执行计划、Policy Gate 与 Processor 路由。',
      });
    }
  }

  const reportDefects: AcceptanceReportDefect[] = input.defects.map((defect) => {
    const linkedCases = defect.relatedCases.map((caseId) => caseById.get(caseId)).filter((item): item is TestCase => Boolean(item));
    const linkedFactIds = [...new Set(linkedCases.flatMap((testCase) => testCase.source?.factIds ?? []))];
    const linkedObjectiveIds = [...new Set(linkedCases.flatMap((testCase) => testCase.source?.objectiveIds ?? []))];
    const linkedCaseIds = [...new Set(linkedCases.map((testCase) => testCase.id))];
    const linkedFacts = linkedFactIds
      .map((id) => input.requirement.factLedger.find((fact) => fact.id === id))
      .filter((item): item is RequirementFact => Boolean(item));
    return {
      ...defect,
      classification: 'PRODUCT_DEFECT',
      requirementFactIds: linkedFactIds,
      requirementStatements: linkedFacts.map((fact) => fact.statement),
      affectedFactIds: linkedFactIds,
      affectedObjectiveIds: linkedObjectiveIds,
      affectedCaseIds: linkedCaseIds,
      suspectedLayer: defect.rca?.category ? String(defect.rca.category) : 'PRODUCT_OR_API_CONTRACT',
    };
  });

  const observationGaps = buildObservationGaps({
    testCases: input.testCases,
    facts: input.requirement.factLedger,
    resultByCase,
  });
  const failedCaseIds = input.regressionPlan?.seedCaseIds ?? [...new Set([
    ...reportDefects.flatMap((defect) => defect.affectedCaseIds),
    ...input.results
      .filter((result) => result.status === 'FAIL' && result.classification === 'PRODUCT_FAILURE')
      .map((result) => result.caseId),
  ])];
  let regression: AcceptanceReport['regression'];
  if (!failedCaseIds.length) {
    regression = { available: false, reason: '本轮没有有证据支持的 PRODUCT_FAILURE，无需生成修复回归范围。' };
  } else {
    try {
      regression = {
        available: true,
        plan: buildFactBasedRegressionPlan({ testCases: input.testCases, failedCaseIds }),
      };
    } catch (error) {
      const reason = error instanceof AcceptanceRegressionError ? error.message : `REGRESSION_PLAN_INVALID：${(error as Error).message}`;
      regression = { available: false, reason };
      risks.push({
        caseId: failedCaseIds.join(','),
        status: 'REGRESSION_PLAN_BLOCKED',
        classification: 'RESULT_INTEGRITY',
        description: reason,
      });
    }
  }

  const observationIssueGroups = new Map<string, AcceptanceObservationGap[]>();
  for (const gap of observationGaps) {
    const key = `${gap.testType}:${gap.requiredCapability}:${gap.missingObservation}:${gap.impact}`;
    const group = observationIssueGroups.get(key) ?? [];
    group.push(gap);
    observationIssueGroups.set(key, group);
  }
  const observationCoreIssues = [...observationIssueGroups.entries()].map(([key, gaps]): AcceptanceCoreIssue => {
    const affectedFactIds = [...new Set(gaps.flatMap((gap) => gap.factIds))].sort();
    const affectedObjectiveIds = [...new Set(gaps.flatMap((gap) => gap.objectiveIds))].sort();
    const affectedCaseIds = [...new Set(gaps.flatMap((gap) => gap.caseIds))].sort();
    const priorities = affectedCaseIds.map((id) => caseById.get(id)?.priority).filter(Boolean);
    const first = gaps[0];
    return {
      id: stableReportId('GAP', key),
      severity: priorities.includes('P0') ? 'P0' : priorities.includes('P1') ? 'P1' : 'P2',
      kind: 'OBSERVATION_GAP',
      title: `${first.testType} 可观察性缺口${gaps.length > 1 ? `（${affectedFactIds.length} 个 Fact）` : ''}`,
      description: `无法验证：${first.missingObservation}；需要：${first.requiredCapability}`,
      impact: first.impact,
      affectedFactIds,
      affectedObjectiveIds,
      affectedCaseIds,
    };
  });
  const coreIssues: AcceptanceCoreIssue[] = [
    ...reportDefects.map((defect): AcceptanceCoreIssue => ({
      id: defect.id,
      severity: defect.severity === 'P0' ? 'P0' : defect.severity === 'P1' ? 'P1' : 'P2',
      kind: 'DEFECT',
      title: defect.title,
      description: `${defect.expected}；实际：${defect.actual}`,
      impact: defect.impact || '已声明的 Requirement/Operation 未满足',
      affectedFactIds: defect.affectedFactIds,
      affectedObjectiveIds: defect.affectedObjectiveIds,
      affectedCaseIds: defect.affectedCaseIds,
    })),
    ...risks.map((risk): AcceptanceCoreIssue => {
      const linkedCase = caseById.get(risk.caseId);
      const severity: AcceptanceCoreIssue['severity'] = risk.classification === 'RESULT_INTEGRITY'
        || risk.classification === 'DATA_LIFECYCLE' ? 'P0' : 'P1';
      return {
        id: stableReportId('RISK', [risk.caseId, risk.status, risk.classification]),
        severity,
        kind: 'RISK',
        title: risk.status,
        description: risk.description,
        impact: '阻断可信执行或降低结果可信度',
        affectedFactIds: linkedCase?.source?.factIds ?? (risk.classification === 'REQUIREMENT_FACT' ? [risk.caseId] : []),
        affectedObjectiveIds: linkedCase?.source?.objectiveIds ?? [],
        affectedCaseIds: linkedCase ? [linkedCase.id] : [],
      };
    }),
    ...observationCoreIssues,
  ].sort((left, right) => ({ P0: 0, P1: 1, P2: 2 }[left.severity] - { P0: 0, P1: 1, P2: 2 }[right.severity]
    || left.id.localeCompare(right.id)));

  const lifecycleBlocked = (input.externalRisks ?? []).some((risk) => risk.classification === 'DATA_LIFECYCLE');
  const operationContractConclusion = operationConclusion(operationCases, resultByCase, lifecycleBlocked);
  const conclusion = overallConclusion({
    testCases: input.testCases,
    objectives,
    facts: input.requirement.factLedger,
    summary: totals,
    risks,
    operationContractConclusion,
    lifecycleBlocked,
  });
  const consumedFacts = normativeFacts.filter((fact) => fact.status === 'CONSUMED').length;
  const businessFactIds = new Set(normativeFacts
    .filter((fact) => ['BUSINESS_RULE', 'STATE', 'SIDE_EFFECT'].includes(fact.category))
    .map((fact) => fact.id));
  const objectiveById = new Map(objectives.map((objective) => [objective.id, objective]));
  const evidencedBusinessFactIds = new Set<string>();
  for (const result of executedResults) {
    if (!result.evidence.request || !result.evidence.response || result.evidence.binding?.valid !== true) continue;
    for (const assertion of result.evidence.assertions) {
      if (assertion.type === 'DESIGN_EXPECTATION') continue;
      const linkedFactIds = new Set(assertion.factIds ?? []);
      for (const objectiveId of assertion.objectiveIds ?? []) {
        for (const factId of objectiveById.get(objectiveId)?.factIds ?? []) linkedFactIds.add(factId);
      }
      for (const factId of linkedFactIds) {
        if (businessFactIds.has(factId)) evidencedBusinessFactIds.add(factId);
      }
    }
  }

  const executions: AcceptanceReport['executions'] = input.testCases.map((testCase) => {
    const result = resultByCase.get(testCase.id);
    const status = reportStatus(result, testCase);
    const integrityProblems = result ? passIntegrityProblems(result, testCase) : [];
    const integrityViolation = result?.status === 'PASS' && integrityProblems.length > 0;
    const defaultAttribution: AcceptanceCaseExecutionResult['attribution'] = {
      classification: 'NOT_EXECUTED',
      confidence: 'HIGH',
      reason: reportDesignedOnly(testCase) ? 'Case 为 DESIGNED_ONLY，仅保留测试设计' : 'Case 未产生 Runner 结果',
      evidenceSources: ['CASE_EXECUTION_MODE'],
    };
    return {
      caseId: testCase.id,
      name: testCase.name,
      testType: testCase.testType ?? 'FUNCTIONAL',
      executionMode: testCase.executionMode,
      status,
      rawStatus: result && status !== result.status ? result.status : undefined,
      executed: !reportDesignedOnly(testCase) && result?.executed === true,
      timestamp: result?.timestamp,
      durationMs: result?.durationMs,
      requestId: result?.requestId,
      error: result?.error,
      blockedReason: result?.blockedReason,
      classification: integrityViolation ? 'SYSTEM_ERROR' as const : result?.classification ?? 'NOT_EXECUTED',
      attribution: integrityViolation ? {
        classification: 'SYSTEM_ERROR' as const,
        confidence: 'HIGH' as const,
        reason: integrityDescription(result, testCase),
        evidenceSources: ['REPORT_INTEGRITY_GATE'],
      } : result?.attribution ?? defaultAttribution,
      evidence: sanitizeEvidence(result?.evidence ?? {
        requirementId: testCase.source?.requirementId,
        acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
        factIds: testCase.source?.factIds,
        objectiveIds: testCase.source?.objectiveIds,
        scenarioId: testCase.source?.scenarioId,
        testPointId: testCase.source?.testPointId,
        assertions: [],
        evidenceItems: [],
      }),
    };
  });
  const executionByCase = new Map(executions.map((execution) => [execution.caseId, execution]));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const caseItems: AcceptanceCaseReportItem[] = input.testCases.map((testCase) => {
    const execution = executionByCase.get(testCase.id)!;
    const quality = caseQuality(testCase);
    const httpInput = testCase.steps
      .filter((step) => step.type === 'HTTP_REQUEST')
      .map((step) => ({ pathParams: step.pathParams, query: step.query, body: step.body }));
    const inputDetails = {
      data: testCase.data,
      testData: testCase.testData,
      parameter: testCase.parameterContext,
      httpRequests: httpInput.length ? httpInput : undefined,
    };
    const hasInput = Object.values(inputDetails).some((value) => value !== undefined);
    return {
      caseId: testCase.id,
      schemaVersion: testCase.schemaVersion,
      testType: testCase.testType ?? 'FUNCTIONAL',
      testAspects: testCase.testAspects ?? [],
      priority: testCase.priority,
      requirementStatus: testCase.requirementStatus,
      scenario: scenarioById.get(testCase.source?.scenarioId ?? '')?.title ?? testCase.name,
      businessScenario: testCase.businessScenario,
      preconditions: testCase.preconditions ?? [],
      preconditionPlan: testCase.preconditionPlan ?? [],
      actor: testCase.actor ?? null,
      input: hasInput ? inputDetails : null,
      testData: testCase.testData ?? [],
      steps: testCase.steps,
      assertions: testCase.assertions,
      expected: testCase.expected,
      expectedResult: expectedResult(testCase),
      evidenceRequirements: testCase.evidenceRequirements ?? [],
      oracle: testCase.oracle,
      prepare: testCase.prepare ?? [],
      cleanup: testCase.cleanup ?? [],
      dependencies: testCase.dependencies ?? [],
      readiness: testCase.readiness,
      sourceFactIds: testCase.source?.factIds ?? [],
      sourceObjectiveIds: testCase.source?.objectiveIds ?? [],
      executionMode: testCase.executionMode,
      executionStatus: execution.status,
      qualityStatus: quality.status,
      qualityIssues: quality.issues,
      evidence: execution.evidence,
    };
  });
  const reportedCaseIds = new Set(input.testCases.map((testCase) => testCase.id));
  const assessedQuality = input.caseQuality?.assessments.filter((assessment) => reportedCaseIds.has(assessment.caseId))
    ?? input.testCases.map((testCase) => ({ status: caseQuality(testCase).status }));
  const qualitySummary: AcceptanceReport['caseQuality'] = {
    generated: input.caseQuality?.generatedCount ?? input.testCases.length,
    retained: input.testCases.length,
    deduplicated: input.caseQuality?.deduplicatedCount ?? 0,
    ready: assessedQuality.filter((assessment) => assessment.status === 'READY').length,
    designedOnly: assessedQuality.filter((assessment) => assessment.status === 'DESIGNED_ONLY').length,
    blocked: assessedQuality.filter((assessment) => assessment.status === 'BLOCKED').length,
    businessChecks: input.caseQuality?.businessChecks ?? [],
  };

  return redactAcceptanceArtifact({
    runId: input.runId ?? 'RUN-NOT-PROVIDED',
    parentRunId: input.parentRunId,
    project: input.project,
    environment: input.environment ?? 'test',
    mode: input.mode ?? 'execute',
    validationStage: 'INITIAL_VALIDATION',
    generatedAt: new Date().toISOString(),
    requirement: {
      id: input.requirement.id,
      title: input.requirement.title,
      documentId: input.requirement.source.documentId,
      acceptanceCriteria: input.requirement.acceptanceCriteria.length,
    },
    requirementUnderstanding: {
      facts: {
        total: input.requirement.factLedger.length,
        normative: normativeFacts.length,
        consumed: consumedFacts,
        unverified: normativeFacts.filter((fact) => fact.status === 'UNVERIFIED').length,
        blocked: normativeFacts.filter((fact) => fact.status === 'BLOCKED').length,
        nonNormative: input.requirement.factLedger.filter((fact) => fact.status === 'NON_NORMATIVE').length,
      },
      byCategory,
      ledger: factItems,
    },
    scope: {
      pages: input.requirement.pages.map((page) => page.path),
      apis: input.requirement.apis.map((api) => `${api.method} ${api.path}`),
      dimensions: [...new Set(objectives.map((objective) => objective.dimension))],
      factIds: input.requirement.factLedger.map((fact) => fact.id),
      objectiveIds: objectives.map((objective) => objective.id),
      scenarioIds: scenarios.map((scenario) => scenario.id),
      testPointIds: input.testPoints.map((point) => point.id),
      testCaseIds: input.testCases.map((testCase) => testCase.id),
    },
    testDesign: {
      summary: {
        objectives: objectives.length,
        scenarios: scenarios.length,
        hybridScenarios: scenarios.filter((scenario) => scenario.kind === 'HYBRID').length,
        cases: input.testCases.length,
        executable: executableCases.length,
        designedOnly: designedOnlyCases.length,
      },
      dimensionDecisions,
      objectives,
      scenarios,
    },
    caseQuality: qualitySummary,
    summary: totals,
    trust: {
      resultScope: 'OPERATION_CONTRACT',
      requirementVerification: 'NOT_VERIFIED',
      businessSemantics: evidencedBusinessFactIds.size > 0 ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED',
      evidenceQuality,
      interpretation: '总体结论仅代表 INITIAL_VALIDATION；Operation Contract PASS 只证明已声明且已执行的 HTTP 断言通过，不证明未执行维度或完整产品无缺陷。',
    },
    coverage: {
      factCoverage: percentage(designedFactIds.size, normativeFacts.length),
      factVerificationCoverage: percentage(consumedFacts, normativeFacts.length),
      objectiveCoverage: percentage(coveredObjectives.size, objectives.length),
      caseCoverage: percentage(traceableCases.length, input.testCases.length),
      executionCoverage: percentage(executedResults.length, input.testCases.length),
      evidenceCoverage: percentage(evidenceResults.length, input.testCases.length),
      operationContractEvidenceCoverage: percentage(operationEvidenceResults.length, operationCases.length),
      uncoveredFacts,
      unverifiedFacts,
    },
    businessCoverage,
    byType,
    typeResults,
    acceptanceCriteriaResults,
    executions,
    cases: caseItems,
    defects: reportDefects,
    coreIssues,
    observationGaps,
    regression,
    risks,
    notTested,
    warnings: input.requirement.warnings,
    bindingIssues,
    operationContractConclusion,
    conclusion,
  }) as AcceptanceReport;
}

function markdownList(items: string[], empty = '无'): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function coverageText(value: AcceptanceCoverageValue): string {
  return value === 'NOT_AVAILABLE' ? value : `${value}%`;
}

function safeCode(value: unknown): string {
  return (JSON.stringify(value, null, 2) ?? 'null').replace(/```/g, "''' ");
}

export function renderAcceptanceReportJson(report: AcceptanceReport): string {
  return `${JSON.stringify(redactAcceptanceArtifact(report), null, 2)}\n`;
}

/** 固定十一节的开发视角报告；字段与 JSON/HTML 使用同一个 AcceptanceReport。 */
export function renderAcceptanceReportMarkdown(report: AcceptanceReport): string {
  report = redactAcceptanceArtifact(report) as AcceptanceReport;
  const typeRows = TEST_TYPES
    .filter((type) => report.typeResults[type]?.total > 0)
    .map((type) => {
      const stats = report.typeResults[type];
      return `| ${type} | ${stats.total} | ${stats.executable} | ${stats.designedOnly} | ${stats.passed} | ${stats.failed} | ${stats.blocked} | ${stats.notExecuted} | ${stats.timedOut} | ${stats.cancelled} |`;
    }).join('\n');
  const factRows = report.requirementUnderstanding.ledger.map((fact) =>
    `| ${fact.id} | ${fact.category} | ${fact.status} | ${fact.statement.replace(/\|/g, '\\|')} | ${fact.reason?.replace(/\|/g, '\\|') ?? '-'} |`,
  ).join('\n');
  const issueCounts = {
    P0: report.coreIssues.filter((issue) => issue.severity === 'P0').length,
    P1: report.coreIssues.filter((issue) => issue.severity === 'P1').length,
    P2: report.coreIssues.filter((issue) => issue.severity === 'P2').length,
  };
  const issueSummary = report.coreIssues.slice(0, 10)
    .map((issue) => `${issue.severity} [${issue.kind}] ${issue.title}：${issue.description}`);
  const coreIssueSections = report.coreIssues.map((issue) => `### ${issue.severity} ${issue.title}

- 类型：${issue.kind}
- 问题：${issue.description}
- 影响：${issue.impact}
- Affected Facts：${issue.affectedFactIds.join(', ') || 'UNVERIFIED'}
- Affected Objectives：${issue.affectedObjectiveIds.join(', ') || 'UNVERIFIED'}
- Affected Cases：${issue.affectedCaseIds.join(', ') || '无'}`).join('\n\n');
  const defectSections = report.defects.map((defect) => `### ${defect.id} [${defect.severity}] ${defect.title}

- Classification：${defect.classification}
- Requirement Fact：${defect.requirementFactIds.join(', ') || 'UNVERIFIED'}
- Requirement：${defect.requirementStatements.join('；') || '未能关联到 Requirement Fact'}
- Expected：${defect.expected}
- Actual：${defect.actual}
- Impact：${defect.impact || '未提供'}
- Suspected Layer：${defect.suspectedLayer}
- Confidence：${defect.confidence ?? 'UNKNOWN'}
- Affected Facts：${defect.affectedFactIds.join(', ') || 'UNVERIFIED'}
- Affected Objectives：${defect.affectedObjectiveIds.join(', ') || 'UNVERIFIED'}
- Affected Cases：${defect.affectedCaseIds.join(', ') || '无'}
- Evidence：${defect.evidence.join('；') || defect.responseSummary || '无'}`).join('\n\n');
  const observationSections = report.observationGaps.map((gap) => `### ${gap.id} [${gap.status}] ${gap.testType}

- Requirement：${gap.requirement.join('；') || '未能关联到 Requirement Fact'}
- 当前能够验证：${gap.currentlyVerified}
- 无法验证：${gap.missingObservation}
- 需要能力：${gap.requiredCapability}
- 影响：${gap.impact}
- Affected Facts：${gap.factIds.join(', ') || 'UNVERIFIED'}
- Affected Objectives：${gap.objectiveIds.join(', ') || 'UNVERIFIED'}
- Affected Cases：${gap.caseIds.join(', ')}`).join('\n\n');
  const unverified = [
    ...report.coverage.uncoveredFacts.map((fact) => `${fact.id} [${fact.status}/${fact.category}] ${fact.statement}；原因：${fact.reason ?? '未形成消费闭环'}；建议：${fact.suggestion}`),
    ...report.notTested.map((item) => `${item.caseId}${item.testType ? ` [${item.testType}]` : ''} ${item.reason}${item.suggestion ? `；建议：${item.suggestion}` : ''}`),
  ];
  const caseSections = report.cases.map((testCase) => `### ${testCase.caseId} [${testCase.priority}] ${testCase.scenario}

- Schema Version：${testCase.schemaVersion ?? 'LEGACY'}
- Test Type：${testCase.testType}
- Test Aspects：${testCase.testAspects.join(', ') || '未声明'}
- Priority：${testCase.priority}
- Requirement Status：${testCase.requirementStatus ?? 'UNSPECIFIED'}
- Scenario：${testCase.scenario}
- Business Scenario：${testCase.businessScenario ? safeCode(testCase.businessScenario) : '未声明'}
- Precondition：${testCase.preconditions.join('；') || '无'}
- Actor：${testCase.actor ? safeCode(testCase.actor) : '未指定'}
- Input：${safeCode(testCase.input)}
- Expected Result：${testCase.expectedResult}
- Source Facts：${testCase.sourceFactIds.join(', ') || 'UNVERIFIED'}
- Source Objectives：${testCase.sourceObjectiveIds.join(', ') || 'UNVERIFIED'}
- Execution Mode：${testCase.executionMode ?? 'UNSPECIFIED'}
- Execution Status：${testCase.executionStatus}
- Case Quality：${testCase.qualityStatus}${testCase.qualityIssues.length ? `（${testCase.qualityIssues.join('；')}）` : ''}
- Readiness：${testCase.readiness ? safeCode(testCase.readiness) : '未声明'}

Precondition Plan：

\`\`\`json
${safeCode(testCase.preconditionPlan)}
\`\`\`

Test Data：

\`\`\`json
${safeCode(testCase.testData)}
\`\`\`

Steps：

\`\`\`json
${safeCode(testCase.steps)}
\`\`\`

Assertions：

\`\`\`json
${safeCode(testCase.assertions)}
\`\`\`

Expected Contract：

\`\`\`json
${safeCode(testCase.expected)}
\`\`\`

Evidence Requirements：

\`\`\`json
${safeCode(testCase.evidenceRequirements)}
\`\`\`

Oracle：

\`\`\`json
${safeCode(testCase.oracle)}
\`\`\`

Prepare：

\`\`\`json
${safeCode(testCase.prepare)}
\`\`\`

Cleanup：

\`\`\`json
${safeCode(testCase.cleanup)}
\`\`\`

Dependencies：

\`\`\`json
${safeCode(testCase.dependencies)}
\`\`\`

Execution Evidence：

\`\`\`json
${safeCode(testCase.evidence)}
\`\`\``).join('\n\n');
  const fixOrder = report.coreIssues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.title} — ${issue.impact}`);
  const regressionText = report.regression.available && report.regression.plan
    ? `- 策略：${report.regression.plan.strategy}
- 原失败 Cases：${report.regression.plan.seedCaseIds.join(', ')}
- Affected Facts：${report.regression.plan.affectedFactIds.join(', ')}
- Affected Objectives：${report.regression.plan.affectedObjectiveIds.join(', ')}
- Affected Cases：${report.regression.plan.affectedCaseIds.join(', ')}
- 相关策略：${report.regression.plan.policies.join(', ') || '无'}

| Case | 选择原因 | Facts | Objectives | Policy |
| --- | --- | --- | --- | --- |
${report.regression.plan.selections.map((selection) => `| ${selection.caseId} | ${selection.reasons.join(' + ')} | ${selection.factIds.join(', ') || '-'} | ${selection.objectiveIds.join(', ') || '-'} | ${selection.policies.join(', ') || '-'} |`).join('\n')}`
    : `不可生成自动回归范围：${report.regression.reason ?? '原因未知'}`;
  const businessQualityRows = (report.caseQuality.businessChecks ?? [])
    .map((issue) => `| ${issue.code} | ${issue.disposition} | ${issue.message} |`)
    .join('\n');

  return `# 智能测试报告

## 1. 测试结论

- Validation Stage：${report.validationStage}
- 总体结论：${report.conclusion}
- Operation Contract Conclusion：${report.operationContractConclusion}
- Result Scope：${report.trust.resultScope}
- 可信边界：${report.trust.interpretation}
- 发现核心问题：${report.coreIssues.length}（P0 ${issueCounts.P0} / P1 ${issueCounts.P1} / P2 ${issueCounts.P2}）

${markdownList(issueSummary, '本轮未发现有证据支持的产品缺陷或执行风险；仍需查看未验证项。')}

## 2. 测试摘要

- 需求：${report.requirement.title}（${report.requirement.id}）
- 版本/文档：${report.requirement.documentId ?? 'NOT_AVAILABLE'}
- 测试时间：${report.generatedAt}
- 测试环境：${report.environment}
- Project：${report.project}
- Mode：${report.mode}
- Run ID：${report.runId}
- Parent Run ID：${report.parentRunId ?? '无'}

## 3. 需求理解

- 需求：${report.requirement.title}（${report.requirement.id}）
- Facts：${report.requirementUnderstanding.facts.total}
- Normative：${report.requirementUnderstanding.facts.normative}
- Consumed：${report.requirementUnderstanding.facts.consumed}
- Unverified：${report.requirementUnderstanding.facts.unverified}
- Blocked：${report.requirementUnderstanding.facts.blocked}
- Non-normative：${report.requirementUnderstanding.facts.nonNormative}
- Requirement Verification：${report.trust.requirementVerification}
- Business Semantics：${report.trust.businessSemantics}

| Fact | Category | Status | Requirement | Reason |
| --- | --- | --- | --- | --- |
${factRows || '| - | - | - | 无可计算 Fact | - |'}

## 4. 测试范围

- Project：${report.project}
- Environment：${report.environment}
- Mode：${report.mode}
- API / Page：
${markdownList([...report.scope.apis, ...report.scope.pages], '  - 无')}
- Dimensions：${report.scope.dimensions.join(', ') || '无'}
- Objectives：${report.testDesign.summary.objectives}
- Scenarios：${report.testDesign.summary.scenarios}（Hybrid ${report.testDesign.summary.hybridScenarios}）

### 统一测试用例

${caseSections || '无测试用例。'}

## 5. 测试统计

- Designed：${report.summary.designed}
- Executable：${report.summary.executable}
- Designed Only：${report.summary.designedOnly}
- Executed：${report.summary.executed}
- Passed：${report.summary.passed}
- Failed：${report.summary.failed}
- Blocked：${report.summary.blocked}
- Not Executed：${report.summary.notExecuted}
- Timeout：${report.summary.timedOut}
- Cancelled：${report.summary.cancelled}
- Unverified Facts：${report.summary.unverified}
- Evidence Quality：${report.trust.evidenceQuality}
- Case Quality：Generated ${report.caseQuality.generated} / Retained ${report.caseQuality.retained} / Deduplicated ${report.caseQuality.deduplicated} / Ready ${report.caseQuality.ready} / Designed Only ${report.caseQuality.designedOnly} / Blocked ${report.caseQuality.blocked}

| 类型 | Designed | Executable | Designed Only | PASS | FAIL | BLOCKED | NOT_EXECUTED | TIMEOUT | CANCELLED |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${typeRows || '| - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |'}

## 6. 核心问题

${coreIssueSections || '无有证据支持的核心问题。'}

## 7. 缺陷详情

${defectSections || '无 PRODUCT_DEFECT。'}

## 8. 未验证项

### Observation Gap

${observationSections || '无已识别的跨通道可观察性缺口。'}

### 其他未验证项

${markdownList(unverified)}

## 9. 测试覆盖

- Requirement Fact Design Coverage：${coverageText(report.coverage.factCoverage)}
- Requirement Fact Verification Coverage：${coverageText(report.coverage.factVerificationCoverage)}
- Objective Coverage：${coverageText(report.coverage.objectiveCoverage)}
- Case Coverage：${coverageText(report.coverage.caseCoverage)}
- Execution Coverage：${coverageText(report.coverage.executionCoverage)}
- Evidence Coverage：${coverageText(report.coverage.evidenceCoverage)}
- Operation Contract Evidence Coverage：${coverageText(report.coverage.operationContractEvidenceCoverage)}

| 一级业务覆盖 | Targets | GENERATED | EXECUTABLE | EXECUTED | VERIFIED |
| --- | ---: | ---: | ---: | ---: | ---: |
| Business Flow Coverage | ${report.businessCoverage.businessFlowCoverage.total} | ${coverageText(report.businessCoverage.businessFlowCoverage.generated)} | ${coverageText(report.businessCoverage.businessFlowCoverage.executable)} | ${coverageText(report.businessCoverage.businessFlowCoverage.executed)} | ${coverageText(report.businessCoverage.businessFlowCoverage.verified)} |
| State Coverage | ${report.businessCoverage.stateCoverage.total} | ${coverageText(report.businessCoverage.stateCoverage.generated)} | ${coverageText(report.businessCoverage.stateCoverage.executable)} | ${coverageText(report.businessCoverage.stateCoverage.executed)} | ${coverageText(report.businessCoverage.stateCoverage.verified)} |
| Permission Coverage | ${report.businessCoverage.permissionCoverage.total} | ${coverageText(report.businessCoverage.permissionCoverage.generated)} | ${coverageText(report.businessCoverage.permissionCoverage.executable)} | ${coverageText(report.businessCoverage.permissionCoverage.executed)} | ${coverageText(report.businessCoverage.permissionCoverage.verified)} |
| Isolation Coverage | ${report.businessCoverage.isolationCoverage.total} | ${coverageText(report.businessCoverage.isolationCoverage.generated)} | ${coverageText(report.businessCoverage.isolationCoverage.executable)} | ${coverageText(report.businessCoverage.isolationCoverage.executed)} | ${coverageText(report.businessCoverage.isolationCoverage.verified)} |
| Side Effect Coverage | ${report.businessCoverage.sideEffectCoverage.total} | ${coverageText(report.businessCoverage.sideEffectCoverage.generated)} | ${coverageText(report.businessCoverage.sideEffectCoverage.executable)} | ${coverageText(report.businessCoverage.sideEffectCoverage.executed)} | ${coverageText(report.businessCoverage.sideEffectCoverage.verified)} |

### Business Quality Gate

| Check | Disposition | Detail |
| --- | --- | --- |
${businessQualityRows || '| PASS | - | 未发现业务风险重复、场景覆盖缺口或 Actor/Owner/Tenant/Resource 关系错误 |'}

## 10. 建议开发修复顺序

${fixOrder.length ? fixOrder.join('\n') : '本轮没有可排序的缺陷；优先补齐 P0 Observation Gap 后再扩大验证。'}

## 11. 回归建议

${regressionText}
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function renderAcceptanceReportHtml(report: AcceptanceReport): string {
  const markdown = renderAcceptanceReportMarkdown(report);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>智能测试报告</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#1f2937}h1{color:#0f766e}.summary{display:flex;gap:24px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px}pre{white-space:pre-wrap;background:#fff;padding:20px;border:1px solid #e2e8f0;border-radius:8px}</style></head><body><h1>智能测试报告</h1><div class="summary"><strong>INITIAL_VALIDATION：${escapeHtml(report.conclusion)}</strong><strong>Operation Contract：${escapeHtml(report.operationContractConclusion)}</strong></div><pre>${escapeHtml(markdown)}</pre></body></html>\n`;
}

export async function writeAcceptanceReports(report: AcceptanceReport, outputDir: string, baseName = 'acceptance-report'): Promise<{
  json: string;
  markdown: string;
  html: string;
}> {
  await mkdir(outputDir, { recursive: true });
  const files = {
    json: path.join(outputDir, `${baseName}.json`),
    markdown: path.join(outputDir, `${baseName}.md`),
    html: path.join(outputDir, `${baseName}.html`),
  };
  await Promise.all([
    writeFile(files.json, renderAcceptanceReportJson(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    writeFile(files.markdown, renderAcceptanceReportMarkdown(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    writeFile(files.html, renderAcceptanceReportHtml(report), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  ]);
  return files;
}
