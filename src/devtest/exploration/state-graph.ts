/**
 * Panqu AI DevTest - 运行时事实状态图 (StateGraph)
 *
 * 动态记录执行事实，发现未经验证的高危状态跃迁与异常复合状态。
 * 绝非死板的手工字典，而是随真实执行不断扩展的事实拓扑。
 */

import {
  type EntityCompositeState,
  type PanquActionType,
  type StateTransitionRecord,
  getCompositeStateKey,
  type PanquActionDefinition,
} from './contracts.js';
import type { PanquActionSpace } from './action-space.js';

export interface UnverifiedFrontier {
  frontierId: string;
  fromKey: string;
  fromState: EntityCompositeState;
  candidateAction: PanquActionDefinition;
  riskScore: number;
  reason: string;
  inferredTargetStates: string[];
  proposedScenario: Array<{
    action: PanquActionType;
    description: string;
    payload: Record<string, any>;
  }>;
}

export class PanquStateGraph {
  private nodes: Map<string, EntityCompositeState> = new Map();
  private transitions: Map<string, StateTransitionRecord> = new Map();

  /**
   * 注册或更新节点
   */
  public registerState(state: EntityCompositeState): string {
    const key = getCompositeStateKey(state);
    this.nodes.set(key, state);
    return key;
  }

  public getState(key: string): EntityCompositeState | undefined {
    return this.nodes.get(key);
  }

  public getAllStates(): EntityCompositeState[] {
    return Array.from(this.nodes.values());
  }

  public getAllTransitions(): StateTransitionRecord[] {
    return Array.from(this.transitions.values());
  }

