/**
 * Panqu AI DevTest — Test Helper: Test Offline Execution Adapter
 *
 * 仅供测试套件用于离线/受控 Mock 执行验证。
 * 绝不属于生产模块，不导出至 src/devtest/index.ts。
 */

import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../src/devtest/canonical-protocol.js';
import type { ExecutionAdapter, ExecutionResult } from '../../src/devtest/execution-ports.js';
import { validateExecutionResult } from '../../src/devtest/execution-ports.js';

export interface TestOfflineExecutionAdapterOptions {
  readonly taskId?: number;
  readonly status?: 'SUBMITTED' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  readonly points?: number;
  readonly message?: string;
  readonly rawResponse?: Record<string, unknown>;
  readonly shouldThrow?: boolean;
}

export class TestOfflineExecutionAdapter implements ExecutionAdapter {
  readonly adapterName = 'test-offline-execution-adapter';
  readonly supportedModes = ['OFFLINE', 'FIXTURE'] as const;
  readonly supportedSideEffectPolicies = ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'] as const;

  private readonly options: TestOfflineExecutionAdapterOptions;

  constructor(options?: TestOfflineExecutionAdapterOptions) {
    this.options = options || {};
  }

  async execute(spec: Readonly<CanonicalTestSpec>, context?: Record<string, unknown>): Promise<ExecutionResult> {
    if (this.options.shouldThrow) {
      throw new Error('TestOfflineExecutionAdapter simulated throw error');
    }

    const startedAt = (context?.startedAt as string) || new Date().toISOString();
    const completedAt = (context?.completedAt as string) || new Date().toISOString();
    const executionId = (context?.executionId as string) || `exec-${spec.testId}-test-offline`;

    const taskId = this.options.taskId ?? 9527;
    const status = this.options.status ?? 'SUBMITTED';
    const points = this.options.points ?? (typeof context?.points === 'number' ? context.points : 0);
    const message = this.options.message ?? `任务提交成功 #${taskId} (受控仿真)`;

    const isSubmitted = status === 'SUBMITTED';
    let evidenceKey: string;
    let observationStatus: 'PASS' | 'FAIL' | 'UNVERIFIED';

    if (isSubmitted) {
      evidenceKey = 'FIXTURE:TASK_SUBMISSION_RECEIPT';
      observationStatus = 'UNVERIFIED';
    } else if (status === 'COMPLETED') {
      evidenceKey = 'FIXTURE:TASK_STATUS';
      observationStatus = 'PASS';
    } else if (status === 'FAILED') {
      evidenceKey = 'FIXTURE:TASK_STATUS';
      observationStatus = 'FAIL';
    } else {
      // BLOCKED
      evidenceKey = 'FIXTURE:TASK_STATUS';
      observationStatus = 'UNVERIFIED';
    }

    const normalizedFields: Record<string, unknown> = isSubmitted
      ? { taskId, lifecycleStatus: 'SUBMITTED', points, message }
      : {
          taskId,
          observedStatus: status === 'COMPLETED' ? 'SUCCESS' : status === 'FAILED' ? 'FAILED' : 'BLOCKED',
          points,
          message,
        };

    const evidence: CanonicalEvidenceEnvelope[] = [
      {
        evidenceId: `${spec.testId}-test-receipt`,
        testId: spec.testId,
        sourceTool: this.adapterName,
        sourceType: 'FIXTURE',
        evidenceKey,
        observationStatus,
        capturedAt: completedAt,
        environment: spec.environment,
        subjectType: 'task',
        subjectId: taskId,
        normalizedFields,
        provenance: `${this.adapterName}:SIMULATED_FIXTURE`,
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      },
    ];

    return validateExecutionResult({
      executionId,
      testId: spec.testId,
      status,
      evidence,
      startedAt,
      completedAt,
      metadata: {
        taskId,
        points,
        message,
        isSimulated: true,
        simulationId: `sim-offline-${spec.testId}`,
        credentialsMasked: 'PHPSESSID=***; session_env=mock_test',
        rawResponse: this.options.rawResponse ?? { code: 0, msg: 'ok', data: { task_id: taskId } },
      },
      error: status === 'FAILED' ? { code: 'FAILED_SUBMIT', message } : undefined,
    });
  }
}
