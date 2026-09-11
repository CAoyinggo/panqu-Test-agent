import { describe, expect, it } from 'vitest';
import {
  QualityGateEngine,
  type QualityGateEvaluationInput,
} from '../../../src/devtest/quality-gate-engine.js';
import type {
  DevTestBusinessFlowGraph,
  DevTestOracleResult,
  DevTestDataLifecycleRecord,
  DevTestRequirementCoverageMatrix,
} from '../../../src/devtest/types.js';

function createHealthyInput(): QualityGateEvaluationInput {
  const requirementCoverage: DevTestRequirementCoverageMatrix = {
    behaviors: [],
    coveredAc: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'],
    uncoveredAc: [],
    ambiguousAc: [],
    blockedAc: [],
    coreCoverage: 100,
  };

  const businessFlowGraph: DevTestBusinessFlowGraph = {
    flows: [
      {
        id: 'flow-1',
        name: '视频闭环',
        kind: 'MAIN_HAPPY_PATH',
        core: true,
        status: 'PASS',
        acIds: ['AC-1'], invariantIds: [],
        steps: [
          {
            id: 'step-1',
            order: 0, dependencies: [],
            name: '提交',
            operation: 'POST /task',
            actions: [],
            caseIds: ['TC-1'],
          },
        ],
      },
    ],
    operationCount: 1,
    dependencies: [],
    coverage: 100,
  };

  const oracleResults: DevTestOracleResult[] = [
    {
      caseId: 'TC-1',
      verdict: 'PASS',
      expected: { requirement: [], contract: [], invariants: [] },
      evidence: {
        execution: true, assertion: true, response: true, observedState: true,
        required: ['RESPONSE'],
        collected: ['RESPONSE'],
        complete: true,
      },
      reason: '正常通过',
    },
  ];

  const dataLifecycle: DevTestDataLifecycleRecord = {
    runId: 'run-001',
    createdBy: 'DEVTEST',
    prepareStatus: 'READY',
    cleanupStatus: 'CLEANED',
    traceable: true,
  };

  return {
    requirementCoverage,
    businessFlowGraph,
    oracleResults,
    dataLifecycle,
    crossStepAudits: [
      {
        flowId: 'flow-1',
        passed: true,
        status: 'PASS', primaryKeys: {},
        inconsistencies: [],
        causalChain: [],
      },
    ],
    idempotencyChecks: [
      {
        kind: 'ANTI_DOUBLE_BILLING',
        verdict: 'PASS',
        evidence: { required: [], collected: [], complete: true },
        reason: '扣费安全',
      },
    ],
    pollutionFindings: [],
  };
}

describe('QualityGateEngine', () => {
  it('仅在上游明确标记不适用时跳过空业务流', () => {
    const input = createHealthyInput();
    input.businessFlowGraph.flows = [];
    expect(QualityGateEngine.evaluateFlowCompleteness(input).status).toBe('BLOCKED');
    input.businessFlowGraph.applicable = false;
    expect(QualityGateEngine.evaluateFlowCompleteness(input)).toMatchObject({ status: 'PASS', required: false });
  });
  it('当八大门禁全部达标时，evaluateAll 返回 allPassed: true', () => {
    const input = createHealthyInput();
    const evaluation = QualityGateEngine.evaluateAll(input);

    expect(evaluation.allPassed).toBe(true);
    expect(evaluation.failedGate).toBeUndefined();
    expect(evaluation.blockedGate).toBeUndefined();
    expect(evaluation.gates).toHaveLength(8);
    expect(evaluation.gates.every((g) => g.status === 'PASS')).toBe(true);
  });

  it('1. RequirementCoverage: 当存在未覆盖 AC 时门禁判定为 FAIL', () => {
    const input = createHealthyInput();
    input.requirementCoverage.uncoveredAc = ['AC-UNCOVERED'];
    input.requirementCoverage.coreCoverage = 80;

    const gate = QualityGateEngine.evaluateRequirementCoverage(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('未覆盖 AC');

    const all = QualityGateEngine.evaluateAll(input);
    expect(all.allPassed).toBe(false);
    expect(all.failedGate?.gate).toBe('RequirementCoverage');
  });

  it('2. FlowCompleteness: 当业务流程失败时门禁判定为 FAIL', () => {
    const input = createHealthyInput();
    input.businessFlowGraph.flows[0].status = 'FAIL';
    input.businessFlowGraph.flows[0].reason = '步骤执行失败';

    const gate = QualityGateEngine.evaluateFlowCompleteness(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('业务流程执行失败');
  });

  it('3. EvidenceCompleteness: 当 Oracle 证据不完整时门禁判定为 BLOCKED', () => {
    const input = createHealthyInput();
    input.oracleResults[0].evidence.complete = false;
    input.oracleResults[0].evidence.missing = ['BILLING_LOG'];

    const gate = QualityGateEngine.evaluateEvidenceCompleteness(input);
    expect(gate.status).toBe('BLOCKED');
    expect(gate.reason).toContain('缺少：BILLING_LOG');
  });

  it('4. CrossStepConsistency: 当跨步骤审计失败时门禁判定为 FAIL', () => {
    const input = createHealthyInput();
    input.crossStepAudits = [
      {
        flowId: 'flow-1',
        passed: false,
        status: 'FAIL', primaryKeys: {},
        reason: 'TASK_ID_MISMATCH',
        inconsistencies: ['TASK_ID_MISMATCH'],
        causalChain: [],
      },
    ];

    const gate = QualityGateEngine.evaluateCrossStepConsistency(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('TASK_ID_MISMATCH');
  });

  it('5. IdempotencySafety: 当重试或防重安全违背时门禁判定为 FAIL', () => {
    const input = createHealthyInput();
    input.idempotencyChecks = [
      {
        kind: 'ANTI_DOUBLE_BILLING',
        verdict: 'FAIL',
        evidence: { required: [], collected: [], complete: true },
        reason: '检测到重复扣款',
      },
    ];

    const gate = QualityGateEngine.evaluateIdempotencySafety(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('检测到重复扣款');
  });

  it('6. DataIsolation: 当检测到数据污染时门禁判定为 FAIL', () => {
    const input = createHealthyInput();
    input.pollutionFindings = [
      {
        caseId: 'TC-1',
        severity: 'CRITICAL', changedPaths: ['res-1'], evidence: {},
        classification: 'TEST_POLLUTION',
        reason: '测试数据污染生产数据库表',
      },
    ];

    const gate = QualityGateEngine.evaluateDataIsolation(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('测试数据污染');
  });

  it('7. CleanupIntegrity: 当数据清理失败时门禁判定为 FAIL 且零容忍', () => {
    const input = createHealthyInput();
    input.dataLifecycle.cleanupStatus = 'FAILED';
    input.dataLifecycle.cleanupIssues = ['CLEANUP_FAILED: S3 delete denied'];

    const gate = QualityGateEngine.evaluateCleanupIntegrity(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('未能安全清理');
  });

  it('8. OracleDeterminism: 当存在 UNKNOWN 结论时判定为 FAIL，禁止猜测', () => {
    const input = createHealthyInput();
    input.oracleResults.push({
      caseId: 'TC-2',
      verdict: 'UNKNOWN',
      expected: { requirement: [], contract: [], invariants: [] },
      evidence: { execution: false, assertion: false, response: false, observedState: false, required: [], collected: [], complete: false },
      reason: '无法确定结果',
    });

    const gate = QualityGateEngine.evaluateOracleDeterminism(input);
    expect(gate.status).toBe('FAIL');
    expect(gate.reason).toContain('存在 1 个不确定 (UNKNOWN)');
  });
});
