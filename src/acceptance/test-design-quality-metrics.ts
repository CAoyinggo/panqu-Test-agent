import { createHash } from 'node:crypto';
import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type {
  AcceptanceRequirement,
  RequirementFact,
  RequirementFactCategory,
  RequirementParseWarning,
} from './requirement-ir.js';
import type { TestDimension, TestObjective } from './test-objective.js';

/**
 * A human-authored oracle.  It deliberately contains semantic expectations,
 * never production Fact/Objective/Case ids or snapshots of generated output.
 */
export interface GroundTruthFact {
  id: string;
  /** Exact source sentence in the benchmark requirement. */
  sourceText: string;
  /** Independent semantic fragments which must all survive interpretation. */
  semanticFragments: string[];
  allowedCategories: RequirementFactCategory[];
  /** A missing Fact is explicit, rather than silent, only when one of these signals is emitted. */
  acceptableOmissionWarningCodes?: RequirementParseWarning['code'][];
}

export interface GroundTruthObjective {
  id: string;
  sourceFactId: string;
  dimension: TestDimension;
  semanticFragments?: string[];
}

export interface GroundTruthCase {
  id: string;
  sourceFactIds: string[];
  testTypes?: string[];
  executionModes?: Array<'EXECUTABLE' | 'DESIGNED_ONLY' | 'DESCRIPTIVE_ONLY'>;
  semanticFragments?: string[];
  actorId?: string;
  targetId?: string;
  parameter?: string;
  boundaryVectors?: string[];
  expectedStatus?: number;
  reasonCode?: string;
}

export interface ProhibitedInterpretation {
  id: string;
  semanticFragments: string[];
  category?: RequirementFactCategory;
}

export interface TestDesignGroundTruth {
  id: string;
  documentId: string;
  markdown: string;
  facts: GroundTruthFact[];
  objectives: GroundTruthObjective[];
  cases: GroundTruthCase[];
  /** Empty means the human oracle expects no requirement-level block. */
  expectedBlockingWarningCodes: RequirementParseWarning['code'][];
  prohibitedInterpretations?: ProhibitedInterpretation[];
}

export interface TestDesignObservation {
  requirement: AcceptanceRequirement;
  objectives: TestObjective[];
  testCases: TestCase[];
}

export interface TestDesignQualityCounts {
  expectedFacts: number;
  recognizedFacts: number;
  silentlyOmittedFacts: number;
  observedInterpretations: number;
  falseInterpretations: number;
  expectedObjectives: number;
  /** Ground Truth objectives that found at least one semantic match. */
  matchedObjectives: number;
  /** Unique generated objectives that match Ground Truth; precision numerator. */
  matchedObservedObjectives: number;
  observedObjectives: number;
  expectedCases: number;
  matchedCases: number;
  observedCases: number;
  duplicateCases: number;
  executableCases: number;
}

export interface TestDesignQualityMetrics extends TestDesignQualityCounts {
  benchmarkId: string;
  factRecall: number;
  silentOmissionRate: number;
  falseInterpretationRate: number;
  objectiveRecall: number;
  objectivePrecision: number;
  caseRecall: number;
  duplicateRate: number;
  executableRate: number;
  missingFactIds: string[];
  silentlyOmittedFactIds: string[];
  falseInterpretationFactIds: string[];
  missingObjectiveIds: string[];
  missingCaseIds: string[];
  missingBlockingWarningCodes: RequirementParseWarning['code'][];
  unexpectedBlockingWarningCodes: RequirementParseWarning['code'][];
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function containsFragments(value: string, fragments: readonly string[] | undefined): boolean {
  const normalized = normalize(value);
  return (fragments ?? []).every((fragment) => normalized.includes(normalize(fragment)));
}

function sourceLines(markdown: string, sourceText: string): number[] {
  const expected = normalize(sourceText);
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const actual = normalize(line);
    return actual === expected || actual.includes(expected) || expected.includes(actual) && actual.length > 4
      ? [index + 1]
      : [];
  });
}

function overlapsSource(fact: RequirementFact, lines: Set<number>): boolean {
  for (let line = fact.source.lineStart; line <= fact.source.lineEnd; line++) {
    if (lines.has(line)) return true;
  }
  return false;
}

function isDocumentBackedContractProjection(fact: RequirementFact, markdown: string): boolean {
  if (fact.provenance !== 'CONTRACT') return false;
  const document = normalize(markdown);
  const atoms = [
    ...(fact.statement.match(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE)\b/gi) ?? []),
    ...(fact.statement.match(/\/[A-Za-z0-9_{}./-]+/g) ?? []),
    ...(fact.statement.match(/\b[1-5]\d{2}\b/g) ?? []),
  ].map(normalize).filter(Boolean);
  return atoms.length > 0 && atoms.every((atom) => document.includes(atom));
}

