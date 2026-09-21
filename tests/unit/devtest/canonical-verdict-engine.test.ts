import { describe, expect, it } from 'vitest';
import {
  evaluateCanonicalVerdict,
  evaluateOperator,
  type CanonicalVerdictResult,
} from '../../../src/devtest/canonical-verdict-engine.js';
import type {
  CanonicalTestSpec,
  CanonicalEvidenceEnvelope,
} from '../../../src/devtest/canonical-protocol.js';

describe('Canonical Verdict Engine 纯函数与真值表测试 (Phase 1.4)', () => {
  const FIXED_TIME = '2026-09-21T10:00:00.000Z';

  const baseSpec: CanonicalTestSpec = {
    testId: 'test-verdict-001',
    requirementId: 'REQ-VERDICT-01',
    scenario: 'VIDEO_GENERATION_ACCEPTANCE',
    environment: 'test',
    executionMode: 'REAL',
    target: { targetType: 'model', modelId: 78, expectedChannelId: 2 },
    inputs: { prompt: 'A running horse' },
    deterministicAssertions: [
      {
        field: 'billing.actualCharge',
        operator: 'EQUALS',
        expectedValue: 50,
        critical: true,
        evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
        actualField: 'actualCharge',
      },
      {
        field: 'routing.expectedChannelId',
        operator: 'EQUALS',
        expectedValue: 2,
        critical: true,
        evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
        actualField: 'actualValue',
      },
    ],
    costLimit: { maxCostPoints: 50 },
    sideEffectPolicy: 'ALLOW_PAID',
    requiredEvidence: [
      'SERVER_API:TASK_STATUS',
      'SERVER_API:ROUTING_CHANNEL',
      'BILLING_LEDGER:TASK_RECORDS',
    ],
  };

  const createServerTaskEnv = (
    overrides?: Partial<CanonicalEvidenceEnvelope>
  ): CanonicalEvidenceEnvelope => ({
    evidenceId: 'ev-task-1',
    testId: 'test-verdict-001',
    sourceTool: 'fetcher',
    sourceType: 'SERVER_API',
    evidenceKey: 'SERVER_API:TASK_STATUS',
    observationStatus: 'PASS',
    capturedAt: FIXED_TIME,
    environment: 'test',
    subjectType: 'task',
    subjectId: 1001,
    normalizedFields: { observedStatus: 'PASS', rawTaskStatus: 'PASS' },
    provenance: 'SERVER_API (/aivideo/v2/task_status/apiGetStatus)',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
    ...overrides,
  });

  const createServerChannelEnv = (
    overrides?: Partial<CanonicalEvidenceEnvelope>
  ): CanonicalEvidenceEnvelope => ({
    evidenceId: 'ev-channel-1',
    testId: 'test-verdict-001',
    sourceTool: 'runtime',
    sourceType: 'SERVER_API',
    evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
    observationStatus: 'PASS',
    capturedAt: FIXED_TIME,
    environment: 'test',
    subjectType: 'gateway_channel',
    subjectId: 2,
    normalizedFields: { observedStatus: 'PASS', actualValue: 2, targetValue: 2 },
    provenance: 'SERVER_RUN_FACT:retrylog',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
    ...overrides,
  });

  const createBillingEnv = (
    overrides?: Partial<CanonicalEvidenceEnvelope>
  ): CanonicalEvidenceEnvelope => ({
    evidenceId: 'ev-billing-1',
    testId: 'test-verdict-001',
    sourceTool: 'billing-oracle',
    sourceType: 'BILLING_LEDGER',
    evidenceKey: 'BILLING_LEDGER:TASK_RECORDS',
    observationStatus: 'PASS',
    capturedAt: FIXED_TIME,
    environment: 'test',
    subjectType: 'billing',
    subjectId: 1001,
    normalizedFields: { observedStatus: 'PASS', actualCharge: 50 },
    provenance: 'BILLING_LEDGER (GET /auth/adminscore/index)',
    confidence: 1.0,
    immutable: true,
    redacted: true,
    collectionStatus: 'SUCCESS',
    ...overrides,
  });

  // ==========================================================================
  // 真值表测试 1~13: 裁决优先级与状态流转
  // ==========================================================================
  describe('一、裁决优先级与真值表核心规则', () => {
    it('1. 全部必需证据 PASS、关键断言 PASS → PASS', () => {
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('PASS');
      expect(res.testId).toBe('test-verdict-001');
      expect(res.requiredEvidenceEvaluation.satisfied).toBe(true);
      expect(res.assertionResults.every((a) => a.status === 'PASS')).toBe(true);
      expect(res.evidenceIdsUsed).toContain('ev-task-1');
      expect(res.evidenceIdsUsed).toContain('ev-channel-1');
      expect(res.evidenceIdsUsed).toContain('ev-billing-1');
      expect(res.reasons.some((r) => r.includes('验证成功'))).toBe(true);
    });

    it('2. 必需证据 FAIL → FAIL', () => {
      const envelopes = [
        createServerTaskEnv({ observationStatus: 'FAIL', normalizedFields: { observedStatus: 'FAIL' } }),
        createServerChannelEnv(),
        createBillingEnv(),
      ];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('FAIL');
      expect(res.requiredEvidenceEvaluation.failedEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
      expect(res.reasons.some((r) => r.includes('必需证据观察明确失败'))).toBe(true);
    });

    it('3. 必需证据缺失 → UNVERIFIED', () => {
      // 缺少 BILLING_LEDGER:TASK_RECORDS
      const envelopes = [createServerTaskEnv(), createServerChannelEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BILLING_LEDGER:TASK_RECORDS');
      expect(res.reasons.some((r) => r.includes('必需证据缺失'))).toBe(true);
    });

    it('4. COLLECTION_FAILED → UNVERIFIED', () => {
      const envelopes = [
        createServerTaskEnv(),
        createServerChannelEnv(),
        createBillingEnv({
          collectionStatus: 'COLLECTION_FAILED',
          observationStatus: 'UNVERIFIED',
          error: { code: 'NETWORK_ERR', message: '拉取超时' },
        }),
      ];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BILLING_LEDGER:TASK_RECORDS');
    });

    it('5. BLOCKED → UNVERIFIED', () => {
      const envelopes = [
        createServerTaskEnv(),
        createServerChannelEnv(),
        createBillingEnv({
          collectionStatus: 'BLOCKED',
          observationStatus: 'UNVERIFIED',
          error: { code: 'POLICY_BLOCKED', message: '权限阻断' },
        }),
      ];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('BILLING_LEDGER:TASK_RECORDS');
    });

    it('6. observationStatus=UNVERIFIED → UNVERIFIED', () => {
      const envelopes = [
        createServerTaskEnv(),
        createServerChannelEnv({ observationStatus: 'UNVERIFIED' }),
        createBillingEnv(),
      ];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.unverifiedEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
    });

    it('7. FAIL 与缺失同时存在 → FAIL (FAIL 优先于 UNVERIFIED)', () => {
      // TASK 为 FAIL，同时缺少 BILLING
      const envelopes = [
        createServerTaskEnv({ observationStatus: 'FAIL' }),
        createServerChannelEnv(),
        // 缺少 createBillingEnv()
      ];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('FAIL');
      expect(res.requiredEvidenceEvaluation.failedEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
    });

    it('8. REAL 使用 FIXTURE → UNVERIFIED', () => {
      const fixtureChannelEnv: CanonicalEvidenceEnvelope = {
        ...createServerChannelEnv(),
        sourceType: 'FIXTURE',
        evidenceKey: 'FIXTURE:ROUTING_CHANNEL',
        provenance: 'SOURCE_STATIC_CONTRACT',
      };
      const envelopes = [createServerTaskEnv(), fixtureChannelEnv, createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
    });

    it('9. REAL 只有 USER_ASSERTION → UNVERIFIED', () => {
      const userAssertionChannelEnv: CanonicalEvidenceEnvelope = {
        ...createServerChannelEnv(),
        sourceType: 'USER_ASSERTION',
        evidenceKey: 'USER_ASSERTION:ROUTING_CHANNEL',
        provenance: 'USER_ASSERTION',
      };
      const envelopes = [createServerTaskEnv(), userAssertionChannelEnv, createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
    });

    it('10. 用户渠道声明与服务端证据冲突 → 服务端事实优先并记录冲突', () => {
      const userAssertedEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-user-ch',
        testId: 'test-verdict-001',
        sourceTool: 'caller-input',
        sourceType: 'USER_ASSERTION',
        evidenceKey: 'USER_ASSERTION:ROUTING_CHANNEL',
        observationStatus: 'UNVERIFIED',
        capturedAt: FIXED_TIME,
        environment: 'test',
        subjectType: 'gateway_channel',
        subjectId: 54,
        normalizedFields: { actualValue: 54 }, // 用户声明为 54
        provenance: 'USER_ASSERTION',
        confidence: 0.1,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      // 服务端事实为 2 (与 target.expectedChannelId = 2 一致且通过)
      const serverEnv = createServerChannelEnv({ normalizedFields: { actualValue: 2 } });
      const envelopes = [createServerTaskEnv(), serverEnv, userAssertedEnv, createBillingEnv()];

      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      // 服务端事实通过，裁决为 PASS，但记录了冲突
      expect(res.verdict).toBe('PASS');
      expect(res.warnings.some((w) => w.includes('EVIDENCE_CONFLICT'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('EVIDENCE_CONFLICT'))).toBe(true);
      expect(res.evidenceIdsUsed).toContain('ev-user-ch');
      expect(res.evidenceIdsUsed).toContain('ev-channel-1');
    });

    it('11. critical assertion FAIL → FAIL', () => {
      // 实际计费扣了 100 积分，与预期 50 不符
      const badBillingEnv = createBillingEnv({
        normalizedFields: { actualCharge: 100 },
      });
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), badBillingEnv];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('FAIL');
      const billAssert = res.assertionResults.find((a) => a.assertion.field === 'billing.actualCharge');
      expect(billAssert?.status).toBe('FAIL');
      expect(res.reasons.some((r) => r.includes('关键确定性断言明确失败'))).toBe(true);
    });

    it('12. critical assertion 字段缺失 → UNVERIFIED', () => {
      // 账单证据成功，但 normalizedFields 中缺少 actualCharge 字段
      const emptyBillingEnv = createBillingEnv({
        normalizedFields: { otherField: 123 }, // 缺少 actualCharge
      });
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), emptyBillingEnv];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      const billAssert = res.assertionResults.find((a) => a.assertion.field === 'billing.actualCharge');
      expect(billAssert?.status).toBe('UNVERIFIED');
      expect(res.reasons.some((r) => r.includes('关键断言缺少绑定或字段缺失'))).toBe(true);
    });

    it('13. non-critical assertion FAIL → Verdict 不变并产生 warning', () => {
      const specWithNonCritical: CanonicalTestSpec = {
        ...baseSpec,
        deterministicAssertions: [
          ...baseSpec.deterministicAssertions,
          {
            field: 'media.format',
            operator: 'EQUALS',
            expectedValue: 'mp4',
            critical: false, // 非关键断言
            evidenceKey: 'MEDIA_BINARY:CONTAINER_CHECK',
            actualField: 'format',
          },
        ],
      };

      const mediaEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-media-1',
        testId: 'test-verdict-001',
        sourceTool: 'media-inspector',
        sourceType: 'MEDIA_BINARY',
        evidenceKey: 'MEDIA_BINARY:CONTAINER_CHECK',
        observationStatus: 'PASS',
        capturedAt: FIXED_TIME,
        environment: 'test',
        subjectType: 'artifact',
        subjectId: 1001,
        normalizedFields: { format: 'webm' }, // 与 mp4 不符，断言失败
        provenance: 'MEDIA_BINARY',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), createBillingEnv(), mediaEnv];
      const res = evaluateCanonicalVerdict(specWithNonCritical, envelopes);

      // 非关键断言失败，Verdict 仍保持 PASS
      expect(res.verdict).toBe('PASS');
      const nonCrit = res.assertionResults.find((a) => a.assertion.field === 'media.format');
      expect(nonCrit?.status).toBe('FAIL');
      expect(res.warnings.some((w) => w.includes('非关键断言 [media.format] 失败'))).toBe(true);
    });
  });

  // ==========================================================================
  // 真值表测试 14~15: 操作符覆盖与边界安全性
  // ==========================================================================
  describe('二、断言操作符覆盖与严格比较规则', () => {
    it('14. 每个支持的 operator 至少一个通过和失败用例', () => {
      // 1. EQUALS
      expect(evaluateOperator('EQUALS', 42, 42).status).toBe('PASS');
      expect(evaluateOperator('EQUALS', 42, 43).status).toBe('FAIL');
      expect(evaluateOperator('EQUALS', '42', 42).status).toBe('FAIL'); // 禁止隐式转换

      // 2. NOT_EQUALS
      expect(evaluateOperator('NOT_EQUALS', 42, 43).status).toBe('PASS');
      expect(evaluateOperator('NOT_EQUALS', 42, 42).status).toBe('FAIL');

      // 3. CONTAINS
      expect(evaluateOperator('CONTAINS', 'hello world', 'world').status).toBe('PASS');
      expect(evaluateOperator('CONTAINS', 'hello world', 'xyz').status).toBe('FAIL');
      expect(evaluateOperator('CONTAINS', [1, 2, 3], 2).status).toBe('PASS');
      expect(evaluateOperator('CONTAINS', [1, 2, 3], 4).status).toBe('FAIL');

      // 4. MATCHES_REGEX
      expect(evaluateOperator('MATCHES_REGEX', 'task_12345', '^task_\\d+$').status).toBe('PASS');
      expect(evaluateOperator('MATCHES_REGEX', 'image_12345', '^task_\\d+$').status).toBe('FAIL');

      // 5. GREATER_THAN
      expect(evaluateOperator('GREATER_THAN', 10, 5).status).toBe('PASS');
      expect(evaluateOperator('GREATER_THAN', 5, 10).status).toBe('FAIL');
      expect(evaluateOperator('GREATER_THAN', 5, 5).status).toBe('FAIL');
      expect(evaluateOperator('GREATER_THAN', '10', 5).status).toBe('UNVERIFIED'); // 非数字 UNVERIFIED

      // 6. LESS_THAN
      expect(evaluateOperator('LESS_THAN', 5, 10).status).toBe('PASS');
      expect(evaluateOperator('LESS_THAN', 10, 5).status).toBe('FAIL');
      expect(evaluateOperator('LESS_THAN', 5, 5).status).toBe('FAIL');
      expect(evaluateOperator('LESS_THAN', 5, '10').status).toBe('UNVERIFIED'); // 非数字 UNVERIFIED

      // 7. IN
      expect(evaluateOperator('IN', 'beta', ['alpha', 'beta', 'gamma']).status).toBe('PASS');
      expect(evaluateOperator('IN', 'delta', ['alpha', 'beta', 'gamma']).status).toBe('FAIL');
      expect(evaluateOperator('IN', 'beta', 'not-an-array').status).toBe('UNVERIFIED'); // 非数组 UNVERIFIED

      // 8. IS_DEFINED
      expect(evaluateOperator('IS_DEFINED', 0, true).status).toBe('PASS');
      expect(evaluateOperator('IS_DEFINED', false, true).status).toBe('PASS');
      expect(evaluateOperator('IS_DEFINED', undefined, true).status).toBe('FAIL');
      expect(evaluateOperator('IS_DEFINED', null, true).status).toBe('FAIL');

      // 9. IS_UNDEFINED
      expect(evaluateOperator('IS_UNDEFINED', undefined, true).status).toBe('PASS');
      expect(evaluateOperator('IS_UNDEFINED', null, true).status).toBe('PASS');
      expect(evaluateOperator('IS_UNDEFINED', 'exists', true).status).toBe('FAIL');
    });

    it('15. 非法 regex → UNVERIFIED (fail-closed)', () => {
      const badRegexEval = evaluateOperator('MATCHES_REGEX', 'hello', '[unclosed-bracket');
      expect(badRegexEval.status).toBe('UNVERIFIED');
      expect(badRegexEval.reason).toContain('非法正则表达式');
    });
  });

  // ==========================================================================
  // 真值表测试 16~22: 上下文隔离、冲突消解、纯函数与不变性
  // ==========================================================================
  describe('三、上下文隔离、多证据冲突与契约不变性', () => {
    it('16. testId 不一致的 Evidence 不参与裁决', () => {
      const foreignEnv = createServerChannelEnv({
        testId: 'different-test-999',
      });
      // 提供 task, foreign channel, billing
      const envelopes = [createServerTaskEnv(), foreignEnv, createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      // 因 foreign channel 被排除，缺少 SERVER_API:ROUTING_CHANNEL 导致 UNVERIFIED
      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
      expect(res.warnings.some((w) => w.includes('testId (different-test-999)') && w.includes('不匹配'))).toBe(true);
    });

    it('17. environment 不一致的 Evidence 不参与裁决', () => {
      const foreignEnv = createServerChannelEnv({
        environment: 'prod', // spec 是 test
      });
      const envelopes = [createServerTaskEnv(), foreignEnv, createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
      expect(res.warnings.some((w) => w.includes('environment (prod)') && w.includes('不匹配'))).toBe(true);
    });

    it('18. 多条同 key 的 PASS/FAIL 冲突 → FAIL (记录 EVIDENCE_CONFLICT)', () => {
      const passTask = createServerTaskEnv({ evidenceId: 'ev-task-pass', observationStatus: 'PASS' });
      const failTask = createServerTaskEnv({ evidenceId: 'ev-task-fail', observationStatus: 'FAIL' });

      const envelopes = [passTask, failTask, createServerChannelEnv(), createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res.verdict).toBe('FAIL');
      expect(res.requiredEvidenceEvaluation.failedEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
      expect(res.reasons.some((r) => r.includes('EVIDENCE_CONFLICT'))).toBe(true);
    });

    it('19. optional Evidence 缺失不影响 PASS', () => {
      // baseSpec 的 requiredEvidence 只有 TASK, CHANNEL, BILLING，不包含 MEDIA_BINARY
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      // 缺少 MEDIA_BINARY 完全不影响 PASS
      expect(res.verdict).toBe('PASS');
      expect(res.requiredEvidenceEvaluation.satisfied).toBe(true);
    });

    it('20. AI_OBSERVATION 不能单独产生 PASS', () => {
      const aiOnlySpec: CanonicalTestSpec = {
        testId: 'test-ai-only',
        requirementId: 'REQ-AI-01',
        scenario: 'AI_REVIEW',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['AI_OBSERVATION:QUALITY_EVAL'],
      };

      const aiEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-ai-1',
        testId: 'test-ai-only',
        sourceTool: 'visual-llm',
        sourceType: 'AI_OBSERVATION',
        evidenceKey: 'AI_OBSERVATION:QUALITY_EVAL',
        observationStatus: 'PASS',
        capturedAt: FIXED_TIME,
        environment: 'test',
        subjectType: 'artifact',
        subjectId: 'v-1',
        normalizedFields: { observedStatus: 'PASS' },
        provenance: 'AI_OBSERVATION',
        confidence: 0.9,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = evaluateCanonicalVerdict(aiOnlySpec, [aiEnv]);
      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.reasons.some((r) => r.includes('AI_OBSERVATION / USER_ASSERTION 不能单独产生 PASS'))).toBe(true);
    });

    it('21. 相同输入重复执行得到完全相同结果 (纯函数确定性测试)', () => {
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), createBillingEnv()];

      const res1: CanonicalVerdictResult = evaluateCanonicalVerdict(baseSpec, envelopes);
      const res2: CanonicalVerdictResult = evaluateCanonicalVerdict(baseSpec, envelopes);

      expect(res1).toEqual(res2);
    });

    it('22. 输出不包含 passed/acceptance 等禁止字段 (契约字段排他性测试)', () => {
      const envelopes = [createServerTaskEnv(), createServerChannelEnv(), createBillingEnv()];
      const res = evaluateCanonicalVerdict(baseSpec, envelopes);

      const rawResult = res as unknown as Record<string, unknown>;
      expect('passed' in rawResult).toBe(false);
      expect('acceptance' in rawResult).toBe(false);
      expect('status' in rawResult).toBe(false);
      expect(res.verdict).toBe('PASS');
    });
  });
});
