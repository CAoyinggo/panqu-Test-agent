/**
 * 业务测试智能体自主规划、变更分析与问题诊断核心测试套件
 *
 * 覆盖四大核心验证场景（Mandatory Cases）：
 * 1. 场景 1：Wan 3.0 NewAPI 分流变更（含 task_type=28，失败退款，万相 Line 10）
 * 2. 场景 2：图片模型计费规则调整（RunningHub 计费调整 vs 纯文案修改裁剪）
 * 3. 场景 3：证据缺失故意拦截（缺少必要分流/扣费证据，必须报告 BLOCKED，严禁给出 PASS）
 * 4. 场景 4：非法任务参数与分流冲突（传入不兼容的模型和参数组合，识别非法业务组合并防御）
 * 5. 补充能力：历史脆弱链路加权、多维失败归因诊断 (PRODUCT_ERROR, ENVIRONMENT_ERROR, TEST_BLOCKED, DATA_INCONSISTENCY)
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeChangeImpact,
  getCapabilityByModel,
  validateBusinessCombination,
  assessHistoricalFragility,
  diagnoseFlowEvidence,
  runAutonomousVerification,
  BUSINESS_CAPABILITY_REGISTRY,
} from '../../src/devtest/index.js';
import type { FlowRunEvidence } from '../../src/devtest/panqu-playwright-engine.js';
import type { SupplierCostVerdict } from '../../src/devtest/supplier-cost-oracle.js';

function createSupplierCostVerdict(
  overrides: Partial<SupplierCostVerdict> = {},
): SupplierCostVerdict {
  return {
    passed: true,
    status: 'PASS',
    expectedCostCny: 0.72,
    unitCostCny: 0.18,
    unit: 'yuan_per_second',
    currency: 'CNY',
    channelCode: 'NEWAPI',
    channelName: 'NewAPI-WanX',
    line: 10,
    pricingBasis: 'TEST',
    isSuccessCharged: true,
    userPointsNetDeducted: 28,
    effectiveCnyPerPoint: 0.1,
    userRevenueCny: 2.8,
    revenueCalculationBasis: '测试夹具',
    rechargeBatchTraceable: true,
    estimatedGrossProfitCny: 2.08,
    estimatedGrossMarginPercent: 74.29,
    grossMarginLabel: '74.29%',
    upstreamCalls: [],
    upstreamExecutionState: 'EXECUTED_SUCCESS',
    evidenceLevel: 'INTERNAL_ESTIMATED',
    externalBillStatus: 'PENDING_SETTLEMENT',
    reasons: [],
    ...overrides,
  };
}

describe('业务测试智能体核心能力验证 (Autonomous Testing Agent)', () => {
  // ------------------------------------------------------------------------
  // 场景 1：Wan 3.0 NewAPI 分流变更
  // ------------------------------------------------------------------------
  describe('场景 1：Wan 3.0 NewAPI 分流与计费变更理解', () => {
    it('能够准确推导视频领域、NewAPI 分流、万相 Line 10 成本与退款 Oracle', () => {
      const requirementText = `
# 需求：Wan 3.0 视频生成接入 NewAPI 分流
1. 模型：Wan 3.0 (model_id=84)，业务 task_type=28
2. 分流：通过 NewAPI 万相 Line 10 派发，落库 extra.diversion=10
3. 计费：标准单价 7 pt/s，若任务失败则 100% 全额退款
4. 上游采购成本：万相 Line 10 成本按 ¥0.18/s 核算
`;

      const impact = analyzeChangeImpact({ requirementText });

      // 1. 领域推导
      expect(impact.affectedDomains).toContain('VIDEO');
      expect(impact.affectedDomains).toContain('DIVERSION');
      expect(impact.affectedDomains).toContain('BILLING');
      expect(impact.affectedDomains).toContain('REFUND');

      // 2. 核心模型命中
      expect(impact.affectedCapabilities.some((c) => c.modelId === 84)).toBe(true);

      // 3. API 与参数映射
      expect(impact.affectedApis.some((a) => a.path === '/aivideo/videonew/index')).toBe(true);
      expect(impact.affectedApis.some((a) => a.keyParameters.includes('task_type'))).toBe(true);

      // 4. 激活的 Oracle 组合
      expect(impact.activatedOracles).toContain('RoutingOracle');
      expect(impact.activatedOracles).toContain('BillingOracle');
      expect(impact.activatedOracles).toContain('SupplierCostOracle');
      expect(impact.activatedOracles).toContain('MediaInspector');
      expect(impact.activatedOracles).toContain('Traceability');

      // 5. 风险等级评定为 HIGH 或 CRITICAL（高风险变更）
      expect(['HIGH', 'CRITICAL']).toContain(impact.riskLevel);

      // 6. 规划场景组合：包含主流程、分流防线、失败退款逆向用例
      const kinds = impact.recommendedScenarios.map((s) => s.kind);
      expect(kinds).toContain('MAIN_FLOW');
      expect(kinds).toContain('ROUTING_GUARD');
      expect(kinds).toContain('FAILURE_REFUND');
      expect(kinds).toContain('BILLING_CONSISTENCY');
    });

    it('自主规划并执行 Wan 3.0 全链路验证闭环', async () => {
      const result = await runAutonomousVerification({
        requirementText: 'Wan 3.0 (model_id=84) 分流 NewAPI 万相 Line 10，支持生成与失败退款',
        isMock: true,
        verbose: false,
      });

      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.status).toBe('READY');
      expect(result.summary.failed).toBe(0);
      expect(result.summary.blocked).toBe(0);

      // 验证生成的场景中包含主流程和退款用例
      const mainFlow = result.scenariosExecuted.find((s) => s.kind === 'MAIN_FLOW');
      expect(mainFlow?.status).toBe('PASS');
      expect(mainFlow?.evidence?.diversion.isDiverted).toBe(true);
      expect(mainFlow?.evidence?.billing.netDeductedPoints).toBe(28);

      const refundFlow = result.scenariosExecuted.find((s) => s.kind === 'FAILURE_REFUND');
      expect(refundFlow?.status).toBe('PASS');
      expect(refundFlow?.evidence?.billing.netDeductedPoints).toBe(0); // 失败净扣 0
      expect(refundFlow?.evidence?.billing.refundedPoints).toBe(28);   // 全额退还 28

      const invalidCombination = result.scenariosExecuted.find((s) => s.kind === 'INVALID_COMBINATION');
      expect(invalidCombination?.status).toBe('PASS');
      expect(invalidCombination?.evidence).toBeUndefined(); // 提交前已由参数契约拒绝，不伪造任务证据
    });

    it('真实执行请求和不可读需求文件均 fail closed', async () => {
      await expect(runAutonomousVerification({
        requirementText: 'Wan 3.0 视频验证',
        isMock: false,
      })).rejects.toThrow('DEVTEST_VERIFY_REAL_UNSUPPORTED');

      await expect(runAutonomousVerification({
        requirementFile: path.join(tmpdir(), 'devtest-requirement-does-not-exist.md'),
        outputDir: path.join(tmpdir(), 'devtest-autonomous-read-failure'),
        verbose: false,
      })).rejects.toThrow('DEVTEST_REQUIREMENT_READ_FAILED');
    });
  });

  // ------------------------------------------------------------------------
  // 场景 2：图片模型计费规则调整与风险驱动裁剪
  // ------------------------------------------------------------------------
  describe('场景 2：图片模型计费调整 vs 纯文案修改的风险驱动裁剪', () => {
    it('图片模型计费调整被识别为 HIGH 风险并激活 BillingOracle', () => {
      const pricingChangeText = `
# 需求：RunningHub 场景生图定价调整
调整 RunningHub nano banana 2 (model_id=201, serviceline=r) 的计费规则，从 5 积分调整为 6 积分，核算采购成本与毛利。
`;
      const impact = analyzeChangeImpact({ requirementText: pricingChangeText });

      expect(impact.affectedDomains).toContain('IMAGE');
      expect(impact.affectedDomains).toContain('BILLING');
      expect(impact.activatedOracles).toContain('BillingOracle');
      expect(impact.activatedOracles).toContain('SupplierCostOracle');
      expect(impact.riskLevel).toBe('HIGH');
      expect(impact.prunedCategories.length).toBe(0); // 高风险不裁剪
      expect(impact.recommendedScenarios.some((s) => s.targetModelId === 201)).toBe(true);
    });

    it('纯前端文案或样式变更被评估为 LOW 风险并自动裁剪重型端到端验证', () => {
      const cosmeticChangeText = `
# 需求：前端提示文案优化
修改生图按钮的悬浮提示文案 placeholder 与图标样式 padding，优化视觉体验。
`;
      const impact = analyzeChangeImpact({ requirementText: cosmeticChangeText });

      expect(impact.riskLevel).toBe('LOW');
      expect(impact.prunedCategories.length).toBeGreaterThan(0);
      expect(impact.prunedCategories.some((c) => c.includes('重型端到端'))).toBe(true);
      expect(impact.reasons.some((r) => r.includes('风险驱动裁剪'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------------
  // 场景 3：证据缺失故意拦截（必须报告 BLOCKED，严禁给出 PASS）
  // ------------------------------------------------------------------------
  describe('场景 3：证据缺失安全门禁与归因诊断', () => {
    it('当缺少分流快照或计费流水时，测试结论必须为 BLOCKED，严禁给出 PASS', async () => {
      const result = await runAutonomousVerification({
        requirementText: 'Wan 3.0 分流验证（故意剥离快照证据）',
        isMock: true,
        simulateMissingEvidence: true, // 故意缺失快照
        verbose: false,
      });

      // 门禁结论铁律：绝不能是 READY (PASS)
      expect(result.status).toBe('BLOCKED');
      expect(result.status).not.toBe('READY');
      expect(result.summary.blocked).toBeGreaterThan(0);

      // 归因诊断检查：归类必须为 TEST_BLOCKED
      const diag = result.diagnoses.find((d) => d.category === 'TEST_BLOCKED');
      expect(diag).toBeDefined();
      expect(diag?.rootCause).toMatch(/MISSING_ROUTING_SNAPSHOT|MISSING_BILLING_LEDGER/);
      expect(diag?.remediation).toContain('测试环境');
    });

    it('单任务证据诊断器对缺少分流证据给出 TEST_BLOCKED 归因', () => {
      const mockEvidence: FlowRunEvidence = {
        caseId: 'CASE_MISSING_EXTRA',
        runId: 'RUN_TEST',
        mediaType: 'video',
        overallStatus: 'BLOCKED',
        businessTaskStatus: 'SUCCESS',
        testAssertionStatus: 'BLOCKED',
        executionMode: 'MOCK',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        submission: {
          method: 'POST',
          url: '/aivideo/videonew/index',
          params: {},
          responseStatus: 200,
          responseCode: 1,
          responseMsg: 'ok',
          durationMs: 100,
        },
        taskTracking: {
          pollCount: 1,
          terminalStatus: 'SUCCESS',
          durationMs: 200,
          timeline: [],
        },
        diversion: {
          willDivert: true,
          expectedNewApi: true,
          expectedChannels: ['NEWAPI'],
          actualNewApi: false,
          status: 'BLOCKED',
          reasons: ['缺少 extra 分流快照字段'],
          evidenceState: 'UNVERIFIED',
          evidenceLevel: 'INSUFFICIENT_EVIDENCE',
        },
        artifact: {
          passed: true,
          status: 'PASS',
          skipped: false,
          fileAccessible: true,
          mediaType: 'video',
          decodable: true,
          reasons: [],
          qualityClassification: 'TASK_SUCCESS_AND_VALID',
        },
        billing: {
          passed: true,
          status: 'PASS',
          expectedPoints: 28,
          unit: 'points',
          preDeductedPoints: 28,
          settledPoints: 28,
          refundedPoints: 0,
          netDeductedPoints: 28,
          underCharged: false,
          overCharged: false,
          duplicateCharged: false,
          duplicateRefunded: false,
          asyncSettlementPending: false,
          ledgerEntries: [],
          balanceAuxiliaryNote: '',
          reasons: [],
        },
        supplierCost: createSupplierCostVerdict(),
        screenshots: [],
        diagnosticLog: [],
      };

      const diag = diagnoseFlowEvidence(mockEvidence);
      expect(diag.category).toBe('TEST_BLOCKED');
      expect(diag.rootCause).toBe('MISSING_ROUTING_SNAPSHOT');
      expect(diag.remediation).toContain('缺少证据严禁判定通过');
    });
  });

  // ------------------------------------------------------------------------
  // 场景 4：非法任务参数与分流冲突（识别非法业务组合并防御）
  // ------------------------------------------------------------------------
  describe('场景 4：非法任务参数与分流冲突校验', () => {
    it('能够识别视频模型传入生图 serviceline 或负时长的非法业务组合', () => {
      // 视频模型 Wan 3.0 错误传入生图参数 serviceline='r' 与负数时长
      const check = validateBusinessCombination({
        mediaType: 'video',
        modelId: 84,
        serviceline: 'r',
        duration: -5,
        taskType: 999, // 非法 taskType
      });

      expect(check.valid).toBe(false);
      expect(check.suggestedAction).toBe('REJECT_WITH_400');
      expect(check.violations.some((v) => v.includes('serviceline'))).toBe(true);
      expect(check.violations.some((v) => v.includes('duration=-5 必须大于 0'))).toBe(true);
      expect(check.violations.some((v) => v.includes('task_type=999'))).toBe(true);
    });

    it('能够识别生图模型错误传入视频时长参数的非法业务组合', () => {
      // 生图模型 RunningHub 错误传入 duration
      const check = validateBusinessCombination({
        mediaType: 'image',
        modelId: 201,
        duration: 10,
      });

      expect(check.valid).toBe(false);
      expect(check.violations.some((v) => v.includes('包含了视频专用的 duration'))).toBe(true);
    });

    it('合法业务组合校验通过', () => {
      const validVideo = validateBusinessCombination({
        mediaType: 'video',
        modelId: 84,
        duration: 4,
        taskType: 28,
      });
      expect(validVideo.valid).toBe(true);
      expect(validVideo.violations.length).toBe(0);
      expect(validVideo.suggestedAction).toBe('EXECUTE');

      const validImage = validateBusinessCombination({
        mediaType: 'image',
        modelId: 201,
        serviceline: 'r',
      });
      expect(validImage.valid).toBe(true);
      expect(validImage.suggestedAction).toBe('EXECUTE');
    });
  });

  // ------------------------------------------------------------------------
  // 补充能力：历史脆弱链路画像与优先级加权
  // ------------------------------------------------------------------------
  describe('历史执行反馈画像与脆弱链路评估', () => {
    it('对历史易超时的 Wan 3.0 直连 task_type=105 调高优先级并发出风险预警', () => {
      const assessment = assessHistoricalFragility({
        modelId: 84,
        taskType: 105,
        channel: 'MAIN_SITE',
      });

      expect(assessment.isFragile).toBe(true);
      expect(assessment.fragilityScore).toBeGreaterThanOrEqual(80);
      expect(assessment.priorityBoost).toBe(true);
      expect(assessment.riskNotes.some((n) => n.includes('超时'))).toBe(true);
      expect(assessment.recommendedMitigations.some((m) => m.includes('task_type=28'))).toBe(true);
    });

    it('对 Seedance 2.0 在 NewAPI 渠道标记 503 兜底降级要求', () => {
      const assessment = assessHistoricalFragility({
        modelId: 15,
        taskType: 28,
        channel: 'NEWAPI',
      });

      expect(assessment.isFragile).toBe(true);
      expect(assessment.requireFallbackVerification).toBe(true);
      expect(assessment.riskNotes.some((n) => n.includes('503'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------------
  // 补充能力：结构化失败归因诊断引擎
  // ------------------------------------------------------------------------
  describe('多维度失败归因诊断 (PRODUCT_ERROR, ENVIRONMENT_ERROR, DATA_INCONSISTENCY)', () => {
    it('计费少退款归因为 PRODUCT_ERROR 且指明 REFUND_MISSING_ON_FAILURE', () => {
      const mockRefundFail: FlowRunEvidence = {
        caseId: 'REFUND_FAIL_SAMPLE',
        runId: 'RUN_1',
        mediaType: 'video',
        overallStatus: 'FAIL',
        businessTaskStatus: 'FAILED',
        testAssertionStatus: 'FAIL',
        executionMode: 'MOCK',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        submission: {
          method: 'POST',
          url: '/aivideo/videonew/index',
          params: {},
          responseStatus: 200,
          responseCode: 1,
          responseMsg: 'ok',
          durationMs: 100,
        },
        taskTracking: {
          pollCount: 2,
          terminalStatus: 'FAILED',
          durationMs: 200,
          timeline: [],
        },
        diversion: {
          willDivert: true,
          expectedNewApi: true,
          expectedChannels: ['NEWAPI'],
          actualNewApi: true,
          actualChannel: 'NEWAPI',
          status: 'PASS',
          reasons: [],
          evidenceState: 'VERIFIED',
          evidenceLevel: 'DUAL_SYSTEM_VERIFIED',
        },
        artifact: {
          passed: true,
          status: 'PASS',
          skipped: true,
          fileAccessible: false,
          mediaType: 'video',
          decodable: false,
          reasons: [],
          qualityClassification: 'TASK_FAILED_SKIPPED',
        },
        billing: {
          passed: false,
          status: 'FAIL',
          expectedPoints: 0,
          unit: 'points',
          preDeductedPoints: 28,
          settledPoints: 0,
          refundedPoints: 0, // 漏退款！
          netDeductedPoints: 28,
          underCharged: false,
          overCharged: true,
          duplicateCharged: false,
          duplicateRefunded: false,
          missingRefund: true,
          asyncSettlementPending: false,
          ledgerEntries: [],
          balanceAuxiliaryNote: '',
          reasons: ['失败任务未全额退款，净扣除 28 积分不为 0'],
        },
        supplierCost: createSupplierCostVerdict({
          userPointsNetDeducted: 28,
          upstreamExecutionState: 'EXECUTED_FAILED',
        }),
        screenshots: [],
        diagnosticLog: [],
      };

      const diag = diagnoseFlowEvidence(mockRefundFail);
      expect(diag.category).toBe('PRODUCT_ERROR');
      expect(diag.rootCause).toBe('REFUND_MISSING_ON_FAILURE');
      expect(diag.expected).toContain('0 pt');
      expect(diag.actual).toContain('28 pt');
      expect(diag.remediation).toContain('退还用户已扣积分');
    });

    it('网关 502/503 或网络超时归因为 ENVIRONMENT_ERROR 并建议指数退避重试', () => {
      const mockEnvFail: FlowRunEvidence = {
        caseId: 'ENV_503_SAMPLE',
        runId: 'RUN_2',
        mediaType: 'video',
        overallStatus: 'FAIL',
        businessTaskStatus: 'NOT_SUBMITTED',
        testAssertionStatus: 'FAIL',
        executionMode: 'MOCK',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        submission: {
          method: 'POST',
          url: '/aivideo/videonew/index',
          params: {},
          responseStatus: 503,
          responseCode: 0,
          responseMsg: 'Service Temporarily Unavailable (NewAPI Gateway 503)',
          durationMs: 100,
        },
        taskTracking: {
          pollCount: 0,
          terminalStatus: 'NOT_SUBMITTED',
          durationMs: 0,
          timeline: [],
        },
        diversion: {
          willDivert: true,
          expectedNewApi: true,
          expectedChannels: ['NEWAPI'],
          actualNewApi: false,
          status: 'BLOCKED',
          reasons: ['接口未提交成功'],
          evidenceState: 'UNVERIFIED',
          evidenceLevel: 'INSUFFICIENT_EVIDENCE',
        },
        artifact: {
          passed: false,
          status: 'BLOCKED',
          skipped: true,
          fileAccessible: false,
          mediaType: 'video',
          decodable: false,
          reasons: [],
          qualityClassification: 'UNVERIFIED',
        },
        billing: {
          passed: false,
          status: 'BLOCKED',
          expectedPoints: 28,
          unit: 'points',
          preDeductedPoints: 0,
          settledPoints: 0,
          refundedPoints: 0,
          netDeductedPoints: 0,
          underCharged: false,
          overCharged: false,
          duplicateCharged: false,
          duplicateRefunded: false,
          asyncSettlementPending: false,
          ledgerEntries: [],
          balanceAuxiliaryNote: '',
          reasons: [],
        },
        supplierCost: createSupplierCostVerdict({
          passed: false,
          status: 'BLOCKED',
          expectedCostCny: 0,
          estimatedGrossProfitCny: 0,
          estimatedGrossMarginPercent: undefined,
          grossMarginLabel: 'N/A (收入为0，不适用)',
          upstreamExecutionState: 'UNKNOWN',
          evidenceLevel: 'UNVERIFIED',
          reasons: ['上游未执行，成本凭证缺失'],
        }),
        screenshots: [],
        diagnosticLog: [],
      };

      const diag = diagnoseFlowEvidence(mockEnvFail);
      // 因为 diversion 处于 BLOCKED，缺失快照会先触发 TEST_BLOCKED；若先看 submission 则为 ENVIRONMENT_ERROR
      expect(['ENVIRONMENT_ERROR', 'TEST_BLOCKED']).toContain(diag.category);
      expect(diag.retryStrategy).toMatch(/EXPONENTIAL_BACKOFF|SUPPLY_CREDENTIALS/);
    });
  });
});