function warningCoversFact(
  warning: RequirementParseWarning,
  truth: GroundTruthFact,
  truthLines: Set<number>,
): boolean {
  if (!warning.blocking) return false;
  const acceptableCode = truth.acceptableOmissionWarningCodes?.includes(warning.code) === true;
  const start = warning.source?.lineStart ?? warning.source?.line;
  const end = warning.source?.lineEnd ?? start;
  if (start !== undefined && end !== undefined) {
    for (let line = start; line <= end; line++) {
      if (truthLines.has(line)) return true;
    }
  }
  return acceptableCode && containsFragments(warning.message, truth.semanticFragments);
}

function matchFacts(
  truth: TestDesignGroundTruth,
  observed: RequirementFact[],
): {
  byTruthId: Map<string, RequirementFact>;
  scopedObserved: RequirementFact[];
  falseFacts: RequirementFact[];
  truthLines: Map<string, Set<number>>;
} {
  const truthLines = new Map(truth.facts.map((fact) => [fact.id, new Set(sourceLines(truth.markdown, fact.sourceText))]));
  const assessedLines = new Set([...truthLines.values()].flatMap((lines) => [...lines]));
  const scopedObserved = observed.filter((fact) => fact.normativity === 'NORMATIVE' && overlapsSource(fact, assessedLines));
  const byTruthId = new Map<string, RequirementFact>();
  const used = new Set<string>();
  for (const expected of truth.facts) {
    const semanticCandidates = scopedObserved.filter((fact) => !used.has(fact.id)
      && containsFragments(fact.statement, expected.semanticFragments));
    // Category is a quality hint, not the definition of Fact recall. A
    // semantically preserved Fact with a wrong category is still recognized;
    // the resulting strategy/objective mismatch is measured downstream.
    const candidate = semanticCandidates.find((fact) => expected.allowedCategories.includes(fact.category))
      ?? semanticCandidates[0];
    if (candidate) {
      byTruthId.set(expected.id, candidate);
      used.add(candidate.id);
    }
  }

  const prohibited = truth.prohibitedInterpretations ?? [];
  // Multiple projections of the same source sentence are duplication, not a
  // false interpretation. False interpretation means semantic content absent
  // from the human oracle, including an explicitly prohibited constraint.
  const semanticallyAccounted = new Set(scopedObserved
    .filter((fact) => truth.facts.some((expected) => containsFragments(fact.statement, expected.semanticFragments)))
    .map((fact) => fact.id));
  const falseIds = new Set(scopedObserved
    .filter((fact) => !semanticallyAccounted.has(fact.id)
      && !isDocumentBackedContractProjection(fact, truth.markdown))
    .map((fact) => fact.id));
  for (const fact of observed) {
    if (prohibited.some((item) => (!item.category || item.category === fact.category)
      && containsFragments(fact.statement, item.semanticFragments))) falseIds.add(fact.id);
  }
  return {
    byTruthId,
    scopedObserved: observed.filter((fact) => scopedObserved.some((item) => item.id === fact.id) || falseIds.has(fact.id)),
    falseFacts: observed.filter((fact) => falseIds.has(fact.id)),
    truthLines,
  };
}

function matchObjectives(
  truth: TestDesignGroundTruth,
  observed: TestObjective[],
  factsByTruthId: Map<string, RequirementFact>,
): { matchedTruthIds: Set<string>; matchedObservedIds: Set<string>; relevant: TestObjective[]; missing: string[] } {
  const recognizedFactIds = new Set([...factsByTruthId.values()].map((fact) => fact.id));
  const relevant = observed.filter((objective) => objective.factIds.some((factId) => recognizedFactIds.has(factId)));
  const matchedTruthIds = new Set<string>();
  const matchedObservedIds = new Set<string>();
  const missing: string[] = [];
  for (const expected of truth.objectives) {
    const sourceFact = factsByTruthId.get(expected.sourceFactId);
    const candidate = sourceFact && relevant.find((objective) => objective.factIds.includes(sourceFact.id)
      && objective.dimension === expected.dimension
      && containsFragments(`${objective.scenario} ${objective.expectedOutcome}`, expected.semanticFragments));
    if (candidate) {
      matchedTruthIds.add(expected.id);
      matchedObservedIds.add(candidate.id);
    }
    else missing.push(expected.id);
  }
  return { matchedTruthIds, matchedObservedIds, relevant, missing };
}

