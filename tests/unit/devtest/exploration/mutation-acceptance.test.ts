import { describe, expect, it } from 'vitest';
import {
  type EntityCompositeState,
} from '../../../../src/devtest/exploration/contracts.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import { PanquStateGraph, type UnverifiedFrontier } from '../../../../src/devtest/exploration/state-graph.js';
import { PanquConstraintEvaluator } from '../../../../src/devtest/exploration/constraint.js';
import { PanquExplorationPolicy } from '../../../../src/devtest/exploration/exploration-policy.js';
import { PanquMutationEngine } from '../../../../src/devtest/exploration/mutation.js';
import { BillingOracle, type ScoreLogEntry } from '../../../../src/devtest/billing.js';
import { inspectBufferMedia } from '../../../../src/devtest/media-inspector.js';

describe('Step 3 硬性业务验收：有目标的状态跃迁变异器 (Targeted Mutation Engine)', () => {
  const actionSpace = new PanquActionSpace();
  const constraintEvaluator = new PanquConstraintEvaluator();
  const mutationEngine = new PanquMutationEngine(constraintEvaluator);

  // 构造标准的高危 Frontier 实体：处于生成中且已预扣款，目标动作 CANCEL_TASK
  function getSampleGeneratingFrontier(): UnverifiedFrontier {
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9100, durationSeconds: 4, modelId: 84 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const cancelAction = actionSpace.getAction('CANCEL_TASK')!;

    return {
      frontierId: 'frontier_generating_cancel_01',
      fromKey: 'task:GENERATING|billing:RESERVED',
      fromState: generatingState,
      candidateAction: cancelAction,
      riskScore: 0.95,
      reason: '未经验证的高危取消跃迁',
      inferredTargetStates: ['task:CANCELLED|billing:CHARGED (High Risk Defect)'],
      proposedScenario: [],
    };
  }

  it('Gate 1: 时序变异 —— 成功生成关键倒置与二次轮询时序，且满足约束检查', () => {
    const frontier = getSampleGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);

    const temporalMutations = mutations.filter((m) => m.mutationType === 'TEMPORAL');
    expect(temporalMutations.length).toBeGreaterThanOrEqual(2);

    // 变异 A: SUBMIT -> CANCEL -> POLL (立即取消)
    const immCancel = temporalMutations.find((m) =>
      m.steps.map((s) => s.action).slice(0, 3).join('->') === 'SUBMIT_TASK->CANCEL_TASK->POLL_STATUS'
    );
    expect(immCancel).toBeDefined();
    expect(immCancel!.constraintEvaluation.satisfied).toBe(true);

    // 变异 B: SUBMIT -> POLL -> CANCEL -> POLL (取消后再轮询，验证终态不可变性)
    const pollAfterCancel = temporalMutations.find((m) =>
      m.steps.map((s) => s.action).slice(0, 4).join('->') === 'SUBMIT_TASK->POLL_STATUS->CANCEL_TASK->POLL_STATUS'
    );
    expect(pollAfterCancel).toBeDefined();
    expect(pollAfterCancel!.constraintEvaluation.satisfied).toBe(true);
  });

  it('Gate 2: 参数边界 —— 针对真实 Panqu duration 精确标定有效与无效边界，不伪装非法参数', () => {
    const frontier = getSampleGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);

    const boundaryMutations = mutations.filter((m) => m.mutationType === 'BOUNDARY');
    expect(boundaryMutations.length).toBe(4);

    // 验证有效边界 (1秒与60秒)
    const validBoundaries = boundaryMutations.filter((m) => m.boundaryValidity === 'VALID_BOUNDARY');
    expect(validBoundaries.length).toBe(2);
    expect(validBoundaries.every((b) => b.constraintEvaluation.satisfied)).toBe(true);

    // 验证非法边界 (0秒与61秒)
    const invalidBoundaries = boundaryMutations.filter((m) => m.boundaryValidity === 'INVALID_BOUNDARY');
    expect(invalidBoundaries.length).toBe(2);
    expect(invalidBoundaries.every((b) => !b.constraintEvaluation.satisfied)).toBe(true);
    expect(invalidBoundaries[0].constraintEvaluation.violations[0]).toContain('PARAM_OUT_OF_BOUNDS');
  });

  it('Gate 3: 竞态变异 —— 正确表达并发候选关系，显式标记 race candidate，绝不伪装完成真实并发', () => {
    const frontier = getSampleGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);

    const raceMutations = mutations.filter((m) => m.mutationType === 'RACE');
    expect(raceMutations.length).toBeGreaterThanOrEqual(2);

    const pollCancelRace = raceMutations.find((m) => m.name.includes('POLL || CANCEL'));
    expect(pollCancelRace).toBeDefined();
    expect(pollCancelRace!.isRaceCandidate).toBe(true); // 显式标记为竞态候选

    // 验证包含了具备同一并发分组 (concurrentGroup) 的步骤
    const concurrentSteps = pollCancelRace!.steps.filter((s) => s.concurrentGroup !== undefined);
    expect(concurrentSteps.length).toBe(2);
    expect(concurrentSteps.map((s) => s.action)).toEqual(['POLL_STATUS', 'CANCEL_TASK']);
    expect(concurrentSteps[0].description).toContain('[RACE CANDIDATE]');
  });

  it('Gate 4: 因果可解释 —— 每个变异候选必须具备完整的意图、风险与预期观察声明', () => {
    const frontier = getSampleGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);

    expect(mutations.length).toBeGreaterThan(0);

    for (const m of mutations) {
      expect(m.id).toBeTruthy();
      expect(m.targetFrontierId).toBe(frontier.frontierId);
      expect(m.mutationType).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.intent).toBeTruthy();
      expect(m.intent.length).toBeGreaterThan(10); // 必须有详尽的业务解释
      expect(m.expectedRisk).toBeTruthy();
      expect(m.expectedObservation).toBeTruthy();
      expect(m.steps.length).toBeGreaterThan(0);
    }
  });

  it('Gate 5: Oracle 不可污染 —— 严谨证明变异过程绝对不篡改计费不变量与媒体质检真值', () => {
    // 1. 验证刊例扣费基准计算未受污染
    const expectedPointsBefore = BillingOracle.calculateExpectedPoints({
      mediaType: 'video',
      modelId: 84,
      duration: 4,
      resolution: '720p',
    });
    expect(expectedPointsBefore).toBe(56); // 14 * 4 = 56

    // 执行变异生成
    const frontier = getSampleGeneratingFrontier();
    mutationEngine.generateMutations(frontier);

    const expectedPointsAfter = BillingOracle.calculateExpectedPoints({
      mediaType: 'video',
      modelId: 84,
      duration: 4,
      resolution: '720p',
    });
    expect(expectedPointsAfter).toBe(56);

    // 2. 验证财务不变量判定标准绝对没有被放宽：
    // 取消任务若只有扣费流水没有退款流水，必须严格判定为 FAIL (reconciled = false, netChargeZero = false)
    const brokenCancelLogs: ScoreLogEntry[] = [{ task_id: 9100, type: 2, score: -56 }];
    const auditResult = BillingOracle.reconcileTaskLedger({
      taskId: 9100,
      expectedPoints: 56,
      terminalStatus: 'FAILED',
      scoreLogs: brokenCancelLogs,
    });
    expect(auditResult.passed).toBe(false);
    expect(auditResult.status).toBe('FAIL');
    expect(auditResult.netChargeZero).toBe(false);
    expect(auditResult.missingRefund).toBe(true);
    expect(auditResult.netDeductedPoints).toBe(56); // 净扣费未清零，不可伪造 PASS

    // 3. 验证媒体容器二进制检验依然保持 Fail-closed
    const emptyBuffer = Buffer.alloc(16);
    const mediaResult = inspectBufferMedia(emptyBuffer, 'video');
    expect(mediaResult.containerIdentified).toBe(false);
    expect(mediaResult.decodable).toBe(false);
    expect(mediaResult.qualityClassification).toBe('FILE_INVALID');
  });

  it('端到端集成验收：从 StateGraph -> Policy 决策 -> Mutation 生成有目标变异的全链路闭环', () => {
    const graph = new PanquStateGraph();
    const policy = new PanquExplorationPolicy(constraintEvaluator);

    // 1. 真实 StateGraph 记录已有正常执行
    const authedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'UNSUBMITTED' },
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9200, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const completedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'COMPLETED', taskId: 9200, durationSeconds: 4 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'VERIFIED', atomsFound: ['ftyp', 'moov', 'mdat'], ownershipVerified: true },
      observedAt: Date.now(),
    };

    graph.observeTransition(authedState, 'SUBMIT_TASK', {}, generatingState);
    graph.observeTransition(generatingState, 'POLL_STATUS', {}, completedState);

    // 2. 探寻未验证前沿 (Frontiers)
    const frontiers = graph.findUnverifiedFrontiers(actionSpace);

    // 3. ExplorationPolicy 评估并排序选出最佳 Top Pick
    const rankedFrontiers = policy.evaluateAndRank(frontiers);
    expect(rankedFrontiers.length).toBeGreaterThan(0);

    const selectedFrontier = rankedFrontiers[0];
    expect(selectedFrontier.frontier.candidateAction.type).toBe('CANCEL_TASK');
    expect(selectedFrontier.frontier.fromState.task.status).toBe('GENERATING');

    // 4. Mutation 引擎消费 Selected Frontier 生成全套变异候选
    const mutations = mutationEngine.generateMutations(selectedFrontier);

    // 验证产生了 5 类有业务目的的变异候选
    const typesFound = new Set(mutations.map((m) => m.mutationType));
    expect(typesFound.has('BOUNDARY')).toBe(true);
    expect(typesFound.has('TEMPORAL')).toBe(true);
    expect(typesFound.has('RACE')).toBe(true);
    expect(typesFound.has('RETRY')).toBe(true);
    expect(typesFound.has('TIMING')).toBe(true);

    // 验证针对该 Frontier 的代表性生成链路：
    // 1) 取消后生命周期锁死：SUBMIT -> POLL -> CANCEL -> POLL
    const temporalCase = mutations.find(
      (m) => m.name.includes('取消后继续轮询')
    );
    expect(temporalCase).toBeDefined();
    expect(temporalCase?.intent).toContain('生命周期一致性');

    // 2) 超时与重试取消复合账务：SUBMIT -> TIMEOUT -> RETRY -> CANCEL -> AUDIT_BILLING
    const retryCase = mutations.find(
      (m) => m.name.includes('超时-重试-取消复合链路')
    );
    expect(retryCase).toBeDefined();
    expect(retryCase?.steps.map((s) => s.action)).toEqual([
      'SUBMIT_TASK',
      'INJECT_TIMEOUT',
      'RETRY_TASK',
      'CANCEL_TASK',
      'AUDIT_BILLING',
    ]);
  });
});
