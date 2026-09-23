/**
 * Panqu AI DevTest — Test Helper: UI Fixture Execution Adapter
 *
 * 仅用于离线契约验证测试 (Test Helper Only)
 * 绝对不属于生产模块，不导出至 src/devtest/index.ts
 */

import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../src/devtest/canonical-protocol.js';
import { validateCanonicalTestSpec } from '../../src/devtest/canonical-protocol.js';
import type { ExecutionAdapter, ExecutionResult, EvidenceProducer } from '../../src/devtest/execution-ports.js';
import { FORBIDDEN_VERDICT_FIELDS } from '../../src/devtest/execution-ports.js';
import {
  UIBrowserEvidenceProducer,
  UIVisualAiEvidenceProducer,
  type BrowserRawCollection,
  type VisualAiRawCollection,
  type DeterministicProducerContext,
} from '../../src/devtest/ui-adapters.js';

export interface UIFixtureAdapterContext {
  readonly capturedAt?: string;
  readonly executionId?: string;
  readonly evidenceIds?: Readonly<Record<string, string>>;
  readonly rawBrowser?: BrowserRawCollection;
  readonly rawVisualAi?: VisualAiRawCollection;
  readonly action?: string;
  readonly intent?: string;
  readonly paidRequired?: boolean;
  readonly [key: string]: unknown;
}

export interface UIFixtureAdapterOptions {
  readonly extraProducers?: readonly EvidenceProducer[];
}

export const FORBIDDEN_MUTATION_KEYWORDS = [
  'SUBMIT',
  'DELETE',
  'UPDATE',
  'CREATE',
  'WRITE',
  'MUTATE',
  'MODIFY',
  'PUT',
  'POST',
  'PATCH',
  'DROP',
  'INSERT',
  'REMOVE',
] as const;

export class UIFixtureExecutionAdapter implements ExecutionAdapter {
  readonly adapterName = 'ui-fixture-execution-adapter';
  readonly supportedModes = ['FIXTURE'] as const;
  readonly supportedSideEffectPolicies = ['READ_ONLY'] as const;

  private browserProducer = new UIBrowserEvidenceProducer();
  private visualAiProducer = new UIVisualAiEvidenceProducer();
  private extraProducers: readonly EvidenceProducer[];

  constructor(options?: UIFixtureAdapterOptions) {
    this.extraProducers = options?.extraProducers || [];
  }

  async execute(spec: Readonly<CanonicalTestSpec>, context?: Record<string, unknown>): Promise<ExecutionResult> {
    const ctx = (context || {}) as UIFixtureAdapterContext;

    const capturedAt =
      ctx.capturedAt || (typeof spec?.metadata?.capturedAt === 'string' ? spec.metadata.capturedAt : undefined);

    const executionId = ctx.executionId || `exec-${spec?.testId || 'unknown'}`;

    const startedAt = capturedAt || '1970-01-01T00:00:00.000Z';
    const completedAt = capturedAt || '1970-01-01T00:00:00.000Z';

    // 1. TestSpec 协议合法性自检
    const specValidation = validateCanonicalTestSpec(spec);
    if (!specValidation.valid) {
      return {
        executionId,
        testId: spec?.testId || 'unknown-test',
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'INVALID_TEST_SPEC',
          message: `输入的 TestSpec 未通过规范校验: ${specValidation.errors.map((e) => e.message).join('; ')}`,
          details: { validationErrors: specValidation.errors },
        },
      };
    }

    // 2. 运行模式门禁
    if (spec.executionMode !== 'FIXTURE') {
      return {
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'UNSUPPORTED_EXECUTION_MODE',
          message: `UIFixtureExecutionAdapter 仅支持 FIXTURE 模式，收到 ${spec.executionMode} 必须严格阻断 [BLOCKED]`,
          details: { requestedMode: spec.executionMode, supported: this.supportedModes },
        },
      };
    }

    // 3. 副作用策略与写操作门禁
    const requestedAction = String(ctx.action || ctx.intent || spec.inputs?.action || '').toUpperCase();
    const hasWriteAction = FORBIDDEN_MUTATION_KEYWORDS.some((kw) => requestedAction.includes(kw));

    if (spec.sideEffectPolicy !== 'READ_ONLY' || hasWriteAction) {
      return {
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'SIDE_EFFECT_POLICY_VIOLATION',
          message: `UI 只读核对场景严禁执行写操作或非 READ_ONLY 策略动作 [BLOCKED]: ${requestedAction || spec.sideEffectPolicy}`,
          details: { policy: spec.sideEffectPolicy, attemptedAction: requestedAction },
        },
      };
    }

    // 4. 成本预算门禁
    const hasCostLimitViolation =
      spec.costLimit.maxCostPoints > 0 ||
      (spec.costLimit.maxCostCny !== undefined && spec.costLimit.maxCostCny > 0) ||
      ctx.paidRequired === true;

    if (hasCostLimitViolation) {
      return {
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'BUDGET_LIMIT_EXCEEDED',
          message: '只读核对场景费用上限 (maxCostPoints 与 maxCostCny) 必须为 0，禁止产生任何计费操作 [BLOCKED]',
          details: { costLimit: spec.costLimit },
        },
      };
    }

    // 5. 确定性调用方入参检查
    if (!capturedAt) {
      return {
        executionId,
        testId: spec.testId,
        status: 'BLOCKED',
        evidence: [],
        startedAt,
        completedAt,
        error: {
          code: 'CAPTURED_AT_REQUIRED',
          message: 'capturedAt 必须由调用方显式提供以保证确定性',
        },
      };
    }

    // 6. 驱动 Producer 采集 UI 事实信封
    const evidence: CanonicalEvidenceEnvelope[] = [];
    const producerContext: DeterministicProducerContext = {
      testId: spec.testId,
      environment: spec.environment,
      subjectType: spec.target.targetType,
      subjectId: spec.target.taskId || spec.target.modelId || 'mock-ui-task',
      capturedAt,
      evidenceIds: ctx.evidenceIds,
    };

    const rawBrowser: BrowserRawCollection = ctx.rawBrowser || {};
    const browserEnvs = await this.browserProducer.produce(rawBrowser, producerContext);
    evidence.push(...browserEnvs);

    const rawVisual: VisualAiRawCollection = ctx.rawVisualAi || {};
    const aiEnvs = await this.visualAiProducer.produce(rawVisual, producerContext);
    evidence.push(...aiEnvs);

    for (const extraProducer of this.extraProducers) {
      const extraRaw = ctx[extraProducer.producerName] || ctx;
      const extraEnvs = await Promise.resolve(extraProducer.produce(extraRaw, producerContext));
      evidence.push(...extraEnvs);
    }

    const result: ExecutionResult = {
      executionId,
      testId: spec.testId,
      status: 'COMPLETED',
      evidence,
      startedAt,
      completedAt,
      metadata: {
        adapter: this.adapterName,
        scenario: spec.scenario,
      },
    };

    for (const field of FORBIDDEN_VERDICT_FIELDS) {
      if (field in (result as unknown as Record<string, unknown>)) {
        delete (result as unknown as Record<string, unknown>)[field];
      }
    }

    return result;
  }
}
