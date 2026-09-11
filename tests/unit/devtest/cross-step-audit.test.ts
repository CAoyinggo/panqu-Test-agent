import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../../src/agents/test-design/testcase-schema.js';
import type { AcceptanceCaseExecutionResult } from '../../../src/acceptance/api-processor.js';
import {
  auditCrossStepConsistency,
  buildBusinessLevelProblems,
  evaluateBusinessFlows,
} from '../../../src/devtest/business-flow-engine.js';
import type { DevTestBusinessFlow } from '../../../src/devtest/types.js';

function createMockExecution(
  caseId: string,
  options: {
    taskId?: number | string;
    projectId?: number | string;
    userId?: number | string;
    assetUrl?: string;
    timestamp?: string;
    status?: 'PASS' | 'FAIL';
  } = {}
): AcceptanceCaseExecutionResult {
  const { taskId, projectId, userId, assetUrl, timestamp, status = 'PASS' } = options;
  return {
    caseId,
    name: `Step ${caseId}`,
    feature: '视频生成',
    priority: 'P0',
    tags: [],
    scene: 'api',
    timestamp: timestamp ?? new Date().toISOString(),
    status,
    executed: true,
    processorInvoked: true,
    processor: 'ApiProcessor',
    pass: status === 'PASS',
    passRate: status === 'PASS' ? 1 : 0,
    assertions: 1,
    passedAssertions: status === 'PASS' ? 1 : 0,
    failedAssertions: status === 'FAIL' ? 1 : 0,
    classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE',
    attribution: {
      classification: status === 'PASS' ? 'SUCCESS' : 'PRODUCT_FAILURE',
      confidence: 'HIGH',
      reason: 'test',
      evidenceSources: ['TEST'],
    },
    evidence: {
      acceptanceCriteriaIds: [],
      request: {
        method: 'POST',
        url: 'http://local/api/panqu/task',
        headers: {},
        pathParams: {},
        query: projectId ? { project_id: projectId } : {},
        body: {
          task_id: taskId,
          project_id: projectId,
          user_id: userId,
        },
      },
      response: {
        status: 200,
        headers: {},
        body: {
          code: 1,
          data: {
            id: taskId,
            project_id: projectId,
            user_id: userId,
            video_url: assetUrl,
          },
        },
      },
      assertions: [],
      evidenceItems: [],
    },
  } as AcceptanceCaseExecutionResult;
}

const mockFlow: DevTestBusinessFlow = {
  id: 'flow-video-generation',
  name: '视频生成闭环',
  kind: 'MAIN_HAPPY_PATH',
  core: true,
  status: 'NOT_EXECUTED',
  acIds: [], invariantIds: [],
  steps: [
    {
      id: 'step-submit',
      name: '提交任务',
      operation: 'POST /api/panqu/task/submit',
      actor: { role: 'CREATOR' }, order: 0, dependencies: [],
      resource: 'VIDEO_TASK',
      actions: ['POST /api/panqu/task/submit'],
      caseIds: ['TC_SUBMIT'],
      stateTransition: { from: 'INITIAL', to: 'SUBMITTED' },
    },
    {
      id: 'step-poll',
      name: '轮询状态',
      operation: 'GET /api/panqu/task/detail',
      actor: { role: 'CREATOR' }, order: 1, dependencies: [],
      resource: 'VIDEO_TASK',
      actions: ['GET /api/panqu/task/detail'],
      caseIds: ['TC_POLL'],
      stateTransition: { from: 'SUBMITTED', to: 'COMPLETED' },
    },
    {
      id: 'step-asset',
      name: '资产核验',
      operation: 'GET /api/panqu/asset/verify',
      actor: { role: 'CREATOR' }, order: 2, dependencies: [],
      resource: 'VIDEO_ASSET',
      actions: ['GET /api/panqu/asset/verify'],
      caseIds: ['TC_ASSET'],
      stateTransition: { from: 'COMPLETED', to: 'DELIVERED' },
    },
  ],
};

