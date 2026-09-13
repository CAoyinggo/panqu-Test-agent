/**
 * 失败问题诊断与多维归因引擎（Problem Diagnosis Engine）
 *
 * 核心设计：
 * 当测试失败或被阻塞时，结合各个 Oracle、HTTP 状态、分流证据、账单流水进行多维归因分析。
 * 区分四类问题归属：
 * 1. PRODUCT_ERROR: 业务缺陷（扣费错误、漏退款、分流跑偏、产物损坏）
 * 2. ENVIRONMENT_ERROR: 环境/上游故障（502/503/504、网络超时、连接断开）
 * 3. TEST_BLOCKED: 测试配置/前置条件不足（缺少快照凭证、缺少积分账单、凭证未配置）
 * 4. DATA_INCONSISTENCY: 数据不一致（跨表数据不符、任务 ID 丢失、流水错乱）
 */

import type { FlowRunEvidence } from './panqu-playwright-engine.js';
import type { DevTestProblem } from './types.js';

export type ProblemDiagnosisCategory =
  | 'PRODUCT_ERROR'
  | 'ENVIRONMENT_ERROR'
  | 'TEST_BLOCKED'
  | 'DATA_INCONSISTENCY';

export type RetryStrategy =
  | 'NO_RETRY_CODE_FIX'
  | 'EXPONENTIAL_BACKOFF'
  | 'FALLBACK_CHANNEL'
  | 'SUPPLY_CREDENTIALS';

export interface StructuredProblemDiagnosis {
  problemId: string;
  category: ProblemDiagnosisCategory;
  rootCause: string;
  affectedFlow: string;
  summary: string;
  expected: string;
  actual: string;
  remediation: string;
  retryStrategy: RetryStrategy;
  evidenceSnapshot?: Record<string, unknown>;
}

/**
 * 根据 FlowRunEvidence 进行细粒度失败归因与诊断
 */
