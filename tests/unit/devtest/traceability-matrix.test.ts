import { describe, expect, it } from 'vitest';
import { TraceabilityMatrixBuilder } from '../../../src/devtest/traceability-matrix.js';
import type {
  DevTestAcceptanceTrace,
  DevTestBusinessFlowGraph,
  DevTestProblem,
} from '../../../src/devtest/types.js';

describe('TraceabilityMatrixBuilder', () => {
  it('能够把 AcceptanceTrace, Business Flow 与 Problem 关联映射为完整的追溯拓扑', () => {
    const traces: DevTestAcceptanceTrace[] = [
      {
        caseId: 'TC-VIDEO-01',
        requirement: {
          explicitFactIds: ['FACT-VIDEO-PROMPT'], derivedFactIds: [], unknownFactIds: [],
          acceptanceCriteriaIds: ['AC-VIDEO-GEN'],
          factIds: ['FACT-VIDEO-PROMPT'],
        },
        testModel: {
          dimension: 'FUNCTIONAL',
          selection: 'SELECTED',
          selectionReason: '核心闭环', objectiveIds: [],
          scenarioId: 'SCENARIO-VIDEO-MAIN',
        },
        execution: {
          status: 'EXECUTED', rawStatus: 'PASS', processorInvoked: true,
          executed: true,
        },
        evidence: {
          required: ['API_RESPONSE', 'RESOURCE_STATE'],
          collected: ['API_RESPONSE', 'RESOURCE_STATE'], missing: [],
          complete: true,
        },
        oracle: {
          expected: { requirement: [], contract: [], invariants: [] },
          verdict: 'PASS',
          reason: '视频生成任务完成，产物符合预期',
        },
        result: 'PASS',
        classification: 'NONE', problemIds: [], explanation: [],
        executableTest: { status: 'READY', preconditions: [], steps: [], assertions: [], evidencePlan: [], missing: [] },
      },
      {
        caseId: 'TC-VIDEO-FAIL-02',
        requirement: {
          explicitFactIds: ['FACT-VIDEO-BALANCE'], derivedFactIds: [], unknownFactIds: [],
          acceptanceCriteriaIds: ['AC-VIDEO-REFUND'],
          factIds: ['FACT-VIDEO-BALANCE'],
        },
        testModel: {
          dimension: 'FAILURE_REFUND',
          selection: 'SELECTED',
          selectionReason: '失败退款分支', objectiveIds: [],
          scenarioId: 'SCENARIO-VIDEO-FAIL',
        },
        execution: {
          status: 'EXECUTED', rawStatus: 'FAIL', processorInvoked: true,
          executed: true,
        },
        evidence: {
          required: ['LOG'],
          collected: [], missing: ['LOG'],
          complete: false,
        },
        oracle: {
          expected: { requirement: [], contract: [], invariants: [] },
          verdict: 'FAIL',
          reason: '上游失败但未触发退款',
        },
        result: 'FAIL',
        classification: 'PRODUCT_BUG', problemIds: ['PROB-REFUND-001'], explanation: [],
        executableTest: { status: 'READY', preconditions: [], steps: [], assertions: [], evidencePlan: [], missing: [] },
      },
    ];

    const businessFlowGraph: DevTestBusinessFlowGraph = {
      flows: [
        {
          id: 'flow-video-main',
          name: '视频生成主流程',
          kind: 'MAIN_HAPPY_PATH',
          core: true,
          status: 'PASS',
          acIds: ['AC-VIDEO-GEN'], invariantIds: [],
          steps: [
            {
              id: 'step-video-submit',
              order: 0, dependencies: [],
              name: '提交视频生成',
              operation: 'POST /api/panqu/task/video',
              actions: ['POST /api/panqu/task/video'],
              caseIds: ['TC-VIDEO-01'],
            },
          ],
        },
        {
          id: 'flow-video-refund',
          name: '视频生成失败退款',
          kind: 'FAILURE_REFUND',
          core: false,
          status: 'FAIL',
          acIds: ['AC-VIDEO-REFUND'], invariantIds: [],
          steps: [
            {
              id: 'step-video-fail',
              order: 0, dependencies: [],
              name: '失败触发退款',
              operation: 'POST /api/panqu/task/video',
              actions: ['POST /api/panqu/task/video'],
              caseIds: ['TC-VIDEO-FAIL-02'],
            },
          ],
        },
      ],
      operationCount: 2,
      dependencies: [],
      coverage: 100,
    };

    const problems: DevTestProblem[] = [
      {
        id: 'PROB-REFUND-001',
        type: 'BUSINESS_RULE_BUG',
        severity: 'CRITICAL',
        dimension: 'FUNCTIONAL',
        scope: 'BUSINESS_RULE',
        message: '失败未退款',
        reasonCode: 'REFUND_NOT_TRIGGERED',
        affectedCases: ['TC-VIDEO-FAIL-02'],
        rootCause: 'BILLING:REFUND_LOGIC',
        failureClass: 'PRODUCT_BUG',
        judgement: 'CONFIRMED_BUG',
        reproducible: true,
        evidence: {},
        remediation: '检查回调与退款流水',
      },
    ];

    const matrix = TraceabilityMatrixBuilder.build({
      acceptanceTraces: traces,
      businessFlowGraph,
      problems,
    });

    expect(matrix.totalItems).toBe(2);
    expect(matrix.coveredAcCount).toBe(2);
    expect(matrix.coveredFactCount).toBe(2);

    const item1 = matrix.items.find((i) => i.caseId === 'TC-VIDEO-01');
    expect(item1).toBeDefined();
    expect(item1?.flowId).toBe('flow-video-main');
    expect(item1?.flowName).toBe('视频生成主流程');
    expect(item1?.stepId).toBe('step-video-submit');
    expect(item1?.scenarioId).toBe('SCENARIO-VIDEO-MAIN');
    expect(item1?.oracleVerdict).toBe('PASS');
    expect(item1?.problemIds).toHaveLength(0);

    const item2 = matrix.items.find((i) => i.caseId === 'TC-VIDEO-FAIL-02');
    expect(item2).toBeDefined();
    expect(item2?.flowId).toBe('flow-video-refund');
    expect(item2?.oracleVerdict).toBe('FAIL');
    expect(item2?.problemIds).toContain('PROB-REFUND-001');
    expect(item2?.rootCause).toBe('BILLING:REFUND_LOGIC');
    expect(item2?.remediation).toBe('检查回调与退款流水');
  });
});
