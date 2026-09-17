import { describe, expect, it } from 'vitest';
import {
  type EntityCompositeState,
  type LearningExperience,
} from '../../../../src/devtest/exploration/contracts.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import { type UnverifiedFrontier } from '../../../../src/devtest/exploration/state-graph.js';
import { PanquConstraintEvaluator } from '../../../../src/devtest/exploration/constraint.js';
import { PanquExplorationPolicy } from '../../../../src/devtest/exploration/exploration-policy.js';

describe('Step 2 硬性业务验收 Gate：探索策略调度器决策力检验 (Constraint + ExplorationPolicy)', () => {
  const actionSpace = new PanquActionSpace();
  const evaluator = new PanquConstraintEvaluator();
  const policy = new PanquExplorationPolicy(evaluator);

  // 辅助构造 Frontier 实体
  function createFrontier(
    fromState: EntityCompositeState,
    actionType: any,
    inferredTargetStates: string[] = ['state:NORMAL']
  ): UnverifiedFrontier {
    const action = actionSpace.getAction(actionType)!;
    return {
      frontierId: `f_${actionType}_${Math.random().toString(36).slice(2, 6)}`,
      fromKey: `task:${fromState.task.status}|billing:${fromState.billing.status}`,
      fromState,
      candidateAction: action,
      riskScore: action.baseRisk,
      reason: 'test_candidate',
      inferredTargetStates,
      proposedScenario: [],
    };
  }

  it('Gate 1: 业务硬性约束拦截 —— 非法时序与缺失关键前置的候选直接剔除', () => {
    // 状态：未提交任务，根本没有 taskId
    const unsubmittedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'UNSUBMITTED' }, // 没有 taskId
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 尝试在无 taskId 时做对账或取消
    const invalidFrontierA = createFrontier(unsubmittedState, 'CANCEL_TASK');
    const invalidFrontierB = createFrontier(unsubmittedState, 'AUDIT_BILLING');

    const ranked = policy.evaluateAndRank([invalidFrontierA, invalidFrontierB]);

    // 必须全部被约束求解器干脆拦截，候选池输出为 0
    expect(ranked.length).toBe(0);
  });

  it('Gate 2: 未知优先铁律 (Unknown > Known) —— 已验证100次的正常高危路径必须让位于0次未验证的危险跃迁', () => {
    // 候选 A: 正常提交任务（虽然是写操作 Risk=0.9，但在历史上已经顺利执行并验证过 100 次）
    const authedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'UNSUBMITTED' },
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const knownNormalSubmit = createFrontier(authedState, 'SUBMIT_TASK');

    // 候选 B: 正在生成中且已预扣款时的取消操作（Risk=0.95，历史上从未验证过，执行 0 次）
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9005, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const unknownCancel = createFrontier(generatingState, 'CANCEL_TASK', [
      'task:CANCELLED|billing:CHARGED (High Risk Defect)',
    ]);

    // 历史运行频次记录表
    const historyCounts = new Map<string, number>();
    historyCounts.set(`${knownNormalSubmit.fromKey}->SUBMIT_TASK`, 100); // 跑过 100 次
    historyCounts.set(`${unknownCancel.fromKey}->CANCEL_TASK`, 0);         // 跑过 0 次 (全新空白)

    const ranked = policy.evaluateAndRank([knownNormalSubmit, unknownCancel], historyCounts);

    expect(ranked.length).toBe(2);

    // 核心断言：未知的取消跃迁必须压倒性夺得第一名！
    expect(ranked[0].frontier.candidateAction.type).toBe('CANCEL_TASK');
    expect(ranked[1].frontier.candidateAction.type).toBe('SUBMIT_TASK');

    // 验证评分细节：
    // 未知取消用例因 0 次执行，罚分必然为 0，且享受 Novelty=1.00 加成
    expect(ranked[0].breakdown.novelty).toBe(1.0);
    expect(ranked[0].breakdown.alreadyCoveredPenalty).toBe(0.0);

    // 已验证 100 次的用例必须被扣除强烈的覆盖惩罚 (> 3.0 分)
    expect(ranked[1].breakdown.alreadyCoveredPenalty).toBeGreaterThan(3.0);
    expect(ranked[0].totalScore).toBeGreaterThan(ranked[1].totalScore + 2.0); // 显著分差
  });

  it('Gate 3: 多候选竞选锦标赛 —— 能够综合风险、不变量、熵值评选最优，并给出完全可解释的自然语言依据', () => {
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9006, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    const completedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'COMPLETED', taskId: 9007, durationSeconds: 4 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'VERIFIED', atomsFound: ['ftyp', 'moov', 'mdat'], ownershipVerified: true },
      observedAt: Date.now(),
    };

    // 5 个候选同台竞争：
    // 1. 生成中取消 (0次，资金退款关键影响，时序边界)
    const frontierCancel = createFrontier(generatingState, 'CANCEL_TASK', [
      'task:CANCELLED|billing:CHARGED (High Risk Defect)',
    ]);
    // 2. 生成中超时 (0次，异步不一致性)
    const frontierTimeout = createFrontier(generatingState, 'INJECT_TIMEOUT', [
      'task:FAILED|billing:REFUNDED',
    ]);
    // 3. 生成中只读轮询 (50次，纯只读)
    const frontierPoll = createFrontier(generatingState, 'POLL_STATUS');
    // 4. 成功后媒体检查 (20次，只读质检)
    const frontierInspectMedia = createFrontier(completedState, 'INSPECT_MEDIA');

    const history = new Map<string, number>([
      [`${frontierCancel.fromKey}->CANCEL_TASK`, 0],
      [`${frontierTimeout.fromKey}->INJECT_TIMEOUT`, 0],
      [`${frontierPoll.fromKey}->POLL_STATUS`, 50],
      [`${frontierInspectMedia.fromKey}->INSPECT_MEDIA`, 20],
    ]);

    const ranked = policy.evaluateAndRank(
      [frontierInspectMedia, frontierPoll, frontierTimeout, frontierCancel],
      history
    );

    // 第一名必须是具备资金影响、高不确定性的 CANCEL_TASK
    const topPick = ranked[0];
    expect(topPick.frontier.candidateAction.type).toBe('CANCEL_TASK');
    expect(topPick.breakdown.businessImpact).toBe(1.2); // 资金不变量最高级别影响
    expect(topPick.breakdown.uncertainty).toBe(0.95);    // 存在潜在 Defect 推导

    // 第二名必须是具备异步边界效应的 INJECT_TIMEOUT
    expect(ranked[1].frontier.candidateAction.type).toBe('INJECT_TIMEOUT');

    // 只读且高频运行的操作必然垫底
    expect(ranked[ranked.length - 1].frontier.candidateAction.type).toBe('POLL_STATUS');

    // 检验决策依据的可解释性 (Explainability)
    expect(topPick.rationale).toContain('[未知优先]');
    expect(topPick.rationale).toContain('[资金不变量]');
    expect(topPick.rationale).toContain('[高不确定性]');
    expect(topPick.rationale).toContain('[业务边界动作]');
  });

  it('Gate 4: 历史因果经验动态反哺 —— 发生过缺陷的历史状态在后续探索中享有权重加成', () => {
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9008 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    const frontierTimeout = createFrontier(generatingState, 'INJECT_TIMEOUT');
    const frontierCancel = createFrontier(generatingState, 'CANCEL_TASK');

    // 假设未注入经验前，CANCEL_TASK 基础分通常高于 INJECT_TIMEOUT
    const beforeRanked = policy.evaluateAndRank([frontierTimeout, frontierCancel]);
    expect(beforeRanked[0].frontier.candidateAction.type).toBe('CANCEL_TASK');

    // 现在系统注入了一条历史确诊经验：INJECT_TIMEOUT 曾导致严重孤儿任务缺陷
    const historicalExperience: LearningExperience = {
      experienceId: 'exp_timeout_defect_01',
      discoveredTransitionId: 'trans_999',
      discoveredAnomaly: 'INJECT_TIMEOUT_CAUSED_ORPHAN_TASK',
      causalChain: ['TIMEOUT -> NO_REFUND -> ORPHAN'],
      policyDirectives: {
        boostMultiplier: 3.5, // 权重暴涨 3.5 倍
        mandatoryInvariants: ['netChargeZero'],
        priorityStatesToExplore: ['task:GENERATING'],
      },
      confidence: 0.98,
      createdAt: Date.now(),
    };

    // 重新评估
    const afterRanked = policy.evaluateAndRank(
      [frontierTimeout, frontierCancel],
      new Map(),
      [historicalExperience]
    );

    // 此时被历史经验强化的 INJECT_TIMEOUT 获得了历史加成，分数大幅上涨
    const timeoutScored = afterRanked.find(
      (s) => s.frontier.candidateAction.type === 'INJECT_TIMEOUT'
    )!;
    expect(timeoutScored.breakdown.historicalFailure).toBeGreaterThan(1.0);
    expect(timeoutScored.rationale).toContain('[历史经验强化]');
  });
});
