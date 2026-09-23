/**
 * Panqu AI DevTest - 有目标的状态跃迁变异器 (Targeted Mutation Engine)
 *
 * 核心设计哲学：
 * 1. 业务目标驱动（每个变异必须回答：为什么变异？针对什么风险？期望观察什么？）；
 * 2. 严格受限于 Constraint（不产生盲目垃圾 Fuzz）；
 * 3. 绝对不污染 Oracle 与不变量裁决；
 * 4. 落地 5 类高价值变异：Boundary, Temporal, Race, Retry, Timing。
 */

import { type PanquActionType, type EntityCompositeState, type MutationExecutionReadiness } from './contracts.js';
import { type UnverifiedFrontier } from './state-graph.js';
import { type ScoredFrontier } from './exploration-policy.js';
import { PanquConstraintEvaluator, type ConstraintEvaluationResult } from './constraint.js';
import { PanquActionSpace } from './action-space.js';

export type MutationType = 'BOUNDARY' | 'TEMPORAL' | 'RACE' | 'RETRY' | 'TIMING';

export interface MutationStep {
  action: PanquActionType;
  description: string;
  payload: Record<string, any>;
  delayMs?: number; // Timing 变异中的显式时间窗口 (毫秒)
  concurrentGroup?: string; // Race 变异中的并发竞争分组标记
}

export interface MutationCandidate {
  id: string;
  targetFrontierId: string;
  mutationType: MutationType;
  name: string;
  intent: string;
  expectedRisk: string;
  expectedObservation: string;
  steps: MutationStep[];
  boundaryValidity?: 'VALID_BOUNDARY' | 'INVALID_BOUNDARY';
  isRaceCandidate: boolean;
  constraintEvaluation: ConstraintEvaluationResult;
  executionReadiness: MutationExecutionReadiness;
}

export class PanquMutationEngine {
  private constraintEvaluator: PanquConstraintEvaluator;
  private actionSpace: PanquActionSpace;

  constructor(constraintEvaluator = new PanquConstraintEvaluator(), actionSpace = new PanquActionSpace()) {
    this.constraintEvaluator = constraintEvaluator;
    this.actionSpace = actionSpace;
  }

  /**
   * 针对 Policy 选出的高价值 Frontier 生成全套有针对性的变异候选
   */
  public generateMutations(target: UnverifiedFrontier | ScoredFrontier): MutationCandidate[] {
    const frontier: UnverifiedFrontier = 'frontier' in target ? target.frontier : target;
    const candidates: MutationCandidate[] = [];

    // 1. Boundary Mutation (参数临界边界)
    candidates.push(...this.generateBoundaryMutations(frontier));

    // 2. Temporal Mutation (时序倒置与后置状态锁死)
    candidates.push(...this.generateTemporalMutations(frontier));

    // 3. Race Mutation (异步状态竞态候选)
    candidates.push(...this.generateRaceMutations(frontier));

    // 4. Retry Mutation (超时恢复、取消与重试组合)
    candidates.push(...this.generateRetryMutations(frontier));

    // 5. Timing Mutation (时间窗口探测)
    candidates.push(...this.generateTimingMutations(frontier));

    return candidates;
  }