function caseText(testCase: TestCase): string {
  return [
    testCase.feature,
    testCase.name,
    testCase.expected?.description,
    testCase.design?.expectedOutcome,
    testCase.design?.actions.join(' '),
    testCase.assertions.map((assertion) => `${assertion.description ?? ''} ${String(assertion.expected ?? '')}`).join(' '),
  ].filter(Boolean).join(' ');
}

function coveredBoundaryVectors(testCase: TestCase): Set<string> {
  return new Set([
    testCase.parameterContext?.boundaryVector,
    ...(testCase.parameterCoverage ?? []).flatMap((coverage) => coverage.boundaryVectors),
  ].filter((item): item is string => Boolean(item)));
}

function statusAssertions(testCase: TestCase): number[] {
  const assertionStatuses = testCase.assertions
    .filter((assertion) => assertion.type === 'STATUS_CODE' && typeof assertion.expected === 'number')
    .map((assertion) => assertion.expected as number);
  const expectedStatus = /^\d{3}$/.test(testCase.expected?.status ?? '')
    ? Number(testCase.expected?.status)
    : undefined;
  return [...new Set([
    ...assertionStatuses,
    expectedStatus,
    testCase.parameterContext?.expectedResponse,
    ...(testCase.parameterCoverage ?? []).map((coverage) => coverage.expectedResponse),
  ].filter((status): status is number => typeof status === 'number'))];
}

