/**
 * Panqu AI DevTest - 探索执行接入器 (Exploration Runner Adapter)
 * 
 * 职责：
 * 作为探索层（Exploration Layer）与冻结核心内核（core-kernel.ts）之间的纯受控适配器：
 * 1. 严格按 executionReadiness 分流（EXECUTABLE vs NEGATIVE_PROBE）；
 * 2. 严禁执行 STRUCTURAL_ONLY 与 BLOCKED_BY_UNSUPPORTED_ACTION；
 * 3. EXECUTABLE 走正常 execute() -> verify() 全闭环；
 * 4. NEGATIVE_PROBE 走专门的网关拒绝拦截判定，绝对禁止调用 verify(0)；
 * 5. 真实客观事实回写 StateGraph.observeTransition()；
 * 6. 严禁拿 expectedObservation 当作真实事实。
 */

import {
  execute,
  verify,
  type ExecuteKernelOptions,
  type ExecuteKernelResult,
  type VerifyKernelOptions,
  type VerifyKernelResult,
} from '../core-kernel.js';
import {
  type EntityCompositeState,
  type MutationExecutionReadiness,
  type StateTransitionRecord,
  type LearningExperience,
} from './contracts.js';
import { type MutationCandidate } from './mutation.js';
import { PanquStateGraph } from './state-graph.js';
import { PanquLearningStore, feedResultIntoLearning } from './learning.js';

export type MutationRunStatus =
  | 'EXECUTABLE_VERIFIED'
  | 'EXECUTABLE_EXECUTION_FAILED'
  | 'NEGATIVE_PROBE_REJECTION_VERIFIED'
  | 'NEGATIVE_PROBE_REJECTION_NOT_VERIFIED'
  | 'BLOCKED_BY_UNSUPPORTED_ACTION'
  | 'STRUCTURAL_ONLY'
  | 'INSUFFICIENT_REAL_EVIDENCE';

export interface MutationRunOptions {
  candidate: MutationCandidate;
  mode?: 'real' | 'mock';
  sessionFile?: string;
  env?: 'test' | 'preonline';
  stateGraph?: PanquStateGraph;
  learningStore?: PanquLearningStore;
  fromState?: EntityCompositeState;
  recordMockTransitions?: boolean; // 单元测试中是否允许将受控模拟结果写入测试专用的 stateGraph
  // 依赖注入钩子，供受控测试使用，默认直连 core-kernel
  executeFn?: (opts: ExecuteKernelOptions) => Promise<ExecuteKernelResult>;
  verifyFn?: (opts: VerifyKernelOptions) => Promise<VerifyKernelResult>;
}

export interface NegativeRejectionEvidence {
  gatewayRejected: boolean;
  taskIdZero: boolean;
  rejectionMessage: string;
  zeroChargeProven: boolean;
}

export interface MutationRunResult {
  ok: boolean;
  candidateId: string;
  status: MutationRunStatus;
  mode: 'real' | 'mock';
  executionReadiness: MutationExecutionReadiness;
  executeResult?: ExecuteKernelResult;
  verifyResult?: VerifyKernelResult;
  rejectionEvidence?: NegativeRejectionEvidence;
  observedTransition?: StateTransitionRecord;
  learnedExperiences?: LearningExperience[];
  message: string;
}

export class PanquExplorationRunner {
  private defaultExecuteFn = execute;
  private defaultVerifyFn = verify;
  private learningStore?: PanquLearningStore;

  constructor(learningStore?: PanquLearningStore) {
    this.learningStore = learningStore;
  }

