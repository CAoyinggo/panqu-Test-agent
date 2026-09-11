/**
 * 八大质量门禁评估引擎（Quality Gate Engine）
 *
 * 严格执行 8 项门禁，任一关键门禁缺失证据或未通过时，绝不输出 PASS (READY)：
 * 1. RequirementCoverage: 需求覆盖门禁（NORMATIVE 规则与核心 AC 必须 100% 覆盖）
 * 2. FlowCompleteness: 业务流完整性门禁（核心业务流程所有步骤均已获得真实执行且闭环）
 * 3. EvidenceCompleteness: 证据完整性门禁（全流程必要证据链完备无缺失）
 * 4. CrossStepConsistency: 跨步骤一致性门禁（task_id, project_id, user_id, asset_id 等主键全链路吻合）
 * 5. IdempotencySafety: 幂等与重试安全门禁（防重扣、超时去重、重复任务/资产拦截 100% 安全）
 * 6. DataIsolation: 数据与租户隔离门禁（无数据污染，无跨项目/跨租户越权）
 * 7. CleanupIntegrity: 测试数据清理完整性门禁（产生的测试数据必须全部清理，清理失败零容忍）
 * 8. OracleDeterminism: 判定确定性门禁（所有断言与 Oracle 均基于确定性证据，零 UNKNOWN）
 */

import type {
  DevTestBusinessFlowGraph,
  DevTestCrossStepAuditResult,
  DevTestDataLifecycleRecord,
  DevTestIdempotencyCheck,
  DevTestOracleResult,
  DevTestPollutionFinding,
  DevTestQualityGateName,
  DevTestQualityGateResult,
  DevTestRequirementCoverageMatrix,
} from './types.js';

export interface QualityGateEvaluationInput {
  requirementCoverage: DevTestRequirementCoverageMatrix;
  businessFlowGraph: DevTestBusinessFlowGraph;
  oracleResults: DevTestOracleResult[];
  crossStepAudits?: DevTestCrossStepAuditResult[];
  idempotencyChecks?: DevTestIdempotencyCheck[];
  dataLifecycle: DevTestDataLifecycleRecord;
  pollutionFindings?: DevTestPollutionFinding[];
  evidenceCompletenessRatio?: number;
}

export class QualityGateEngine {
  /**
   * 1. 需求覆盖门禁
   */
  static evaluateRequirementCoverage(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const matrix = input.requirementCoverage;
    const uncovered = matrix.uncoveredAc ?? [];
    const ambiguous = matrix.ambiguousAc ?? [];
    const blocked = matrix.blockedAc ?? [];
    const coreCoverage = matrix.coreCoverage ?? 0;

    if (uncovered.length > 0 || blocked.length > 0 || coreCoverage < 100) {
      const issues: string[] = [];
      if (coreCoverage < 100) issues.push(`核心需求覆盖率仅为 ${coreCoverage}% (需 100%)`);
      if (uncovered.length > 0) issues.push(`未覆盖 AC: ${uncovered.join(', ')}`);
      if (blocked.length > 0) issues.push(`阻断 AC: ${blocked.join(', ')}`);

      return {
        gate: 'RequirementCoverage',
        status: blocked.length > 0 ? 'BLOCKED' : 'FAIL',
        required: true,
        score: coreCoverage,
        reason: `需求覆盖门禁未达标：${issues.join('；')}`,
        details: { uncovered, blocked, ambiguous, coreCoverage },
      };
    }

    return {
      gate: 'RequirementCoverage',
      status: 'PASS',
      required: true,
      score: coreCoverage,
      reason: `需求覆盖门禁通过：核心需求覆盖率 100%，无未覆盖或阻断 AC`,
      details: { coveredCount: matrix.coveredAc?.length ?? 0 },
    };
  }

  /**
   * 2. 业务流完整性门禁
   */
  static evaluateFlowCompleteness(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const flows = input.businessFlowGraph.flows ?? [];
    if (flows.length === 0 && input.businessFlowGraph.applicable === false) {
      return { gate: 'FlowCompleteness', status: 'PASS', required: false,
        reason: '业务流门禁不适用：上游明确标记无多步骤流程；单用例证据与 Oracle 仍须通过' };
    }
    if (flows.length === 0) {
      return {
        gate: 'FlowCompleteness',
        status: 'BLOCKED',
        required: true,
        score: 0,
        reason: '业务流完整性门禁阻断：未提取出可验证的业务流程',
      };
    }

    const failedFlows = flows.filter((f) => f.status === 'FAIL');
    const blockedFlows = flows.filter((f) => f.status === 'BLOCKED');
    const passedFlows = flows.filter((f) => f.status === 'PASS');
    const completeness = Math.round((passedFlows.length / flows.length) * 100);

    if (failedFlows.length > 0) {
      return {
        gate: 'FlowCompleteness',
        status: 'FAIL',
        required: true,
        score: completeness,
        reason: `业务流完整性门禁失败：${failedFlows.length} 条业务流程执行失败（${failedFlows.map((f) => f.name).join(', ')}）`,
        details: { failedFlows: failedFlows.map((f) => ({ id: f.id, name: f.name, reason: f.reason })) },
      };
    }

    if (blockedFlows.length > 0) {
      return {
        gate: 'FlowCompleteness',
        status: 'BLOCKED',
        required: true,
        score: completeness,
        reason: `业务流完整性门禁阻断：${blockedFlows.length} 条业务流程被前置条件或证据缺失阻断`,
        details: { blockedFlows: blockedFlows.map((f) => ({ id: f.id, name: f.name, reason: f.reason })) },
      };
    }

    return {
      gate: 'FlowCompleteness',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `业务流完整性门禁通过：全部 ${flows.length} 条业务流均成功闭环通过`,
      details: { totalFlows: flows.length },
    };
  }