function matchesCase(expected: GroundTruthCase, testCase: TestCase, observedFactIds: Set<string>): boolean {
  const caseFactIds = testCase.source?.factIds ?? [];
  if (!caseFactIds.some((id) => observedFactIds.has(id))) return false;
  if (expected.testTypes?.length && !expected.testTypes.includes(testCase.testType ?? '')) return false;
  if (expected.executionModes?.length && !expected.executionModes.includes(testCase.executionMode ?? 'EXECUTABLE')) return false;
  if (!containsFragments(caseText(testCase), expected.semanticFragments)) return false;
  if (expected.actorId && testCase.actor?.id !== expected.actorId) return false;
  if (expected.targetId && testCase.data?.targetId !== expected.targetId) return false;
  if (expected.parameter && testCase.parameterContext?.parameter !== expected.parameter
    && !(testCase.parameterCoverage ?? []).some((coverage) => coverage.parameter === expected.parameter)) return false;
  const vectors = coveredBoundaryVectors(testCase);
  if (expected.boundaryVectors?.some((vector) => !vectors.has(vector))) return false;
  if (expected.expectedStatus !== undefined && !statusAssertions(testCase).includes(expected.expectedStatus)) return false;
  const reason = `${testCase.design?.reason ?? ''} ${String(testCase.metadata?.reason ?? '')}`;
  if (expected.reasonCode && !reason.includes(expected.reasonCode)) return false;
  return true;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

/** Independent from the production execution-plan digest so the metric can detect regressions in that digest. */
export function qualityCaseSemanticDigest(testCase: TestCase): string {
  const semantic = canonical({
    // Presentation labels and readiness are dispositions, not test intent.
    // The same request/oracle duplicated under API/AUTH or READY/DESIGNED_ONLY
    // must still count as semantic duplication.
    actor: testCase.actor && {
      id: testCase.actor.id,
      userId: testCase.actor.userId,
      role: testCase.actor.role,
      tenantId: testCase.actor.tenantId,
    },
    data: testCase.data,
    steps: testCase.steps.map((step) => ({
      action: step.action,
      type: step.type,
      method: step.method,
      url: step.url,
      pathParams: step.pathParams,
      query: step.query,
      body: step.body,
    })),
    assertions: testCase.assertions.map((assertion) => ({
      type: assertion.type,
      target: assertion.target,
      path: assertion.path,
      operator: assertion.operator,
      expected: assertion.expected,
      description: assertion.description,
    })),
    parameter: testCase.parameterContext && {
      parameter: testCase.parameterContext.parameter,
      testData: testCase.parameterContext.testData,
      expectedResponse: testCase.parameterContext.expectedResponse,
    },
    expectedOutcome: testCase.design?.expectedOutcome ?? testCase.expected?.description,
    actions: testCase.design?.actions,
  });
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateTestDesignQuality(
  truth: TestDesignGroundTruth,
  observation: TestDesignObservation,
): TestDesignQualityMetrics {
  const factMatch = matchFacts(truth, observation.requirement.factLedger);
  const objectiveMatch = matchObjectives(truth, observation.objectives, factMatch.byTruthId);
  const expectedCaseMatches = new Set<string>();
  for (const expected of truth.cases) {
    const observedFactIds = new Set(expected.sourceFactIds
      .map((id) => factMatch.byTruthId.get(id)?.id)
      .filter((id): id is string => Boolean(id)));
    const candidate = observation.testCases.find((testCase) => matchesCase(expected, testCase, observedFactIds));
    if (candidate) {
      expectedCaseMatches.add(expected.id);
    }
  }

  const relevantFactIds = new Set([...factMatch.byTruthId.values()].map((fact) => fact.id));
  const relevantCases = observation.testCases.filter((testCase) =>
    testCase.source?.factIds?.some((factId) => relevantFactIds.has(factId)) === true);
  const uniqueCaseDigests = new Set(relevantCases.map(qualityCaseSemanticDigest));
  const duplicateCases = relevantCases.length - uniqueCaseDigests.size;
  const missingFactIds = truth.facts.filter((fact) => !factMatch.byTruthId.has(fact.id)).map((fact) => fact.id);
  const silentlyOmittedFactIds = truth.facts.filter((fact) => {
    if (factMatch.byTruthId.has(fact.id)) return false;
    const lines = factMatch.truthLines.get(fact.id) ?? new Set<number>();
    return !observation.requirement.warnings.some((warning) => warningCoversFact(warning, fact, lines));
  }).map((fact) => fact.id);
  const observedBlockingCodes = new Set(observation.requirement.warnings
    .filter((warning) => warning.blocking)
    .map((warning) => warning.code));
  const missingBlockingWarningCodes = truth.expectedBlockingWarningCodes
    .filter((code) => !observedBlockingCodes.has(code));
  const expectedBlockingCodes = new Set(truth.expectedBlockingWarningCodes);
  const unexpectedBlockingWarningCodes = [...observedBlockingCodes]
    .filter((code) => !expectedBlockingCodes.has(code));

  const counts: TestDesignQualityCounts = {
    expectedFacts: truth.facts.length,
    recognizedFacts: factMatch.byTruthId.size,
    silentlyOmittedFacts: silentlyOmittedFactIds.length,
    observedInterpretations: factMatch.scopedObserved.length,
    falseInterpretations: factMatch.falseFacts.length,
    expectedObjectives: truth.objectives.length,
    matchedObjectives: objectiveMatch.matchedTruthIds.size,
    matchedObservedObjectives: objectiveMatch.matchedObservedIds.size,
    observedObjectives: objectiveMatch.relevant.length,
    expectedCases: truth.cases.length,
    matchedCases: expectedCaseMatches.size,
    observedCases: relevantCases.length,
    duplicateCases,
    executableCases: relevantCases.filter((testCase) => testCase.executionMode === 'EXECUTABLE').length,
  };
  return {
    benchmarkId: truth.id,
    ...counts,
    factRecall: ratio(counts.recognizedFacts, counts.expectedFacts),
    silentOmissionRate: ratio(counts.silentlyOmittedFacts, counts.expectedFacts),
    falseInterpretationRate: ratio(counts.falseInterpretations, counts.observedInterpretations),
    objectiveRecall: ratio(counts.matchedObjectives, counts.expectedObjectives),
    objectivePrecision: ratio(counts.matchedObservedObjectives, counts.observedObjectives),
    caseRecall: ratio(counts.matchedCases, counts.expectedCases),
    duplicateRate: ratio(counts.duplicateCases, counts.observedCases),
    executableRate: ratio(counts.executableCases, counts.observedCases),
    missingFactIds,
    silentlyOmittedFactIds,
    falseInterpretationFactIds: factMatch.falseFacts.map((fact) => fact.id),
    missingObjectiveIds: objectiveMatch.missing,
    missingCaseIds: truth.cases.filter((item) => !expectedCaseMatches.has(item.id)).map((item) => item.id),
    missingBlockingWarningCodes,
    unexpectedBlockingWarningCodes,
  };
}

export function aggregateTestDesignQuality(
  metrics: readonly TestDesignQualityMetrics[],
): Omit<TestDesignQualityMetrics, 'benchmarkId' | 'missingFactIds' | 'silentlyOmittedFactIds'
  | 'falseInterpretationFactIds' | 'missingObjectiveIds' | 'missingCaseIds' | 'missingBlockingWarningCodes'
  | 'unexpectedBlockingWarningCodes'> {
  const counts = metrics.reduce<TestDesignQualityCounts>((total, item) => ({
    expectedFacts: total.expectedFacts + item.expectedFacts,
    recognizedFacts: total.recognizedFacts + item.recognizedFacts,
    silentlyOmittedFacts: total.silentlyOmittedFacts + item.silentlyOmittedFacts,
    observedInterpretations: total.observedInterpretations + item.observedInterpretations,
    falseInterpretations: total.falseInterpretations + item.falseInterpretations,
    expectedObjectives: total.expectedObjectives + item.expectedObjectives,
    matchedObjectives: total.matchedObjectives + item.matchedObjectives,
    matchedObservedObjectives: total.matchedObservedObjectives + item.matchedObservedObjectives,
    observedObjectives: total.observedObjectives + item.observedObjectives,
    expectedCases: total.expectedCases + item.expectedCases,
    matchedCases: total.matchedCases + item.matchedCases,
    observedCases: total.observedCases + item.observedCases,
    duplicateCases: total.duplicateCases + item.duplicateCases,
    executableCases: total.executableCases + item.executableCases,
  }), {
    expectedFacts: 0, recognizedFacts: 0, silentlyOmittedFacts: 0,
    observedInterpretations: 0, falseInterpretations: 0,
    expectedObjectives: 0, matchedObjectives: 0, matchedObservedObjectives: 0, observedObjectives: 0,
    expectedCases: 0, matchedCases: 0, observedCases: 0,
    duplicateCases: 0, executableCases: 0,
  });
  return {
    ...counts,
    factRecall: ratio(counts.recognizedFacts, counts.expectedFacts),
    silentOmissionRate: ratio(counts.silentlyOmittedFacts, counts.expectedFacts),
    falseInterpretationRate: ratio(counts.falseInterpretations, counts.observedInterpretations),
    objectiveRecall: ratio(counts.matchedObjectives, counts.expectedObjectives),
    objectivePrecision: ratio(counts.matchedObservedObjectives, counts.observedObjectives),
    caseRecall: ratio(counts.matchedCases, counts.expectedCases),
    duplicateRate: ratio(counts.duplicateCases, counts.observedCases),
    executableRate: ratio(counts.executableCases, counts.observedCases),
  };
}

export interface SeededDefectGroundTruth {
  id: string;
  dimension: 'API' | 'PARAMETER' | 'PERMISSION' | 'ISOLATION' | 'STATE' | 'BUSINESS_RULE' | 'UI';
  availability: 'EXECUTABLE' | 'NOT_AVAILABLE';
}

export interface SeededDefectObservation {
  id: string;
  caseGenerated: boolean;
  executionStatus: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_EXECUTED' | 'NOT_AVAILABLE';
  executed: boolean;
  attribution?: string;
}

export interface SeededDefectMetrics {
  totalSeeds: number;
  executableSeeds: number;
  designedSeeds: number;
  executedSeeds: number;
  detectedSeeds: number;
  correctlyAttributedSeeds: number;
  unavailableSeeds: string[];
  designCoverage: number;
  executionCoverage: number;
  defectYield: number | 'NOT_AVAILABLE';
  attributionPrecision: number | 'NOT_AVAILABLE';
}

export function evaluateSeededDefectYield(
  truth: readonly SeededDefectGroundTruth[],
  observed: readonly SeededDefectObservation[],
): SeededDefectMetrics {
  const observationById = new Map(observed.map((item) => [item.id, item]));
  const executable = truth.filter((item) => item.availability === 'EXECUTABLE');
  const designed = truth.filter((item) => observationById.get(item.id)?.caseGenerated);
  const executed = executable.filter((item) => observationById.get(item.id)?.executed === true);
  const detected = executable.filter((item) => {
    const observation = observationById.get(item.id);
    return observation?.executed === true && observation.executionStatus === 'FAIL';
  });
  // UNCONFIRMED is deliberately not counted as correct attribution. It is an
  // honest uncertainty state, not evidence that the product owns the defect.
  const attributed = detected.filter((item) => observationById.get(item.id)?.attribution === 'PRODUCT_FAILURE');
  return {
    totalSeeds: truth.length,
    executableSeeds: executable.length,
    designedSeeds: designed.length,
    executedSeeds: executed.length,
    detectedSeeds: detected.length,
    correctlyAttributedSeeds: attributed.length,
    unavailableSeeds: truth.filter((item) => item.availability === 'NOT_AVAILABLE').map((item) => item.id),
    designCoverage: ratio(designed.length, truth.length),
    executionCoverage: ratio(executed.length, executable.length),
    defectYield: executable.length ? ratio(detected.length, executable.length) : 'NOT_AVAILABLE',
    attributionPrecision: detected.length ? ratio(attributed.length, detected.length) : 'NOT_AVAILABLE',
  };
}