  /**
   * 执行单个变异候选并按就绪度分流
   */
  public async run(options: MutationRunOptions): Promise<MutationRunResult> {
    const { candidate } = options;
    const mode = options.mode === 'real' ? 'real' : 'mock';
    const executeFn = options.executeFn || this.defaultExecuteFn;
    const verifyFn = options.verifyFn || this.defaultVerifyFn;
    const targetStore = options.learningStore || this.learningStore;

    const attachLearning = (res: MutationRunResult): MutationRunResult => {
      if (targetStore) {
        res.learnedExperiences = feedResultIntoLearning(res, targetStore, {
          mode,
          allowMockLearning: options.recordMockTransitions,
        });
      }
      return res;
    };

    // 1. 拦截未证实动作 (CANCEL_TASK, RETRY_TASK, INJECT_TIMEOUT)
    if (candidate.executionReadiness === 'BLOCKED_BY_UNSUPPORTED_ACTION') {
      return {
        ok: false,
        candidateId: candidate.id,
        status: 'BLOCKED_BY_UNSUPPORTED_ACTION',
        mode,
        executionReadiness: candidate.executionReadiness,
        message: `候选用例包含当前代码库未证实的动作 (如 CANCEL/RETRY/TIMEOUT)，禁止发起真实请求或伪造执行`,
      };
    }

    // 2. 拦截纯结构设计标记 (RACE, TIMING)
    if (candidate.executionReadiness === 'STRUCTURAL_ONLY') {
      return {
        ok: false,
        candidateId: candidate.id,
        status: 'STRUCTURAL_ONLY',
        mode,
        executionReadiness: candidate.executionReadiness,
        message: `候选用例包含纯结构设计元数据 (Race/Timing)，当前执行层无底层并发/调度支持，跳过执行`,
      };
    }

    // 3. 提取执行参数 (严禁将 duration=0 或 61 用 || 默认值覆盖)
    const primaryStep = candidate.steps[0];
    const payload = primaryStep?.payload || {};
    const modelId = Number(payload.modelId ?? 84);
    const mediaType = (payload.mediaType || 'video') as 'video' | 'image';
    const duration = payload.duration !== undefined ? Number(payload.duration) : undefined;
    const resolution = typeof payload.resolution === 'string' ? payload.resolution : undefined;
    const prompt = typeof payload.promptText === 'string'
      ? payload.promptText
      : typeof payload.prompt === 'string'
      ? payload.prompt
      : undefined;

    const fromState: EntityCompositeState = options.fromState || {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'UNSUBMITTED' },
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 4. 分流分支 A: EXECUTABLE (正向合法变异)
    if (candidate.executionReadiness === 'EXECUTABLE') {
      const execResult = await executeFn({
        modelId,
        mediaType,
        duration,
        resolution,
        prompt,
        mode,
        sessionFile: options.sessionFile,
        env: options.env,
      });

      if (!execResult.ok || execResult.taskId <= 0) {
        return attachLearning({
          ok: false,
          candidateId: candidate.id,
          status: 'EXECUTABLE_EXECUTION_FAILED',
          mode,
          executionReadiness: candidate.executionReadiness,
          executeResult: execResult,
          message: `正向变异任务提交失败: ${execResult.message}`,
        });
      }

      // 任务提交成功，调用正常 verify(taskId)
      const verifyRes = await verifyFn({
        taskId: execResult.taskId,
        modelId,
        mediaType,
        duration,
        resolution,
        sessionFile: options.sessionFile,
        env: options.env,
        isSimulated: execResult.isSimulated,
      });

      // 判定复合业务实体状态
      const taskStatus =
        verifyRes.status === 'SUCCESS' ? 'COMPLETED' : verifyRes.status === 'PROCESSING' ? 'GENERATING' : 'FAILED';
      const billingStatus =
        verifyRes.evidence.billing.status === 'PASS'
          ? 'CHARGED'
          : verifyRes.evidence.billing.status === 'FAIL'
          ? 'INCONSISTENT'
          : 'RESERVED';
      const artifactStatus =
        verifyRes.evidence.media.status === 'PASS'
          ? 'VERIFIED'
          : verifyRes.evidence.media.status === 'FAIL'
          ? 'INVALID'
          : 'PARTIAL';

      const toState: EntityCompositeState = {
        session: { status: 'AUTHENTICATED' },
        task: {
          status: taskStatus,
          taskId: execResult.taskId,
          durationSeconds: duration,
          modelId,
        },
        billing: {
          status: billingStatus,
          netPointsDeducted: verifyRes.evidence.billing.netDeductedPoints ?? execResult.points,
          recordCount: verifyRes.billing?.ledgerEntries?.length ?? 1,
        },
        artifacts: {
          status: artifactStatus,
          atomsFound: verifyRes.evidence.media.hasMdat ? ['mdat'] : [],
          ownershipVerified: verifyRes.evidence.media.ownership === 'VERIFIED',
          mediaUrl: verifyRes.evidence.task.videoUrl || verifyRes.evidence.task.imageUrl,
        },
        observedAt: Date.now(),
      };

      // REAL 模式或测试显式允许时回写 StateGraph
      let observedTransition: StateTransitionRecord | undefined;
      if (options.stateGraph && (mode === 'real' || options.recordMockTransitions)) {
        observedTransition = options.stateGraph.observeTransition(
          fromState,
          'SUBMIT_TASK',
          { duration, resolution, modelId },
          toState,
          verifyRes.passed ? [] : verifyRes.reasons
        );
      }

      return attachLearning({
        ok: verifyRes.passed,
        candidateId: candidate.id,
        status: 'EXECUTABLE_VERIFIED',
        mode,
        executionReadiness: candidate.executionReadiness,
        executeResult: execResult,
        verifyResult: verifyRes,
        observedTransition,
        message: `正向变异执行与验证完成 (taskId: #${execResult.taskId}, passed: ${verifyRes.passed})`,
      });
    }

    // 5. 分流分支 B: NEGATIVE_PROBE (负向边界探测)
    if (candidate.executionReadiness === 'NEGATIVE_PROBE') {
      const execResult = await executeFn({
        modelId,
        mediaType,
        duration, // 明确携带 0 或 61
        resolution,
        prompt,
        mode,
        sessionFile: options.sessionFile,
        env: options.env,
      });

      // 严格 Fail-closed 检验网关拒绝事实
      const gatewayRejected = !execResult.ok;
      const taskIdZero = execResult.taskId === 0;
      const rejectionMessage = execResult.message || '';
      const hasRejectionMessage = rejectionMessage.length > 0;

      // 零扣费证据：当前系统未直接在 executeResult 中对比用户钱包余额前后的绝对增量，故客观标定为未由流水严格证明 (保持 Fail-closed)
      const zeroChargeProven = false;

      const rejectionVerified = gatewayRejected && taskIdZero && hasRejectionMessage;

      if (!rejectionVerified) {
        return attachLearning({
          ok: false,
          candidateId: candidate.id,
          status: 'NEGATIVE_PROBE_REJECTION_NOT_VERIFIED',
          mode,
          executionReadiness: candidate.executionReadiness,
          executeResult: execResult,
          rejectionEvidence: {
            gatewayRejected,
            taskIdZero,
            rejectionMessage,
            zeroChargeProven,
          },
          message: `[SECURITY DEFECT] 负向非法探测未被网关拦截！服务端错误接受了参数并分配了 taskId #${execResult.taskId}`,
        });
      }

      // 映射符合 contracts.ts 现有枚举的客观状态 (任务未提交成功，状态保持 UNSUBMITTED，产物 NONE)
      const toState: EntityCompositeState = {
        session: { status: 'AUTHENTICATED' },
        task: {
          status: 'UNSUBMITTED',
          durationSeconds: duration,
          modelId,
        },
        billing: {
          status: 'UNBILLED',
          netPointsDeducted: 0,
          recordCount: 0,
        },
        artifacts: {
          status: 'NONE',
          atomsFound: [],
          ownershipVerified: false,
        },
        observedAt: Date.now(),
      };

      // 记录真实拦截事实，并在异常中明确记录零扣费尚未由流水账单证明 (保持 Fail-closed)
      const anomalies = ['NEGATIVE_PROBE_REJECTED_AT_GATEWAY'];
      if (!zeroChargeProven) {
        anomalies.push('BILLING_ZERO_CHARGE_UNPROVEN_BY_LEDGER');
      }

      let observedTransition: StateTransitionRecord | undefined;
      if (options.stateGraph && (mode === 'real' || options.recordMockTransitions)) {
        observedTransition = options.stateGraph.observeTransition(
          fromState,
          'SUBMIT_TASK',
          { duration, resolution, modelId },
          toState,
          anomalies
        );
      }

      return attachLearning({
        ok: true, // 网关成功拦截，负向安全探测符合预期
        candidateId: candidate.id,
        status: 'NEGATIVE_PROBE_REJECTION_VERIFIED',
        mode,
        executionReadiness: candidate.executionReadiness,
        executeResult: execResult,
        rejectionEvidence: {
          gatewayRejected,
          taskIdZero,
          rejectionMessage,
          zeroChargeProven,
        },
        observedTransition,
        message: `负向安全探测验证成功: 网关正确拦截非法参数 (taskId=0, msg: ${rejectionMessage})`,
      });
    }

    return {
      ok: false,
      candidateId: candidate.id,
      status: 'INSUFFICIENT_REAL_EVIDENCE',
      mode,
      executionReadiness: candidate.executionReadiness,
      message: `未知的变异就绪度: ${candidate.executionReadiness}`,
    };
  }
}

export const defaultRunner = new PanquExplorationRunner();

export async function runMutationCandidate(
  options: MutationRunOptions
): Promise<MutationRunResult> {
  return defaultRunner.run(options);
}