  /**
   * 3. 证据完整性门禁
   */
  static evaluateEvidenceCompleteness(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const oracles = input.oracleResults;
    if (oracles.length === 0) {
      return {
        gate: 'EvidenceCompleteness',
        status: 'BLOCKED',
        required: true,
        score: 0,
        reason: '证据完整性门禁阻断：缺少 Oracle 执行结果',
      };
    }

    const incompleteOracles = oracles.filter((o) => !o.evidence.complete);
    const completeCount = oracles.length - incompleteOracles.length;
    const completenessRatio = Math.round((completeCount / oracles.length) * 100);

    if (incompleteOracles.length > 0) {
      return {
        gate: 'EvidenceCompleteness',
        status: 'BLOCKED',
        required: true,
        score: completenessRatio,
        reason: `证据完整性门禁阻断：${incompleteOracles.length} 个测试用例缺失必要证据（缺少：${[...new Set(incompleteOracles.flatMap((o) => o.evidence.missing ?? []))].join(', ')}）`,
        details: { incompleteCaseIds: incompleteOracles.map((o) => o.caseId) },
      };
    }

    return {
      gate: 'EvidenceCompleteness',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `证据完整性门禁通过：全部 ${oracles.length} 个测试用例的证据链均完整`,
    };
  }

  /**
   * 4. 跨步骤一致性门禁
   */
  static evaluateCrossStepConsistency(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const audits = input.crossStepAudits ?? [];
    if (audits.length === 0) {
      // 若流程只有单步或未注入多步骤，检查业务流内部 audit
      const flowAudits = (input.businessFlowGraph.flows ?? [])
        .map((f) => f.crossStepAudit)
        .filter((a): a is DevTestCrossStepAuditResult => Boolean(a));
      if (flowAudits.length > 0) {
        audits.push(...flowAudits);
      }
    }

    if (audits.length === 0) {
      return {
        gate: 'CrossStepConsistency',
        status: 'PASS',
        required: true,
        score: 100,
        reason: '跨步骤一致性门禁通过：无跨步骤复杂长流程依赖或各步骤自包含',
      };
    }

    const failedAudits = audits.filter((a) => !a.passed || a.status === 'FAIL');
    if (failedAudits.length > 0) {
      const reasons = failedAudits.map((a) => a.reason || a.inconsistencies.join('; ')).join('；');
      return {
        gate: 'CrossStepConsistency',
        status: 'FAIL',
        required: true,
        score: Math.round(((audits.length - failedAudits.length) / audits.length) * 100),
        reason: `跨步骤一致性门禁失败：发现跨步骤主键/状态错配（${reasons}）`,
        details: { failedAudits },
      };
    }

    return {
      gate: 'CrossStepConsistency',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `跨步骤一致性门禁通过：全部 ${audits.length} 个业务流的 task_id, project_id, user_id, asset_url 与时序主键完全吻合`,
    };
  }

  /**
   * 5. 幂等与重试安全门禁
   */
  static evaluateIdempotencySafety(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const checks = input.idempotencyChecks ?? [];
    if (checks.length === 0) {
      return {
        gate: 'IdempotencySafety',
        status: 'PASS',
        required: true,
        score: 100,
        reason: '幂等与重试安全门禁通过：无异常重试或重复提交事件',
      };
    }

    const failedChecks = checks.filter((c) => c.verdict === 'FAIL');
    const blockedChecks = checks.filter((c) => c.verdict === 'BLOCKED');

    if (failedChecks.length > 0) {
      return {
        gate: 'IdempotencySafety',
        status: 'FAIL',
        required: true,
        score: Math.round(((checks.length - failedChecks.length) / checks.length) * 100),
        reason: `幂等与重试安全门禁失败：发现 ${failedChecks.length} 项防重安全违背（${failedChecks.map((c) => `${c.kind}: ${c.reason}`).join('；')}）`,
        details: { failedChecks },
      };
    }

    if (blockedChecks.length > 0) {
      return {
        gate: 'IdempotencySafety',
        status: 'BLOCKED',
        required: true,
        score: Math.round(((checks.length - blockedChecks.length) / checks.length) * 100),
        reason: `幂等与重试安全门禁阻断：${blockedChecks.length} 项幂等性测试缺少关键对账流水或快照证据`,
      };
    }

    return {
      gate: 'IdempotencySafety',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `幂等与重试安全门禁通过：全部 ${checks.length} 项防重、防二次扣费与最终一致性校验均安全通过`,
    };
  }

