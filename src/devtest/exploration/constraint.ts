/**
 * Panqu AI DevTest - 业务约束评估器 (Constraint Solver & Evaluator)
 *
 * 严格基于 Panqu 领域规则进行前置谓词校验、时序排他性检测与参数边界约束求解。
 * 确保只有业务可行、时序合理的候选动作进入后续探索与评分流程。
 */

import { type EntityCompositeState, type PanquActionType, type PanquActionDefinition } from './contracts.js';

export interface ConstraintEvaluationResult {
  satisfied: boolean;
  stateFeasible: boolean;
  payloadValid: boolean;
  violations: string[];
  inferredBounds?: Record<string, any>;
}

export class PanquConstraintEvaluator {
  /**
   * 综合评估某个动作在指定状态与载荷下的合法性
   *
   * 严格解耦：
   * - stateFeasible: 当前系统状态在时序与前置谓词上是否允许发起动作 (探索物理可行性)
   * - payloadValid: 请求参数是否属于客户端已知合法边界 (载荷合规性)
   * - satisfied: stateFeasible && payloadValid (保持已有调用方兼容)
   */
  public evaluate(
    action: PanquActionDefinition,
    state: EntityCompositeState,
    payload: Record<string, any> = {},
  ): ConstraintEvaluationResult {
    const stateViolations: string[] = [];
    const payloadViolations: string[] = [];
    const inferredBounds: Record<string, any> = {};

    // 1. 前置谓词校验 (状态维度)
    for (let i = 0; i < action.preconditions.length; i++) {
      const check = action.preconditions[i];
      if (!check(state)) {
        stateViolations.push(`PRECONDITION_FAILED: 前置条件 #${i + 1} 不满足 (动作: ${action.type})`);
      }
    }

    // 2. 核心实体互斥性与时序单向性约束 (状态维度)
    this.checkTemporalExclusivity(action.type, state, stateViolations);

    // 3. 业务参数边界约束 (载荷参数维度)
    this.checkParameterBounds(action.type, payload, payloadViolations, inferredBounds);

    const stateFeasible = stateViolations.length === 0;
    const payloadValid = payloadViolations.length === 0;
    const satisfied = stateFeasible && payloadValid;
    const violations = [...stateViolations, ...payloadViolations];

    return {
      satisfied,
      stateFeasible,
      payloadValid,
      violations,
      inferredBounds,
    };
  }

  /**
   * 时序排他性检查：防止不可能发生的状态回溯与非法操作
   */
  private checkTemporalExclusivity(type: PanquActionType, state: EntityCompositeState, violations: string[]): void {
    // A. 已经处于终态的任务，禁止执行进行时动作 (轮询、取消、超时注入)
    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED'];
    if (terminalStatuses.includes(state.task.status)) {
      if (['POLL_STATUS', 'CANCEL_TASK', 'INJECT_TIMEOUT'].includes(type)) {
        violations.push(`TEMPORAL_CONFLICT: 任务已处于终态 [${state.task.status}]，禁止执行时序中动作 [${type}]`);
      }
    }

    // B. 没有 TaskId 的情况下，禁止执行与任务绑定的操作
    if (state.task.taskId === undefined) {
      if (['POLL_STATUS', 'CANCEL_TASK', 'INJECT_TIMEOUT', 'AUDIT_BILLING'].includes(type)) {
        violations.push(`MISSING_ENTITY_ID: 未生成真实 taskId，禁止执行任务级动作 [${type}]`);
      }
    }

    // C. 会话未认证时，严禁提交涉及计费的写操作
    if (state.session.status !== 'AUTHENTICATED') {
      if (['SUBMIT_TASK', 'CANCEL_TASK', 'RETRY_TASK'].includes(type)) {
        violations.push(`AUTH_REQUIRED: 会话状态为 [${state.session.status}]，禁止执行涉及资产操作 [${type}]`);
      }
    }
  }

  /**
   * 参数边界校验 (Parameter Boundary Evaluation)
   */
  private checkParameterBounds(
    type: PanquActionType,
    payload: Record<string, any>,
    violations: string[],
    inferredBounds: Record<string, any>,
  ): void {
    if (type === 'SUBMIT_TASK') {
      // 视频时长边界 [1, 60] 秒
      const duration = payload.duration ?? 4;
      if (typeof duration !== 'number' || duration <= 0 || duration > 60) {
        violations.push(`PARAM_OUT_OF_BOUNDS: 视频时长必须在 [1, 60] 秒之间，当前为: ${duration}`);
      } else {
        inferredBounds.durationRange = [1, 60];
      }

      // 模型 ID 必须在支持的模型清单中
      const supportedModels = [84, 88, 15, 201, 205];
      const modelId = payload.modelId ?? 84;
      if (!supportedModels.includes(modelId)) {
        violations.push(`UNSUPPORTED_MODEL: 不支持的模型 ID [${modelId}]`);
      }
    }

    if (type === 'CANCEL_TASK') {
      inferredBounds.cancellationReason = payload.reason ?? 'user_manual_cancel';
    }
  }
}
