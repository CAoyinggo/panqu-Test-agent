/**
 * 全链路需求溯源矩阵（Requirement Traceability Matrix）
 *
 * 建立稳定的多层追溯拓扑结构，回答：
 * “这个测试结论来自哪条需求、哪个业务场景、哪个执行步骤、哪条真实证据、哪个 Oracle？”
 *
 * 链路：
 * Requirement (Fact / AC)
 *   → Business Flow (Flow / Step)
 *   → Scenario (ScenarioId)
 *   → Executable Step (Operation / Channel)
 *   → Evidence (EvidenceKind / Source / Digest)
 *   → Oracle (Verdict / Reason)
 *   → Problem (ProblemId / RootCause / Remediation)
 */

import type {
  DevTestAcceptanceTrace,
  DevTestBusinessFlowGraph,
  DevTestProblem,
} from './types.js';

export interface TraceabilityItem {
  requirementId: string;
  acId?: string;
  factId?: string;
  flowId?: string;
  flowName?: string;
  stepId?: string;
  operation?: string;
  scenarioId?: string;
  caseId: string;
  executionStatus: string;
  evidenceChannels: string[];
  evidenceComplete: boolean;
  oracleVerdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN';
  oracleReason: string;
  problemIds: string[];
  rootCause?: string;
  remediation?: string;
}

export interface TraceabilityMatrixSummary {
  totalItems: number;
  coveredAcCount: number;
  coveredFactCount: number;
  items: TraceabilityItem[];
}

export class TraceabilityMatrixBuilder {
  static build(input: {
    acceptanceTraces: DevTestAcceptanceTrace[];
    businessFlowGraph: DevTestBusinessFlowGraph;
    problems: DevTestProblem[];
  }): TraceabilityMatrixSummary {
    const flows = input.businessFlowGraph.flows ?? [];
    const problemsByCase = new Map<string, DevTestProblem[]>();

    for (const problem of input.problems) {
      for (const caseId of problem.affectedCases) {
        const list = problemsByCase.get(caseId) ?? [];
        list.push(problem);
        problemsByCase.set(caseId, list);
      }
    }

    const items: TraceabilityItem[] = [];
    const seenAcs = new Set<string>();
    const seenFacts = new Set<string>();

    for (const trace of input.acceptanceTraces) {
      const caseId = trace.caseId;
      const acIds = trace.requirement.acceptanceCriteriaIds ?? [];
      const factIds = trace.requirement.factIds ?? [];

      for (const ac of acIds) seenAcs.add(ac);
      for (const fact of factIds) seenFacts.add(fact);

      // 寻找关联的 Business Flow 与 Step
      const matchedFlow = flows.find((f) =>
        f.steps.some((step) => step.caseIds.includes(caseId))
      );
      const matchedStep = matchedFlow?.steps.find((step) =>
        step.caseIds.includes(caseId)
      );

      const associatedProblems = problemsByCase.get(caseId) ?? [];
      const primaryProblem = associatedProblems[0];

      items.push({
        requirementId: trace.requirement.acceptanceCriteriaIds[0] ?? 'REQ_DEFAULT',
        acId: acIds.join(', ') || undefined,
        factId: factIds.join(', ') || undefined,
        flowId: matchedFlow?.id,
        flowName: matchedFlow?.name,
        stepId: matchedStep?.id,
        operation: matchedStep?.operation ?? trace.testModel.dimension,
        scenarioId: trace.testModel.scenarioId,
        caseId,
        executionStatus: trace.execution.status,
        evidenceChannels: trace.evidence.collected.map(String),
        evidenceComplete: trace.evidence.complete,
        oracleVerdict: trace.oracle.verdict as any,
        oracleReason: trace.oracle.reason,
        problemIds: associatedProblems.map((p) => p.id),
        rootCause: primaryProblem?.rootCause,
        remediation: primaryProblem?.remediation,
      });
    }

    return {
      totalItems: items.length,
      coveredAcCount: seenAcs.size,
      coveredFactCount: seenFacts.size,
      items,
    };
  }
}