export function diagnoseFlowEvidence(evidence: FlowRunEvidence): StructuredProblemDiagnosis {
  const problemId = `DIAG-${evidence.caseId || 'TASK'}-${Date.now().toString().slice(-6)}`;
  const flowName = evidence.mediaType === 'video' ? '视频生成端到端链路' : '图片生成端到端链路';

  // 1. 证据缺失阻断 (TEST_BLOCKED) - 最高优先级检查
  if (evidence.diversion.status === 'BLOCKED' || evidence.diversion.evidenceLevel === 'INSUFFICIENT_EVIDENCE'
    || evidence.diversion.reasons.some((r) => /缺少|未提供|缺失/i.test(r))) {
    return {
      problemId,
      category: 'TEST_BLOCKED',
      rootCause: 'MISSING_ROUTING_SNAPSHOT',
      affectedFlow: `${flowName} > 渠道分流核验`,
      summary: '分流快照证据缺失，无法判定实际派发渠道',
      expected: `存在明确路由快照 (${evidence.diversion.expectedChannels?.join(' 或 ') || 'NEWAPI'})`,
      actual: evidence.diversion.reasons.join('；') || '未采集到 extra.diversion / extra.newapi_image 字段',
      remediation: '在测试环境配置 FastAdmin 分流快照持久化，或在测试输入中注入包含路由快照的 mockExtra。缺少证据严禁判定通过。',
      retryStrategy: 'SUPPLY_CREDENTIALS',
      evidenceSnapshot: {
        rawExtra: evidence.diversion.rawExtra,
        evidenceLevel: evidence.diversion.evidenceLevel,
      },
    };
  }

  if (evidence.billing.status === 'BLOCKED' || evidence.billing.reasons.some((r) => /缺少|无法查到/i.test(r))) {
    return {
      problemId,
      category: 'TEST_BLOCKED',
      rootCause: 'MISSING_BILLING_LEDGER',
      affectedFlow: `${flowName} > 积分扣退对账`,
      summary: '积分流水凭据缺失，无法完成对账核算',
      expected: `存在关联 taskId=${evidence.taskId ?? 'N/A'} 的扣费与退款流水记录`,
      actual: evidence.billing.reasons.join('；') || '未查询到 pq_score_log 流水',
      remediation: '检查用户积分变动日志接口或数据库流水授权；验证缺少扣费凭据时的安全门禁。',
      retryStrategy: 'SUPPLY_CREDENTIALS',
      evidenceSnapshot: {
        taskId: evidence.taskId,
        billingStatus: evidence.billing.status,
      },
    };
  }

  if (evidence.supplierCost?.status === 'BLOCKED') {
    return {
      problemId,
      category: 'TEST_BLOCKED',
      rootCause: 'MISSING_SUPPLIER_COST_EVIDENCE',
      affectedFlow: `${flowName} > 供应商成本与毛利核算`,
      summary: '供应商计费与外部消耗凭证缺失',
      expected: '提供上游 GPU 运算耗时记录或明确的采购成本计费依据',
      actual: evidence.supplierCost.reasons.join('；') || '成本核算凭证不足',
      remediation: '配置 upstreamCalls 或关联上游账单流水，严禁在未确认调用凭据时直接将成本归零。',
      retryStrategy: 'SUPPLY_CREDENTIALS',
      evidenceSnapshot: {
        supplierCostVerdict: evidence.supplierCost,
      },
    };
  }

  // 2. 接口提交与网络环境错误 (ENVIRONMENT_ERROR vs PRODUCT_ERROR)
  if (evidence.submission.responseCode !== 1) {
    const status = evidence.submission.responseStatus;
    const isNetworkOr5xx = status >= 500 || status === 0 || /timeout|timed out|network|econnrefused/i.test(evidence.submission.responseMsg);
    if (isNetworkOr5xx) {
      return {
        problemId,
        category: 'ENVIRONMENT_ERROR',
        rootCause: 'UPSTREAM_GATEWAY_OR_NETWORK_ERROR',
        affectedFlow: `${flowName} > 任务接口提交`,
        summary: `任务提交通信失败: HTTP ${status} - ${evidence.submission.responseMsg}`,
        expected: 'HTTP 200/201 且业务 code=1',
        actual: `HTTP ${status} (${evidence.submission.responseMsg})`,
        remediation: '检查目标网关连通性、域名解析与上游服务器健康状态，稍后带退避重试。',
        retryStrategy: 'EXPONENTIAL_BACKOFF',
        evidenceSnapshot: {
          submission: evidence.submission,
        },
      };
    }

    return {
      problemId,
      category: 'PRODUCT_ERROR',
      rootCause: 'TASK_SUBMISSION_REJECTED',
      affectedFlow: `${flowName} > 任务接口提交`,
      summary: `后端业务校验拒绝: code=${evidence.submission.responseCode} (${evidence.submission.responseMsg})`,
      expected: '参数合法并通过业务校验，返回 taskId',
      actual: `code=${evidence.submission.responseCode} msg=${evidence.submission.responseMsg}`,
      remediation: '排查请求参数是否与接口契约冲突（如视频模型缺少 duration，或点数不足）。',
      retryStrategy: 'NO_RETRY_CODE_FIX',
      evidenceSnapshot: {
        params: evidence.submission.params,
        responseMsg: evidence.submission.responseMsg,
      },
    };
  }

  // 3. 异步轮询超时 (ENVIRONMENT_ERROR / DATA_INCONSISTENCY)
  if (evidence.businessTaskStatus === 'TIMEOUT') {
    return {
      problemId,
      category: 'ENVIRONMENT_ERROR',
      rootCause: 'ASYNC_TASK_POLLING_TIMEOUT',
      affectedFlow: `${flowName} > 异步任务生命周期状态机`,
      summary: `轮询超时任务未能在限定时间内达到终态 (pollCount=${evidence.taskTracking.pollCount})`,
      expected: '任务在指定超时时间内转变为 SUCCESS 或 FAILED 终态',
      actual: `任务保持中间状态 status=${evidence.taskTracking.lastResponse?.status ?? 'UNKNOWN'}，已超时`,
      remediation: '排查上游生成节点队列积压情况，或检查任务调度轮询 Worker 是否正常消费。',
      retryStrategy: 'EXPONENTIAL_BACKOFF',
      evidenceSnapshot: {
        taskTracking: evidence.taskTracking,
      },
    };
  }

  // 4. 分流跑偏缺陷 (PRODUCT_ERROR)
  if (evidence.diversion.status === 'FAIL') {
    return {
      problemId,
      category: 'PRODUCT_ERROR',
      rootCause: 'ROUTING_MISMATCH',
      affectedFlow: `${flowName} > 渠道分流路由`,
      summary: `分流渠道偏离预期: 预期命中 [${evidence.diversion.expectedChannels?.join(', ') || 'NEWAPI'}]，实际命中 [${evidence.diversion.actualChannel || '未知'}]`,
      expected: `命中 ${evidence.diversion.expectedChannels?.join(' 或 ') || 'NEWAPI'}`,
      actual: `实际为 ${evidence.diversion.actualChannel ?? '直连/未命中'} (${evidence.diversion.reasons.join('; ')})`,
      remediation: '检查 pq_aivideo_diversion 分流配置中心权重与条件规则，排查是否未命中 model_id 导致穿透至默认路由。',
      retryStrategy: 'NO_RETRY_CODE_FIX',
      evidenceSnapshot: {
        expectedChannels: evidence.diversion.expectedChannels,
        actualChannel: evidence.diversion.actualChannel,
        rawExtra: evidence.diversion.rawExtra,
      },
    };
  }

  // 5. 计费对账缺陷 (PRODUCT_ERROR / DATA_INCONSISTENCY)
  if (evidence.billing.status === 'FAIL') {
    const isRefundIssue = evidence.billing.missingRefund || evidence.billing.duplicateRefunded;
    return {
      problemId,
      category: isRefundIssue ? 'PRODUCT_ERROR' : 'PRODUCT_ERROR',
      rootCause: evidence.billing.missingRefund
        ? 'REFUND_MISSING_ON_FAILURE'
        : evidence.billing.overCharged
        ? 'POINTS_OVERCHARGED'
        : evidence.billing.underCharged
        ? 'POINTS_UNDERCHARGED'
        : 'BILLING_ANOMALY',
      affectedFlow: `${flowName} > 积分账单流水核对`,
      summary: `计费对账不一致: 预期扣除 ${evidence.billing.expectedPoints} pt，实际净扣 ${evidence.billing.netDeductedPoints} pt`,
      expected: `净扣积分 = ${evidence.billing.expectedPoints} pt`,
      actual: `净扣积分 = ${evidence.billing.netDeductedPoints} pt (预扣 ${evidence.billing.preDeductedPoints} pt, 已退 ${evidence.billing.refundedPoints} pt)`,
      remediation: evidence.billing.missingRefund
        ? '修复失败任务退款事务，确保生成失败时 100% 退还用户已扣积分。'
        : '检查定价规则与 site_recharge 折算口径，杜绝点数少扣或多扣。',
      retryStrategy: 'NO_RETRY_CODE_FIX',
      evidenceSnapshot: {
        billing: evidence.billing,
      },
    };
  }

  // 6. 供应商成本核算失败 (PRODUCT_ERROR)
  if (evidence.supplierCost && evidence.supplierCost.status === 'FAIL') {
    return {
      problemId,
      category: 'PRODUCT_ERROR',
      rootCause: 'SUPPLIER_COST_VERIFICATION_FAILED',
      affectedFlow: `${flowName} > 供应商成本与毛利对账`,
      summary: `供应商成本存在未预期偏差: 预期成本 ¥${evidence.supplierCost.expectedCostCny}，实际核算存在冲突`,
      expected: `预期采购成本 ¥${evidence.supplierCost.expectedCostCny}`,
      actual: evidence.supplierCost.reasons.join('；'),
      remediation: '核实各渠道供应商采购单价与毛利换算公式，排查多重调用成本累加是否遗漏。',
      retryStrategy: 'NO_RETRY_CODE_FIX',
      evidenceSnapshot: {
        supplierCost: evidence.supplierCost,
      },
    };
  }

  // 7. 媒体产物缺陷 (PRODUCT_ERROR)
  if (evidence.artifact.status === 'FAIL') {
    return {
      problemId,
      category: 'PRODUCT_ERROR',
      rootCause: 'ARTIFACT_CORRUPTED_OR_INVALID',
      affectedFlow: `${flowName} > 媒体产物解码校验`,
      summary: `媒体产物格式损坏或不符合容器规范: ${evidence.artifact.reasons.join('; ')}`,
      expected: `生成符合规范且可解码的 ${evidence.mediaType.toUpperCase()} 产物`,
      actual: `产物异常: ${evidence.artifact.reasons.join('; ')}`,
      remediation: '排查上游成片合成器转码管道与 OSS 链接可读性，确保容器头完整且视频轨正常。',
      retryStrategy: 'NO_RETRY_CODE_FIX',
      evidenceSnapshot: {
        artifact: evidence.artifact,
      },
    };
  }

  // 8. 默认未知归因
  return {
    problemId,
    category: 'PRODUCT_ERROR',
    rootCause: 'UNCLASSIFIED_FLOW_FAILURE',
    affectedFlow: flowName,
    summary: '全链路执行异常未通过门禁',
    expected: '全链路断言与证据门禁 100% 通过',
    actual: `overallStatus=${evidence.overallStatus}`,
    remediation: '检查全链路日志与 Playwright Trace 现场录制。',
    retryStrategy: 'NO_RETRY_CODE_FIX',
  };
}

