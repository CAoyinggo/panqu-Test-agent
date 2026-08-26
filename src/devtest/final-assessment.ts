import type { AcceptanceReport } from '../acceptance/acceptance-report.js';
import type { DevTestBaselineSnapshot } from './baseline.js';
import type {
  DevTestConfidenceScore,
  DevTestFeatureResult,
  DevTestProblem,
  DevTestRequirementCoverageMatrix,
  DevTestVersionComparison,
} from './types.js';

export function computeDevConfidence(input: {
  conclusion: DevTestFeatureResult;
  matrix: DevTestRequirementCoverageMatrix;
  report: AcceptanceReport;
  problems: readonly DevTestProblem[];
}): DevTestConfidenceScore {
  const total = input.report.summary.designed;
  const executionCoverage = total ? Math.round(input.report.summary.executed / total * 100) : 0;
  const executable = input.report.summary.executable;
  const evidenceCoverage = executable ? Math.round(input.report.cases.filter((item) => item.executionStatus === 'PASS'
    && item.evidence.assertions.length > 0 && item.evidence.request && item.evidence.response).length / executable * 100) : 0;
  const confirmed = input.problems.filter((problem) => problem.judgement === 'CONFIRMED_BUG');
  const likely = input.problems.filter((problem) => problem.judgement === 'LIKELY_BUG');
  const problemConfidence = confirmed.length ? 0 : likely.length ? 50 : 100;
  const unknowns = input.matrix.uncoveredAc.length + input.matrix.ambiguousAc.length
    + input.problems.filter((problem) => problem.judgement === 'UNKNOWN').length;
  const unknownPenalty = Math.min(25, unknowns * 5);
  const blockedP0 = input.report.cases.filter((item) => item.priority === 'P0' && item.executionStatus !== 'PASS').length;
  const blockedP0Penalty = Math.min(40, blockedP0 * 20);
  const factors = {
    coreCoverage: input.matrix.coreCoverage,
    executionCoverage,
    evidenceCoverage,
    problemConfidence,
    unknownPenalty,
    blockedP0Penalty,
  };
  const raw = factors.coreCoverage * 0.30 + executionCoverage * 0.20 + evidenceCoverage * 0.20
    + problemConfidence * 0.15 + 15 - unknownPenalty - blockedP0Penalty;
  return { score: Math.max(0, Math.min(100, Math.round(raw))), factors, failClosed: input.conclusion !== 'READY' };
}

export function buildVersionComparison(input: {
  requirementVersion: string;
  codeVersion: string;
  contractVersion: string;
  acIds: readonly string[];
  caseIds: readonly string[];
  contractDrift: boolean;
  baseline?: DevTestBaselineSnapshot;
  newProblems: readonly string[];
  fixedProblems: readonly string[];
  regressions: readonly string[];
}): DevTestVersionComparison {
  const beforeAc = new Set(input.baseline?.requirementAcIds ?? []);
  const afterAc = new Set(input.acIds);
  const beforeCases = new Set(input.baseline?.cases.map((item) => item.caseId) ?? []);
  const afterCases = new Set(input.caseIds);
  return {
    requirementVersion: input.requirementVersion.slice(0, 12),
    codeVersion: input.codeVersion.slice(0, 12),
    contractVersion: input.contractVersion.slice(0, 12),
    baselineRunId: input.baseline?.runId,
    addedRequirements: [...afterAc].filter((id) => !beforeAc.has(id)),
    removedRequirements: [...beforeAc].filter((id) => !afterAc.has(id)),
    contractDrift: input.contractDrift || Boolean(input.baseline?.contractVersion
      && input.baseline.contractVersion !== input.contractVersion),
    addedCases: [...afterCases].filter((id) => !beforeCases.has(id)),
    removedCases: [...beforeCases].filter((id) => !afterCases.has(id)),
    newProblems: [...input.newProblems],
    fixedProblems: [...input.fixedProblems],
    regressions: [...input.regressions],
  };
}
