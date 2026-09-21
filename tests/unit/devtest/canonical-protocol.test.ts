import { describe, expect, it } from 'vitest';
import {
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
  evaluateRequiredEvidence,
  type CanonicalTestSpec,
  type CanonicalEvidenceEnvelope,
} from '../../../src/devtest/canonical-protocol.js';

describe('Canonical TestSpec & Evidence Envelope 协议契约测试 (Phase 1.1)', () => {
  describe('1. Canonical TestSpec 规范校验', () => {
    it('1. 最小合法 REAL TestSpec 能够通过校验', () => {
      const realSpec: CanonicalTestSpec = {
        testId: 'test-real-video-001',
        requirementId: 'REQ-DIVERSION-78-RH2',
        scenario: 'VIDEO_DIVERSION_CHANGE',
        environment: 'test',
        executionMode: 'REAL',
        target: {
          targetType: 'model',
          modelId: 78,
          expectedChannelId: 2,
        },
        inputs: {
          prompt: 'A graceful running deer in forest, 4k high quality',
          duration: 4,
          resolution: '720p',
        },
        deterministicAssertions: [
          { field: 'media.format', operator: 'EQUALS', expectedValue: 'mp4' },
          { field: 'billing.netCharge', operator: 'EQUALS', expectedValue: 84 },
        ],
        costLimit: {
          maxCostPoints: 84,
          maxCostCny: 21,
          allowZeroCostOnly: false,
        },
        sideEffectPolicy: 'ALLOW_PAID',
        requiredEvidence: [
          'SERVER_API:TASK_STATUS',
          'MEDIA_BINARY:MP4_CONTAINER',
          'BILLING_LEDGER:RECORD',
        ],
      };

      const res = validateCanonicalTestSpec(realSpec);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.data?.testId).toBe('test-real-video-001');
      expect(res.data?.executionMode).toBe('REAL');
    });

    it('2. OFFLINE 与 FIXTURE 模式合法且通过校验', () => {
      const offlineSpec: CanonicalTestSpec = {
        testId: 'test-offline-001',
        requirementId: 'REQ-OFFLINE-SIM-01',
        scenario: 'OFFLINE_SIMULATION',
        environment: 'offline',
        executionMode: 'OFFLINE',
        target: { targetType: 'channel', channelId: 54 },
        inputs: { duration: 4 },
        deterministicAssertions: [
          { field: 'simulated', operator: 'EQUALS', expectedValue: true },
        ],
        costLimit: { maxCostPoints: 0, allowZeroCostOnly: true },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:TASK_SNAPSHOT'],
      };

      const fixtureSpec: CanonicalTestSpec = {
        testId: 'test-fixture-001',
        requirementId: 'REQ-FIXTURE-CONTRACT-01',
        scenario: 'CONTRACT_UNIT_AUDIT',
        environment: 'offline',
        executionMode: 'FIXTURE',
        target: { targetType: 'scenario' },
        inputs: {},
        deterministicAssertions: [
          { field: 'codec', operator: 'EQUALS', expectedValue: 'h264' },
        ],
        costLimit: { maxCostPoints: 0, allowZeroCostOnly: true },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:BINARY_BUFFER'],
      };

      expect(validateCanonicalTestSpec(offlineSpec).valid).toBe(true);
      expect(validateCanonicalTestSpec(fixtureSpec).valid).toBe(true);
    });

    it('3. 空 testId / requirementId / scenario / environment 拒绝', () => {
      const invalidSpec = {
        testId: '   ',
        requirementId: '',
        scenario: '',
        environment: '',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = validateCanonicalTestSpec(invalidSpec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === 'testId')).toBe(true);
      expect(res.errors.some((e) => e.field === 'requirementId')).toBe(true);
      expect(res.errors.some((e) => e.field === 'scenario')).toBe(true);
      expect(res.errors.some((e) => e.field === 'environment')).toBe(true);
    });

    it('4. 非法 executionMode 严格拒绝，禁止静默降级', () => {
      const spec = {
        testId: 'test-exec-invalid',
        requirementId: 'REQ-001',
        scenario: 'SCENARIO_1',
        environment: 'test',
        executionMode: 'SIMULATED', // 非法模式
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['TEST'],
      };

      const res = validateCanonicalTestSpec(spec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'INVALID_EXECUTION_MODE')).toBe(true);
    });

    it('5. 非法 costLimit 拒绝 (负数 / NaN / READ_ONLY 策略下设正数费用冲突)', () => {
      const negativeCostSpec = {
        testId: 'test-cost-neg',
        requirementId: 'REQ-002',
        scenario: 'SCENARIO_2',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: -10 },
        sideEffectPolicy: 'ALLOW_PAID',
        requiredEvidence: ['TEST'],
      };

      const conflictCostSpec = {
        testId: 'test-cost-conflict',
        requirementId: 'REQ-003',
        scenario: 'SCENARIO_3',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 50 },
        sideEffectPolicy: 'READ_ONLY', // 策略与费用冲突
        requiredEvidence: ['TEST'],
      };

      expect(validateCanonicalTestSpec(negativeCostSpec).valid).toBe(false);
      expect(validateCanonicalTestSpec(conflictCostSpec).valid).toBe(false);
      const conflictRes = validateCanonicalTestSpec(conflictCostSpec);
      expect(conflictRes.errors.some((e) => e.code === 'CONFLICTING_COST_AND_POLICY')).toBe(true);
    });

    it('6. 非法 sideEffectPolicy 拒绝', () => {
      const spec = {
        testId: 'test-policy-invalid',
        requirementId: 'REQ-004',
        scenario: 'SCENARIO_4',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'ALLOW_EVERYTHING', // 非法策略
        requiredEvidence: ['TEST'],
      };

      const res = validateCanonicalTestSpec(spec);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'INVALID_SIDE_EFFECT_POLICY')).toBe(true);
    });

    it('7. 专有工具字段禁止进入 Canonical TestSpec', () => {
      const specWithPlaywright = {
        testId: 'test-tool-leak',
        requirementId: 'REQ-005',
        scenario: 'SCENARIO_5',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['TEST'],
        playwrightConfig: { headless: true }, // 工具专用字段泄漏
      };

      const res = validateCanonicalTestSpec(specWithPlaywright);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'PROPRIETARY_TOOL_FIELD_FORBIDDEN')).toBe(true);
    });

    it('8. 未知/不支持的 assertion operator 必须被拒绝且返回 UNSUPPORTED_OPERATOR', () => {
      const specWithBadOperator = {
        testId: 'test-bad-op',
        requirementId: 'REQ-006',
        scenario: 'SCENARIO_6',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model' },
        inputs: {},
        deterministicAssertions: [
          { field: 'foo', operator: 'UNKNOWN_CUSTOM_OP', expectedValue: 123 },
        ],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['TEST'],
      };

      const res = validateCanonicalTestSpec(specWithBadOperator);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'UNSUPPORTED_OPERATOR')).toBe(true);
    });
  });

  describe('2. Canonical Evidence Envelope 规范校验', () => {
    it('7. 完整 SERVER_API Evidence 合法通过校验', () => {
      const serverEvidence: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-server-task-239467',
        testId: 'test-real-video-001',
        sourceTool: 'panqu-http-fetcher',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 239467,
        rawReference: {
          endpoint: '/aivideo/v2/task_status/apiGetStatus',
          status: 200,
          taskId: 239467,
        },
        normalizedFields: {
          status: 2,
          progress: 100,
          videoUrl: 'https://test-main.example.com/assets/video_239467.mp4',
        },
        provenance: 'GET /aivideo/v2/task_status/apiGetStatus?id=239467 (READONLY)',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = validateEvidenceEnvelope(serverEvidence);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.data?.evidenceId).toBe('ev-server-task-239467');
      expect(res.data?.sourceType).toBe('SERVER_API');
      expect(res.data?.evidenceKey).toBe('SERVER_API:TASK_STATUS');
      expect(res.data?.observationStatus).toBe('PASS');
    });

    it('8. confidence 超出 0～1 拒绝', () => {
      const baseEnvelope: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-conf-01',
        testId: 'test-01',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1001,
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.5, // 超限
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      expect(validateEvidenceEnvelope({ ...baseEnvelope, confidence: 1.5 }).valid).toBe(false);
      expect(validateEvidenceEnvelope({ ...baseEnvelope, confidence: -0.1 }).valid).toBe(false);
      expect(validateEvidenceEnvelope({ ...baseEnvelope, confidence: NaN }).valid).toBe(false);
      expect(validateEvidenceEnvelope({ ...baseEnvelope, confidence: 0 }).valid).toBe(true);
      expect(validateEvidenceEnvelope({ ...baseEnvelope, confidence: 1 }).valid).toBe(true);
    });

    it('9. 非 SUCCESS 状态缺少 error 必须拒绝', () => {
      const envelopeWithoutError: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-err-missing',
        testId: 'test-02',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'FAIL',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1002,
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 0.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'COLLECTION_FAILED',
        // 缺少 error
      };

      const res = validateEvidenceEnvelope(envelopeWithoutError);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'ERROR_REQUIRED_ON_FAILURE')).toBe(true);
    });

    it('10. SUCCESS 携带错误状态冲突必须拒绝', () => {
      const conflictEnvelope: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-conflict-01',
        testId: 'test-03',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1003,
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
        error: { code: 'ERR_DUMMY', message: 'Something failed' }, // SUCCESS 不允许附带 error
      };

      const res = validateEvidenceEnvelope(conflictEnvelope);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'ERROR_NOT_ALLOWED_ON_SUCCESS')).toBe(true);
    });

    it('11. capturedAt 时间戳非法必须拒绝', () => {
      const invalidTimestampEnvelope = {
        evidenceId: 'ev-time-01',
        testId: 'test-04',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: 'not-a-valid-date-string',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1004,
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = validateEvidenceEnvelope(invalidTimestampEnvelope);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'INVALID_TIMESTAMP')).toBe(true);
    });

    it('12. 不允许明文凭据进入 rawReference', () => {
      const leakEnvelopeWithPassword: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-leak-01',
        testId: 'test-05',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1005,
        rawReference: {
          authHeader: 'Bearer eyJhbGciOi...',
          password: 'plain_password_123',
        },
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.0,
        immutable: true,
        redacted: false,
        collectionStatus: 'SUCCESS',
      };

      const leakEnvelopeWithSessid: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-leak-02',
        testId: 'test-06',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1006,
        rawReference: 'Cookie: PHPSESSID=live_secret_session_456;',
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.0,
        immutable: true,
        redacted: false,
        collectionStatus: 'SUCCESS',
      };

      expect(validateEvidenceEnvelope(leakEnvelopeWithPassword).valid).toBe(false);
      expect(validateEvidenceEnvelope(leakEnvelopeWithPassword).errors.some((e) => e.code === 'UNREDACTED_CREDENTIALS_FORBIDDEN')).toBe(true);
      expect(validateEvidenceEnvelope(leakEnvelopeWithSessid).valid).toBe(false);
      expect(validateEvidenceEnvelope(leakEnvelopeWithSessid).errors.some((e) => e.code === 'UNREDACTED_CREDENTIALS_FORBIDDEN')).toBe(true);
    });

    it('13. sourceType 与 collectionStatus 非法枚举值拒绝', () => {
      const invalidEnumEnvelope = {
        evidenceId: 'ev-enum-01',
        testId: 'test-07',
        sourceTool: 'unit-tool',
        sourceType: 'UNKNOWN_SOURCE', // 非法
        evidenceKey: 'UNKNOWN_SOURCE:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1007,
        normalizedFields: {},
        provenance: 'READONLY_API',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'PARTIALLY_PASSED', // 非法
      };

      const res = validateEvidenceEnvelope(invalidEnumEnvelope);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'INVALID_SOURCE_TYPE')).toBe(true);
      expect(res.errors.some((e) => e.code === 'INVALID_COLLECTION_STATUS')).toBe(true);
    });

    it('14. provenance 防篡改：USER_ASSERTION/FIXTURE 不能伪装为 SERVER_API，且来源不得由预期推导', () => {
      const fakeServerEnvelope: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-fake-01',
        testId: 'test-08',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1008,
        normalizedFields: {},
        provenance: 'USER_ASSERTION (手填通过)', // 冲突：SERVER_API 下声明为 USER_ASSERTION
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const expectationDerivedEnvelope: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-fake-02',
        testId: 'test-09',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1009,
        normalizedFields: {},
        provenance: 'DEVTEST_EXPECTATION (按预期推导)', // 冲突：由预期反推
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      expect(validateEvidenceEnvelope(fakeServerEnvelope).valid).toBe(false);
      expect(validateEvidenceEnvelope(fakeServerEnvelope).errors.some((e) => e.code === 'UNTRUSTED_PROVENANCE_FOR_SERVER_API')).toBe(true);
      expect(validateEvidenceEnvelope(expectationDerivedEnvelope).valid).toBe(false);
      expect(validateEvidenceEnvelope(expectationDerivedEnvelope).errors.some((e) => e.code === 'PROVENANCE_DERIVED_FROM_EXPECTATION')).toBe(true);
    });

    it('15. evidenceKey 缺失或格式不合法拒绝 (Phase 1.3C)', () => {
      const baseEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-key-01',
        testId: 'test-10',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: '',
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1010,
        normalizedFields: {},
        provenance: 'PROBE_HTTP',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      // 缺失空字符串
      const resEmpty = validateEvidenceEnvelope({ ...baseEnv, evidenceKey: '' });
      expect(resEmpty.valid).toBe(false);
      expect(resEmpty.errors.some((e) => e.field === 'evidenceKey' && e.code === 'REQUIRED')).toBe(true);

      // 格式不合法 (缺少冒号或包含非法小写/特殊字符)
      const resBadFormat1 = validateEvidenceEnvelope({ ...baseEnv, evidenceKey: 'SERVER_API_TASK_STATUS' });
      expect(resBadFormat1.valid).toBe(false);
      expect(resBadFormat1.errors.some((e) => e.code === 'INVALID_EVIDENCE_KEY_FORMAT')).toBe(true);

      const resBadFormat2 = validateEvidenceEnvelope({ ...baseEnv, evidenceKey: 'server_api:task' });
      expect(resBadFormat2.valid).toBe(false);
      expect(resBadFormat2.errors.some((e) => e.code === 'INVALID_EVIDENCE_KEY_FORMAT')).toBe(true);
    });

    it('16. sourceType 与 evidenceKey 前缀不一致拒绝 (Phase 1.3C)', () => {
      const mismatchEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-mismatch-01',
        testId: 'test-11',
        sourceTool: 'unit-tool',
        sourceType: 'MEDIA_BINARY',
        evidenceKey: 'SERVER_API:TASK_STATUS', // 前缀为 SERVER_API，但 sourceType 为 MEDIA_BINARY
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1011,
        normalizedFields: {},
        provenance: 'MEDIA_INSPECTION',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = validateEvidenceEnvelope(mismatchEnv);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'SOURCE_TYPE_KEY_MISMATCH')).toBe(true);
    });

    it('17. USER_ASSERTION 试图冒充 SERVER_API evidenceKey 拒绝 (Phase 1.3C)', () => {
      const impersonationEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-impersonate-01',
        testId: 'test-12',
        sourceTool: 'cli-caller',
        sourceType: 'USER_ASSERTION',
        evidenceKey: 'SERVER_API:ROUTING_CHANNEL', // USER_ASSERTION 试图冒充 SERVER_API
        observationStatus: 'PASS',
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'gateway_channel',
        subjectId: 'ch-99',
        normalizedFields: {},
        provenance: 'USER_ASSERTION',
        confidence: 0.1,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = validateEvidenceEnvelope(impersonationEnv);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'SERVER_API_IMPERSONATION_FORBIDDEN')).toBe(true);
      expect(res.errors.some((e) => e.code === 'SOURCE_TYPE_KEY_MISMATCH')).toBe(true);
    });

    it('18. observationStatus 非法枚举拒绝 (Phase 1.3C)', () => {
      const invalidStatusEnv = {
        evidenceId: 'ev-obs-01',
        testId: 'test-13',
        sourceTool: 'unit-tool',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'BOGUS_STATUS', // 非法
        capturedAt: '2026-09-20T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 1013,
        normalizedFields: {},
        provenance: 'PROBE_HTTP',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const res = validateEvidenceEnvelope(invalidStatusEnv);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.code === 'INVALID_OBSERVATION_STATUS')).toBe(true);
    });
  });

  describe('3. evaluateRequiredEvidence 契约评估纯函数 (Phase 1.3C)', () => {
    const validSpec: CanonicalTestSpec = {
      testId: 'test-eval-001',
      requirementId: 'REQ-001',
      scenario: 'SCENARIO_1',
      environment: 'test',
      executionMode: 'REAL',
      target: { targetType: 'model', modelId: 78 },
      inputs: {},
      deterministicAssertions: [],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:TASK_STATUS', 'SERVER_API:ROUTING_CHANNEL'],
    };

    it('1. requiredEvidence 与 evidenceKey 精确匹配成功', () => {
      const env1: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-1',
        testId: 'test-eval-001',
        sourceTool: 'fetcher',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 100,
        normalizedFields: {},
        provenance: 'SERVER_API (/status)',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const env2: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-2',
        testId: 'test-eval-001',
        sourceTool: 'runtime',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
        observationStatus: 'PASS',
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'gateway_channel',
        subjectId: 'ch-2',
        normalizedFields: {},
        provenance: 'SERVER_RUN_FACT',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const evalResult = evaluateRequiredEvidence(validSpec, [env1, env2]);
      expect(evalResult.satisfied).toBe(true);
      expect(evalResult.missingEvidenceKeys).toHaveLength(0);
      expect(evalResult.failedEvidenceKeys).toHaveLength(0);
      expect(evalResult.unverifiedEvidenceKeys).toHaveLength(0);
      expect(evalResult.matchedEnvelopes['SERVER_API:TASK_STATUS']).toBe(env1);
      expect(evalResult.matchedEnvelopes['SERVER_API:ROUTING_CHANNEL']).toBe(env2);
      expect(evalResult.details.every((d) => d.matched)).toBe(true);
    });

    it('2. FIXTURE 不能满足 REAL 模式下的 SERVER_API:ROUTING_CHANNEL', () => {
      const fixtureEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-fix',
        testId: 'test-eval-001',
        sourceTool: 'oracle',
        sourceType: 'FIXTURE',
        evidenceKey: 'FIXTURE:ROUTING_CHANNEL', // key 不匹配
        observationStatus: 'PASS',
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'gateway_channel',
        subjectId: 'ch-2',
        normalizedFields: {},
        provenance: 'SOURCE_STATIC_CONTRACT',
        confidence: 0.5,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const evalResult = evaluateRequiredEvidence(validSpec, [fixtureEnv]);
      expect(evalResult.satisfied).toBe(false);
      expect(evalResult.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');

      // 即使试图越权标记为 SERVER_API key，但 sourceType 为 FIXTURE，在 REAL 模式下也被拒绝
      const spoofedEnv: CanonicalEvidenceEnvelope = {
        ...fixtureEnv,
        evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
        sourceType: 'FIXTURE',
      };
      const spoofEval = evaluateRequiredEvidence(validSpec, [spoofedEnv]);
      expect(spoofEval.satisfied).toBe(false);
      expect(spoofEval.missingEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
      expect(spoofEval.details.find((d) => d.key === 'SERVER_API:ROUTING_CHANNEL')?.reason).toContain(
        'REAL 模式下 FIXTURE 来源不能满足'
      );
    });

    it('3. collectionStatus != SUCCESS 时无法满足 requiredEvidence', () => {
      const failedCollectionEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-col-failed',
        testId: 'test-eval-001',
        sourceTool: 'fetcher',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS', // 虽有 PASS 但采集状态非 SUCCESS
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 100,
        normalizedFields: {},
        provenance: 'SERVER_API (/status)',
        confidence: 0.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'COLLECTION_FAILED',
        error: { code: 'NETWORK_TIMEOUT', message: '连接超时' },
      };

      const evalResult = evaluateRequiredEvidence(validSpec, [failedCollectionEnv]);
      expect(evalResult.satisfied).toBe(false);
      expect(evalResult.missingEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
      expect(evalResult.details.find((d) => d.key === 'SERVER_API:TASK_STATUS')?.matched).toBe(false);
    });

    it('4. observationStatus = FAIL 记录为 failedEvidenceKeys', () => {
      const failEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-fail-1',
        testId: 'test-eval-001',
        sourceTool: 'fetcher',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'FAIL',
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 100,
        normalizedFields: { rawTaskStatus: 'FAIL' },
        provenance: 'SERVER_API (/status)',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const evalResult = evaluateRequiredEvidence(validSpec, [failEnv]);
      expect(evalResult.satisfied).toBe(false);
      expect(evalResult.failedEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
      expect(evalResult.matchedEnvelopes['SERVER_API:TASK_STATUS']).toBe(failEnv);
      expect(evalResult.details.find((d) => d.key === 'SERVER_API:TASK_STATUS')?.matched).toBe(false);
    });

    it('5. observationStatus = UNVERIFIED 记录为 unverifiedEvidenceKeys 且 satisfied = false', () => {
      const unverifiedEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'ev-unv-1',
        testId: 'test-eval-001',
        sourceTool: 'caller-input',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:ROUTING_CHANNEL',
        observationStatus: 'UNVERIFIED',
        capturedAt: '2026-09-21T10:00:00.000Z',
        environment: 'test',
        subjectType: 'gateway_channel',
        subjectId: 'ch-unknown',
        normalizedFields: {},
        provenance: 'SERVER_API',
        confidence: 0.5,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const evalResult = evaluateRequiredEvidence(validSpec, [unverifiedEnv]);
      expect(evalResult.satisfied).toBe(false);
      expect(evalResult.unverifiedEvidenceKeys).toContain('SERVER_API:ROUTING_CHANNEL');
      expect(evalResult.matchedEnvelopes['SERVER_API:ROUTING_CHANNEL']).toBe(unverifiedEnv);
      expect(evalResult.details.find((d) => d.key === 'SERVER_API:ROUTING_CHANNEL')?.matched).toBe(false);
    });
  });
});
