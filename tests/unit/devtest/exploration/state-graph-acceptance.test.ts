import { describe, expect, it } from 'vitest';
import { type EntityCompositeState } from '../../../../src/devtest/exploration/contracts.js';
import { PanquActionSpace } from '../../../../src/devtest/exploration/action-space.js';
import { PanquStateGraph } from '../../../../src/devtest/exploration/state-graph.js';

describe('Step 1 硬性业务验收：运行时事实图与高危未知跃迁发现 (StateGraph + ActionSpace)', () => {
  const actionSpace = new PanquActionSpace();

  it('1. 能够基于真实执行事实动态沉淀状态节点与跃迁拓扑', () => {
    const graph = new PanquStateGraph();

    // 初始状态：已认证、未提交
    const state0: EntityCompositeState = {
      session: { status: 'AUTHENTICATED', userId: 'user_dev_01', cookiePresent: true },
      task: { status: 'UNSUBMITTED' },
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 执行提交后：处理中、已预扣 28 点
    const state1: EntityCompositeState = {
      session: { status: 'AUTHENTICATED', userId: 'user_dev_01', cookiePresent: true },
      task: { status: 'GENERATING', taskId: 9001, durationSeconds: 4, modelId: 84 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1, lastLogType: 2 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    // 执行轮询完成后：成功、实扣完成、MP4 完整
    const state2: EntityCompositeState = {
      session: { status: 'AUTHENTICATED', userId: 'user_dev_01', cookiePresent: true },
      task: { status: 'COMPLETED', taskId: 9001, durationSeconds: 4, modelId: 84 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1, lastLogType: 2 },
      artifacts: {
        status: 'VERIFIED',
        atomsFound: ['ftyp', 'moov', 'mdat'],
        ownershipVerified: true,
        mediaUrl: 'https://cdn.panqu.example/videos/9001.mp4',
      },
      observedAt: Date.now(),
    };

    // 记录正常主链路跃迁
    const trans1 = graph.observeTransition(state0, 'SUBMIT_TASK', { duration: 4 }, state1, ['prechargeSuccess']);
    const trans2 = graph.observeTransition(state1, 'POLL_STATUS', { taskId: 9001 }, state2, [
      'taskStatusSuccess',
      'mediaVerified',
    ]);

    expect(trans1.historyCount).toBe(1);
    expect(trans2.historyCount).toBe(1);
    expect(graph.getAllStates().length).toBe(3);
    expect(graph.getAllTransitions().length).toBe(2);

    // 再次观察同类跃迁，historyCount 累加，非静态字典
    graph.observeTransition(state0, 'SUBMIT_TASK', { duration: 4 }, state1);
    expect(trans1.historyCount).toBe(2);
  });

  it('2. 能够敏锐识别复合业务状态中的不变量违规（异常复合态）', () => {
    const graph = new PanquStateGraph();

    // 异态 A：任务已取消，但账务发生实扣且净扣费 > 0 (漏退款缺陷)
    const brokenCancelState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'CANCELLED', taskId: 9002 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const anomaliesA = graph.detectAnomalies(brokenCancelState);
    expect(anomaliesA).toContain('CANCELLED_TASK_CHARGED_WITHOUT_REFUND');

    // 异态 B：任务声明 COMPLETED，但视频产物丢失
    const missingMediaState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'COMPLETED', taskId: 9003 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'MISSING', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };
    const anomaliesB = graph.detectAnomalies(missingMediaState);
    expect(anomaliesB).toContain('COMPLETED_TASK_MISSING_ARTIFACT');
  });

  it('3. 【硬性验收核心】面对既有正常测试链路，能自动计算并指出“未充分验证的高危状态跃迁”并生成可执行场景', () => {
    const graph = new PanquStateGraph();

    // 预置系统已有的测试覆盖历史：只测试过顺利走通的主流程
    const authedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'UNSUBMITTED' },
      billing: { status: 'UNBILLED', netPointsDeducted: 0, recordCount: 0 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    const generatingState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'GENERATING', taskId: 9004, durationSeconds: 4 },
      billing: { status: 'RESERVED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'NONE', atomsFound: [], ownershipVerified: false },
      observedAt: Date.now(),
    };

    const completedState: EntityCompositeState = {
      session: { status: 'AUTHENTICATED' },
      task: { status: 'COMPLETED', taskId: 9004, durationSeconds: 4 },
      billing: { status: 'CHARGED', netPointsDeducted: 28, recordCount: 1 },
      artifacts: { status: 'VERIFIED', atomsFound: ['ftyp', 'moov', 'mdat'], ownershipVerified: true },
      observedAt: Date.now(),
    };

    // 现有测试集只跑了：AUTHENTICATED -> SUBMIT -> GENERATING -> POLL -> COMPLETED
    graph.observeTransition(authedState, 'SUBMIT_TASK', {}, generatingState);
    graph.observeTransition(generatingState, 'POLL_STATUS', {}, completedState);

    // 触发探索前沿发现
    const frontiers = graph.findUnverifiedFrontiers(actionSpace);

    // 验证标准：必须能指认出至少一个未被验证的高危前沿
    expect(frontiers.length).toBeGreaterThan(0);

    // 验证是否准确抓取到了在 GENERATING 状态下的取消操作 CANCEL_TASK
    const cancelFrontier = frontiers.find(
      (f) => f.fromState.task.status === 'GENERATING' && f.candidateAction.type === 'CANCEL_TASK',
    );

    expect(cancelFrontier).toBeDefined();
    expect(cancelFrontier!.riskScore).toBeGreaterThanOrEqual(0.95); // 异步中取消属于超高危业务动作
    expect(cancelFrontier!.reason).toContain('从未在测试中被验证');

    // 验证推导出的潜在目标状态与风险提示
    expect(cancelFrontier!.inferredTargetStates).toContain('task:CANCELLED|billing:CHARGED (High Risk Defect)');

    // 验证自动生成的可执行端到端探索场景链条
    const scenarioActions = cancelFrontier!.proposedScenario.map((s) => s.action);
    expect(scenarioActions).toEqual(['SUBMIT_TASK', 'POLL_STATUS', 'CANCEL_TASK', 'AUDIT_BILLING', 'INSPECT_MEDIA']);

    // 打印场景说明以供调试与审查
    const cancelStep = cancelFrontier!.proposedScenario.find((s) => s.action === 'CANCEL_TASK');
    expect(cancelStep?.description).toContain('【核心探索】执行候选动作 主动取消正在排队/生成的任务');
  });
});