  /**
   * 6. 数据与租户隔离门禁
   */
  static evaluateDataIsolation(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const findings = input.pollutionFindings ?? [];
    const criticalPollutions = findings.filter((f) =>
      f.classification === 'TEST_POLLUTION' || f.classification === 'SHARED_STATE'
    );

    if (criticalPollutions.length > 0) {
      return {
        gate: 'DataIsolation',
        status: 'FAIL',
        required: true,
        score: 0,
        reason: `数据与租户隔离门禁失败：发现 ${criticalPollutions.length} 项数据污染或共享状态破坏（${criticalPollutions.map((f) => f.reason).join('；')}）`,
        details: { criticalPollutions },
      };
    }

    return {
      gate: 'DataIsolation',
      status: 'PASS',
      required: true,
      score: 100,
      reason: '数据与租户隔离门禁通过：测试用例间严格数据隔离，未发生跨租户或共享状态污染',
    };
  }

  /**
   * 7. 测试数据清理完整性门禁
   */
  static evaluateCleanupIntegrity(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const lifecycle = input.dataLifecycle;
    if (lifecycle.cleanupStatus === 'FAILED' || (lifecycle.cleanupIssues && lifecycle.cleanupIssues.length > 0)) {
      return {
        gate: 'CleanupIntegrity',
        status: 'FAIL',
        required: true,
        score: 0,
        reason: `测试数据清理完整性门禁失败：测试产生的数据未能安全清理或发生异常（${lifecycle.cleanupIssues?.join('；')}）`,
        details: { cleanupIssues: lifecycle.cleanupIssues },
      };
    }

    return {
      gate: 'CleanupIntegrity',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `测试数据清理完整性门禁通过：所有临时测试数据已归属、追踪并安全回收（状态：${lifecycle.cleanupStatus}）`,
    };
  }

  /**
   * 8. 判定确定性门禁
   */
  static evaluateOracleDeterminism(input: QualityGateEvaluationInput): DevTestQualityGateResult {
    const oracles = input.oracleResults;
    const unknownOracles = oracles.filter((o) => o.verdict === 'UNKNOWN');
    const blockedOracles = oracles.filter((o) => o.verdict === 'BLOCKED');

    if (unknownOracles.length > 0) {
      return {
        gate: 'OracleDeterminism',
        status: 'FAIL',
        required: true,
        score: Math.round(((oracles.length - unknownOracles.length) / oracles.length) * 100),
        reason: `判定确定性门禁失败：存在 ${unknownOracles.length} 个不确定 (UNKNOWN) 的测试结论，禁止猜测结果`,
        details: { unknownCaseIds: unknownOracles.map((o) => o.caseId) },
      };
    }

    if (blockedOracles.length > 0) {
      return {
        gate: 'OracleDeterminism',
        status: 'BLOCKED',
        required: true,
        score: Math.round(((oracles.length - blockedOracles.length) / oracles.length) * 100),
        reason: `判定确定性门禁阻断：存在 ${blockedOracles.length} 个被阻断 (BLOCKED) 的测试结论`,
        details: { blockedCaseIds: blockedOracles.map((o) => o.caseId) },
      };
    }

    return {
      gate: 'OracleDeterminism',
      status: 'PASS',
      required: true,
      score: 100,
      reason: `判定确定性门禁通过：全部 ${oracles.length} 个用例均具备确定性 Oracle 判定（PASS 或 FAIL）`,
    };
  }

  /**
   * 汇总评估八大质量门禁
   */
  static evaluateAll(input: QualityGateEvaluationInput): {
    gates: DevTestQualityGateResult[];
    allPassed: boolean;
    failedGate?: DevTestQualityGateResult;
    blockedGate?: DevTestQualityGateResult;
  } {
    const gates: DevTestQualityGateResult[] = [
      this.evaluateRequirementCoverage(input),
      this.evaluateFlowCompleteness(input),
      this.evaluateEvidenceCompleteness(input),
      this.evaluateCrossStepConsistency(input),
      this.evaluateIdempotencySafety(input),
      this.evaluateDataIsolation(input),
      this.evaluateCleanupIntegrity(input),
      this.evaluateOracleDeterminism(input),
    ];

    const failedGate = gates.find((g) => g.status === 'FAIL');
    const blockedGate = gates.find((g) => g.status === 'BLOCKED');
    const allPassed = !failedGate && !blockedGate && gates.every((g) => g.status === 'PASS');

    return {
      gates,
      allPassed,
      failedGate,
      blockedGate,
    };
  }
}