  /**
   * 观察并记录一次真实执行跃迁 (Observed Transition)
   */
  public observeTransition(
    fromState: EntityCompositeState,
    actionType: PanquActionType,
    actionPayload: Record<string, any>,
    toState: EntityCompositeState,
    invariantsChecked: string[] = [],
  ): StateTransitionRecord {
    const fromKey = this.registerState(fromState);
    const toKey = this.registerState(toState);

    // 动态核验目标状态是否存在复合业务异常
    const anomalies = this.detectAnomalies(toState);

    const transitionKey = `${fromKey}->${actionType}->${toKey}`;
    const existing = this.transitions.get(transitionKey);

    if (existing) {
      existing.historyCount += 1;
      existing.lastObserved = Date.now();
      existing.actionPayload = { ...existing.actionPayload, ...actionPayload };
      existing.invariantsChecked = Array.from(new Set([...existing.invariantsChecked, ...invariantsChecked]));
      existing.anomaliesDetected = Array.from(new Set([...existing.anomaliesDetected, ...anomalies]));
      return existing;
    }

    const newRecord: StateTransitionRecord = {
      id: `trans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      fromKey,
      fromState,
      actionType,
      actionPayload,
      toKey,
      toState,
      historyCount: 1,
      lastObserved: Date.now(),
      invariantsChecked,
      anomaliesDetected: anomalies,
    };

    this.transitions.set(transitionKey, newRecord);
    return newRecord;
  }

  /**
   * 自动探测复合状态的内在不变量异常
   */
  public detectAnomalies(state: EntityCompositeState): string[] {
    const anomalies: string[] = [];

    // 1. 成功任务但账务仍处于未实扣的预扣态
    if (state.task.status === 'COMPLETED' && state.billing.status === 'RESERVED') {
      anomalies.push('COMPLETED_TASK_WITH_UNSETTLED_PRECHARGE');
    }

    // 2. 任务声明成功但产物丢失或未经验证
    if (
      state.task.status === 'COMPLETED' &&
      (state.artifacts.status === 'MISSING' || state.artifacts.status === 'NONE')
    ) {
      anomalies.push('COMPLETED_TASK_MISSING_ARTIFACT');
    }

    // 3. 取消任务却发生了实扣 (未清零)
    if (
      state.task.status === 'CANCELLED' &&
      (state.billing.status === 'CHARGED' || state.billing.netPointsDeducted > 0)
    ) {
      anomalies.push('CANCELLED_TASK_CHARGED_WITHOUT_REFUND');
    }

    // 4. 失败任务却发生了实扣 (未清零)
    if (state.task.status === 'FAILED' && (state.billing.status === 'CHARGED' || state.billing.netPointsDeducted > 0)) {
      anomalies.push('FAILED_TASK_CHARGED_WITHOUT_REFUND');
    }

    // 5. 账务状态机不一致 (如产生重复扣款或退款异常)
    if (state.billing.status === 'INCONSISTENT') {
      anomalies.push('BILLING_INCONSISTENCY_DETECTED');
    }

    return anomalies;
  }

  /**
   * 核心发现机制：探寻未经验证的边界前沿 (Unverified Frontiers)
   *
   * 算法逻辑：
   * 遍历当前已知的所有节点，对每个节点计算 ActionSpace 中的可行操作。
   * 如果该操作在历史中从未从该状态执行过，或者虽执行过但属于高危未知跃迁，
   * 系统主动标定其为高价值探索前沿，并自动生成探索场景。
   */
  public findUnverifiedFrontiers(actionSpace: PanquActionSpace): UnverifiedFrontier[] {
    const frontiers: UnverifiedFrontier[] = [];
    const allStates = this.getAllStates();

    for (const state of allStates) {
      const fromKey = getCompositeStateKey(state);
      const feasibleActions = actionSpace.getFeasibleActions(state);

      for (const action of feasibleActions) {
        // 查找历史上是否已经存在以该状态为起点、执行该动作的跃迁
        const observedMatchingTransitions = this.getAllTransitions().filter(
          (t) => t.fromKey === fromKey && t.actionType === action.type,
        );

        const neverExplored = observedMatchingTransitions.length === 0;
        const hasAnomaly = observedMatchingTransitions.some((t) => t.anomaliesDetected.length > 0);

        if (neverExplored || hasAnomaly) {
          // 计算风险分：结合动作本身的 baseRisk 与当前状态业务权重
          let riskScore = action.baseRisk;
          if (state.task.status === 'GENERATING' || state.task.status === 'DISPATCHED') {
            riskScore = Math.min(1.0, riskScore + 0.15); // 异步进行中的操作风险高
          }
          if (state.billing.status === 'RESERVED') {
            riskScore = Math.min(1.0, riskScore + 0.2); // 处于预扣状态，涉及资金安全性
          }

          const rationale = neverExplored
            ? `状态 [${fromKey}] 下的可行动作 [${action.type}] 从未在测试中被验证，存在未知业务状态黑盒。`
            : `状态 [${fromKey}] 下的动作 [${action.type}] 曾探测到复合异常: ${observedMatchingTransitions[0]?.anomaliesDetected.join(', ')}`;

          // 自动构建可执行探索场景
          const proposedScenario = this.buildScenarioForFrontier(state, action);

          frontiers.push({
            frontierId: `frontier_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            fromKey,
            fromState: state,
            candidateAction: action,
            riskScore,
            reason: rationale,
            inferredTargetStates: this.inferPossibleTargetStates(state, action.type),
            proposedScenario,
          });
        }
      }
    }

    // 按风险分降序排列
    return frontiers.sort((a, b) => b.riskScore - a.riskScore);
  }

  /**
   * 推导可能的后置状态特征
   */
  private inferPossibleTargetStates(currentState: EntityCompositeState, action: PanquActionType): string[] {
    switch (action) {
      case 'CANCEL_TASK':
        return ['task:CANCELLED|billing:REFUNDED', 'task:CANCELLED|billing:CHARGED (High Risk Defect)'];
      case 'INJECT_TIMEOUT':
        return ['task:FAILED|billing:REFUNDED', 'task:GENERATING|billing:RESERVED (Orphan State)'];
      case 'RETRY_TASK':
        return ['task:SUBMITTED|billing:RESERVED (Verify Single Charge)'];
      default:
        return ['state:UNKNOWN_AWAITING_EXPLORATION'];
    }
  }

  /**
   * 为未知前沿构建完整的复现与探测调用链
   */
  private buildScenarioForFrontier(
    targetState: EntityCompositeState,
    candidateAction: PanquActionDefinition,
  ): Array<{ action: PanquActionType; description: string; payload: Record<string, any> }> {
    const steps: Array<{ action: PanquActionType; description: string; payload: Record<string, any> }> = [];

    // 1. 若前置需要认证
    if (targetState.session.status === 'ANONYMOUS') {
      steps.push({
        action: 'AUTHENTICATE',
        description: '初始化用户会话与凭据',
        payload: { refresh: true },
      });
    }

    // 2. 若目标状态是任务处理中，必须先提交任务
    if (['DISPATCHED', 'GENERATING'].includes(targetState.task.status)) {
      steps.push({
        action: 'SUBMIT_TASK',
        description: '提交新任务并锁定预扣款',
        payload: { modelId: 84, promptText: 'Autonomous test probing scenario', duration: 4 },
      });
      steps.push({
        action: 'POLL_STATUS',
        description: '等待进入处理中状态',
        payload: { targetStatus: targetState.task.status },
      });
    }

    // 3. 核心探测动作（针对该未知跃迁）
    steps.push({
      action: candidateAction.type,
      description: `【核心探索】执行候选动作 ${candidateAction.name}`,
      payload: candidateAction.payloadGenerator ? candidateAction.payloadGenerator(targetState) : {},
    });

    // 4. 后置全量审计（保证账务与产物不变量）
    steps.push({
      action: 'AUDIT_BILLING',
      description: '核销防重扣与退款幂等性',
      payload: {},
    });
    steps.push({
      action: 'INSPECT_MEDIA',
      description: '核查最终产物归属与二进制容器完整性',
      payload: {},
    });

    return steps;
  }
}