/**
 * 将已有的 DevTestProblem 映射为统一的结构化诊断
 */
export function mapProblemToDiagnosis(problem: DevTestProblem): StructuredProblemDiagnosis {
  let category: ProblemDiagnosisCategory = 'PRODUCT_ERROR';
  if (problem.type === 'ENVIRONMENT_MISSING' || problem.failureClass === 'ENVIRONMENT_ISSUE') {
    category = 'ENVIRONMENT_ERROR';
  } else if (problem.type === 'EVIDENCE_MISSING' || problem.reasonCode?.includes('BLOCKED') || problem.type === 'SAFE_BLOCKED') {
    category = 'TEST_BLOCKED';
  } else if (problem.type === 'DATA_CONSISTENCY_BUG') {
    category = 'DATA_INCONSISTENCY';
  }

  return {
    problemId: problem.id,
    category,
    rootCause: problem.rootCause || problem.reasonCode || problem.type,
    affectedFlow: problem.affectedBusinessFlows?.join(', ') || problem.affectedFeature || '主业务流',
    summary: problem.message,
    expected: problem.expected || '业务规则满足且证据完整',
    actual: problem.actual || problem.message,
    remediation: problem.remediation || '查看问题详情并修复产品代码或测试环境配置。',
    retryStrategy: category === 'ENVIRONMENT_ERROR' ? 'EXPONENTIAL_BACKOFF' : 'NO_RETRY_CODE_FIX',
  };
}