describe('CrossStepConsistencyAudit', () => {
  it('当全链路 task_id, project_id, user_id, asset_url 与执行时序均一致时，审计通过', () => {
    const results = [
      createMockExecution('TC_SUBMIT', {
        taskId: 'task_1001',
        projectId: 'proj_88',
        userId: 'u_10',
        timestamp: '2026-09-11T10:00:00.000Z',
      }),
      createMockExecution('TC_POLL', {
        taskId: 'task_1001',
        projectId: 'proj_88',
        userId: 'u_10',
        assetUrl: 'https://cdn.example.com/video1.mp4',
        timestamp: '2026-09-11T10:00:05.000Z',
      }),
      createMockExecution('TC_ASSET', {
        taskId: 'task_1001',
        projectId: 'proj_88',
        userId: 'u_10',
        assetUrl: 'https://cdn.example.com/video1.mp4',
        timestamp: '2026-09-11T10:00:10.000Z',
      }),
    ];

    const audit = auditCrossStepConsistency({
      flow: mockFlow,
      results,
    });

    expect(audit.passed).toBe(true);
    expect(audit.inconsistencies).toHaveLength(0);
    expect(audit.causalChain).toHaveLength(3);
    expect(audit.causalChain.every((c) => c.primaryKeyMatched)).toBe(true);
  });

  it('当步骤间 task_id 错配时，审计判定失败并记录 TASK_ID_MISMATCH', () => {
    const results = [
      createMockExecution('TC_SUBMIT', { taskId: 'task_1001', timestamp: '2026-09-11T10:00:00.000Z' }),
      createMockExecution('TC_POLL', { taskId: 'task_9999', timestamp: '2026-09-11T10:00:05.000Z' }),
    ];

    const audit = auditCrossStepConsistency({
      flow: mockFlow,
      results,
    });

    expect(audit.passed).toBe(false);
    expect(audit.inconsistencies.some((msg) => msg.includes('TASK_ID_MISMATCH'))).toBe(true);
  });

  it('当步骤间 project_id 发生跨越/篡改时，审计判定失败并记录 PROJECT_ID_MISMATCH', () => {
    const results = [
      createMockExecution('TC_SUBMIT', { taskId: 'task_1001', projectId: 'proj_A', timestamp: '2026-09-11T10:00:00.000Z' }),
      createMockExecution('TC_POLL', { taskId: 'task_1001', projectId: 'proj_B_HIJACKED', timestamp: '2026-09-11T10:00:05.000Z' }),
    ];

    const audit = auditCrossStepConsistency({
      flow: mockFlow,
      results,
    });

    expect(audit.passed).toBe(false);
    expect(audit.inconsistencies.some((msg) => msg.includes('PROJECT_ID_MISMATCH'))).toBe(true);
  });

  it('当后续资产验证中的 asset_url 与生成成品不一致时，记录 ASSET_URL_MISMATCH', () => {
    const results = [
      createMockExecution('TC_SUBMIT', { taskId: 'task_1001', timestamp: '2026-09-11T10:00:00.000Z' }),
      createMockExecution('TC_POLL', {
        taskId: 'task_1001',
        assetUrl: 'https://cdn.example.com/video_canonical.mp4',
        timestamp: '2026-09-11T10:00:05.000Z',
      }),
      createMockExecution('TC_ASSET', {
        taskId: 'task_1001',
        assetUrl: 'https://cdn.example.com/video_tampered.mp4',
        timestamp: '2026-09-11T10:00:10.000Z',
      }),
    ];

    const audit = auditCrossStepConsistency({
      flow: mockFlow,
      results,
    });

    expect(audit.passed).toBe(false);
    expect(audit.inconsistencies.some((msg) => msg.includes('ASSET_URL_MISMATCH'))).toBe(true);
  });

  it('当时序发生因果倒置（后序步骤执行时间早于前序）时，记录 TIMELINE_CAUSALITY_VIOLATION', () => {
    const results = [
      createMockExecution('TC_SUBMIT', { taskId: 'task_1001', timestamp: '2026-09-11T10:00:10.000Z' }),
      createMockExecution('TC_POLL', { taskId: 'task_1001', timestamp: '2026-09-11T10:00:00.000Z' }), // 早于前序！
    ];

    const audit = auditCrossStepConsistency({
      flow: mockFlow,
      results,
    });

    expect(audit.passed).toBe(false);
    expect(audit.inconsistencies.some((msg) => msg.includes('TIMELINE_CAUSALITY_VIOLATION'))).toBe(true);
  });

  it('跨步骤一致性审计失败时，Flow 状态被置为 FAIL 且生成 CRITICAL 级别 CROSS_STEP_CORRELATION_ERROR', async () => {
    const submitCase: TestCase = {
      id: 'TC_SUBMIT',
      feature: '视频生成',
      name: '提交',
      priority: 'P0',
      testType: 'API',
      executionMode: 'EXECUTABLE',
      protocol: 'HTTP',
      tags: [],
      source: {
        requirementId: 'REQ-V1',
        testPointId: 'TP-SUBMIT',
        sourceType: 'REQUIREMENT',
        acceptanceCriteriaIds: ['AC-SUBMIT'],
        apiOperationKey: 'POST /api/panqu/task/submit',
      },
      steps: [{ type: 'HTTP_REQUEST', method: 'POST', url: '/api/panqu/task/submit' }],
      assertions: [{ type: 'STATUS_CODE', expected: 200 }],
    };
    const pollCase: TestCase = {
      id: 'TC_POLL',
      feature: '视频生成',
      name: '轮询',
      priority: 'P0',
      testType: 'API',
      executionMode: 'EXECUTABLE',
      protocol: 'HTTP',
      tags: [],
      source: {
        requirementId: 'REQ-V1',
        testPointId: 'TP-POLL',
        sourceType: 'REQUIREMENT',
        acceptanceCriteriaIds: ['AC-POLL'],
        apiOperationKey: 'GET /api/panqu/task/detail',
      },
      steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/api/panqu/task/detail' }],
      assertions: [{ type: 'STATUS_CODE', expected: 200 }],
    };

    const twoStepFlow: DevTestBusinessFlow = {
      ...mockFlow,
      steps: mockFlow.steps.slice(0, 2),
    };

    const graph = {
      flows: [twoStepFlow],
      operationCount: 2,
      dependencies: [],
      coverage: 100,
    };

    const results = [
      createMockExecution('TC_SUBMIT', { taskId: 'task_1001', timestamp: '2026-09-11T10:00:00.000Z' }),
      createMockExecution('TC_POLL', { taskId: 'task_mismatch', timestamp: '2026-09-11T10:00:05.000Z' }),
    ];

    const evaluated = await evaluateBusinessFlows({
      graph,
      testCases: [submitCase, pollCase],
      invariants: [],
      results,
    });

    expect(evaluated.graph.flows[0].status).toBe('FAIL');
    expect(evaluated.crossStepAudits).toBeDefined();
    expect(evaluated.crossStepAudits![0].passed).toBe(false);

    const problems = buildBusinessLevelProblems({
      graph: evaluated.graph,
      invariants: [],
      consistency: evaluated.consistency,
      reproductionRun: false,
    });

    const crossStepProblem = problems.find((p) => p.reasonCode === 'CROSS_STEP_CORRELATION_ERROR');
    expect(crossStepProblem).toBeDefined();
    expect(crossStepProblem?.type).toBe('DATA_CONSISTENCY_BUG');
    expect(crossStepProblem?.severity).toBe('CRITICAL');
  });
});
