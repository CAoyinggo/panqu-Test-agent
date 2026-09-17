/**
 * Panqu AI DevTest - 动作空间模型
 * 
 * 建模真实 Panqu 业务动作，包含前置约束与风险评级。
 */

import {
  type EntityCompositeState,
  type PanquActionDefinition,
  type PanquActionType,
} from './contracts.js';

export class PanquActionSpace {
  private actions: Map<PanquActionType, PanquActionDefinition> = new Map();

  constructor() {
    this.registerDefaultActions();
  }

  private registerDefaultActions(): void {
    // 1. 鉴权
    this.register({
      type: 'AUTHENTICATE',
      name: '会话鉴权 / Cookie 初始化',
      description: '探测并初始化用户 Session 与 Cookie',
      riskCategory: 'READ_ONLY',
      baseRisk: 0.1,
      executionSupport: 'REAL_SETUP',
      preconditions: [
        (s) => s.session.status === 'ANONYMOUS' || s.session.status === 'EXPIRED',
      ],
      payloadGenerator: () => ({ refresh: true }),
    });

    // 2. 提交任务
    this.register({
      type: 'SUBMIT_TASK',
      name: '提交异步音视频生成任务',
      description: '向主站发起生成请求，触发预扣款',
      riskCategory: 'CRITICAL_FINANCIAL',
      baseRisk: 0.9,
      executionSupport: 'REAL_EXECUTABLE',
      preconditions: [
        (s) => s.session.status === 'AUTHENTICATED',
        (s) => ['UNSUBMITTED', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(s.task.status),
      ],
      payloadGenerator: (s) => ({
        modelId: s.task.modelId ?? 84, // 默认 Wan 3.0
        promptText: s.task.promptText ?? 'A cinematic drone shot of a futuristic metropolis at sunset',
        duration: s.task.durationSeconds ?? 4,
        resolution: '720p',
      }),
    });

    // 3. 轮询状态
    this.register({
      type: 'POLL_STATUS',
      name: '轮询任务生成进度',
      description: '只读获取任务后端状态',
      riskCategory: 'READ_ONLY',
      baseRisk: 0.2,
      executionSupport: 'REAL_EXECUTABLE',
      preconditions: [
        (s) => s.task.taskId !== undefined,
        (s) => ['SUBMITTED', 'DISPATCHED', 'GENERATING'].includes(s.task.status),
      ],
      payloadGenerator: (s) => ({ taskId: s.task.taskId }),
    });

    // 4. 超时中断注入
    this.register({
      type: 'INJECT_TIMEOUT',
      name: '模拟网关超时或网络截断',
      description: '在任务处理阶段注入 504 Gateway Timeout 或网络中断 (结构化测试意图，当前代码库无真实注入支持)',
      riskCategory: 'ASYNC_CONSISTENCY',
      baseRisk: 0.85,
      executionSupport: 'CODEBASE_UNSUPPORTED',
      preconditions: [
        (s) => s.task.taskId !== undefined,
        (s) => ['DISPATCHED', 'GENERATING'].includes(s.task.status),
      ],
      payloadGenerator: (s) => ({ timeoutMs: 5000, taskId: s.task.taskId }),
    });

    // 5. 取消任务
    this.register({
      type: 'CANCEL_TASK',
      name: '主动取消正在排队/生成的任务',
      description: '调用取消接口，必须严格触发退款且不得生成产物 (当前代码库没有足够证据证明其具备真实执行能力)',
      riskCategory: 'CRITICAL_FINANCIAL',
      baseRisk: 0.95,
      executionSupport: 'UNVERIFIED_UNSUPPORTED',
      preconditions: [
        (s) => s.task.taskId !== undefined,
        (s) => ['SUBMITTED', 'DISPATCHED', 'GENERATING'].includes(s.task.status),
      ],
      payloadGenerator: (s) => ({ taskId: s.task.taskId, reason: 'user_cancelled_in_test' }),
    });

    // 6. 重试任务
    this.register({
      type: 'RETRY_TASK',
      name: '失败/取消后发起重试',
      description: '对终态异常任务发起重试，核验是否会产生双重预扣款 (理论业务动作，当前代码库未证实独立重试API支持)',
      riskCategory: 'ASYNC_CONSISTENCY',
      baseRisk: 0.75,
      executionSupport: 'UNVERIFIED_UNSUPPORTED',
      preconditions: [
        (s) => ['FAILED', 'CANCELLED'].includes(s.task.status),
      ],
      payloadGenerator: (s) => ({ previousTaskId: s.task.taskId }),
    });

    // 7. 账务流水对账
    this.register({
      type: 'AUDIT_BILLING',
      name: '全量流水审计与三不变量核销',
      description: '审计防重扣 (antiDoubleBilling)、净扣零 (netChargeZero)、退款幂等 (refundIdempotency)',
      riskCategory: 'CRITICAL_FINANCIAL',
      baseRisk: 0.65,
      executionSupport: 'REAL_EXECUTABLE',
      preconditions: [
        (s) => s.task.taskId !== undefined,
      ],
      payloadGenerator: (s) => ({ taskId: s.task.taskId }),
    });

    // 8. 产物二进制核验
    this.register({
      type: 'INSPECT_MEDIA',
      name: '产物结构与归属完整性核验',
      description: '对 MP4 (ftyp, moov, mdat) 及 PNG (IHDR) 二进制进行只读校验',
      riskCategory: 'MEDIA_INTEGRITY',
      baseRisk: 0.6,
      executionSupport: 'REAL_EXECUTABLE',
      preconditions: [
        (s) => s.task.status === 'COMPLETED' || s.artifacts.mediaUrl !== undefined,
      ],
      payloadGenerator: (s) => ({ mediaUrl: s.artifacts.mediaUrl }),
    });
  }

  public register(action: PanquActionDefinition): void {
    this.actions.set(action.type, action);
  }

  public getAction(type: PanquActionType): PanquActionDefinition | undefined {
    return this.actions.get(type);
  }

  public getAllActions(): PanquActionDefinition[] {
    return Array.from(this.actions.values());
  }

  /**
   * 基于当前运行时状态，计算所有满足前置条件的可行动作
   */
  public getFeasibleActions(state: EntityCompositeState): PanquActionDefinition[] {
    return this.getAllActions().filter((action) => {
      return action.preconditions.every((predicate) => predicate(state));
    });
  }
}
