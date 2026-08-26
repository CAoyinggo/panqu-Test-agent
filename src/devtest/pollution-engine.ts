import { createHash } from 'node:crypto';

import type { TestCase } from '../agents/test-design/testcase-schema.js';
import { ApiProcessor, type AcceptanceCaseExecutionResult, type ApiProcessorOptions } from '../acceptance/api-processor.js';
import type { DevTestBusinessFlowGraph, DevTestEnvironmentSnapshot, DevTestPollutionFinding, DevTestProblem } from './types.js';

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalized(item)]));
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalized(value))).digest('hex');
}

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const output = new Map<string, string>();
  if (Array.isArray(value)) value.forEach((item, index) => {
    for (const [key, entry] of flatten(item, `${prefix}[${index}]`)) output.set(key, entry);
  });
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    for (const [path, entry] of flatten(item, prefix ? `${prefix}.${key}` : key)) output.set(path, entry);
  } else output.set(prefix || '$', JSON.stringify(value));
  return output;
}

function changedPaths(before: unknown, after: unknown): string[] {
  const left = flatten(before);
  const right = flatten(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
}

export class SnapshottingProcessor extends ApiProcessor {
  constructor(private readonly input: {
    inner: ApiProcessor;
    observer: (input: { caseId: string; phase: 'BEFORE' | 'AFTER_EXECUTE' | 'AFTER_CLEANUP' }) => Promise<unknown>;
    records: DevTestEnvironmentSnapshot[];
    prepare?: (caseId: string) => Promise<void>;
    cleanup?: (caseId: string) => Promise<void>;
  }) { super(); }

  private async capture(caseId: string, phase: DevTestEnvironmentSnapshot['phase']): Promise<void> {
    try {
      const value = await this.input.observer({ caseId, phase });
      this.input.records.push({ caseId, phase, value, fingerprint: fingerprint(value), capturedAt: new Date().toISOString() });
    } catch (error) {
      this.input.records.push({ caseId, phase, capturedAt: new Date().toISOString(), error: (error as Error).message });
    }
  }

  override async execute(testCase: TestCase, options: ApiProcessorOptions): Promise<AcceptanceCaseExecutionResult> {
    try { await this.input.prepare?.(testCase.id); }
    catch (error) { return lifecycleBlockedResult(testCase, options.runId, 'CASE_PREPARE_FAILED', error as Error); }
    await this.capture(testCase.id, 'BEFORE');
    try {
      return await this.input.inner.execute(testCase, options);
    } finally {
      // 必须在 Cleanup 前捕获，避免回滚把真实隐藏副作用从证据中抹掉。
      await this.capture(testCase.id, 'AFTER_EXECUTE');
      try { await this.input.cleanup?.(testCase.id); } catch (error) {
        this.input.records.push({ caseId: testCase.id, phase: 'AFTER_CLEANUP', capturedAt: new Date().toISOString(),
          error: `CASE_CLEANUP_FAILED：${(error as Error).message}` });
      }
      await this.capture(testCase.id, 'AFTER_CLEANUP');
    }
  }
}

function lifecycleBlockedResult(
  testCase: TestCase,
  runId: string | undefined,
  code: string,
  error: Error,
): AcceptanceCaseExecutionResult {
  const message = `${code}：${error.message}`;
  return {
    runId, caseId: testCase.id, name: testCase.name, feature: testCase.feature, scene: 'api',
    processor: 'snapshotting-processor', processorInvoked: false, timestamp: new Date().toISOString(),
    priority: testCase.priority, tags: testCase.tags, pass: false, passRate: 0, executed: false,
    status: 'BLOCKED', assertions: 0, passedAssertions: 0, failedAssertions: 0,
    blockedReason: { code, stage: 'GATE', message, recoverable: true }, error: `BLOCKED：${message}`,
    classification: 'EXECUTION_BLOCKED', attribution: {
      classification: 'EXECUTION_BLOCKED', confidence: 'HIGH', reason: message, evidenceSources: ['CASE_LIFECYCLE'],
    },
    evidence: {
      requirementId: testCase.source?.requirementId,
      acceptanceCriteriaIds: testCase.source?.acceptanceCriteriaIds ?? [],
      factIds: testCase.source?.factIds ?? [], objectiveIds: testCase.source?.objectiveIds ?? [],
      scenarioId: testCase.source?.scenarioId, sourceType: testCase.source?.sourceType,
      testPointId: testCase.source?.testPointId, assertions: [], evidenceItems: [],
    },
  };
}

export function detectTestPollution(input: {
  snapshots: readonly DevTestEnvironmentSnapshot[];
  results: readonly AcceptanceCaseExecutionResult[];
  testCases: readonly TestCase[];
  graph: DevTestBusinessFlowGraph;
  cleanupConfigured: boolean;
}): DevTestPollutionFinding[] {
  const findings: DevTestPollutionFinding[] = [];
  const resultByCase = new Map(input.results.map((item) => [item.caseId, item]));
  const pairByCase = new Map(input.testCases.map((testCase) => [testCase.id, {
    before: input.snapshots.find((item) => item.caseId === testCase.id && item.phase === 'BEFORE'),
    afterExecute: input.snapshots.find((item) => item.caseId === testCase.id && item.phase === 'AFTER_EXECUTE'),
    afterCleanup: input.snapshots.find((item) => item.caseId === testCase.id && item.phase === 'AFTER_CLEANUP'),
  }]));
  let previousCaseId: string | undefined;
  for (const testCase of input.testCases) {
    const pair = pairByCase.get(testCase.id)!;
    const result = resultByCase.get(testCase.id);
    if (!pair.before || !pair.afterExecute || !pair.afterCleanup) { previousCaseId = testCase.id; continue; }
    if (pair.before.error || pair.afterExecute.error || pair.afterCleanup.error) {
      findings.push({ caseId: testCase.id, classification: 'ENVIRONMENT_DRIFT', severity: 'HIGH', changedPaths: [],
        reason: pair.before.error ?? pair.afterExecute.error ?? pair.afterCleanup.error ?? 'Snapshot Observer failed',
        evidence: { before: pair.before, afterExecute: pair.afterExecute, afterCleanup: pair.afterCleanup } });
      previousCaseId = testCase.id;
      continue;
    }
    const executionChanges = changedPaths(pair.before.value, pair.afterExecute.value);
    const cleanupChanges = changedPaths(pair.before.value, pair.afterCleanup.value);
    const expectedStatus = Number(testCase.expected?.status);
    const rejected = Number.isInteger(expectedStatus) && expectedStatus >= 400 && result?.evidence?.response?.status === expectedStatus;
    const hidden = executionChanges.filter((item) => /db|database|task|billing|balance|audit|queue|provider|resource/i.test(item));
    if (rejected && hidden.length) findings.push({ caseId: testCase.id, classification: 'UNEXPECTED_SIDE_EFFECT', severity: 'CRITICAL',
      changedPaths: hidden, reason: `失败请求产生隐藏副作用：${hidden.join(', ')}`,
      evidence: { before: pair.before, after: pair.afterExecute, afterExecute: pair.afterExecute, afterCleanup: pair.afterCleanup } });
    if (input.cleanupConfigured && cleanupChanges.length) findings.push({ caseId: testCase.id, classification: 'TEST_POLLUTION', severity: 'MEDIUM',
      changedPaths: cleanupChanges, reason: `Case Cleanup 后环境未恢复：${cleanupChanges.join(', ')}`,
      evidence: { before: pair.before, after: pair.afterCleanup, afterExecute: pair.afterExecute, afterCleanup: pair.afterCleanup } });

    if (previousCaseId && result?.status === 'FAIL') {
      const priorPair = pairByCase.get(previousCaseId);
      const priorChanges = priorPair?.before && priorPair.afterCleanup
        ? changedPaths(priorPair.before.value, priorPair.afterCleanup.value) : [];
      const sameFlow = input.graph.flows.some((flow) => flow.steps.some((step) => step.caseIds.includes(previousCaseId!))
        && flow.steps.some((step) => step.caseIds.includes(testCase.id)));
      if (priorChanges.length && !sameFlow) findings.push({ caseId: testCase.id, previousCaseId,
        classification: input.cleanupConfigured ? 'TEST_POLLUTION' : 'SHARED_STATE', severity: 'MEDIUM',
        changedPaths: priorChanges, reason: `前序 ${previousCaseId} 的状态变化与当前失败相关，先排除共享状态污染`,
        evidence: { before: priorPair?.before, after: priorPair?.afterCleanup,
          afterExecute: priorPair?.afterExecute, afterCleanup: priorPair?.afterCleanup } });
    }
    previousCaseId = testCase.id;
  }
  return findings;
}

export function buildPollutionProblems(
  findings: readonly DevTestPollutionFinding[],
  options: { reproductionRun?: boolean } = {},
): DevTestProblem[] {
  return findings.map((finding) => {
    const unexpected = finding.classification === 'UNEXPECTED_SIDE_EFFECT';
    const environment = finding.classification === 'ENVIRONMENT_DRIFT';
    return {
      id: 'P000', type: unexpected ? 'DATA_CONSISTENCY_BUG' : 'TEST_POLLUTION', severity: finding.severity,
      dimension: 'EXECUTION', caseId: finding.caseId, message: finding.reason,
      evidence: finding.evidence, affectedCases: [finding.caseId], reasonCode: finding.classification,
      category: unexpected ? 'State Error' : environment ? 'Environment Block' : 'Test Reliability',
      failureClass: unexpected ? 'PRODUCT_BUG' : environment ? 'ENVIRONMENT_ISSUE' : 'TEST_ISSUE',
      judgement: unexpected ? (options.reproductionRun ? 'CONFIRMED_BUG' : 'LIKELY_BUG')
        : environment ? 'ENVIRONMENT_ISSUE' : 'TEST_ISSUE',
      reproducible: unexpected && options.reproductionRun === true,
      confidence: unexpected ? (options.reproductionRun ? 1 : 0.85) : 0.9,
      confidenceLabel: unexpected && options.reproductionRun ? 'CONFIRMED' : 'LIKELY',
      rootCause: unexpected ? `UNEXPECTED_SIDE_EFFECT:${finding.changedPaths.join(',')}` : `TEST_POLLUTION:${finding.previousCaseId ?? finding.caseId}`,
      expected: unexpected ? '失败请求不产生 DB/Task/Billing/Audit/Queue/Provider 副作用' : 'Case Cleanup 后恢复环境快照',
      actual: finding.changedPaths.join(', '), remediation: unexpected
        ? '修复失败路径的事务/补偿边界，并用独立 Observer 复测。'
        : '隔离 Fixture/Actor/Tenant/Resource，并修复 Case Cleanup；不得归因产品 Bug。',
    };
  });
}