  /**
   * 1. 参数边界变异 (Boundary Mutation)
   * 针对 Panqu 真实参数（如 duration 1, 60, 0, 61），明确标定合规性
   */
  private generateBoundaryMutations(frontier: UnverifiedFrontier): MutationCandidate[] {
    const list: MutationCandidate[] = [];
    const submitAction = this.actionSpace.getAction('SUBMIT_TASK') ?? frontier.candidateAction;

    // 提交动作的前置状态基准（已认证，未提交或已结单）
    const submitBaseState: EntityCompositeState = {
      ...frontier.fromState,
      task: { status: 'UNSUBMITTED' },
    };

    // 针对涉及任务提交的边界值测试
    const boundaryDurations = [
      { val: 1, validity: 'VALID_BOUNDARY' as const, desc: '最小时长边界 (1秒)' },
      { val: 60, validity: 'VALID_BOUNDARY' as const, desc: '最大时长边界 (60秒)' },
      { val: 0, validity: 'INVALID_BOUNDARY' as const, desc: '下溢非法边界 (0秒)' },
      { val: 61, validity: 'INVALID_BOUNDARY' as const, desc: '超限非法边界 (61秒)' },
    ];

    for (const b of boundaryDurations) {
      const payload = {
        modelId: 84,
        promptText: 'Targeted Boundary Mutation Probe',
        duration: b.val,
        resolution: '720p',
      };

      const evalResult = this.constraintEvaluator.evaluate(submitAction, submitBaseState, payload);

      const readiness: MutationExecutionReadiness = evalResult.satisfied
        ? 'EXECUTABLE'
        : evalResult.stateFeasible && !evalResult.payloadValid
          ? 'NEGATIVE_PROBE'
          : 'BLOCKED_BY_UNSUPPORTED_ACTION';

      list.push({
        id: `mut_bound_${b.val}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        targetFrontierId: frontier.frontierId,
        mutationType: 'BOUNDARY',
        name: `参数边界变异: 视频时长 ${b.val}s (${b.desc})`,
        intent: `验证极限参数 [duration=${b.val}] 是否导致预扣分计算溢出、网关拦截失败或产生异常账务状态`,
        expectedRisk:
          b.validity === 'VALID_BOUNDARY'
            ? 'CRITICAL_FINANCIAL: 刊例计费基准计算精度与预扣款正确性'
            : 'INPUT_VALIDATION: 业务网关是否具备 Fail-closed 参数防御拦截能力',
        expectedObservation:
          b.validity === 'VALID_BOUNDARY'
            ? `SUBMIT 成功扣费 ${b.val * 14} 点 (Wan 3.0 720p=14/s)，任务正常进入 DISPATCHED`
            : '网关直接返回 PARAM_OUT_OF_BOUNDS 400，严禁创建任务且预扣款必须为 0',
        steps: [
          {
            action: 'SUBMIT_TASK',
            description: `提交边界参数任务 (duration: ${b.val})`,
            payload,
          },
          {
            action: 'AUDIT_BILLING',
            description: '审计边界提交后的账单扣费是否完全对齐预估刊例',
            payload: {},
          },
        ],
        boundaryValidity: b.validity,
        isRaceCandidate: false,
        constraintEvaluation: evalResult,
        executionReadiness: readiness,
      });
    }

    return list;
  }

  /**
   * 2. 时序变异 (Temporal Mutation)
   * 改变合法业务动作的执行顺序，探测状态转换窗口与终态锁死
   * 包含未证实动作 CANCEL_TASK，标定为 BLOCKED_BY_UNSUPPORTED_ACTION
   */
  private generateTemporalMutations(frontier: UnverifiedFrontier): MutationCandidate[] {
    const list: MutationCandidate[] = [];

    // 变异 A: SUBMIT -> CANCEL -> POLL (刚提交即取消，甚至在轮询之前)
    const stepsA: MutationStep[] = [
      { action: 'SUBMIT_TASK', description: '提交任务锁定预扣款', payload: { modelId: 84, duration: 4 } },
      {
        action: 'CANCEL_TASK',
        description: '【时序变异】立即取消正在排队/生成的任务',
        payload: { reason: 'immediate_cancel' },
      },
      { action: 'POLL_STATUS', description: '取消后轮询任务状态', payload: {} },
      { action: 'AUDIT_BILLING', description: '全量流水核销净扣零与退款幂等', payload: {} },
    ];

    list.push({
      id: `mut_temp_imm_cancel_${Date.now()}`,
      targetFrontierId: frontier.frontierId,
      mutationType: 'TEMPORAL',
      name: '时序变异: 提交后立即取消 (SUBMIT -> CANCEL -> POLL)',
      intent: '验证在任务尚未被 Worker 消费轮询前发起取消，后端是否能安全撤回调度并执行全额退款',
      expectedRisk: 'CRITICAL_FINANCIAL: 预扣款孤儿锁死或并发退款异常',
      expectedObservation: 'task.status === CANCELLED, billing.status === REFUNDED, netPoints === 0',
      steps: stepsA,
      isRaceCandidate: false,
      constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
      executionReadiness: 'BLOCKED_BY_UNSUPPORTED_ACTION',
    });

    // 变异 B: SUBMIT -> POLL -> CANCEL -> POLL (取消后再轮询，验证终态不可变性)
    const stepsB: MutationStep[] = [
      { action: 'SUBMIT_TASK', description: '提交任务', payload: { modelId: 84, duration: 4 } },
      { action: 'POLL_STATUS', description: '正常轮询至进行中', payload: {} },
      { action: 'CANCEL_TASK', description: '执行取消', payload: {} },
      {
        action: 'POLL_STATUS',
        description: '【时序变异】取消后二次轮询状态，验证状态锁死与生命周期一致性',
        payload: {},
      },
      { action: 'AUDIT_BILLING', description: '审计流水不变量', payload: {} },
      { action: 'INSPECT_MEDIA', description: '验证取消任务绝对不生成合法产物', payload: {} },
    ];

    list.push({
      id: `mut_temp_poll_after_cancel_${Date.now()}`,
      targetFrontierId: frontier.frontierId,
      mutationType: 'TEMPORAL',
      name: '时序变异: 取消后继续轮询 (SUBMIT -> POLL -> CANCEL -> POLL)',
      intent: '验证任务进入 CANCELLED 终态后，后续轮询是否会发生状态回溯或错误覆盖为 SUCCESS，确保 Task 生命周期一致性',
      expectedRisk: 'ASYNC_CONSISTENCY: 异步 Worker 忽略取消指令继续生成导致状态裂脑',
      expectedObservation: '二次 POLL 依然锁定为 CANCELLED，产物状态为 NONE，禁止生成有效 MP4',
      steps: stepsB,
      isRaceCandidate: false,
      constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
      executionReadiness: 'BLOCKED_BY_UNSUPPORTED_ACTION',
    });

    return list;
  }

  /**
   * 3. 竞态变异 (Race Mutation)
   * 针对异步 Task 竞争窗口，构建结构化并发候选 (当前无物理并发执行器，标定为 STRUCTURAL_ONLY)
   */
  private generateRaceMutations(frontier: UnverifiedFrontier): MutationCandidate[] {
    const list: MutationCandidate[] = [];

    // 变异: POLL_STATUS || CANCEL_TASK (轮询与取消并发)
    list.push({
      id: `mut_race_poll_cancel_${Date.now()}`,
      targetFrontierId: frontier.frontierId,
      mutationType: 'RACE',
      name: '竞态变异: 轮询与取消并发竞态 (POLL || CANCEL)',
      intent: '验证在轮询收到进行中响应的同一微秒发起取消请求，服务端状态机与分布式锁的互斥性',
      expectedRisk: 'CONCURRENCY_CONFLICT: 状态更新锁冲突或产生竞态脏写',
      expectedObservation: '最终状态收敛于 CANCELLED 或 COMPLETED 之一，绝不允许出现既实扣又退款的撕裂态',
      steps: [
        { action: 'SUBMIT_TASK', description: '前置提交任务', payload: { duration: 4 } },
        {
          action: 'POLL_STATUS',
          description: '[RACE CANDIDATE] 并发分支 A: 轮询状态',
          payload: {},
          concurrentGroup: 'race_poll_cancel_group',
        },
        {
          action: 'CANCEL_TASK',
          description: '[RACE CANDIDATE] 并发分支 B: 取消任务',
          payload: { reason: 'race_cancel' },
          concurrentGroup: 'race_poll_cancel_group',
        },
        { action: 'AUDIT_BILLING', description: '核销最终账务一致性', payload: {} },
      ],
      isRaceCandidate: true,
      constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
      executionReadiness: 'STRUCTURAL_ONLY',
    });

    // 变异: RETRY_TASK || CANCEL_TASK (重试与取消并发竞态)
    list.push({
      id: `mut_race_retry_cancel_${Date.now()}`,
      targetFrontierId: frontier.frontierId,
      mutationType: 'RACE',
      name: '竞态变异: 重试与取消并发竞态 (RETRY || CANCEL)',
      intent: '验证在异常任务重试瞬间同时收到取消指令时，系统是否会发生双重退款或死锁',
      expectedRisk: 'CRITICAL_FINANCIAL: refundIdempotency 违背与重复扣费',
      expectedObservation: '退款记录严格恰好一次，netChargeZero 恒成立',
      steps: [
        { action: 'SUBMIT_TASK', description: '提交前置任务', payload: {} },
        { action: 'INJECT_TIMEOUT', description: '制造超时进入失败态', payload: {} },
        {
          action: 'RETRY_TASK',
          description: '[RACE CANDIDATE] 并发分支 A: 发起重试',
          payload: {},
          concurrentGroup: 'race_retry_cancel_group',
        },
        {
          action: 'CANCEL_TASK',
          description: '[RACE CANDIDATE] 并发分支 B: 发起取消',
          payload: {},
          concurrentGroup: 'race_retry_cancel_group',
        },
        { action: 'AUDIT_BILLING', description: '核查最终流水三不变量', payload: {} },
      ],
      isRaceCandidate: true,
      constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
      executionReadiness: 'STRUCTURAL_ONLY',
    });

    return list;
  }

  /**
   * 4. 重试变异 (Retry Mutation)
   * 重点检验 SUBMIT -> TIMEOUT -> RETRY -> POLL 与复杂组合链路 (依赖未证实动作，标定为 BLOCKED_BY_UNSUPPORTED_ACTION)
   */
  private generateRetryMutations(frontier: UnverifiedFrontier): MutationCandidate[] {
    const list: MutationCandidate[] = [];

    // 组合链路: SUBMIT -> TIMEOUT -> RETRY -> CANCEL -> AUDIT_BILLING
    list.push({
      id: `mut_retry_complex_${Date.now()}`,
      targetFrontierId: frontier.frontierId,
      mutationType: 'RETRY',
      name: '重试变异: 超时-重试-取消复合链路 (SUBMIT -> TIMEOUT -> RETRY -> CANCEL)',
      intent: '模拟任务由于网络原因 504 超时，触发重试后用户再次取消，核查多次流转下的账务最终一致性',
      expectedRisk: 'CRITICAL_FINANCIAL: 复合生命周期下的 antiDoubleBilling 防重扣与漏退款',
      expectedObservation: '重试前预扣与重试后预扣均被清晰审计，最终净扣费归零，无孤儿 Task 残留',
      steps: [
        { action: 'SUBMIT_TASK', description: '初始任务提交 (发生预扣 A)', payload: { duration: 4 } },
        { action: 'INJECT_TIMEOUT', description: '注入网关 504 超时', payload: { timeoutMs: 5000 } },
        { action: 'RETRY_TASK', description: '根据策略触发重试机制', payload: {} },
        { action: 'CANCEL_TASK', description: '重试任务处理中主动取消', payload: { reason: 'user_abort_retry' } },
        {
          action: 'AUDIT_BILLING',
          description: '深度核销全量流水记录 (核查 antiDoubleBilling 与 netChargeZero)',
          payload: {},
        },
      ],
      isRaceCandidate: false,
      constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
      executionReadiness: 'BLOCKED_BY_UNSUPPORTED_ACTION',
    });

    return list;
  }

  /**
   * 5. 时间窗口变异 (Timing Mutation)
   * 生成有限且具成本效益的时间延迟变异候选 (去除了对未证实 CANCEL_TASK 的依赖，当前 delayMs 属于结构元数据，标为 STRUCTURAL_ONLY)
   */
  private generateTimingMutations(frontier: UnverifiedFrontier): MutationCandidate[] {
    const list: MutationCandidate[] = [];

    // 延时配置矩阵 (精确受控，绝不引入无意义超长 sleep)
    const timingConfigs = [
      { delayMs: 0, label: '零延时即时探测 (0ms)', risk: '高速时序冲击与缓存未落盘' },
      { delayMs: 500, label: '短时窗口微延时 (500ms)', risk: '分布式队列消费出栈窗口' },
      { delayMs: 4500, label: '临界超时边界窗口 (4500ms)', risk: '网关超时阈值 (5000ms) 临界态' },
    ];

    for (const t of timingConfigs) {
      list.push({
        id: `mut_timing_${t.delayMs}_${Date.now()}`,
        targetFrontierId: frontier.frontierId,
        mutationType: 'TIMING',
        name: `时间窗口变异: 提交后延时对账 [${t.label}]`,
        intent: `探查任务提交与账单最终落库之间的时间窗口 [delay=${t.delayMs}ms]，排查异步账单延迟到账造成的假性未对齐`,
        expectedRisk: `TIMING_SENSITIVITY: ${t.risk}`,
        expectedObservation: `在经历 ${t.delayMs}ms 延时后，查询账单流水必须呈现确定终态，严禁返回中间未决状态`,
        steps: [
          { action: 'SUBMIT_TASK', description: '前置提交任务', payload: { duration: 4 } },
          {
            action: 'AUDIT_BILLING',
            description: `【延时变异】延时 ${t.delayMs}ms 后发起全量流水审计`,
            payload: {},
            delayMs: t.delayMs,
          },
        ],
        isRaceCandidate: false,
        constraintEvaluation: { satisfied: true, stateFeasible: true, payloadValid: true, violations: [] },
        executionReadiness: 'STRUCTURAL_ONLY',
      });
    }

    return list;
  }
}
