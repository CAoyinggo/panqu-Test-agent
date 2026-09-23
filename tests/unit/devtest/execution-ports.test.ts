import { describe, expect, it } from 'vitest';
import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import {
  FORBIDDEN_VERDICT_FIELDS,
  type ExecutionAdapter,
  type ExecutionResult,
  type EvidenceProducer,
  type EvidenceProducerContext,
} from '../../../src/devtest/execution-ports.js';

// ============================================================================
// 测试目录专用离线 Fixture 实现 (不放入生产注册表，不导出为默认生产适配器)
// ============================================================================

class FixtureEvidenceProducer implements EvidenceProducer {
  readonly producerName = 'fixture-evidence-producer';
  readonly sourceType = 'FIXTURE' as const;

  produce(rawCollection: unknown, context: EvidenceProducerContext): CanonicalEvidenceEnvelope[] {
    const raw = rawCollection && typeof rawCollection === 'object' ? (rawCollection as Record<string, unknown>) : {};

    // 核心安全约束：provenance 必须由 producer 确定性生成，绝不接受调用者指定的覆盖值
    const fixedProvenance = `FIXTURE (${this.producerName}:${context.environment || 'offline'})`;

    const envelope: CanonicalEvidenceEnvelope = {
      evidenceId: `ev-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      testId: context.testId,
      sourceTool: this.producerName,
      sourceType: this.sourceType,
      evidenceKey: 'FIXTURE:TASK_SNAPSHOT',
      observationStatus: 'PASS',
      capturedAt: new Date().toISOString(),
      environment: context.environment || 'offline',
      subjectType: context.subjectType,
      subjectId: context.subjectId,
      rawReference: raw,
      normalizedFields: {
        mockExecuted: true,
        ...(raw.fields ? (raw.fields as Record<string, unknown>) : {}),
      },
      provenance: fixedProvenance, // 绝不使用 raw.provenance 或 raw.overrideProvenance
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    };

    return [envelope];
  }
}

class FixtureExecutionAdapter implements ExecutionAdapter {
  readonly adapterName = 'fixture-execution-adapter';
  readonly supportedModes = ['FIXTURE'] as const;
  readonly supportedSideEffectPolicies = ['READ_ONLY'] as const;

  private producer = new FixtureEvidenceProducer();

  async execute(spec: Readonly<CanonicalTestSpec>, context?: Record<string, unknown>): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();

    // 1. 模式门禁：仅允许 FIXTURE 模式，REAL 或 OFFLINE 必须严格 BLOCKED
    if (spec.executionMode !== 'FIXTURE') {
      return {
        executionId: `exec-blocked-${Date.now()}`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: 'UNSUPPORTED_EXECUTION_MODE',
          message: `FixtureExecutionAdapter 仅支持 FIXTURE 模式，收到 ${spec.executionMode} 必须严格阻断 [BLOCKED]`,
          details: { requestedMode: spec.executionMode, supported: this.supportedModes },
        },
      };
    }

    // 2. 副作用策略门禁：READ_ONLY 策略下严禁执行提交或副作用变更动作
    if (spec.sideEffectPolicy === 'READ_ONLY' && (context?.intent === 'SUBMIT' || context?.action === 'SUBMIT')) {
      return {
        executionId: `exec-blocked-${Date.now()}`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: 'SIDE_EFFECT_POLICY_VIOLATION',
          message: 'sideEffectPolicy 为 READ_ONLY 时严禁执行提交动作 [BLOCKED]',
          details: { policy: spec.sideEffectPolicy, attemptedAction: context?.action || context?.intent },
        },
      };
    }

    // 3. 费用预算门禁：零费用预算禁止执行付费动作
    if (spec.costLimit.maxCostPoints === 0 && (context?.paidRequired || context?.requiresCost)) {
      return {
        executionId: `exec-blocked-${Date.now()}`,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: 'BUDGET_LIMIT_EXCEEDED',
          message: 'costLimit.maxCostPoints 为 0 时禁止执行需要扣费的操作 [BLOCKED]',
          details: { costLimit: spec.costLimit },
        },
      };
    }

    // 4. 离线纯内存仿真执行并产出 FIXTURE 证据信封
    const evidence = this.producer.produce(
      { mockTaskDone: true, fields: { status: 'MOCK_OK', duration: spec.inputs.duration || 4 } },
      {
        testId: spec.testId,
        environment: spec.environment,
        subjectType: spec.target.targetType || 'scenario',
        subjectId: spec.target.taskId || spec.target.modelId || 'fixture-subject',
      },
    );

    return {
      executionId: `exec-${Date.now()}`,
      testId: spec.testId,
      status: 'COMPLETED',
      evidence,
      startedAt,
      completedAt: new Date().toISOString(),
      metadata: { adapter: this.adapterName, mode: 'FIXTURE' },
    };
  }
}

// ============================================================================
// 测试用例集
// ============================================================================

describe('Phase 1.2 ExecutionAdapter & EvidenceProducer 最小标准端口契约测试', () => {
  const adapter = new FixtureExecutionAdapter();
  const producer = new FixtureEvidenceProducer();

  const baseFixtureSpec: CanonicalTestSpec = {
    testId: 'test-fixture-001',
    requirementId: 'REQ-FIXTURE-01',
    scenario: 'OFFLINE_CONTRACT_AUDIT',
    environment: 'offline',
    executionMode: 'FIXTURE',
    target: { targetType: 'scenario', modelId: 78 },
    inputs: { duration: 4 },
    deterministicAssertions: [{ field: 'status', operator: 'EQUALS', expectedValue: 'MOCK_OK' }],
    costLimit: { maxCostPoints: 0, allowZeroCostOnly: true },
    sideEffectPolicy: 'READ_ONLY',
    requiredEvidence: ['FIXTURE:TASK_SNAPSHOT'],
  };

  it('1. FIXTURE TestSpec 能够被 FixtureAdapter 正常执行且状态为 COMPLETED', async () => {
    const result = await adapter.execute(baseFixtureSpec);
    expect(result.status).toBe('COMPLETED');
    expect(result.testId).toBe(baseFixtureSpec.testId);
    expect(result.executionId).toBeDefined();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].sourceType).toBe('FIXTURE');
    expect(result.error).toBeUndefined();
  });

  it('2. REAL 模式输入必须被 FixtureAdapter 严格阻断 (BLOCKED)', async () => {
    const realSpec: CanonicalTestSpec = {
      ...baseFixtureSpec,
      testId: 'test-real-blocked',
      executionMode: 'REAL',
    };

    const result = await adapter.execute(realSpec);
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('UNSUPPORTED_EXECUTION_MODE');
    expect(result.evidence).toHaveLength(0);
  });

  it('3. OFFLINE 模式输入必须被 FixtureAdapter 严格阻断 (BLOCKED)', async () => {
    const offlineSpec: CanonicalTestSpec = {
      ...baseFixtureSpec,
      testId: 'test-offline-blocked',
      executionMode: 'OFFLINE',
    };

    const result = await adapter.execute(offlineSpec);
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('UNSUPPORTED_EXECUTION_MODE');
    expect(result.evidence).toHaveLength(0);
  });

  it('4. READ_ONLY 策略下禁止提交型动作，执行时返回 BLOCKED', async () => {
    const result = await adapter.execute(baseFixtureSpec, { intent: 'SUBMIT', action: 'SUBMIT' });
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('SIDE_EFFECT_POLICY_VIOLATION');
    expect(result.error?.message).toContain('READ_ONLY');
  });

  it('5. costLimit=0 时禁止付费型动作，执行时返回 BLOCKED', async () => {
    const result = await adapter.execute(baseFixtureSpec, { paidRequired: true });
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.code).toBe('BUDGET_LIMIT_EXCEEDED');
  });

  it('6. EvidenceProducer 自动生成合规 FIXTURE provenance', () => {
    const envelopes = producer.produce(
      { data: 'sample' },
      {
        testId: 'test-sample-01',
        environment: 'offline',
        subjectType: 'task',
        subjectId: 12345,
      },
    );

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].sourceType).toBe('FIXTURE');
    expect(envelopes[0].provenance).toBe('FIXTURE (fixture-evidence-producer:offline)');
    expect(envelopes[0].confidence).toBe(1.0);
    expect(envelopes[0].collectionStatus).toBe('SUCCESS');
  });

  it('7. 调用者试图在采集参数中覆盖 provenance 时被强制忽略，保持 Producer 自身生成', () => {
    const envelopes = producer.produce(
      {
        data: 'sample',
        provenance: 'SERVER_API_FORGED', // 调用者试图伪造来源
        overrideProvenance: 'SERVER_API_FORGED_OVERRIDE',
      },
      {
        testId: 'test-forgery-01',
        environment: 'offline',
        subjectType: 'task',
        subjectId: 12345,
      },
    );

    expect(envelopes[0].provenance).toBe('FIXTURE (fixture-evidence-producer:offline)');
    expect(envelopes[0].provenance).not.toContain('SERVER_API');
    expect(envelopes[0].provenance).not.toContain('FORGED');
  });

  it('8. 防止第二套 Verdict：执行结果中绝不得包含任何最终裁决字段', async () => {
    const result = await adapter.execute(baseFixtureSpec);

    // 检查黑名单字段
    for (const forbiddenField of FORBIDDEN_VERDICT_FIELDS) {
      expect(forbiddenField in result).toBe(false);
      expect((result as unknown as Record<string, unknown>)[forbiddenField]).toBeUndefined();
    }

    // 严禁在 status 中返回 PASS / FAIL / UNVERIFIED 最终裁决值
    const validStatuses = ['SUBMITTED', 'COMPLETED', 'FAILED', 'BLOCKED'];
    expect(validStatuses).toContain(result.status);
    expect(['PASS', 'FAIL', 'UNVERIFIED', 'ACCEPTED', 'REJECTED']).not.toContain(result.status);
  });

  it('9. 失败/阻断时必须返回结构化 error (含 code 与 message)', async () => {
    const realSpec: CanonicalTestSpec = {
      ...baseFixtureSpec,
      executionMode: 'REAL',
    };

    const result = await adapter.execute(realSpec);
    expect(result.status).toBe('BLOCKED');
    expect(result.error).toBeDefined();
    expect(typeof result.error?.code).toBe('string');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.code.length).toBeGreaterThan(0);
    expect(result.error?.message.length).toBeGreaterThan(0);
  });

  it('10. 适配器执行过程中严禁修改输入的 TestSpec (保持输入不变)', async () => {
    const specToExecute: CanonicalTestSpec = JSON.parse(JSON.stringify(baseFixtureSpec));
    Object.freeze(specToExecute);
    Object.freeze(specToExecute.target);
    Object.freeze(specToExecute.costLimit);

    const beforeJson = JSON.stringify(specToExecute);
    const result = await adapter.execute(specToExecute);

    expect(result.status).toBe('COMPLETED');
    const afterJson = JSON.stringify(specToExecute);
    expect(afterJson).toBe(beforeJson);
  });
});
