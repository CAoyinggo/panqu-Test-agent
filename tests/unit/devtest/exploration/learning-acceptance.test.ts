import { describe, expect, it, vi } from 'vitest';
import {
  type EntityCompositeState,
  type LearningExperience,
} from '../../../../src/devtest/exploration/contracts.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import {
  PanquStateGraph,
  type UnverifiedFrontier,
} from '../../../../src/devtest/exploration/state-graph.js';
import { PanquConstraintEvaluator } from '../../../../src/devtest/exploration/constraint.js';
import { PanquExplorationPolicy } from '../../../../src/devtest/exploration/exploration-policy.js';
import { PanquMutationEngine } from '../../../../src/devtest/exploration/mutation.js';
import {
  PanquExplorationRunner,
  type MutationRunResult,
} from '../../../../src/devtest/exploration/runner.js';
import {
  PanquLearningStore,
  extractLearningExperiences,
  buildActionHistoryCounts,
  feedResultIntoLearning,
} from '../../../../src/devtest/exploration/learning.js';

describe('Step 5 硬性验收：真实结果 → Learning → Exploration Policy 自进化闭环', () => {
  const actionSpace = new PanquActionSpace();
  const constraintEvaluator = new PanquConstraintEvaluator();
  const policy = new PanquExplorationPolicy(constraintEvaluator);
  const mutationEngine = new PanquMutationEngine();
  const runner = new PanquExplorationRunner();

  // 辅助构造测试 Frontier
  function createFrontier(
    fromState: EntityCompositeState,
    actionType: any,
    inferredTargetStates: string[] = ['state:NORMAL']
  ): UnverifiedFrontier {
    const action = actionSpace.getAction(actionType)!;
    return {
      frontierId: `f_${actionType}_${Math.random().toString(36).slice(2, 6)}`,
      fromKey: `session:${fromState.session.status}|task:${fromState.task.status}|billing:${fromState.billing.status}|artifacts:${fromState.artifacts.status}`,
      fromState,
      candidateAction: action,
      riskScore: action.baseRisk,
      reason: 'frontier_for_learning_test',
      inferredTargetStates,
      proposedScenario: [],
    };
  }

  // 基础认证且未提交状态
  const unsubmittedState: EntityCompositeState = {
    session: { status: 'AUTHENTICATED' },
    task: { status: 'UNSUBMITTED' },
    billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
    artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
    observedAt: Date.now(),
  };

  // 生成中复合状态
  const generatingState: EntityCompositeState = {
    session: { status: 'AUTHENTICATED' },
    task: { status: 'GENERATING', taskId: 9020, durationSeconds: 5 },
    billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
    artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
    observedAt: Date.now(),
  };

  it('Test 1: 真实执行与验证结果 → LearningExperience 因果经验提取', async () => {
    // 构造一个包含真实物理失败证据的 MutationRunResult
    const mockRunResult: MutationRunResult = {
      ok: false,
      candidateId: 'cand_submit_double_billing_01',
      status: 'EXECUTABLE_VERIFIED',
      mode: 'real',
      executionReadiness: 'EXECUTABLE',
      executeResult: {
        ok: true,
        taskId: 9021,
        mode: 'real',
        modelId: 84,
        mediaType: 'video',
        status: 'SUCCESS',
        points: 70,
        message: '提交成功',
      },
      verifyResult: {
        ok: false,
        passed: false,
        taskId: 9021,
        modelId: 84,
        mediaType: 'video',
        verdict: 'FAIL',
        status: 'FAILED',
        reasons: ['[FP-004] 计费防重扣违背：检测到 2 笔预扣款记录，存在严重资损风险'],
        evidence: {
          session: { status: 'AUTHENTICATED', tokenPresent: true },
          task: { status: 'PASS' },
          media: { status: 'UNVERIFIED', source: 'local', ownership: 'UNVERIFIED' },
          billing: {
            status: 'FAIL',
            source: 'remote_api',
            netDeductedPoints: 140,
            preDeductedPoints: 140,
            reason: '防重扣违背',
          },
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
      } as any,
      observedTransition: {
        id: 'trans_fail_9021',
        fromKey: 'session:AUTHENTICATED|task:UNSUBMITTED|billing:UNBILLED|artifacts:NONE',
        fromState: unsubmittedState,
        actionType: 'SUBMIT_TASK',
        actionPayload: { duration: 5, modelId: 84 },
        toKey: 'session:AUTHENTICATED|task:COMPLETED|billing:INCONSISTENT|artifacts:NONE',
        toState: {
          ...unsubmittedState,
          task: { status: 'COMPLETED', taskId: 9021 },
          billing: { status: 'INCONSISTENT', netPointsDeducted: 140, recordCount: 2 },
          observedAt: Date.now(),
        },
        historyCount: 1,
        lastObserved: Date.now(),
        invariantsChecked: ['antiDoubleBilling'],
        anomaliesDetected: ['BILLING_INCONSISTENCY_DETECTED'],
      },
      message: '正向变异执行与验证完成 (taskId: #9021, passed: false)',
    };

    // 提取经验
    const experiences = extractLearningExperiences(mockRunResult, { mode: 'real' });

    expect(experiences.length).toBe(1);
    const exp = experiences[0];

    // 断言经验完全基于真实失败事实
    expect(exp.discoveredTransitionId).toBe('trans_fail_9021');
    expect(exp.discoveredAnomaly).toContain('SUBMIT_TASK');
    expect(exp.discoveredAnomaly).toContain('BILLING_INCONSISTENCY_DETECTED');
    expect(exp.causalChain).toContain('SUBMIT_TASK');
    expect(exp.causalChain.some((c) => c.includes('FP-004'))).toBe(true);
    expect(exp.policyDirectives.boostMultiplier).toBe(3.0);
    expect(exp.policyDirectives.mandatoryInvariants).toContain('antiDoubleBilling');
    expect(exp.confidence).toBe(0.98);
  });

  it('Test 2: expectedObservation 防投毒隔离 —— 虚假预期绝不污染 LearningExperience', async () => {
    // 构造一个被恶意植入虚假预期的 MutationCandidate
    const poisonedCandidate = {
      id: 'cand_poisoned_001',
      name: 'poisoned_candidate',
      sourceFrontierId: 'frontier_test_01',
      targetFrontierId: 'frontier_test_01',
      isRaceCandidate: false,
      constraintEvaluation: {
        satisfied: true,
        stateFeasible: true,
        payloadValid: true,
        checkedConstraints: [],
        violations: [],
      },
      mutationType: 'BOUNDARY' as const,
      intent: '恶意植入虚假经验测试',
      expectedRisk: '0.05',
      // 恶意虚假声明：声称账单已退款且产物已验证
      expectedObservation:
        'task:SUCCESS|billing:REFUNDED_ZERO_CHARGE_PROVEN|artifacts:ALL_ATOMS_VERIFIED_CLEAN|fakeInjectRule:ALWAYS_PASS_FOREVER',
      steps: [
        {
          action: 'SUBMIT_TASK' as const,
          description: '提交任务',
          payload: { duration: 5, modelId: 84 },
        },
      ],
      executionReadiness: 'EXECUTABLE' as const,
    };

    // 真实执行与验证（真实结果为媒体缺失失败）
    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 9022,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      points: 70,
    });
    const verifySpy = vi.fn().mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      status: 'FAILED',
      reasons: ['[FP-002] 媒体产物丢失，无有效原子'],
      evidence: {
        session: { status: 'AUTHENTICATED', tokenPresent: true },
        task: { taskId: 9022, status: 'PASS' },
        media: { status: 'FAIL', source: 'local', ownership: 'UNVERIFIED' },
        billing: { status: 'VERIFIED', source: 'remote_api' },
      },
      businessValidation: {
        businessSuccess: false,
        status: 'FAIL',
        reasons: ['产物损坏'],
        failedInvariants: ['mediaFormatValid'],
      },
    });

    const runResult = await runner.run({
      candidate: poisonedCandidate,
      mode: 'real',
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    const experiences = extractLearningExperiences(runResult, { mode: 'real' });
    expect(experiences.length).toBe(1);
    const exp = experiences[0];

    // 强断言：虚假预期中的任何关键词均不存在于生成的因果经验中！
    const serializedExp = JSON.stringify(exp);
    expect(serializedExp).not.toContain('REFUNDED_ZERO_CHARGE_PROVEN');
    expect(serializedExp).not.toContain('ALL_ATOMS_VERIFIED_CLEAN');
    expect(serializedExp).not.toContain('fakeInjectRule');
    expect(serializedExp).not.toContain('ALWAYS_PASS_FOREVER');

    // 真实经验严格反映物理失败事实
    expect(serializedExp).toContain('FP-002');
    expect(serializedExp).toContain('mediaFormatValid');
  });

  it('Test 3: Confirmed Failure → Policy 自进化反哺 —— 经验改变下一轮候选评分与决策', () => {
    const store = new PanquLearningStore();

    // 候选 A: SUBMIT_TASK (正常提交)
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    // 候选 B: AUTHENTICATE (认证检查)
    const frontierAuth = createFrontier(unsubmittedState, 'AUTHENTICATE');

    // 第一轮策略评估（此时没有任何历史缺陷经验）
    const initialRanked = policy.evaluateAndRank(
      [frontierSubmit, frontierAuth],
      new Map(),
      store.getExperiences('real')
    );

    const initialSubmitScore = initialRanked.find(
      (s) => s.frontier.candidateAction.type === 'SUBMIT_TASK'
    )!;
    expect(initialSubmitScore.breakdown.historicalFailure).toBe(0.0);
    expect(initialSubmitScore.rationale).not.toContain('[历史经验强化]');

    // 模拟一次真实执行发现了严重资损 Bug (SUBMIT_TASK 导致重扣)
    const realDefectExperience: LearningExperience = {
      experienceId: 'exp_real_double_billing_01',
      discoveredTransitionId: 'trans_real_fail_1',
      discoveredAnomaly: 'SUBMIT_TASK_ANTI_DOUBLE_BILLING_VIOLATION',
      causalChain: ['UNSUBMITTED', 'SUBMIT_TASK', 'FAILED', 'FP-004 重扣资损'],
      policyDirectives: {
        boostMultiplier: 3.5, // 强加成
        mandatoryInvariants: ['antiDoubleBilling'],
        priorityStatesToExplore: [frontierSubmit.fromKey],
      },
      confidence: 1.0,
      createdAt: Date.now(),
    };

    // 存入学习库
    store.record(realDefectExperience, 'real');

    // 第二轮策略评估（注入学习到的真实缺陷经验）
    const updatedRanked = policy.evaluateAndRank(
      [frontierSubmit, frontierAuth],
      new Map(),
      store.getExperiences('real')
    );

    const updatedSubmitScore = updatedRanked.find(
      (s) => s.frontier.candidateAction.type === 'SUBMIT_TASK'
    )!;

    // 核心断言：SUBMIT_TASK 获得了历史经验加成，总分上涨，依据中出现强化标识
    expect(updatedSubmitScore.breakdown.historicalFailure).toBeGreaterThan(1.0);
    expect(updatedSubmitScore.totalScore).toBeGreaterThan(initialSubmitScore.totalScore);
    expect(updatedSubmitScore.rationale).toContain('[历史经验强化]');
  });

  it('Test 4: AlreadyCovered 惩罚真实生效 —— 从 StateGraph 读取真实频次消除无意义刷绿', () => {
    const graph = new PanquStateGraph();
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');

    // 第一轮：尚未执行任何跃迁 (0 次)
    const history1 = buildActionHistoryCounts(graph);
    expect(history1.get(`${frontierSubmit.fromKey}->SUBMIT_TASK`) ?? 0).toBe(0);

    const rankedRound1 = policy.evaluateAndRank([frontierSubmit], history1);
    expect(rankedRound1[0].breakdown.novelty).toBe(1.0);
    expect(rankedRound1[0].breakdown.alreadyCoveredPenalty).toBe(0.0);
    expect(rankedRound1[0].rationale).toContain('[未知优先]');

    // 执行并记录跃迁到真实 StateGraph
    const toCompletedState: EntityCompositeState = {
      ...unsubmittedState,
      task: { status: 'COMPLETED', taskId: 9023 },
      billing: { status: 'CHARGED', netPointsDeducted: 70, recordCount: 1 },
      artifacts: { status: 'VERIFIED', atomsFound: ['mdat'], ownershipVerified: true },
      observedAt: Date.now(),
    };
    graph.observeTransition(
      unsubmittedState,
      'SUBMIT_TASK',
      { duration: 5, modelId: 84 },
      toCompletedState,
      ['allInvariantsPassed']
    );

    // 第二轮：从 StateGraph 读取累加历史频次
    const history2 = buildActionHistoryCounts(graph);
    expect(history2.get(`${frontierSubmit.fromKey}->SUBMIT_TASK`)).toBe(1);

    const rankedRound2 = policy.evaluateAndRank([frontierSubmit], history2);

    // 核心断言：AlreadyCovered 惩罚生效，Novelty 下降，依据中明确声明已覆盖惩罚
    expect(rankedRound2[0].breakdown.alreadyCoveredPenalty).toBeGreaterThan(0.5);
    expect(rankedRound2[0].breakdown.novelty).toBeLessThan(1.0);
    expect(rankedRound2[0].totalScore).toBeLessThan(rankedRound1[0].totalScore);
    expect(rankedRound2[0].rationale).toContain('[已覆盖惩罚]');
  });

  it('Test 5: Evidence Gap (Negative Probe) —— 凭证缺口不被粉饰为确认安全，提升不确定性与探索权重', async () => {
    // 构造 Negative Probe 执行结果：网关拦截，但账单流水未证明 (zeroChargeProven = false)
    const negativeProbeResult: MutationRunResult = {
      ok: true, // 网关防御成功
      candidateId: 'cand_boundary_duration_0',
      status: 'NEGATIVE_PROBE_REJECTION_VERIFIED',
      mode: 'real',
      executionReadiness: 'NEGATIVE_PROBE',
      executeResult: {
        ok: false,
        taskId: 0,
        mode: 'real',
        modelId: 84,
        mediaType: 'video',
        status: 'FAILED',
        points: 0,
        message: '视频时长超出下限1秒 [PARAM_OUT_OF_BOUNDS]',
      },
      rejectionEvidence: {
        gatewayRejected: true,
        taskIdZero: true,
        rejectionMessage: 'PARAM_OUT_OF_BOUNDS',
        zeroChargeProven: false, // 核心：尚未由账单流水证实绝对零扣费
      },
      observedTransition: {
        id: 'trans_neg_001',
        fromKey: 'session:AUTHENTICATED|task:UNSUBMITTED|billing:UNBILLED|artifacts:NONE',
        fromState: unsubmittedState,
        actionType: 'SUBMIT_TASK',
        actionPayload: { duration: 0, modelId: 84 },
        toKey: 'session:AUTHENTICATED|task:UNSUBMITTED|billing:UNBILLED|artifacts:NONE',
        toState: unsubmittedState,
        historyCount: 1,
        lastObserved: Date.now(),
        invariantsChecked: [
          'NEGATIVE_PROBE_REJECTED_AT_GATEWAY',
          'BILLING_ZERO_CHARGE_UNPROVEN_BY_LEDGER',
        ],
        anomaliesDetected: [],
      },
      message: '负向非法参数探测通过：网关成功拦截',
    };

    // 提取经验
    const experiences = extractLearningExperiences(negativeProbeResult, { mode: 'real' });
    expect(experiences.length).toBe(1);
    const exp = experiences[0];

    // 断言：绝不标记为确诊安全，而是如实记录未证实凭证缺口
    expect(exp.discoveredAnomaly).toContain('NEGATIVE_PROBE_ZERO_CHARGE_UNPROVEN_BY_LEDGER');
    expect(exp.confidence).toBeLessThan(0.9); // 0.85 (表示凭证未完全确凿)
    expect(exp.policyDirectives.mandatoryInvariants).toContain('ledgerZeroChargeProof');

    // 检验反哺 Policy：存在凭证缺口时，该 Frontier 的 uncertainty 被显著提升到 >= 0.85
    const frontierSubmit = createFrontier(unsubmittedState, 'SUBMIT_TASK');
    const ranked = policy.evaluateAndRank([frontierSubmit], new Map(), [exp]);

    expect(ranked[0].breakdown.uncertainty).toBeGreaterThanOrEqual(0.85);
    expect(ranked[0].breakdown.historicalFailure).toBeGreaterThan(0.5);
  });

  it('Test 6: REAL 与 MOCK 隔离 —— MOCK 经验默认不写入真实学习库', async () => {
    const store = new PanquLearningStore();

    // 构造 MOCK 运行结果
    const mockResult: MutationRunResult = {
      ok: false,
      candidateId: 'cand_mock_test_01',
      status: 'EXECUTABLE_VERIFIED',
      mode: 'mock',
      executionReadiness: 'EXECUTABLE',
      executeResult: {
        ok: true,
        taskId: 8888,
        mode: 'mock',
        modelId: 84,
        mediaType: 'video',
        status: 'FAILED',
        points: 0,
        message: 'Mock execution failed',
      },
      verifyResult: {
        ok: false,
        passed: false,
        taskId: 8888,
        modelId: 84,
        mediaType: 'video',
        verdict: 'FAIL',
        status: 'FAILED',
        reasons: ['Mock 注入测试失败'],
        evidence: {
          session: { status: 'AUTHENTICATED', tokenPresent: true },
          task: { status: 'FAIL' },
          media: { status: 'FAIL', source: 'mock', ownership: 'UNVERIFIED' },
          billing: { status: 'FAIL', source: 'mock' },
          invariants: { status: 'FAIL' },
        },
        mode: 'mock',
      } as any,
      message: 'Mock 测试失败',
    };

    // 默认提取（未开放 allowMockLearning）
    const experiencesDefault = extractLearningExperiences(mockResult);
    expect(experiencesDefault.length).toBe(0); // 严格隔离：默认输出空

    // 即使在受控测试中允许提取 MOCK 经验，feedResultIntoLearning 也会存入 mock 分区
    feedResultIntoLearning(mockResult, store, { allowMockLearning: true });

    // 核心断言：真实生产经验库中仍然为空！
    expect(store.getExperiences('real').length).toBe(0);
    // MOCK 分区中存在记录
    expect(store.getExperiences('mock').length).toBe(1);
  });
});
