import { describe, expect, it, vi } from 'vitest';
import { PanquExplorationRunner } from '../../../../src/devtest/exploration/runner.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import { PanquConstraintEvaluator } from '../../../../src/devtest/exploration/constraint.js';
import { PanquMutationEngine } from '../../../../src/devtest/exploration/mutation.js';
import { PanquStateGraph } from '../../../../src/devtest/exploration/state-graph.js';
import { type EntityCompositeState } from '../../../../src/devtest/exploration/contracts.js';

describe('Step 4 硬性验收：探索执行接入器与最小执行闭环 (Exploration Runner Adapter)', () => {
  const actionSpace = new PanquActionSpace();
  const evaluator = new PanquConstraintEvaluator();
  const mutationEngine = new PanquMutationEngine(evaluator, actionSpace);
  const runner = new PanquExplorationRunner();

  function getBaseGeneratingFrontier() {
    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9500, durationSeconds: 4, modelId: 84 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    return {
      frontierId: 'frontier_runner_test',
      fromKey: 'task:GENERATING|billing:RESERVED',
      fromState: generatingState,
      candidateAction: actionSpace.getAction('SUBMIT_TASK')!,
      riskScore: 0.9,
      reason: 'runner_test',
      inferredTargetStates: [],
      proposedScenario: [],
    };
  }

  it('1. 正向 EXECUTABLE 变异：走通 execute() -> verify() 全闭环并将真实事实回写 StateGraph', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const validBoundary = mutations.find(
      (m) => m.mutationType === 'BOUNDARY' && m.boundaryValidity === 'VALID_BOUNDARY' && m.steps[0].payload.duration === 1
    );
    expect(validBoundary).toBeDefined();
    expect(validBoundary!.executionReadiness).toBe('EXECUTABLE');

    const graph = new PanquStateGraph();

    // 注入受控 execute 与 verify 实现，模拟真实返回契约
    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 9801,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'SUBMITTED',
      points: 14,
      message: '真实视频任务提交成功 (taskId: #9801)',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: true,
      passed: true,
      taskId: 9801,
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      verdict: 'PASS',
      billingAudit: 'AUDITED',
      evidence: {
        task: { status: 'PASS', source: 'live_polling', terminalStatus: 'SUCCESS', taskStatus: 2 },
        media: { status: 'PASS', source: 'TASK_SNAPSHOT', ownership: 'VERIFIED', format: 'mp4', atomsFound: ['ftyp', 'moov', 'mdat'] },
        billing: { status: 'PASS', source: 'auth_adminscore', netDeductedPoints: 14 },
        invariants: { status: 'PASS' },
      },
      billing: {
        ledgerEntries: [{ id: '1', type: 'PRE_DEDUCT', points: 14 }],
      },
      reasons: [],
    });

    const result = await runner.run({
      candidate: validBoundary!,
      mode: 'real',
      stateGraph: graph,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('EXECUTABLE_VERIFIED');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 84,
      duration: 1,
      mediaType: 'video',
      mode: 'real',
    }));

    // 验证调用了 verify 并传入真实的 taskId
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 9801,
      modelId: 84,
      duration: 1,
    }));

    // 验证 StateGraph 真实回写
    expect(result.observedTransition).toBeDefined();
    expect(graph.getAllTransitions().length).toBe(1);
    const transition = graph.getAllTransitions()[0];
    expect(transition.toState.task.status).toBe('COMPLETED');
    expect(transition.toState.task.taskId).toBe(9801);
    expect(transition.toState.billing.status).toBe('CHARGED');
    expect(transition.toState.billing.netPointsDeducted).toBe(14);
    expect(transition.toState.artifacts.status).toBe('VERIFIED');
  });

  it('2. 负向探测 duration=0：确保真实参数直达 execute()，不调用 verify(0)，不伪造 UNBILLED 证明', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const zeroBoundary = mutations.find(
      (m) => m.mutationType === 'BOUNDARY' && m.steps[0].payload.duration === 0
    );
    expect(zeroBoundary).toBeDefined();
    expect(zeroBoundary!.executionReadiness).toBe('NEGATIVE_PROBE');

    const graph = new PanquStateGraph();

    const executeSpy = vi.fn().mockResolvedValue({
      ok: false,
      taskId: 0,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'FAILED',
      points: 14,
      message: '视频时长不能小于1秒 [PARAM_OUT_OF_BOUNDS]',
    });

    const verifySpy = vi.fn();

    const result = await runner.run({
      candidate: zeroBoundary!,
      mode: 'real',
      stateGraph: graph,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 核心断言 1：duration=0 绝对没有被默认值覆盖为 4
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
      duration: 0,
      mode: 'real',
    }));

    // 核心断言 2：绝对禁止调用 verify(0)
    expect(verifySpy).not.toHaveBeenCalled();

    // 核心断言 3：负向安全判定成功 (网关成功防御拦截)
    expect(result.ok).toBe(true);
    expect(result.status).toBe('NEGATIVE_PROBE_REJECTION_VERIFIED');
    expect(result.rejectionEvidence?.gatewayRejected).toBe(true);
    expect(result.rejectionEvidence?.taskIdZero).toBe(true);
    expect(result.rejectionEvidence?.rejectionMessage).toContain('PARAM_OUT_OF_BOUNDS');

    // 核心断言 4：零扣费保持 Fail-closed，不得谎称已由账单流水证明
    expect(result.rejectionEvidence?.zeroChargeProven).toBe(false);

    // 核心断言 5：StateGraph 记录 UNSUBMITTED 与拦截异常，明确包含账单未由流水证明的警告
    expect(result.observedTransition).toBeDefined();
    expect(result.observedTransition?.toState.task.status).toBe('UNSUBMITTED');
    expect(result.observedTransition?.invariantsChecked).toContain('NEGATIVE_PROBE_REJECTED_AT_GATEWAY');
    expect(result.observedTransition?.invariantsChecked).toContain('BILLING_ZERO_CHARGE_UNPROVEN_BY_LEDGER');
  });

  it('3. 负向探测 duration=61：验证超限非法参数直达 execute() 且被网关拦截', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const overflowBoundary = mutations.find(
      (m) => m.mutationType === 'BOUNDARY' && m.steps[0].payload.duration === 61
    );
    expect(overflowBoundary).toBeDefined();
    expect(overflowBoundary!.executionReadiness).toBe('NEGATIVE_PROBE');

    const executeSpy = vi.fn().mockResolvedValue({
      ok: false,
      taskId: 0,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'FAILED',
      points: 854,
      message: '视频时长超出上限60秒 [PARAM_OUT_OF_BOUNDS]',
    });

    const verifySpy = vi.fn();

    const result = await runner.run({
      candidate: overflowBoundary!,
      mode: 'real',
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 核心断言：61 秒直达 execute
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
      duration: 61,
    }));
    expect(verifySpy).not.toHaveBeenCalled();
    expect(result.status).toBe('NEGATIVE_PROBE_REJECTION_VERIFIED');
    expect(result.rejectionEvidence?.taskIdZero).toBe(true);
  });

  it('4. 未证实动作候选 (CANCEL_TASK / INJECT_TIMEOUT)：绝对禁止发送请求，禁止写入 StateGraph', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const unsupportedTemporal = mutations.find(
      (m) => m.mutationType === 'TEMPORAL'
    );
    expect(unsupportedTemporal).toBeDefined();
    expect(unsupportedTemporal!.executionReadiness).toBe('BLOCKED_BY_UNSUPPORTED_ACTION');

    const graph = new PanquStateGraph();
    const executeSpy = vi.fn();
    const verifySpy = vi.fn();

    const result = await runner.run({
      candidate: unsupportedTemporal!,
      mode: 'real',
      stateGraph: graph,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 核心断言：完全不发起任何网络请求
    expect(executeSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe('BLOCKED_BY_UNSUPPORTED_ACTION');

    // 核心断言：未向 StateGraph 写入虚假跃迁
    expect(graph.getAllTransitions().length).toBe(0);
    expect(result.observedTransition).toBeUndefined();
  });

  it('5. expectedObservation 隔离：即便变异包含虚假预期，也绝不污染任何真实事实或 StateGraph', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const validBoundary = mutations.find(
      (m) => m.mutationType === 'BOUNDARY' && m.boundaryValidity === 'VALID_BOUNDARY'
    )!;

    // 恶意构造一个与物理世界完全矛盾的 expectedObservation
    const poisonedCandidate = {
      ...validBoundary,
      expectedObservation: 'POISONED_FAKE_OBSERVATION_THAT_NEVER_HAPPENED',
    };

    const graph = new PanquStateGraph();
    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 9999,
      mode: 'real',
      modelId: 84,
      mediaType: 'video',
      status: 'SUBMITTED',
      points: 56,
      message: '提交成功',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: true,
      passed: true,
      taskId: 9999,
      modelId: 84,
      mediaType: 'video',
      status: 'SUCCESS',
      verdict: 'PASS',
      billingAudit: 'AUDITED',
      evidence: {
        task: { status: 'PASS', terminalStatus: 'SUCCESS' },
        media: { status: 'PASS', format: 'mp4' },
        billing: { status: 'PASS', netDeductedPoints: 56 },
        invariants: { status: 'PASS' },
      },
      reasons: [],
    });

    const result = await runner.run({
      candidate: poisonedCandidate,
      mode: 'real',
      stateGraph: graph,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    // 验证投毒的 expectedObservation 绝未流入 execute 入参
    expect(JSON.stringify(executeSpy.mock.calls)).not.toContain('POISONED_FAKE_OBSERVATION');

    // 验证投毒的 expectedObservation 绝未流入 toState
    expect(JSON.stringify(result.observedTransition?.toState)).not.toContain('POISONED_FAKE_OBSERVATION');

    // 验证投毒内容未流入 StateGraph 任何节点
    const states = graph.getAllStates();
    expect(JSON.stringify(states)).not.toContain('POISONED_FAKE_OBSERVATION');
  });

  it('6. REAL 与 MOCK 隔离：mode === "mock" 且未授权记录时，绝不污染真实探索 StateGraph', async () => {
    const frontier = getBaseGeneratingFrontier();
    const mutations = mutationEngine.generateMutations(frontier);
    const validBoundary = mutations.find(
      (m) => m.mutationType === 'BOUNDARY' && m.boundaryValidity === 'VALID_BOUNDARY'
    )!;

    const realGraph = new PanquStateGraph();
    const executeSpy = vi.fn().mockResolvedValue({
      ok: true,
      taskId: 29555,
      mode: 'mock',
      isSimulated: true,
      modelId: 84,
      mediaType: 'video',
      status: 'SUBMITTED',
      points: 56,
      message: '[OFFLINE 离线仿真] 仅生成离线模拟 ID',
    });

    const verifySpy = vi.fn().mockResolvedValue({
      ok: true,
      passed: true,
      taskId: 29555,
      status: 'SUCCESS',
      verdict: 'PASS',
      evidence: {
        task: { status: 'PASS', terminalStatus: 'SUCCESS' },
        media: { status: 'PASS' },
        billing: { status: 'PASS', netDeductedPoints: 56 },
        invariants: { status: 'PASS' },
      },
      reasons: [],
    });

    const result = await runner.run({
      candidate: validBoundary,
      mode: 'mock',
      stateGraph: realGraph,
      executeFn: executeSpy,
      verifyFn: verifySpy,
    });

    expect(result.mode).toBe('mock');
    expect(result.status).toBe('EXECUTABLE_VERIFIED');

    // 核心断言：未授权的 Mock 运行，绝不向 realGraph 写入任何跃迁事实
    expect(realGraph.getAllTransitions().length).toBe(0);
    expect(result.observedTransition).toBeUndefined();
  });
});
