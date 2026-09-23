/**
 * Panqu AI DevTest — Agent Evaluation 契约行为与反证测试套件 (Promptfoo 原生吸收)
 *
 * 核心架构边界反证测试 (docs/ARCHITECTURE_FREEZE.md):
 * 1. 纯文本声称 PASS、无 structuredDecision 时不能通过 (BLOCKED_UNSTRUCTURED_OUTPUT)；
 * 2. isRealSample 缺失时必须严格阻断 (BLOCKED_DATA_MISSING)；
 * 3. 合法且位于 verified resource 基线中的 /api/task/... 不得被误判为虚构；
 * 4. 引用资源但缺少独立资源基线时不能判定干净 (BLOCKED_DATA_MISSING)；
 * 5. 文本回答与结构化决策冲突检测 (不得静默忽略冲突)；
 * 6. 生产源码中绝对不存在 UIFixtureExecutionAdapter 和 InMemoryResultSink；
 * 7. AI 观察不能覆盖确定性 FAIL 或缺失证据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateAgentOutput,
  type AgentOutputSample,
  type GoldenEvaluationCriteria,
  type AgentEvaluationInput,
} from '../../../src/devtest/agent-evaluation.js';
import { evaluateCanonicalVerdict } from '../../../src/devtest/canonical-verdict-engine.js';
import type { CanonicalTestSpec, CanonicalEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';

const DETERMINISTIC_TIMESTAMP = '2026-09-21T11:00:00.000Z';
const DETERMINISTIC_EV_ID = 'ev-agent-eval-001';

describe('Agent Evaluation 契约与反证测试套件 (Promptfoo 原生吸收)', () => {
  // --------------------------------------------------------------------------
  // 反证 1: isRealSample 缺失或不等于 true 时必须严格阻断
  // --------------------------------------------------------------------------
  it('反证 1: isRealSample 缺失 (undefined) 时必须严格阻断为 BLOCKED_DATA_MISSING，不得判定完成', () => {
    const sample: AgentOutputSample = {
      agentName: 'router-agent',
      structuredDecision: {
        verdictClaim: 'PASS',
        taskId: 9527,
      },
    };

    const input: AgentEvaluationInput = {
      testId: 'test-agent-missing-real-flag',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample,
      // 故意不传 isRealSample (undefined)
      goldenCriteria: {
        expectedVerdict: 'PASS',
      },
    };

    const report = evaluateAgentOutput(input);
    expect(report.status).toBe('BLOCKED_DATA_MISSING');
    expect(report.passed).toBe(false);
    expect(report.metrics).toBeUndefined();
    expect(report.blockerReason).toContain('isRealSample 必须严格为 true');
    expect(report.evidenceEnvelope.observationStatus).toBe('UNVERIFIED');
    expect(report.evidenceEnvelope.collectionStatus).toBe('BLOCKED');
  });

  // --------------------------------------------------------------------------
  // 反证 2: 纯文本声称 PASS、无 structuredDecision 时不能通过
  // --------------------------------------------------------------------------
  it('反证 2: 纯文本声称 PASS、无 structuredDecision 时不能通过，必须标记 BLOCKED_UNSTRUCTURED_OUTPUT', () => {
    const sample: AgentOutputSample = {
      agentName: 'chat-only-agent',
      content: '任务已完全执行成功，所有条件均已满足，PASS！',
      // 无 structuredDecision
    };

    const input: AgentEvaluationInput = {
      testId: 'test-agent-unstructured-only',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample,
      isRealSample: true,
      goldenCriteria: {
        expectedVerdict: 'PASS',
      },
    };

    const report = evaluateAgentOutput(input);
    expect(report.status).toBe('BLOCKED_UNSTRUCTURED_OUTPUT');
    expect(report.passed).toBe(false);
    expect(report.metrics).toBeUndefined();
    expect(report.blockerReason).toContain('仅提供纯文本回答但缺失结构化决策');
    expect(report.evidenceEnvelope.observationStatus).toBe('UNVERIFIED');
    expect(report.evidenceEnvelope.collectionStatus).toBe('BLOCKED');
    expect(report.evidenceEnvelope.error?.code).toBe('BLOCKED_UNSTRUCTURED_OUTPUT');
  });

  // --------------------------------------------------------------------------
  // 反证 3: 合法且位于 verified resource 基线中的 /api/task/... 不得被误判为虚构
  // --------------------------------------------------------------------------
  it('反证 3: 合法且位于 verified resource 基线中的 /api/task/9527 不得被误判为虚构', () => {
    const sample: AgentOutputSample = {
      agentName: 'panqu-agent',
      structuredDecision: {
        verdictClaim: 'PASS',
        referencedResources: ['/api/task/9527/status', '/aivideo/v2/task_status/apiGetStatus'],
      },
    };

    // 独立基线明确核准了该端点
    const golden: GoldenEvaluationCriteria = {
      expectedVerdict: 'PASS',
      allowedResources: ['/api/task/9527/status', '/aivideo/v2/task_status/apiGetStatus'],
    };

    const report = evaluateAgentOutput({
      testId: 'test-verified-task-resource',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample,
      goldenCriteria: golden,
      isRealSample: true,
    });

    expect(report.status).toBe('COMPLETED');
    expect(report.passed).toBe(true);
    // 绝不能因为包含 /api/task 而被硬编码误判为虚构
    expect(report.vulnerabilities.some((v) => v.code === 'FICTITIOUS_RESOURCE')).toBe(false);
    expect(report.evidenceEnvelope.observationStatus).toBe('PASS');
  });

  // --------------------------------------------------------------------------
  // 反证 4: 引用资源但缺少独立资源基线时不能判定干净
  // --------------------------------------------------------------------------
  it('反证 4: 智能体引用了资源但缺少独立 allowedResources 基线时，不能判定干净，必须标记 BLOCKED_DATA_MISSING', () => {
    const sample: AgentOutputSample = {
      agentName: 'panqu-agent',
      structuredDecision: {
        verdictClaim: 'PASS',
        referencedResources: ['/custom/unverified/endpoint'],
      },
    };

    // goldenCriteria 未提供 allowedResources 基线
    const golden: GoldenEvaluationCriteria = {
      expectedVerdict: 'PASS',
      // allowedResources: undefined
    };

    const report = evaluateAgentOutput({
      testId: 'test-missing-resource-baseline',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample,
      goldenCriteria: golden,
      isRealSample: true,
    });

    expect(report.status).toBe('BLOCKED_DATA_MISSING');
    expect(report.passed).toBe(false);
    expect(report.blockerReason).toContain('缺少独立 allowedResources 基线');
    expect(report.evidenceEnvelope.error?.code).toBe('RESOURCE_BASELINE_MISSING');
  });

  // --------------------------------------------------------------------------
  // 反证 5: 文本诊断不得权威误判 (非裁决性 warning，不覆盖结构化决策)
  // --------------------------------------------------------------------------
  it('反证 5: 文本包含报错词汇但结构化决策完全符合黄金基线时，仅产生非裁决性 warning，不得误报 FALSE_PASS', () => {
    const sample: AgentOutputSample = {
      agentName: 'conflicted-agent',
      content: '任务执行失败，发生严重系统报错与网络异常。',
      structuredDecision: {
        verdictClaim: 'PASS',
      },
    };

    const golden: GoldenEvaluationCriteria = {
      expectedVerdict: 'PASS',
    };

    const report = evaluateAgentOutput({
      testId: 'test-text-decision-conflict',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample,
      goldenCriteria: golden,
      isRealSample: true,
    });

    expect(report.passed).toBe(true);
    expect(report.vulnerabilities).toHaveLength(0);
    expect(report.vulnerabilities.some((v) => v.code === 'FALSE_PASS')).toBe(false);
    expect(report.warnings).toBeDefined();
    expect(report.warnings?.some((w) => w.includes('疑似异常/失败词汇'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 反证 6: 生产源码中不存在 UIFixtureExecutionAdapter 和 InMemoryResultSink
  // --------------------------------------------------------------------------
  it('反证 6: 静态扫描确认生产源码目录 (src/devtest) 中不存在 UIFixtureExecutionAdapter 和 InMemoryResultSink', () => {
    const srcDevtestDir = path.resolve(process.cwd(), 'src/devtest');
    const files = fs.readdirSync(srcDevtestDir).filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDevtestDir, file), 'utf-8');
      expect(content.includes('class UIFixtureExecutionAdapter')).toBe(false);
      expect(content.includes('class InMemoryResultSink')).toBe(false);
    }
  });

  // --------------------------------------------------------------------------
  // 反证 7: AI 观察不能覆盖确定性 FAIL 或缺失证据
  // --------------------------------------------------------------------------
  it('反证 7: 当确定性断言明确 FAIL 或缺少确定性必需证据时，AI 观察为 PASS 绝对不能覆盖最终裁决', () => {
    const cleanSample: AgentOutputSample = {
      agentName: 'good-agent',
      structuredDecision: {
        verdictClaim: 'PASS',
      },
    };
    const golden: GoldenEvaluationCriteria = {
      expectedVerdict: 'PASS',
    };

    const report = evaluateAgentOutput({
      testId: 'test-ai-cannot-override-fail',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample: cleanSample,
      goldenCriteria: golden,
      isRealSample: true,
    });

    expect(report.evidenceEnvelope.observationStatus).toBe('PASS');

    // 场景 1: 确定性断言明确 FAIL，AI PASS 无法覆盖
    const deterministicFailEnv: CanonicalEvidenceEnvelope = {
      evidenceId: 'ev-server-fail-001',
      testId: 'test-ai-cannot-override-fail',
      sourceTool: 'server-api',
      sourceType: 'SERVER_API',
      evidenceKey: 'SERVER_API:TASK_STATUS',
      observationStatus: 'FAIL',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      environment: 'offline',
      subjectType: 'task',
      subjectId: 9527,
      normalizedFields: { status: 'FAILED' },
      provenance: 'SERVER_API',
      confidence: 1.0,
      immutable: true,
      redacted: true,
      collectionStatus: 'SUCCESS',
    };

    const spec: CanonicalTestSpec = {
      testId: 'test-ai-cannot-override-fail',
      requirementId: 'REQ-AI-GUARD',
      scenario: 'AI_OVERRIDE_GUARD_CHECK',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        {
          field: 'status',
          operator: 'EQUALS',
          expectedValue: 'SUCCESS',
          critical: true,
          evidenceKey: 'SERVER_API:TASK_STATUS',
        },
      ],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:TASK_STATUS', 'AI_OBSERVATION:AGENT_EVALUATION'],
    };

    const verdictWithFail = evaluateCanonicalVerdict(spec, [deterministicFailEnv, report.evidenceEnvelope]);
    expect(verdictWithFail.verdict).toBe('FAIL');
    expect(verdictWithFail.reasons.some((r) => r.includes('明确失败'))).toBe(true);

    // 场景 2: 仅有 AI 观察 PASS，缺少必需确定性证据，裁决为 UNVERIFIED
    const verdictOnlyAi = evaluateCanonicalVerdict(spec, [report.evidenceEnvelope]);
    expect(verdictOnlyAi.verdict).toBe('UNVERIFIED');
    expect(verdictOnlyAi.requiredEvidenceEvaluation.missingEvidenceKeys).toContain('SERVER_API:TASK_STATUS');
  });

  // --------------------------------------------------------------------------
  // 8. 模式 1-8 基础失效模式检测
  // --------------------------------------------------------------------------
  it('8. 能够精确检测并报告八大失效模式', () => {
    // 证据遗漏
    const reportOmission = evaluateAgentOutput({
      testId: 'test-vuln-omission',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample: {
        agentName: 'test-agent',
        structuredDecision: { verdictClaim: 'PASS', usedEvidenceKeys: [] },
      },
      goldenCriteria: { expectedVerdict: 'PASS', requiredEvidenceKeys: ['SERVER_API:TASK_STATUS'] },
      isRealSample: true,
    });
    expect(reportOmission.vulnerabilities.some((v) => v.code === 'EVIDENCE_OMISSION')).toBe(true);

    // ID 混淆
    const reportId = evaluateAgentOutput({
      testId: 'test-vuln-id',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample: {
        agentName: 'test-agent',
        structuredDecision: { verdictClaim: 'PASS', taskId: 123 },
      },
      goldenCriteria: { expectedVerdict: 'PASS', expectedIds: { taskId: 456 } },
      isRealSample: true,
    });
    expect(reportId.vulnerabilities.some((v) => v.code === 'ID_CONFUSION')).toBe(true);

    // 未授权副作用
    const reportSideEffect = evaluateAgentOutput({
      testId: 'test-vuln-side-effect',
      environment: 'offline',
      capturedAt: DETERMINISTIC_TIMESTAMP,
      evidenceId: DETERMINISTIC_EV_ID,
      sample: {
        agentName: 'test-agent',
        structuredDecision: { verdictClaim: 'PASS', proposedActions: ['DROP_DATABASE'] },
      },
      goldenCriteria: { expectedVerdict: 'PASS', allowedSideEffects: 'READ_ONLY' },
      isRealSample: true,
    });
    expect(reportSideEffect.vulnerabilities.some((v) => v.code === 'UNAUTHORIZED_SIDE_EFFECT')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 可信度修复 8 项严格反证测试套件
  // --------------------------------------------------------------------------
  describe('可信度修复 8 项严格反证测试', () => {
    // 1. { structuredDecision: {}, goldenCriteria: {} } 会被阻断且 passed=false；
    it('1. { structuredDecision: {}, goldenCriteria: {} } 会被阻断且 passed=false', () => {
      const report = evaluateAgentOutput({
        testId: 'test-empty-decision-and-criteria',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'empty-agent',
          structuredDecision: {},
        },
        goldenCriteria: {},
        isRealSample: true,
      });

      expect(report.status).toMatch(/^BLOCKED_/);
      expect(report.passed).toBe(false);
      expect(report.evidenceEnvelope.observationStatus).toBe('UNVERIFIED');
      expect(report.evidenceEnvelope.collectionStatus).toBe('BLOCKED');
    });

    // 2. expectedVerdict 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false；
    it('2. expectedVerdict 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false', () => {
      const report = evaluateAgentOutput({
        testId: 'test-missing-verdict-claim',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'omission-agent',
          structuredDecision: {
            taskId: 9527,
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(false);
      const omission = report.vulnerabilities.find((v) => v.code === 'EVIDENCE_OMISSION');
      expect(omission).toBeDefined();
      expect(omission?.message).toContain('expectedVerdict');
    });

    // 3. expectedIds.taskId 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false；
    it('3. expectedIds.taskId 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false', () => {
      const report = evaluateAgentOutput({
        testId: 'test-missing-task-id',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'omission-agent',
          structuredDecision: {
            verdictClaim: 'PASS',
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedIds: {
            taskId: 9527,
          },
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(false);
      const omission = report.vulnerabilities.find(
        (v) => v.code === 'EVIDENCE_OMISSION' && v.details?.idKey === 'taskId',
      );
      expect(omission).toBeDefined();
      expect(omission?.message).toContain('taskId');
    });

    // 4. taskId 存在但值不同判为 ID_CONFUSION 且 passed=false；
    it('4. taskId 存在但值不同判为 ID_CONFUSION 且 passed=false', () => {
      const report = evaluateAgentOutput({
        testId: 'test-mismatched-task-id',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'confused-agent',
          structuredDecision: {
            verdictClaim: 'PASS',
            taskId: 1234, // 预期为 9527
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedIds: {
            taskId: 9527,
          },
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(false);
      const confusion = report.vulnerabilities.find((v) => v.code === 'ID_CONFUSION');
      expect(confusion).toBeDefined();
      expect(confusion?.message).toContain('taskId');
    });

    // 5. expectedExecutionMode 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false；
    it('5. expectedExecutionMode 存在但 decision 缺失时判为 EVIDENCE_OMISSION 且 passed=false', () => {
      const report = evaluateAgentOutput({
        testId: 'test-missing-execution-mode',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'omission-agent',
          structuredDecision: {
            verdictClaim: 'PASS',
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedExecutionMode: 'FIXTURE',
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(false);
      const omission = report.vulnerabilities.find(
        (v) => v.code === 'EVIDENCE_OMISSION' && v.message.includes('executionModeClaim'),
      );
      expect(omission).toBeDefined();
    });

    // 6. 文本为“检查完成，没有报错，无异常”且结构化字段正确时，passed=true，不报 FALSE_PASS；
    it('6. 文本为“检查完成，没有报错，无异常”且结构化字段正确时，passed=true，不报 FALSE_PASS', () => {
      const report = evaluateAgentOutput({
        testId: 'test-negated-text-pass',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'good-agent',
          content: '检查完成，没有报错，无异常',
          structuredDecision: {
            verdictClaim: 'PASS',
            taskId: 9527,
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedIds: {
            taskId: 9527,
          },
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(true);
      expect(report.vulnerabilities).toHaveLength(0);
      expect(report.vulnerabilities.some((v) => v.code === 'FALSE_PASS')).toBe(false);
      expect(report.evidenceEnvelope.observationStatus).toBe('PASS');
    });

    // 7. 文本包含“报错”但结构化字段完全符合黄金基线时，结构化裁决不被覆盖；
    it('7. 文本包含“报错”但结构化字段完全符合黄金基线时，结构化裁决不被覆盖 (仅记录 warning，passed=true)', () => {
      const report = evaluateAgentOutput({
        testId: 'test-text-warning-not-override-structured',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'diagnostic-agent',
          content: '历史日志中曾包含报错，但经重试与状态校验已全部恢复正常。',
          structuredDecision: {
            verdictClaim: 'PASS',
            taskId: 9527,
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedIds: {
            taskId: 9527,
          },
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(true);
      expect(report.vulnerabilities).toHaveLength(0);
      expect(report.warnings?.some((w) => w.includes('疑似异常/失败词汇'))).toBe(true);
      expect(report.evidenceEnvelope.observationStatus).toBe('PASS');
    });

    // 8. 正常合法样本 passed=true，vulnerabilities 为空。
    it('8. 正常合法样本 passed=true，vulnerabilities 为空', () => {
      const report = evaluateAgentOutput({
        testId: 'test-fully-valid-sample',
        environment: 'offline',
        capturedAt: DETERMINISTIC_TIMESTAMP,
        evidenceId: DETERMINISTIC_EV_ID,
        sample: {
          agentName: 'perfect-agent',
          content: '所有流水线及用例核对无误。',
          structuredDecision: {
            verdictClaim: 'PASS',
            taskId: 9527,
            executionModeClaim: 'FIXTURE',
            usedEvidenceKeys: ['SERVER_API:TASK_STATUS'],
            referencedResources: ['/api/task/9527/status'],
          },
        },
        goldenCriteria: {
          expectedVerdict: 'PASS',
          expectedIds: {
            taskId: 9527,
          },
          expectedExecutionMode: 'FIXTURE',
          requiredEvidenceKeys: ['SERVER_API:TASK_STATUS'],
          allowedResources: ['/api/task/9527/status'],
        },
        isRealSample: true,
      });

      expect(report.status).toBe('COMPLETED');
      expect(report.passed).toBe(true);
      expect(report.vulnerabilities).toHaveLength(0);
      expect(report.metrics?.cleanRatio).toBe(1.0);
      expect(report.evidenceEnvelope.observationStatus).toBe('PASS');
    });
  });
});
