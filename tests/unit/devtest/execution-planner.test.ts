import { describe, expect, it } from 'vitest';
import { ExecutionPlanner } from '../../../src/devtest/execution-planner.js';
import type { DevTestScenario } from '../../../src/devtest/types.js';

describe('ExecutionPlanner (可执行 DAG 规划器)', () => {
  it('正确构建主成功流的步骤依赖 DAG 与主键传递映射', () => {
    const scenario: DevTestScenario = {
      id: 'SCENARIO_WAN3_HAPPY_PATH',
      name: 'Wan 3.0 视频生成主成功流',
      kind: 'MAIN_HAPPY_PATH',
      whySelected: '核心测试',
      relatedRequirement: '视频生成',
      relatedRisk: '核心故障',
      requiredEvidence: [],
      requiredOracles: [],
      modelId: 84,
    };

    const dag = ExecutionPlanner.planDagForScenario(scenario);

    expect(dag.scenarioId).toBe('SCENARIO_WAN3_HAPPY_PATH');
    expect(dag.steps.length).toBe(9); // identity, project, submit, poll, routing, billing, media, cross_audit, cleanup

    const submitStep = dag.steps.find((s) => s.operation.includes('videonew/add'));
    expect(submitStep).toBeDefined();
    expect(submitStep?.output).toContain('taskId');

    const pollStep = dag.steps.find((s) => s.operation.includes('apiGetStatus'));
    expect(pollStep).toBeDefined();
    expect(pollStep?.dependsOn).toContain(submitStep!.id);
    expect(pollStep?.inputFrom.some((i) => i.fromField === 'taskId' && i.toField === 'taskId')).toBe(true);

    const mediaStep = dag.steps.find((s) => s.operation === 'MEDIA_INSPECT');
    expect(mediaStep).toBeDefined();
    expect(mediaStep?.dependsOn).toContain(pollStep!.id);
    expect(mediaStep?.inputFrom.some((i) => i.fromField === 'assetUrl')).toBe(true);

    const auditStep = dag.steps.find((s) => s.operation === 'CROSS_STEP_AUDIT');
    expect(auditStep).toBeDefined();
    expect(auditStep?.dependsOn).toContain(submitStep!.id);
  });

  it('在 RETRY_IDEMPOTENCY 场景中插入携带相同 clientToken 的重发步骤', () => {
    const scenario: DevTestScenario = {
      id: 'SCENARIO_IDEMPOTENCY',
      name: '幂等防重场景',
      kind: 'RETRY_IDEMPOTENCY',
      whySelected: '防重测试',
      relatedRequirement: '幂等',
      relatedRisk: '双重扣费',
      requiredEvidence: [],
      requiredOracles: [],
      modelId: 84,
    };

    const dag = ExecutionPlanner.planDagForScenario(scenario);
    const reSubmitStep = dag.steps.find((s) => s.id.includes('RESUBMIT_IDEMPOTENCY'));
    expect(reSubmitStep).toBeDefined();
    expect(reSubmitStep?.oracle).toBe('IdempotencyOracle');
  });

  it('在 FAILURE_REFUND 场景中跳过产物介质核验并核验失败状态', () => {
    const scenario: DevTestScenario = {
      id: 'SCENARIO_FAIL_REFUND',
      name: '失败退款场景',
      kind: 'FAILURE_REFUND',
      whySelected: '退款测试',
      relatedRequirement: '退款',
      relatedRisk: '不退款',
      requiredEvidence: [],
      requiredOracles: [],
      modelId: 84,
    };

    const dag = ExecutionPlanner.planDagForScenario(scenario);
    const mediaStep = dag.steps.find((s) => s.operation === 'MEDIA_INSPECT');
    expect(mediaStep).toBeUndefined(); // 失败任务无介质产物

    const pollStep = dag.steps.find((s) => s.operation.includes('apiGetStatus'));
    expect(pollStep?.requiredEvidence).toContain('TASK_STATUS_FAILED');
  });
});
