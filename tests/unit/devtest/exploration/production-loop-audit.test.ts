import { describe, expect, it, vi } from 'vitest';
import {
  type EntityCompositeState,
} from '../../../../src/devtest/exploration/contracts.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import {
  PanquStateGraph,
  type UnverifiedFrontier,
} from '../../../../src/devtest/exploration/state-graph.js';
import { PanquConstraintEvaluator } from '../../../../src/devtest/exploration/constraint.js';
import { PanquExplorationPolicy } from '../../../../src/devtest/exploration/exploration-policy.js';
import {
  PanquExplorationRunner,
} from '../../../../src/devtest/exploration/runner.js';
import {
  PanquLearningStore,
  buildActionHistoryCounts,
} from '../../../../src/devtest/exploration/learning.js';
import { type MutationCandidate } from '../../../../src/devtest/exploration/mutation.js';

describe('Step 5 生产级收口审计：真实主链接通、隔离与自进化稳定性验证', () => {
  const actionSpace = new PanquActionSpace();
  const constraintEvaluator = new PanquConstraintEvaluator();
  const policy = new PanquExplorationPolicy(constraintEvaluator);

  function createFrontier(
    fromState: EntityCompositeState,
    actionType: any,
    baseRiskOverride?: number
  ): UnverifiedFrontier {
    const action = actionSpace.getAction(actionType)!;
    return {
      frontierId: `f_${actionType}_${Math.random().toString(36).slice(2, 6)}`,
      fromKey: `session:${fromState.session.status}|task:${fromState.task.status}|billing:${fromState.billing.status}|artifacts:${fromState.artifacts.status}`,
      fromState,
      candidateAction: baseRiskOverride !== undefined ? { ...action, baseRisk: baseRiskOverride } : action,
      riskScore: baseRiskOverride ?? action.baseRisk,
      reason: 'audit_test_frontier',
      inferredTargetStates: ['state:NORMAL'],
      proposedScenario: [],
    };
  }

  const unsubmittedState: EntityCompositeState = {
    session: { status: 'AUTHENTICATED' },
    task: { status: 'UNSUBMITTED' },
    billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
    artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
    observedAt: Date.now(),
  };

  const sampleSubmitCandidate: MutationCandidate = {
    id: 'cand_submit_test_01',
    name: 'submit_candidate',
    targetFrontierId: 'frontier_submit_01',
    mutationType: 'BOUNDARY',
    intent: '测试真实主链自动学习闭环',
    expectedRisk: 'HIGH',
    expectedObservation: 'task:SUCCESS',
    steps: [
      {
        action: 'SUBMIT_TASK',
        description: '提交视频生成任务',
        payload: { duration: 5, modelId: 84 },
      },
    ],
    isRaceCandidate: false,
    constraintEvaluation: {
      satisfied: true,
      stateFeasible: true,
      payloadValid: true,
      violations: [],
    },
    executionReadiness: 'EXECUTABLE',
  };

  it('1. 真实主链自动闭环：执行一次后自动提炼 REAL experience 写入 Store (无需手动调用辅助函数)', async () => {
    const graph = new PanquStateGraph();
    const store = new PanquLearningStore();
    const runner = new PanquExplorationRunner();

    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 7701,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      points: 70,
      message: '提交成功',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: false,
      passed: false,
      taskId: 7701,
      modelId: 84,
      mediaType: 'video',
      verdict: 'FAIL',
      status: 'FAILED',
      reasons: ['[FP-004] 计费防重扣违背：发生多笔扣费'],
      evidence: {
        session: { status: 'AUTHENTICATED', tokenPresent: true },
        task: { status: 'PASS' },
        media: { status: 'UNVERIFIED', source: 'local', ownership: 'UNVERIFIED' },
        billing: { status: 'FAIL', source: 'remote_api', reason: '防重扣失败' },
        invariants: { status: 'FAIL', antiDoubleBilling: false },
      },
      businessValidation: {
        status: 'FAIL',
        technicalSuccess: true,
        businessSuccess: false,
        verdictDetail: {
          apiVerified: true,
          taskStateVerified: true,
          artifactBound: false,
          oracleConsistent: false,
          relationsValid: true,
        },
        matchedFailurePatterns: ['FP-004'],
        reasons: ['FP-004 重复预扣'],
        credibility: 'CONFIRMED',
      },
      mode: 'real',
    } as any);

    // 沿真实生产路径调用 runner.run
    const result = await runner.run({
      candidate: sampleSubmitCandidate,
      mode: 'real',
      stateGraph: graph,
      learningStore: store,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 核心断言 1：返回值自动携带提取出的经验
    expect(result.learnedExperiences).toBeDefined();
    expect(result.learnedExperiences!.length).toBe(1);

    // 核心断言 2：注入的 Store 中自动产生真实经验，无需外层手动干涉
    const realExps = store.getExperiences('real');
    expect(realExps.length).toBe(1);
    expect(realExps[0].discoveredAnomaly).toContain('SUBMIT_TASK');
    expect(realExps[0].policyDirectives.boostMultiplier).toBe(3.0);

    // 核心断言 3：StateGraph 跃迁记录自动沉淀
    expect(graph.getAllTransitions().length).toBe(1);
  });

  it('2. 决策反转验证：经验反哺 Policy 导致 Top Pick 候选选择发生真实倒置', () => {
    const store = new PanquLearningStore();

    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9005, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 候选 A: SUBMIT_TASK (曾执行过 2 次，受覆盖惩罚，原本得分为 1.915)
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    // 候选 B: POLL_STATUS (未执行过，处于 GENERATING 关键异步态，原本得分为 2.80)
    const frontierPoll = createFrontier(generatingState, 'POLL_STATUS');

    const historyCounts = new Map<string, number>([
      [`${frontierSubmit.fromKey}->SUBMIT_TASK`, 2],
      [`${frontierPoll.fromKey}->POLL_STATUS`, 0],
    ]);

    // Round 1: 无经验时，由于 SUBMIT_TASK 受覆盖惩罚压制，POLL_STATUS 排在第 1 名
    const rankedRound1 = policy.evaluateAndRank(
      [frontierSubmit, frontierPoll],
      historyCounts,
      store.getExperiences('real')
    );
    expect(rankedRound1[0].frontier.candidateAction.type).toBe('POLL_STATUS');
    expect(rankedRound1[1].frontier.candidateAction.type).toBe('SUBMIT_TASK');

    // 现在向真实 Store 注入由于 SUBMIT_TASK 暴露出的真实资损缺陷经验 (加成 +1.30)
    store.record(
      {
        experienceId: 'exp_real_001',
        discoveredTransitionId: 'trans_001',
        discoveredAnomaly: 'SUBMIT_TASK_DOUBLE_BILLING',
        causalChain: ['UNSUBMITTED', 'SUBMIT_TASK', 'FAILED'],
        policyDirectives: {
          boostMultiplier: 3.5,
          mandatoryInvariants: ['antiDoubleBilling'],
          priorityStatesToExplore: [frontierSubmit.fromKey],
        },
        confidence: 0.98,
        createdAt: Date.now(),
      },
      'real'
    );

    // Round 2: 重新评估
    const rankedRound2 = policy.evaluateAndRank(
      [frontierSubmit, frontierPoll],
      historyCounts,
      store.getExperiences('real')
    );

    // 核心断言：Top Pick 发生真实倒置！SUBMIT_TASK 因缺陷强化跃升至第 1 名！
    expect(rankedRound2[0].frontier.candidateAction.type).toBe('SUBMIT_TASK');
    expect(rankedRound2[0].rationale).toContain('[历史经验强化]');
  });

  it('3. MOCK 主链执行隔离：MOCK 模式运行绝对不向真实生产 Store 写入任何数据', async () => {
    const store = new PanquLearningStore();
    const runner = new PanquExplorationRunner(store);

    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 9999,
      mode: 'mock',
      modelId: 84,
      mediaType: 'video',
      status: 'FAILED',
      points: 0,
      message: 'Mock execution',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: false,
      passed: false,
      taskId: 9999,
      modelId: 84,
      mediaType: 'video',
      verdict: 'FAIL',
      status: 'FAILED',
      reasons: ['Mock failure'],
      evidence: {
        session: { status: 'AUTHENTICATED', tokenPresent: true },
        task: { status: 'FAIL' },
        media: { status: 'FAIL', source: 'mock', ownership: 'UNVERIFIED' },
        billing: { status: 'FAIL', source: 'mock' },
        invariants: { status: 'FAIL' },
      },
      mode: 'mock',
    } as any);

    // 以 mode === 'mock' 运行
    await runner.run({
      candidate: sampleSubmitCandidate,
      mode: 'mock',
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 核心断言：真实生产 Store 100% 保持为空
    expect(store.getExperiences('real').length).toBe(0);
  });

  it('4. 错误经验防失控：同一失败重复发生不会导致经验库无限膨胀，且权重有确定数学天花板', async () => {
    const store = new PanquLearningStore();
    const runner = new PanquExplorationRunner(store);

    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 7702,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      points: 70,
      message: '提交成功',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: false,
      passed: false,
      taskId: 7702,
      modelId: 84,
      mediaType: 'video',
      verdict: 'FAIL',
      status: 'FAILED',
      reasons: ['[FP-004] 持续发生的计费防重扣违背'],
      evidence: {
        session: { status: 'AUTHENTICATED', tokenPresent: true },
        task: { status: 'PASS' },
        media: { status: 'UNVERIFIED', source: 'local', ownership: 'UNVERIFIED' },
        billing: { status: 'FAIL', source: 'remote_api' },
        invariants: { status: 'FAIL', antiDoubleBilling: false },
      },
      mode: 'real',
    } as any);

    // 连续重复执行 5 次相同的失败
    for (let i = 0; i < 5; i++) {
      await runner.run({
        candidate: sampleSubmitCandidate,
        mode: 'real',
        executeFn: executeSpy,
        verifyFn: verifySpy,
      });
    }

    // 核心断言 1：Store 内置去重，经验条目保持为 1，杜绝无意义膨胀
    expect(store.getExperiences('real').length).toBe(1);

    // 核心断言 2：Policy 计算中的 historicalFailure 严格遵守 Math.min(1.5, ...) 天花板
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    const scored = policy.evaluateAndRank([frontierSubmit], new Map(), store.getExperiences('real'));
    expect(scored[0].breakdown.historicalFailure).toBeLessThanOrEqual(1.5);
  });

  it('5. 动态平衡：后续多次成功证据能够通过 AlreadyCovered 惩罚克服历史失败，防止永久锁死', () => {
    const store = new PanquLearningStore();

    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9005, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 注入一条历史缺陷经验 (+1.30 分)
    store.record(
      {
        experienceId: 'exp_defect_01',
        discoveredTransitionId: 'trans_old_fail',
        discoveredAnomaly: 'SUBMIT_TASK_INVARIANT_FAILED',
        causalChain: ['FAILED'],
        policyDirectives: {
          boostMultiplier: 3.0,
          mandatoryInvariants: ['netChargeZero'],
          priorityStatesToExplore: [unsubmittedState.session.status],
        },
        confidence: 0.98,
        createdAt: Date.now(),
      },
      'real'
    );

    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    const frontierPoll = createFrontier(generatingState, 'POLL_STATUS');

    // 在仅执行 1 次时，失败经验使 SUBMIT_TASK 领先 (得分为 3.65 vs POLL 2.80)
    const historyRound1 = new Map<string, number>([
      [`${frontierSubmit.fromKey}->SUBMIT_TASK`, 1],
      [`${frontierPoll.fromKey}->POLL_STATUS`, 0],
    ]);
    const rankedRound1 = policy.evaluateAndRank(
      [frontierSubmit, frontierPoll],
      historyRound1,
      store.getExperiences('real')
    );
    expect(rankedRound1[0].frontier.candidateAction.type).toBe('SUBMIT_TASK');

    // 假设经过修复后，该路径顺利完成了 15 次真实成功测试 (惩罚高达 2.20 分)
    const historyRound2 = new Map<string, number>([
      [`${frontierSubmit.fromKey}->SUBMIT_TASK`, 15],
      [`${frontierPoll.fromKey}->POLL_STATUS`, 0],
    ]);
    const rankedRound2 = policy.evaluateAndRank(
      [frontierSubmit, frontierPoll],
      historyRound2,
      store.getExperiences('real')
    );

    // 核心断言：由于执行了 15 次，AlreadyCovered 罚分达到 0.55 * log2(16) = 2.20 分，
    // 成功超越了 1.30 的历史缺陷加成，让位给尚未充分测试的其他动作！证明系统不会永久锁死！
    expect(rankedRound2[0].frontier.candidateAction.type).toBe('POLL_STATUS');
    expect(rankedRound2[1].frontier.candidateAction.type).toBe('SUBMIT_TASK');
    expect(rankedRound2[1].breakdown.alreadyCoveredPenalty).toBeGreaterThan(2.0);
  });

  it('6. Evidence Gap 严谨性：未证实的负向探测维持 Uncertainty 探索权重，绝不升级为 Confirmed Failure', async () => {
    const store = new PanquLearningStore();
    const runner = new PanquExplorationRunner(store);

    const negativeProbeCandidate: MutationCandidate = {
      ...sampleSubmitCandidate,
      id: 'cand_boundary_duration_0',
      executionReadiness: 'NEGATIVE_PROBE',
      steps: [
        {
          action: 'SUBMIT_TASK',
          description: '边界测试 0 秒',
          payload: { duration: 0, modelId: 84 },
        },
      ],
    };

    const executeSpy = vi.fn().mockResolvedValue({
      ok: false,
      taskId: 0,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'FAILED',
      points: 0,
      message: '视频时长超出下限1秒 [PARAM_OUT_OF_BOUNDS]',
    });

    const result = await runner.run({
      candidate: negativeProbeCandidate,
      mode: 'real',
      executeFn: executeSpy,
    });

    expect(result.status).toBe('NEGATIVE_PROBE_REJECTION_VERIFIED');
    expect(result.learnedExperiences).toBeDefined();
    expect(result.learnedExperiences!.length).toBe(1);

    const exp = result.learnedExperiences![0];
    // 核心断言 1：置信度明确低于 0.90，表明事实存在凭证缺口
    expect(exp.confidence).toBeLessThan(0.9);
    expect(exp.discoveredAnomaly).toContain('NEGATIVE_PROBE_ZERO_CHARGE_UNPROVEN_BY_LEDGER');

    // 核心断言 2：Policy 计算时提升的是 uncertainty，而非假冒为确诊缺陷
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    const scored = policy.evaluateAndRank([frontierSubmit], new Map(), [exp]);
    expect(scored[0].breakdown.uncertainty).toBeGreaterThanOrEqual(0.85);
  });
});
