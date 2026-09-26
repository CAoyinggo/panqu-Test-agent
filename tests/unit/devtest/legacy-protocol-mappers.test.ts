import { describe, it, expect } from 'vitest';
import {
  mapPlanToCanonicalTestSpec,
  mapProbeToCanonicalEvidence,
  mapExecuteToExecutionResult,
  mapVerifyToCanonicalEvidence,
  buildCanonicalEvidenceFromVerifyFacts,
  redactSensitiveData,
  type CanonicalVerifyFacts,
} from '../../../src/devtest/legacy-protocol-mappers.js';
import type {
  PlanKernelResult,
  ProbeKernelResult,
  ExecuteKernelResult,
  VerifyKernelResult,
} from '../../../src/devtest/core-kernel.js';

// 深度冻结辅助工具 (用于反证测试: 保证旧对象不可变)
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[prop];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

describe('Legacy Protocol Mappers (Phase 1.3 & 1.3B)', () => {
  const FIXED_TIME = '2026-09-21T10:00:00.000Z';

  // ==========================================================================
  // 1. 副作用与预算安全控制 (Phase 1.3B)
  // ==========================================================================
  describe('1. 副作用与预算显式授权规则', () => {
    it('1.1 REAL 计划不会自动获得 ALLOW_PAID，未显式授权时默认 READ_ONLY + 0 预算并返回 issue', () => {
      const legacyPlan: PlanKernelResult = {
        ok: true,
        modelId: 84,
        mediaType: 'video',
        flowType: 'diversion',
        decision: 'ROUTE_TO_DIVERSION',
        willDivert: true,
        routeLine: 2,
        expectedPoints: 40,
        gatewayRouting: { priority: 1, sourceMode: 'SOURCE_REAL_GATEWAY' } as any,
        candidateChannels: ['Panqu-Video-Direct'],
        reason: '命中分流',
        scenario: 'VIDEO_DIVERSION_CHANGE',
        scenarioName: '视频分流变更',
        changeType: 'diversion_change',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'DETERMINED',
      };

      // 未显式提供 sideEffectPolicy 和 costLimit
      const result = mapPlanToCanonicalTestSpec(legacyPlan, {
        testId: 'spec-test-unauthorized-paid',
        executionMode: 'REAL',
      });

      // 映射应当返回失败 issue，绝不自动晋级为 ALLOW_PAID
      expect(result.success).toBe(false);
      expect(result.issues.some((i) => i.code === 'UNAUTHORIZED_PAID_EXECUTION')).toBe(true);
      expect(result.issues.some((i) => i.code === 'INSUFFICIENT_COST_LIMIT')).toBe(true);
    });

    it('1.2 expectedPoints 不会变成授权预算，授权预算严格取决于 options.costLimit', () => {
      const legacyPlan: PlanKernelResult = {
        ok: true,
        modelId: 84,
        mediaType: 'video',
        flowType: 'diversion',
        decision: 'ROUTE_TO_DIVERSION',
        willDivert: true,
        routeLine: 2,
        expectedPoints: 100, // 预期 100
        gatewayRouting: { priority: 1, sourceMode: 'SOURCE_REAL_GATEWAY' } as any,
        candidateChannels: ['Panqu-Video-Direct'],
        reason: '命中分流',
        scenario: 'VIDEO_DIVERSION_CHANGE',
        scenarioName: '视频分流变更',
        changeType: 'diversion_change',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'DETERMINED',
      };

      // 显式授权 ALLOW_PAID，但预算上限只给 150
      const result = mapPlanToCanonicalTestSpec(legacyPlan, {
        testId: 'spec-test-budget-control',
        executionMode: 'REAL',
        sideEffectPolicy: 'ALLOW_PAID',
        costLimit: { maxCostPoints: 150, allowZeroCostOnly: false },
      });

      expect(result.success).toBe(true);
      expect(result.value!.costLimit.maxCostPoints).toBe(150); // 严格是显式上限 150，不是 expectedPoints (100)
      expect(result.value!.sideEffectPolicy).toBe('ALLOW_PAID');
    });
  });

  // ==========================================================================
  // 2. 证据范围与定价断言规则 (Phase 1.3B)
  // ==========================================================================
  describe('2. requiredEvidence 与定价断言精细化规则', () => {
    it('2.1 pricingStatus=UNVERIFIED 时不生成确定价格断言，且不把 BILLING_LEDGER 纳入必需证据', () => {
      const unverifiedPlan: PlanKernelResult = {
        ok: true,
        modelId: 84,
        mediaType: 'video',
        flowType: 'direct',
        decision: 'DIRECT',
        willDivert: false,
        routeLine: 0,
        expectedPoints: 0,
        gatewayRouting: { priority: 0, sourceMode: 'SOURCE_STATIC_CONTRACT' } as any,
        candidateChannels: [],
        reason: '直连未定价',
        scenario: 'VIDEO_NEW_MODEL',
        scenarioName: '新视频模型未定价',
        changeType: 'new_model',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'UNVERIFIED',
      };

      const result = mapPlanToCanonicalTestSpec(unverifiedPlan, {
        testId: 'spec-unverified-price',
        executionMode: 'FIXTURE',
      });

      expect(result.success).toBe(true);
      const spec = result.value!;
      // 严禁生成 billing.expectedPoints 确定性断言
      expect(spec.deterministicAssertions.some((a) => a.field === 'billing.expectedPoints')).toBe(false);
      // requiredEvidence 不应包含 BILLING_LEDGER
      expect(spec.requiredEvidence.some((e) => e.includes('BILLING_LEDGER'))).toBe(false);
      expect(result.warnings.some((w) => w.includes('UNVERIFIED'))).toBe(true);
    });

    it('2.2 指定 expectedChannelId 时 requiredEvidence 包含路由证据，并生成渠道断言', () => {
      const channelPlan: PlanKernelResult = {
        ok: true,
        modelId: 84,
        mediaType: 'video',
        flowType: 'diversion',
        decision: 'ROUTE_TO_DIVERSION',
        willDivert: true,
        routeLine: 1,
        expectedPoints: 20,
        gatewayRouting: { priority: 1, sourceMode: 'SOURCE_REAL_GATEWAY' } as any,
        candidateChannels: ['Panqu-Direct'],
        reason: '指定路由渠道',
        scenario: 'VIDEO_DIVERSION_CHANGE',
        scenarioName: '渠道承接测试',
        changeType: 'diversion_change',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'DETERMINED',
        disambiguation: {
          targetKind: 'channel',
          channelId: 239458,
          projectId: 9001,
        } as any,
      };

      const result = mapPlanToCanonicalTestSpec(channelPlan, {
        testId: 'spec-channel-route',
        executionMode: 'REAL',
        sideEffectPolicy: 'ALLOW_PAID',
        costLimit: { maxCostPoints: 20 },
      });

      expect(result.success).toBe(true);
      const spec = result.value!;
      // 包含 SERVER_API 路由证据
      expect(spec.requiredEvidence).toContain('SERVER_API:ROUTING_CHANNEL');
      // 包含 expectedChannelId 确定断言
      const routeAssertion = spec.deterministicAssertions.find((a) => a.field === 'routing.expectedChannelId');
      expect(routeAssertion).toBeDefined();
      expect(routeAssertion?.expectedValue).toBe(239458);
    });
  });

  // ==========================================================================
  // 3. 采集状态与业务观察解耦 (Phase 1.3B)
  // ==========================================================================
  describe('3. collectionStatus 与 normalizedFields 业务观察解耦', () => {
    it('3.1 成功采集到业务 FAIL 时 collectionStatus=SUCCESS，业务结果放入 normalizedFields', () => {
      const verifyWithFailedTask: VerifyKernelResult = {
        ok: false,
        passed: false,
        taskId: 88890,
        modelId: 84,
        mediaType: 'video',
        status: 'FAILED',
        verdict: 'FAIL',
        acceptance: 'REJECTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['任务处理超时失败', '视频花屏解码损坏', '账单少退积分'],
        evidence: {
          task: { status: 'FAILED', source: 'SERVER_API (/aivideo/v2/task_status/apiGetStatus)' },
        } as any,
        artifact: {
          decodable: false, // 业务解码失败
          durationSeconds: 0,
          dimensions: { width: 0, height: 0 },
          fileAccessible: true, // 但文件已被成功抓取检查
        } as any,
        billing: {
          passed: false, // 账务审计发现不变量违背
          preDeductedPoints: 40,
          settledPoints: 40,
          netDeductedPoints: 40,
          expectedPoints: 0,
          reasons: ['应全额退款但未退款'],
        } as any,
        invariants: { antiDoubleBilling: true, netChargeZero: false, refundIdempotency: false },
      };

      const result = mapVerifyToCanonicalEvidence(verifyWithFailedTask, {
        testId: 'verify-observed-fail',
        capturedAt: FIXED_TIME,
      });

      expect(result.success).toBe(true);
      expect(result.value).toBeDefined();

      // 1. Task 证据
      const taskEv = result.value!.find((e) => e.subjectType === 'task')!;
      expect(taskEv.collectionStatus).toBe('SUCCESS'); // 采集成功
      expect(taskEv.normalizedFields.observedStatus).toBe('FAIL'); // 业务观察为失败
      expect(taskEv.normalizedFields.assertionMatched).toBe(false);

      // 2. Media 证据
      const mediaEv = result.value!.find((e) => e.subjectType === 'artifact')!;
      expect(mediaEv.collectionStatus).toBe('SUCCESS'); // 采集成功
      expect(mediaEv.normalizedFields.observedStatus).toBe('FAIL');
      expect(mediaEv.normalizedFields.decodable).toBe(false);
      expect(mediaEv.normalizedFields.assertionMatched).toBe(false);

      // 3. Billing 证据
      const billingEv = result.value!.find((e) => e.subjectType === 'billing')!;
      expect(billingEv.collectionStatus).toBe('SUCCESS'); // 采集成功
      expect(billingEv.normalizedFields.observedStatus).toBe('FAIL');
      expect(billingEv.normalizedFields.assertionMatched).toBe(false);
    });

    it('3.2 真正采集失败时才是 COLLECTION_FAILED / MISSING', () => {
      // 1. 端点探活无法拿到 HTTP 响应 (真正采集失败)
      const probeFailed: ProbeKernelResult = {
        env: 'test',
        probedAt: FIXED_TIME,
        auth: { status: 'MISSING', hasSession: false, details: '未找到会话凭据' },
        endpoints: [
          {
            name: 'unreachable_ep',
            url: 'https://invalid-domain.example/probe',
            reachable: false,
            message: 'ECONNREFUSED',
          },
        ],
      } as any;

      const probeRes = mapProbeToCanonicalEvidence(probeFailed, {
        testId: 'probe-collect-failed',
        capturedAt: FIXED_TIME,
      });

      expect(probeRes.success).toBe(true);
      const authEv = probeRes.value!.find((e) => e.subjectType === 'auth')!;
      expect(authEv.collectionStatus).toBe('MISSING');

      const epEv = probeRes.value!.find((e) => e.subjectType === 'endpoint')!;
      expect(epEv.collectionStatus).toBe('COLLECTION_FAILED'); // 未拿到 HTTP 响应
      expect(epEv.error?.code).toBe('ENDPOINT_UNREACHABLE');

      // 2. Verify 产物文件丢失不可访问 (真正采集缺失)
      const verifyArtifactMissing: VerifyKernelResult = {
        ok: false,
        passed: false,
        taskId: 88891,
        modelId: 84,
        mediaType: 'video',
        status: 'FAILED',
        verdict: 'FAIL',
        acceptance: 'REJECTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'SKIPPED_NO_LOGS',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['文件不可访问'],
        evidence: {} as any,
        artifact: {
          fileAccessible: false, // 产物无法访问
          decodable: false,
        } as any,
      };

      const verifyRes = mapVerifyToCanonicalEvidence(verifyArtifactMissing, {
        testId: 'verify-missing-file',
        capturedAt: FIXED_TIME,
      });

      expect(verifyRes.success).toBe(true);
      const missingMediaEv = verifyRes.value!.find((e) => e.subjectType === 'artifact')!;
      expect(missingMediaEv.collectionStatus).toBe('MISSING');
    });
  });

  // ==========================================================================
  // 4. 消除 Date.now() 隐式不确定性 (Phase 1.3B)
  // ==========================================================================
  describe('4. 确定性映射与 ID/时间显式化', () => {
    it('4.1 缺少必要 ID 或时间时返回结构化 mapping issue', () => {
      // 缺少 testId
      const planRes = mapPlanToCanonicalTestSpec(
        { modelId: 84, expectedPoints: 0, scenario: 'VIDEO_NEW_MODEL' } as any,
        {} as any,
      );
      expect(planRes.success).toBe(false);
      expect(planRes.issues.some((i) => i.code === 'MISSING_TEST_ID')).toBe(true);

      // 缺少 capturedAt
      const execRes = mapExecuteToExecutionResult(
        { mode: 'mock', status: 'SUCCESS', ok: true } as any,
        { testId: 'exec-1' } as any,
      );
      expect(execRes.success).toBe(false);
      expect(execRes.issues.some((i) => i.code === 'MISSING_CAPTURED_AT')).toBe(true);

      const verifyRes = mapVerifyToCanonicalEvidence(
        { taskId: 123, executionMode: 'real' } as any,
        { testId: 'v-1' } as any,
      );
      expect(verifyRes.success).toBe(false);
      expect(verifyRes.issues.some((i) => i.code === 'MISSING_CAPTURED_AT')).toBe(true);
    });

    it('4.2 相同输入和 options 映射结果完全一致 (消除 Date.now 随机性)', () => {
      const legacyVerify: VerifyKernelResult = {
        ok: true,
        passed: true,
        taskId: 88881,
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        verdict: 'PASS',
        acceptance: 'ACCEPTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['通过'],
        evidence: {
          task: { status: 'PASS', source: 'SERVER_API' },
        } as any,
        artifact: { decodable: true, durationSeconds: 4, dimensions: { width: 1280, height: 720 } } as any,
        billing: { passed: true, preDeductedPoints: 40, settledPoints: 40, expectedPoints: 40 } as any,
      };

      const options = { testId: 'stable-test-id-99', capturedAt: FIXED_TIME };
      const run1 = mapVerifyToCanonicalEvidence(legacyVerify, options);
      const run2 = mapVerifyToCanonicalEvidence(legacyVerify, options);

      expect(run1).toEqual(run2);
      expect(run1.value![0].evidenceId).toBe('stable-test-id-99-task-1');
      expect(run1.value![1].evidenceId).toBe('stable-test-id-99-artifact-1');
      expect(run1.value![2].evidenceId).toBe('stable-test-id-99-billing-1');
    });
  });

  // ==========================================================================
  // 5. 既有核心映射与边界规则守护 (Phase 1.3 继承)
  // ==========================================================================
  describe('5. 核心协议边界守护', () => {
    it('5.1 plan 映射不得产生 Evidence，且结果不含任何证据信封', () => {
      const legacyPlan: PlanKernelResult = {
        ok: true,
        modelId: 201,
        mediaType: 'image',
        flowType: 'direct',
        decision: 'FALLBACK_DIRECT',
        willDivert: false,
        routeLine: 0,
        expectedPoints: 0,
        gatewayRouting: { priority: 0, sourceMode: 'SOURCE_STATIC_CONTRACT' } as any,
        candidateChannels: [],
        reason: '直连模型',
        scenario: 'IMAGE_NEW_MODEL',
        scenarioName: '图片新模型',
        changeType: 'new_model',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'DETERMINED',
      };

      const result = mapPlanToCanonicalTestSpec(legacyPlan, { testId: 'spec-no-evidence' });

      expect(result.success).toBe(true);
      const rawResult = result as unknown as Record<string, unknown>;
      expect('evidence' in rawResult).toBe(false);
      expect('envelopes' in rawResult).toBe(false);

      const rawSpec = result.value as unknown as Record<string, unknown>;
      expect('evidence' in rawSpec).toBe(false);
      expect('envelopes' in rawSpec).toBe(false);
    });

    it('5.2 REAL execute SUBMITTED 映射为 SUBMITTED，不得为 COMPLETED', () => {
      const legacyExecute: ExecuteKernelResult = {
        ok: true,
        status: 'SUBMITTED',
        mode: 'real',
        points: 40,
        taskId: 23945801,
        modelId: 84,
        mediaType: 'video',
        message: '任务已成功推入队列',
        rawResponse: { code: 0, msg: 'Task submitted', data: { taskId: 23945801 } },
      };

      const result = mapExecuteToExecutionResult(legacyExecute, {
        testId: 'test-exec-3',
        capturedAt: FIXED_TIME,
      });

      expect(result.success).toBe(true);
      expect(result.value!.execution.status).toBe('SUBMITTED');
      expect(result.value!.execution.status).not.toBe('COMPLETED');
    });

    it('5.3 mock execute 只能产生 FIXTURE 证据，严禁标记为 SERVER_API', () => {
      const legacyMockExecute: ExecuteKernelResult = {
        ok: true,
        status: 'SUCCESS',
        mode: 'mock',
        points: 0,
        taskId: 0,
        simulationId: 'sim-video-test-01',
        isSimulated: true,
        modelId: 84,
        mediaType: 'video',
        message: 'Mock execution simulation completed',
      };

      const result = mapExecuteToExecutionResult(legacyMockExecute, {
        testId: 'test-exec-mock',
        capturedAt: FIXED_TIME,
      });

      expect(result.success).toBe(true);
      for (const ev of result.value!.evidence) {
        expect(ev.sourceType).toBe('FIXTURE');
        expect(ev.sourceType).not.toBe('SERVER_API');
      }
    });

    it('5.4 CLI 声明渠道映射为 USER_ASSERTION，静态渠道映射为 FIXTURE，严禁标记为 SERVER_API', () => {
      // CLI 声明渠道
      const verifyAsserted: VerifyKernelResult = {
        ok: true,
        passed: true,
        taskId: 88882,
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        verdict: 'PASS',
        acceptance: 'ACCEPTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['通过'],
        evidence: {} as any,
        isActualChannelAssertedOnly: true,
        provenance: { actualChannelId: 'CLI_ASSERTED_INPUT', fallbackChannel: '', retryProvider: '', extra: '' },
        channelDetail: { actualChannelId: 239458, isGatewayChannelVerified: false } as any,
      };

      const resAsserted = mapVerifyToCanonicalEvidence(verifyAsserted, {
        testId: 'v-asserted',
        capturedAt: FIXED_TIME,
      });
      expect(resAsserted.value![0].sourceType).toBe('USER_ASSERTION');

      // 静态渠道
      const verifyStatic: VerifyKernelResult = {
        ...verifyAsserted,
        isActualChannelAssertedOnly: false,
        provenance: {
          actualChannelId: 'SOURCE_STATIC_CONTRACT:domain-knowledge:239458',
          fallbackChannel: '',
          retryProvider: '',
          extra: '',
        },
      };
      const resStatic = mapVerifyToCanonicalEvidence(verifyStatic, { testId: 'v-static', capturedAt: FIXED_TIME });
      expect(resStatic.value![0].sourceType).toBe('FIXTURE');
    });

    it('5.5 verify 最终 verdict/acceptance/passed 不得进入 Envelope', () => {
      const legacyVerify: VerifyKernelResult = {
        ok: true,
        passed: true,
        taskId: 88886,
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        verdict: 'PASS',
        acceptance: 'ACCEPTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['通过'],
        evidence: { task: { status: 'PASS', source: 'SERVER_API' } } as any,
      };

      const result = mapVerifyToCanonicalEvidence(legacyVerify, { testId: 'v-no-verdict', capturedAt: FIXED_TIME });
      expect(result.success).toBe(true);
      for (const env of result.value!) {
        const rawEnv = env as unknown as Record<string, unknown>;
        expect('verdict' in rawEnv).toBe(false);
        expect('acceptance' in rawEnv).toBe(false);
        expect('passed' in rawEnv).toBe(false);
        expect('status' in rawEnv).toBe(false);

        expect('verdict' in env.normalizedFields).toBe(false);
        expect('acceptance' in env.normalizedFields).toBe(false);
        expect('passed' in env.normalizedFields).toBe(false);
      }
    });

    it('5.6 无法识别来源时返回 issue 并拒绝标记 SERVER_API', () => {
      const legacyVerify: VerifyKernelResult = {
        ok: true,
        passed: true,
        taskId: 88887,
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        verdict: 'PASS',
        acceptance: 'ACCEPTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['来源异常'],
        evidence: {} as any,
        provenance: {
          actualChannelId: 'MYSTERIOUS_UNKNOWN_CHANNEL_ORIGIN',
          fallbackChannel: '',
          retryProvider: '',
          extra: '',
        },
      };

      const result = mapVerifyToCanonicalEvidence(legacyVerify, { testId: 'v-unk-source', capturedAt: FIXED_TIME });
      expect(result.success).toBe(false);
      expect(result.issues.some((i) => i.code === 'UNKNOWN_EVIDENCE_SOURCE')).toBe(true);
    });

    it('5.7 cookie/session/token 必须脱敏且标记 redacted: true', () => {
      const sensitivePayload = {
        password: 'super_secret_pw',
        token: 'jwt.token.123456',
        cookies: 'PHPSESSID=session_value_abc; other=1',
        authorization: 'Bearer token_secret_string',
        safeData: { code: 0, phpsessid: 'inline_secret_123', auth_token: 'bearer_token_xyz' },
      };

      const redacted = redactSensitiveData(sensitivePayload) as Record<string, any>;
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.cookies).toBe('[REDACTED]');
      expect(redacted.authorization).toBe('[REDACTED]');
      expect(redacted.safeData.phpsessid).toBe('[REDACTED]');
      expect(redacted.safeData.auth_token).toBe('[REDACTED]');
      expect(redacted.safeData.code).toBe(0);

      const execWithSecrets: ExecuteKernelResult = {
        ok: true,
        status: 'SUBMITTED',
        mode: 'real',
        points: 0,
        taskId: 99991,
        modelId: 84,
        mediaType: 'video',
        message: 'submitted',
        rawResponse: {
          token: 'secret_token_val',
          authorization: 'Bearer secret_key',
          cookie: 'PHPSESSID=live_session_id',
        },
      };

      const mappedExec = mapExecuteToExecutionResult(execWithSecrets, { testId: 'v-redact', capturedAt: FIXED_TIME });
      expect(mappedExec.success).toBe(true);

      const rawRef = mappedExec.value!.evidence[0].rawReference as Record<string, unknown>;
      expect(rawRef.token).toBe('[REDACTED]');
      expect(rawRef.authorization).toBe('[REDACTED]');
      expect(rawRef.cookie).toBe('[REDACTED]');
      expect(mappedExec.value!.evidence[0].redacted).toBe(true);
    });

    it('5.8 旧对象在映射过程中不得被修改 (Deep Freeze 测试)', () => {
      const frozenPlan = deepFreeze<PlanKernelResult>({
        ok: true,
        modelId: 84,
        mediaType: 'video',
        flowType: 'direct',
        decision: 'DIRECT',
        willDivert: false,
        routeLine: 0,
        expectedPoints: 0,
        gatewayRouting: { priority: 0, sourceMode: 'SOURCE_STATIC_CONTRACT' } as any,
        candidateChannels: ['ch-1', 'ch-2'],
        reason: 'test',
        scenario: 'VIDEO_NEW_MODEL',
        scenarioName: '新视频模型',
        changeType: 'new_model',
        contract: {} as any,
        testPlan: {} as any,
        blocked: [],
        pricingStatus: 'DETERMINED',
      });

      const frozenProbe = deepFreeze<ProbeKernelResult>({
        env: 'test',
        probedAt: FIXED_TIME,
        auth: { status: 'VALID', hasSession: true, details: 'OK' },
        endpoints: [
          { name: 'ep1', url: 'https://test.panqu.com/ep1', reachable: true, statusCode: 200, latencyMs: 50 },
        ],
      } as any);

      const frozenExecute = deepFreeze<ExecuteKernelResult>({
        ok: true,
        status: 'SUBMITTED',
        mode: 'real',
        points: 0,
        taskId: 55555,
        modelId: 84,
        mediaType: 'video',
        message: 'submitted',
        rawResponse: { code: 0, msg: 'ok', data: { id: 55555 } },
      });

      const frozenVerify = deepFreeze<VerifyKernelResult>({
        ok: true,
        passed: true,
        taskId: 55555,
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        verdict: 'PASS',
        acceptance: 'ACCEPTED',
        mode: 'real',
        executionMode: 'real',
        billingAudit: 'AUDITED',
        evidenceCompleteness: {} as any,
        acceptanceReport: {} as any,
        reasons: ['ok'],
        evidence: { task: { status: 'PASS', source: 'SERVER_API' } } as any,
        provenance: { actualChannelId: 'SERVER_RUN_FACT:retrylog', fallbackChannel: '', retryProvider: '', extra: '' },
        artifact: { decodable: true, durationSeconds: 4, dimensions: { width: 1280, height: 720 } } as any,
        billing: {
          passed: true,
          preDeductedPoints: 50,
          settledPoints: 50,
          netDeductedPoints: 50,
          reasons: ['ok'],
        } as any,
      });

      expect(() => mapPlanToCanonicalTestSpec(frozenPlan, { testId: 'freeze-plan' })).not.toThrow();
      expect(() =>
        mapProbeToCanonicalEvidence(frozenProbe, { testId: 'freeze-probe', capturedAt: FIXED_TIME }),
      ).not.toThrow();
      expect(() =>
        mapExecuteToExecutionResult(frozenExecute, { testId: 'freeze-exec', capturedAt: FIXED_TIME }),
      ).not.toThrow();
      expect(() =>
        mapVerifyToCanonicalEvidence(frozenVerify, { testId: 'freeze-verify', capturedAt: FIXED_TIME }),
      ).not.toThrow();
    });
  });

  // ==========================================================================
  // 6. requiredEvidence 与 Evidence Envelope 匹配契约映射 (Phase 1.3C)
  // ==========================================================================
  describe('6. Phase 1.3C 证据键与局部观察状态映射契约', () => {
    const baseVerify: VerifyKernelResult = {
      ok: true,
      passed: true,
      taskId: 12345,
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      verdict: 'PASS',
      acceptance: 'ACCEPTED',
      mode: 'real',
      executionMode: 'real',
      billingAudit: 'AUDITED',
      evidenceCompleteness: {} as any,
      acceptanceReport: {} as any,
      reasons: ['通过'],
      evidence: {} as any,
    };

    it('6.1 channelMatched = true 映射为 PASS 且 assertionMatched = true', () => {
      const verifySuccess: VerifyKernelResult = {
        ...baseVerify,
        provenance: { actualChannelId: 'SERVER_RUN_FACT:retrylog', fallbackChannel: '', retryProvider: '', extra: '' },
        channelDetail: {
          actualChannelId: 2,
          targetChannelId: 2,
          channelMatched: true,
          isGatewayChannelVerified: true,
        } as any,
      };

      const res = mapVerifyToCanonicalEvidence(verifySuccess, { testId: 'v-ch-pass', capturedAt: FIXED_TIME });
      expect(res.success).toBe(true);

      const channelEnv = res.value!.find((e) => e.evidenceKey === 'SERVER_API:ROUTING_CHANNEL');
      expect(channelEnv).toBeDefined();
      expect(channelEnv!.sourceType).toBe('SERVER_API');
      expect(channelEnv!.evidenceKey).toBe('SERVER_API:ROUTING_CHANNEL');
      expect(channelEnv!.observationStatus).toBe('PASS');
      expect(channelEnv!.normalizedFields.observedStatus).toBe('PASS');
      expect(channelEnv!.normalizedFields.assertionMatched).toBe(true);
    });

    it('6.2 channelMatched = false 映射为 FAIL 且 assertionMatched = false，严禁标记 PASS', () => {
      const verifyFail: VerifyKernelResult = {
        ...baseVerify,
        provenance: { actualChannelId: 'SERVER_RUN_FACT:retrylog', fallbackChannel: '', retryProvider: '', extra: '' },
        channelDetail: {
          actualChannelId: 54,
          targetChannelId: 2,
          channelMatched: false,
          isGatewayChannelVerified: true,
        } as any,
      };

      const res = mapVerifyToCanonicalEvidence(verifyFail, { testId: 'v-ch-fail', capturedAt: FIXED_TIME });
      expect(res.success).toBe(true);

      const channelEnv = res.value!.find((e) => e.evidenceKey === 'SERVER_API:ROUTING_CHANNEL');
      expect(channelEnv).toBeDefined();
      expect(channelEnv!.sourceType).toBe('SERVER_API');
      expect(channelEnv!.evidenceKey).toBe('SERVER_API:ROUTING_CHANNEL');
      expect(channelEnv!.observationStatus).toBe('FAIL');
      expect(channelEnv!.normalizedFields.observedStatus).toBe('FAIL');
      expect(channelEnv!.normalizedFields.assertionMatched).toBe(false);
    });

    it('6.3 仅有 assertion/static channel 映射为 UNVERIFIED 且 assertionMatched = false', () => {
      // 1. 调用者入参手填声明 (CLI/MCP)
      const verifyAsserted: VerifyKernelResult = {
        ...baseVerify,
        isActualChannelAssertedOnly: true,
        provenance: { actualChannelId: 'CLI_ASSERTED_INPUT', fallbackChannel: '', retryProvider: '', extra: '' },
        channelDetail: {
          actualChannelId: 2,
          targetChannelId: 2,
          channelMatched: true,
          isGatewayChannelVerified: false,
        } as any,
      };

      const resAsserted = mapVerifyToCanonicalEvidence(verifyAsserted, {
        testId: 'v-ch-asserted',
        capturedAt: FIXED_TIME,
      });
      expect(resAsserted.success).toBe(true);
      const assertedEnv = resAsserted.value!.find((e) => e.evidenceKey === 'USER_ASSERTION:ROUTING_CHANNEL');
      expect(assertedEnv).toBeDefined();
      expect(assertedEnv!.sourceType).toBe('USER_ASSERTION');
      expect(assertedEnv!.observationStatus).toBe('UNVERIFIED');
      expect(assertedEnv!.normalizedFields.observedStatus).toBe('UNVERIFIED');
      expect(assertedEnv!.normalizedFields.assertionMatched).toBe(false);

      // 2. 静态渠道配置
      const verifyStatic: VerifyKernelResult = {
        ...baseVerify,
        provenance: {
          actualChannelId: 'SOURCE_STATIC_CONTRACT:domain-knowledge',
          fallbackChannel: '',
          retryProvider: '',
          extra: '',
        },
        channelDetail: {
          actualChannelId: 2,
          targetChannelId: 2,
          channelMatched: true,
          isGatewayChannelVerified: false,
        } as any,
      };

      const resStatic = mapVerifyToCanonicalEvidence(verifyStatic, { testId: 'v-ch-static', capturedAt: FIXED_TIME });
      expect(resStatic.success).toBe(true);
      const staticEnv = resStatic.value!.find((e) => e.evidenceKey === 'FIXTURE:ROUTING_CHANNEL');
      expect(staticEnv).toBeDefined();
      expect(staticEnv!.sourceType).toBe('FIXTURE');
      expect(staticEnv!.observationStatus).toBe('UNVERIFIED');
      expect(staticEnv!.normalizedFields.observedStatus).toBe('UNVERIFIED');
      expect(staticEnv!.normalizedFields.assertionMatched).toBe(false);
    });

    it('6.4 媒体二进制、账单流水的 evidenceKey 和 observationStatus 正确映射', () => {
      const verifyWithArtifactAndBilling: VerifyKernelResult = {
        ...baseVerify,
        artifact: {
          decodable: true,
          fileAccessible: true,
          durationSeconds: 4,
          dimensions: { width: 1280, height: 720 },
        } as any,
        billing: {
          passed: true,
          preDeductedPoints: 50,
          settledPoints: 50,
          netDeductedPoints: 50,
        } as any,
        evidence: {
          billing: { expectedChargeSource: 'REAL_BILLING_FACT' },
        } as any,
      };

      const res = mapVerifyToCanonicalEvidence(verifyWithArtifactAndBilling, {
        testId: 'v-art-bill',
        capturedAt: FIXED_TIME,
      });
      expect(res.success).toBe(true);

      const mediaEnv = res.value!.find((e) => e.evidenceKey === 'MEDIA_BINARY:CONTAINER_CHECK');
      expect(mediaEnv).toBeDefined();
      expect(mediaEnv!.sourceType).toBe('MEDIA_BINARY');
      expect(mediaEnv!.observationStatus).toBe('PASS');
      expect(mediaEnv!.collectionStatus).toBe('SUCCESS');

      const billEnv = res.value!.find((e) => e.evidenceKey === 'BILLING_LEDGER:TASK_RECORDS');
      expect(billEnv).toBeDefined();
      expect(billEnv!.sourceType).toBe('BILLING_LEDGER');
      expect(billEnv!.observationStatus).toBe('PASS');
      expect(billEnv!.collectionStatus).toBe('SUCCESS');

      // 反证：媒体不可解码或账单未通过时，映射为 FAIL
      const verifyWithFails: VerifyKernelResult = {
        ...baseVerify,
        artifact: {
          decodable: false,
          fileAccessible: true,
        } as any,
        billing: {
          passed: false,
          preDeductedPoints: 50,
          settledPoints: 100,
          netDeductedPoints: 100,
        } as any,
      };

      const resFails = mapVerifyToCanonicalEvidence(verifyWithFails, { testId: 'v-fails', capturedAt: FIXED_TIME });
      expect(resFails.success).toBe(true);
      const failMedia = resFails.value!.find((e) => e.evidenceKey === 'MEDIA_BINARY:CONTAINER_CHECK');
      expect(failMedia?.observationStatus).toBe('FAIL');
      const failBilling = resFails.value!.find((e) => e.evidenceKey === 'BILLING_LEDGER:TASK_RECORDS');
      expect(failBilling?.observationStatus).toBe('FAIL');

      // 反证：文件不可访问或账单日志缺失时，采集为 MISSING，观察为 UNVERIFIED
      const verifyMissing: VerifyKernelResult = {
        ...baseVerify,
        artifact: {
          decodable: true,
          fileAccessible: false,
        } as any,
        billing: {
          passed: true,
        } as any,
        billingAudit: 'SKIPPED_NO_LOGS',
      };

      const resMissing = mapVerifyToCanonicalEvidence(verifyMissing, { testId: 'v-missing', capturedAt: FIXED_TIME });
      expect(resMissing.success).toBe(true);
      const missingMedia = resMissing.value!.find((e) => e.evidenceKey === 'MEDIA_BINARY:CONTAINER_CHECK');
      expect(missingMedia?.collectionStatus).toBe('MISSING');
      expect(missingMedia?.observationStatus).toBe('UNVERIFIED');
      const missingBilling = resMissing.value!.find((e) => e.evidenceKey === 'BILLING_LEDGER:TASK_RECORDS');
      expect(missingBilling?.collectionStatus).toBe('MISSING');
      expect(missingBilling?.observationStatus).toBe('UNVERIFIED');
    });
  });

  // ==========================================================================
  // 7. 路由预测/真实落库对账证据 (Routing Prediction Reconciliation)
  //    契约预测走 NewAPI 网关分流, 但真实落库为直连 (diversion=0/line=1, 无 pq_newapi_task_log 行)。
  //    绝不因"网关不适用"而静默 PASS: 必须生成独立 UNVERIFIED 信封, 结论未决交人工确认是否为合法能力降级。
  // ==========================================================================
  describe('7. 路由对账 UNVERIFIED 证据映射 (预测分流 vs 真实直连)', () => {
    const baseFacts: CanonicalVerifyFacts = {
      testId: 'v-routing-recon',
      capturedAt: FIXED_TIME,
      executionMode: 'real',
      taskId: 239545,
    };

    it('7.1 REAL 模式预测分流但真实直连 → 生成 SERVER_API:ROUTING_RECONCILIATION 信封 (采集 SUCCESS, 观察 UNVERIFIED, 附 ROUTING_PREDICTION_MISMATCH)', () => {
      const facts: CanonicalVerifyFacts = {
        ...baseFacts,
        routingReconciliation: {
          predictedDivert: true,
          actualDiverted: false,
          mismatch:
            '契约预测 willDivert=true, 但 pq_aivideo_new.extra.diversion=0 / pq_volcengine_ai_task.line=1, 真实直连未走网关',
        },
      };

      const res = buildCanonicalEvidenceFromVerifyFacts(facts);
      expect(res.success).toBe(true);
      const recon = res.value!.find((e) => e.evidenceKey === 'SERVER_API:ROUTING_RECONCILIATION');
      expect(recon).toBeDefined();
      // 采集成功、结论未决: 决不能因为网关不适用就消失或判 PASS
      expect(recon?.collectionStatus).toBe('SUCCESS');
      expect(recon?.observationStatus).toBe('UNVERIFIED');
      expect(recon?.confidence).toBe(0.0);
      expect(recon?.sourceType).toBe('SERVER_API');
      expect(recon?.subjectType).toBe('routing_reconciliation');
      expect(recon?.subjectId).toBe(239545);
      expect(recon?.normalizedFields?.actualValue).toBe('ACTUAL_DIRECT');
      expect(recon?.normalizedFields?.expectedValue).toBe('DIVERTED_VIA_NEWAPI_GATEWAY');
      expect(recon?.normalizedFields?.predictedDivert).toBe(true);
      expect(recon?.normalizedFields?.actualDiverted).toBe(false);
      // 采集成功 → error 字段绝不出现 (否则 ERROR_NOT_ALLOWED_ON_SUCCESS 会令信封被静默丢弃);
      // 偏差原因/代码作为业务观察事实记录在 normalizedFields
      expect(recon?.error).toBeUndefined();
      expect(recon?.normalizedFields?.reconciliationCode).toBe('ROUTING_PREDICTION_MISMATCH');
      expect(recon?.normalizedFields?.mismatchReason).toContain('真实直连');
      expect(recon?.provenance).toContain('pq_newapi_task_log');
    });

    it('7.2 OFFLINE/FIXTURE 模式对账映射到 FIXTURE:ROUTING_RECONCILIATION, 绝不冒充 SERVER_API', () => {
      const facts: CanonicalVerifyFacts = {
        ...baseFacts,
        executionMode: 'fixture',
        routingReconciliation: {
          predictedDivert: true,
          actualDiverted: false,
          mismatch: '静态契约: 预测分流但 fixture 落库直连',
        },
      };

      const res = buildCanonicalEvidenceFromVerifyFacts(facts);
      expect(res.success).toBe(true);
      expect(res.value!.some((e) => e.evidenceKey === 'SERVER_API:ROUTING_RECONCILIATION')).toBe(false);
      const recon = res.value!.find((e) => e.evidenceKey === 'FIXTURE:ROUTING_RECONCILIATION');
      expect(recon).toBeDefined();
      expect(recon?.sourceType).toBe('FIXTURE');
      expect(recon?.observationStatus).toBe('UNVERIFIED');
      expect(recon?.provenance).toContain('FIXTURE');
    });

    it('7.3 无对账偏差 (未设置 routingReconciliation.mismatch) → 绝不生成对账信封, 不制造假 FAIL/UNVERIFIED', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts(baseFacts);
      expect(res.success).toBe(true);
      expect(res.value!.some((e) => e.evidenceKey.includes('ROUTING_RECONCILIATION'))).toBe(false);
    });
  });

  // ==========================================================================
  // 8. 业务校验缺省 fail-closed
  //    businessValidationStatus 未提供时: 信封判 UNVERIFIED(结论未决), 绝不缺省 PASS。
  //    这是"伪绿态"防线的一环: 缺失的前置校验不得被静默当作通过。
  // ==========================================================================
  describe('8. 业务校验缺省 fail-closed (businessValidationStatus 未提供 → UNVERIFIED, 绝不默认 PASS)', () => {
    const bvBase: CanonicalVerifyFacts = {
      testId: 'v-bizval-default',
      capturedAt: FIXED_TIME,
      executionMode: 'real',
      taskId: 240001,
    };

    it('8.1 未提供 businessValidationStatus → observationStatus=UNVERIFIED (fail-closed, 不冒充 PASS)', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts(bvBase);
      expect(res.success).toBe(true);
      const bv = res.value!.find((e) => e.evidenceKey === 'SERVER_API:BUSINESS_VALIDATION');
      expect(bv).toBeDefined();
      expect(bv?.observationStatus).toBe('UNVERIFIED');
      expect(bv?.normalizedFields?.assertionMatched).toBe(false);
    });

    it('8.2 显式提供 businessValidationStatus=PASS → 如实透传 PASS', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({ ...bvBase, businessValidationStatus: 'PASS' });
      expect(res.success).toBe(true);
      const bv = res.value!.find((e) => e.evidenceKey === 'SERVER_API:BUSINESS_VALIDATION');
      expect(bv?.observationStatus).toBe('PASS');
      expect(bv?.normalizedFields?.assertionMatched).toBe(true);
    });

    it('8.3 显式提供 businessValidationStatus=FAIL → 如实透传 FAIL', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({ ...bvBase, businessValidationStatus: 'FAIL' });
      const bv = res.value!.find((e) => e.evidenceKey === 'SERVER_API:BUSINESS_VALIDATION');
      expect(bv?.observationStatus).toBe('FAIL');
    });
  });

  // ==========================================================================
  // 9. 账单 provenance 据实标注 (真实 billingSource → BILLING_LEDGER, 绝不误标 FIXTURE)
  //    provenance 应反映真实数据来源(DB 物理落库 / AdminScore HTTP), 而非用 expectedChargeSource
  //    (仅描述"预期分"来源)反推。误标真实证据为 FIXTURE 会自伤可信度(安全方向, 非伪绿态,
  //    但同属不诚实标注), 此处收敛。
  // ==========================================================================
  describe('9. 账单 provenance 据实标注真实数据来源', () => {
    const billBase: CanonicalVerifyFacts = {
      testId: 'v-bill-prov',
      capturedAt: FIXED_TIME,
      executionMode: 'real',
      taskId: 240010,
    };
    const KEY = 'BILLING_LEDGER:TASK_RECORDS';

    it('9.1 真实 DB 物理落库 (source=DATABASE_PHYSICAL_RECORD) + 默认 DEVTEST_EXPECTATION → BILLING_LEDGER, 不得标 FIXTURE', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({
        ...billBase,
        billing: { status: 'PASS', passed: true, settledPoints: 120, source: 'DATABASE_PHYSICAL_RECORD:pq_score_log' },
      });
      const bill = res.value!.find((e) => e.evidenceKey === KEY);
      expect(bill).toBeDefined();
      expect(bill?.observationStatus).toBe('PASS');
      expect(bill?.provenance).toContain('BILLING_LEDGER');
      expect(bill?.provenance).toContain('DATABASE_PHYSICAL_RECORD:pq_score_log');
      expect(bill?.provenance).not.toContain('FIXTURE');
    });

    it('9.2 真实 AdminScore HTTP 实测 (source=auth_adminscore) → BILLING_LEDGER (auth_adminscore)', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({
        ...billBase,
        billing: { status: 'PASS', passed: true, settledPoints: 120, source: 'auth_adminscore' },
      });
      const bill = res.value!.find((e) => e.evidenceKey === KEY);
      expect(bill?.provenance).toBe('BILLING_LEDGER (auth_adminscore)');
    });

    it('9.3 无真实来源标识且非 REAL_BILLING_FACT → 回落 FIXTURE (billing_fixture), 不冒充真实账本', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({
        ...billBase,
        executionMode: 'fixture',
        billing: { status: 'PASS', passed: true, settledPoints: 120, source: 'score_logs' },
      });
      const bill = res.value!.find((e) => e.evidenceKey === KEY);
      expect(bill?.provenance).toBe('FIXTURE (billing_fixture)');
    });

    it('9.4 expectedChargeSource=REAL_BILLING_FACT 且无 source → 保持既有 BILLING_LEDGER (GET /auth/adminscore/index)', () => {
      const res = buildCanonicalEvidenceFromVerifyFacts({
        ...billBase,
        expectedChargeSource: 'REAL_BILLING_FACT',
        billing: { status: 'PASS', passed: true, settledPoints: 120 },
      });
      const bill = res.value!.find((e) => e.evidenceKey === KEY);
      expect(bill?.provenance).toBe('BILLING_LEDGER (GET /auth/adminscore/index)');
    });
  });
});
