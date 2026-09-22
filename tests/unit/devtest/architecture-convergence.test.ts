// Panqu AI DevTest v6.0.0 Architecture Convergence Tests
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  probe,
  plan,
  execute,
  verify,
  executeCanonical,
} from '../../../src/devtest/core-kernel.js';
import {
  validateCanonicalTestSpec,
  validateEvidenceEnvelope,
  evaluateRequiredEvidence,
  type CanonicalTestSpec,
  type CanonicalEvidenceEnvelope,
} from '../../../src/devtest/canonical-protocol.js';
import {
  evaluateCanonicalVerdict,
} from '../../../src/devtest/canonical-verdict-engine.js';
import {
  validateExecutionResult,
  PanquMediaExecutionAdapter,
  mapCanonicalEnvironmentToPanquSessionEnv,
  FORBIDDEN_VERDICT_FIELDS,
  type ExecutionAdapter,
  type ExecutionResult,
  type EvidenceProducer,
  type EvidenceProducerContext,
} from '../../../src/devtest/execution-ports.js';
import {
  resolveRequirementTraceForSpec,
  isStableRequirementId,
  type RequirementTrace,
} from '../../../src/devtest/requirement-trace.js';
import {
  mapExecuteToCanonicalTestSpec,
  mapPlanToCanonicalTestSpec,
} from '../../../src/devtest/legacy-protocol-mappers.js';
import * as mediaFlow from '../../../src/devtest/media-flow.js';
import { TestOfflineExecutionAdapter } from '../../helpers/test-adapters.js';
import {
  mapVerdictToExportRecord,
  type ResultSink,
} from '../../../src/devtest/result-sink.js';
import {
  DEVTEST_MCP_TOOL,
  DevTestMcpService,
} from '../../../src/devtest/mcp-service.js';
import { runDevTestCli } from '../../../bin/devtest-cli.js';
import {
  UIBrowserEvidenceProducer,
  UIVisualAiEvidenceProducer,
  type DeterministicProducerContext,
} from '../../../src/devtest/ui-adapters.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';

describe('Architecture Convergence — RequirementTrace → TestSpec → Adapter → Evidence → Verdict', () => {
  const validMp4 = createSyntheticValidMp4({ width: 720, height: 1280, durationSeconds: 4 });

  describe('1. RequirementTrace 与 Impact Analysis 规范', () => {
    it('无变更路径与需求输入时，明确记录未执行，严禁虚构或伪造', () => {
      const trace = resolveRequirementTraceForSpec({});

      expect(trace.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect((trace.impactAnalysis as any).executed).toBe(false);
      expect((trace.impactAnalysis as any).reason).toBe('UNRESOLVED_REQUIREMENT: 缺少有效 stable requirementId 与需求描述，未执行影响分析');
    });

    it('有明确需求与变更路径输入时，能够正向推导影响范围与关联场景', () => {
      const sampleTrace: RequirementTrace = {
        requirementId: 'REQ-VIDEO-DIVERSION',
        description: '960 视频模型分流',
        sourceRefs: ['src/devtest/routing.ts'],
        testIds: ['test-video-diversion'],
      };

      const trace = resolveRequirementTraceForSpec({
        requirement: 'REQ-VIDEO-DIVERSION',
        changedPaths: ['src/devtest/routing.ts'],
        traces: [sampleTrace],
      });

      expect('affectedRequirements' in trace.impactAnalysis).toBe(true);
      expect((trace.impactAnalysis as any).affectedRequirements).toContain('REQ-VIDEO-DIVERSION');
      expect((trace.impactAnalysis as any).affectedTests).toContain('test-video-diversion');
      expect((trace.impactAnalysis as any).changedPaths).toContain('src/devtest/routing.ts');
    });

    it('plan 产出的 CanonicalTestSpec 正确挂载 requirementTrace', async () => {
      const res = await plan({
        modelId: 84,
        mediaType: 'video',
        flowType: 'diversion',
        price: 21,
        channelId: 2,
        requirement: '对齐 84 视频分流',
      });

      expect(res.canonicalSpec).toBeDefined();
      const specValidation = validateCanonicalTestSpec(res.canonicalSpec);
      expect(specValidation.valid).toBe(true);

      const trace = res.canonicalSpec?.metadata?.requirementTrace as any;
      expect(trace).toBeDefined();
      expect(trace.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(trace.requirementText).toBe('对齐 84 视频分流');
      expect(trace.impactAnalysis).toBeDefined();
    });
  });

  describe('2. Canonical TestSpec 唯一意图源', () => {
    it('probe、plan、execute、verify 均统一接入并产出合法 CanonicalTestSpec', async () => {
      // 1. probe
      const probeRes = await probe({ mock: true });
      expect(probeRes.canonicalSpec).toBeDefined();
      expect(validateCanonicalTestSpec(probeRes.canonicalSpec).valid).toBe(true);

      // 2. plan
      const planRes = await plan({ modelId: 201, mediaType: 'image' });
      expect(planRes.canonicalSpec).toBeDefined();
      expect(validateCanonicalTestSpec(planRes.canonicalSpec).valid).toBe(true);

      // 3. execute
      const execRes = await execute({
        mode: 'mock',
        modelId: 201,
        mediaType: 'image',
      });
      expect(execRes.canonicalSpec).toBeDefined();
      expect(validateCanonicalTestSpec(execRes.canonicalSpec).valid).toBe(true);

      // 4. verify
      const verifyRes = await verify({
        taskId: 99901,
        modelId: 201,
        mediaType: 'image',
        terminalStatus: 'SUCCESS',
        artifactBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        scoreLogs: [{ task_id: 99901, type: 2, score: -10, memo: 'IMAGE_GEN' }],
      });
      expect(verifyRes.canonicalSpec).toBeDefined();
      expect(validateCanonicalTestSpec(verifyRes.canonicalSpec).valid).toBe(true);
    });
  });

  describe('3. ExecutionAdapter 防御性门禁 (Fail-Closed)', () => {
    it('FORBIDDEN_VERDICT_FIELDS 覆盖所有业务裁决字段', () => {
      expect(FORBIDDEN_VERDICT_FIELDS).toContain('verdict');
      expect(FORBIDDEN_VERDICT_FIELDS).toContain('passed');
      expect(FORBIDDEN_VERDICT_FIELDS).toContain('acceptance');
      expect(FORBIDDEN_VERDICT_FIELDS).toContain('businessPass');
      expect(FORBIDDEN_VERDICT_FIELDS).toContain('finalStatus');
    });

    it('适配器返回 verdict 等裁决字段时，validateExecutionResult 抛出 ADAPTER_ILLEGAL_VERDICT_FIELD', () => {
      const illegalResults = [
        { success: true, verdict: 'PASS', outputs: {} },
        { success: true, passed: true, outputs: {} },
        { success: true, acceptance: 'ACCEPTED', outputs: {} },
        { success: true, businessPass: true, outputs: {} },
        { success: true, finalStatus: 'SUCCESS', outputs: {} },
      ];

      for (const res of illegalResults) {
        expect(() => validateExecutionResult(res)).toThrowError(/ADAPTER_ILLEGAL_VERDICT_FIELD/);
      }
    });

    it('execute() 注入非法裁决字段适配器时抛错拦截，无法越权篡改裁决', async () => {
      const maliciousAdapter: ExecutionAdapter = {
        adapterName: 'malicious-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT'],
        execute: async (spec) => {
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            verdict: 'PASS', // 试图直接宣称业务通过
          } as any;
        },
      };

      const res = await execute({
        mode: 'mock',
        modelId: 201,
        mediaType: 'image',
        executionAdapter: maliciousAdapter,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
      expect(res.canonicalSpec).toBeDefined();
      expect(res.executionResult).toBeDefined();
      expect(res.executionResult?.status).toBe('BLOCKED');
      expect(res.executionResult?.error?.code).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
    });

    it('生产内置 PanquMediaExecutionAdapter 正常执行且绝无裁决字段输出', async () => {
      const adapter = new PanquMediaExecutionAdapter();
      const mockSpec: CanonicalTestSpec = {
        testId: 'spec-test-media',
        requirementId: 'REQ-MEDIA-1',
        scenario: 'IMAGE_MOCK',
        environment: 'offline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 201 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'ALLOW_SUBMIT',
        requiredEvidence: ['FIXTURE:TASK_STATUS'],
      };

      // 1. 无真实 handler 时返回 OFFLINE_DRY_RUN，绝不伪造 COMPLETED
      const execResult = await adapter.execute(mockSpec);
      expect(execResult.status).toBe('BLOCKED');
      expect(execResult.error?.code).toBe('OFFLINE_DRY_RUN');
      expect(execResult.metadata?.taskId).toBeUndefined();

      // 防御校验不报错
      const validated = validateExecutionResult(execResult);
      for (const field of FORBIDDEN_VERDICT_FIELDS) {
        expect((validated as any)[field]).toBeUndefined();
      }

      // 2. 提供真实 handler 时正确返回提交回执且绝无裁决字段
      const adapterWithHandler = new PanquMediaExecutionAdapter({
        submitHandler: async () => ({
          taskId: 12345,
          points: 10,
          message: 'ok',
        }),
      });
      const execWithHandler = await adapterWithHandler.execute(mockSpec);
      expect(execWithHandler.status).toBe('SUBMITTED');
      expect(execWithHandler.metadata?.taskId).toBe(12345);
      const validatedWithHandler = validateExecutionResult(execWithHandler);
      for (const field of FORBIDDEN_VERDICT_FIELDS) {
        expect((validatedWithHandler as any)[field]).toBeUndefined();
      }
    });
  });

  describe('4. UI Evidence 与 Visual Assist (吸收 Playwright 与 Midscene 思想)', () => {
    it('UIBrowserEvidenceProducer 产出确定性 DOM / Network / Screenshot 物理证据', async () => {
      const producer = new UIBrowserEvidenceProducer();
      const context: DeterministicProducerContext = {
        testId: 'ui-test-1',
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
        capturedAt: '2026-09-21T12:00:00.000Z',
        evidenceId: 'ev-ui-1',
        evidenceIdMap: {
          'BROWSER:TASK_STATUS_DOM': 'ev-dom-1',
          'BROWSER:NETWORK_REQUESTS': 'ev-net-1',
          'BROWSER:SCREENSHOT': 'ev-shot-1',
        },
      };

      const envelopes = await producer.produce(
        {
          domTaskStatus: 'SUCCESS',
          rowFound: true,
          networkLogs: [{ url: 'https://example.com/api', status: 200, method: 'POST' }],
          screenshotHash: 'a1b2c3d4e5f6',
        },
        context
      );

      expect(envelopes.length).toBeGreaterThanOrEqual(2);
      for (const env of envelopes) {
        expect(env.sourceType).toBe('BROWSER');
        expect(validateEvidenceEnvelope(env).valid).toBe(true);
      }
    });

    it('UIVisualAiEvidenceProducer 仅输出 AI_OBSERVATION 辅助观察证据', async () => {
      const visualProducer = new UIVisualAiEvidenceProducer();
      const context: EvidenceProducerContext = {
        testId: 'visual-test-1',
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
      };

      const envelopes = await visualProducer.produce(
        {
          observations: [{ element: 'button', label: 'Submit', visible: true, confidence: 0.95 }],
        },
        context
      );

      expect(envelopes.length).toBe(1);
      expect(envelopes[0].sourceType).toBe('AI_OBSERVATION');
      expect(validateEvidenceEnvelope(envelopes[0]).valid).toBe(true);
    });

    it('不变量核验：AI_OBSERVATION 绝不覆盖确定性断言失败，断言失败必须判定 FAIL', () => {
      const spec: CanonicalTestSpec = {
        testId: 'spec-conflict-test',
        requirementId: 'REQ-1',
        scenario: 'UI_VERIFY',
        environment: 'test',
        executionMode: 'FIXTURE',
        target: { targetType: 'model', modelId: 201 },
        inputs: {},
        deterministicAssertions: [
          {
            field: 'button.clicked',
            operator: 'EQUALS',
            expectedValue: true,
            critical: true,
            evidenceKey: 'BROWSER:DOM_EVENT',
            actualField: 'clicked',
          },
        ],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['BROWSER:DOM_EVENT'],
      };

      // 确定性证据：button.clicked = false (断言失败)
      const deterministicEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'env-dom-1',
        testId: 'spec-conflict-test',
        sourceTool: 'ui-browser',
        sourceType: 'BROWSER',
        evidenceKey: 'BROWSER:DOM_EVENT',
        observationStatus: 'FAIL',
        capturedAt: '2026-09-21T12:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
        normalizedFields: { clicked: false },
        provenance: 'BROWSER_DOM',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      // 视觉辅助证据：声称看起来很像成功 (PASS)
      const visualEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'env-visual-1',
        testId: 'spec-conflict-test',
        sourceTool: 'ui-visual-ai',
        sourceType: 'AI_OBSERVATION',
        evidenceKey: 'AI_OBSERVATION:VISUAL_CHECK',
        observationStatus: 'PASS',
        capturedAt: '2026-09-21T12:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
        normalizedFields: { looksGood: true },
        provenance: 'MIDSCENE_VISUAL_MODEL',
        confidence: 0.99,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const verdictResult = evaluateCanonicalVerdict(spec, [deterministicEnv, visualEnv]);
      // 必须是 FAIL，绝对不能被 AI_OBSERVATION 掩盖为 PASS！
      expect(verdictResult.verdict).toBe('FAIL');
    });
  });

  describe('5. 唯一裁决引擎与凭据穿透 (Single Verdict Source)', () => {
    it('缺少必需证据判定 UNVERIFIED，核心断言失败判定 FAIL，完整证据判定 PASS', async () => {
      // 1. 缺少证据 -> UNVERIFIED
      const missingRes = await verify({
        taskId: 88801,
        modelId: 201,
        mediaType: 'image',
        terminalStatus: 'UNKNOWN',
      });
      expect(missingRes.verdict).toBe('UNVERIFIED');
      expect(missingRes.acceptance).toBe('BLOCKED');
      expect(missingRes.passed).toBe(false);

      // 2. 核心失败 -> FAIL
      const failRes = await verify({
        taskId: 88802,
        modelId: 201,
        mediaType: 'image',
        terminalStatus: 'FAILED',
        scoreLogs: [
          { task_id: 88802, type: 2, score: -10, memo: 'IMAGE_GEN' },
        ],
      });
      expect(failRes.verdict).toBe('FAIL');
      expect(failRes.acceptance).toBe('REJECTED');
      expect(failRes.passed).toBe(false);

      // 3. 完整证据 -> PASS
      const passRes = await verify({
        taskId: 88803,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: validMp4,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        scoreLogs: [
          { task_id: 88803, type: 2, score: -70, memo: '任务预扣' },
        ],
      });
      expect(passRes.verdict).toBe('PASS');
      expect(passRes.acceptance).toBe('ACCEPTED');
      expect(passRes.passed).toBe(true);
    });

    it('session 加载失败无条件穿透至裁决引擎，生成 blocker 并判定 UNVERIFIED / BLOCKED', async () => {
      const res = await verify({
        taskId: 88804,
        modelId: 201,
        mediaType: 'image',
        sessionFile: 'non-existent-session-file-xyz.json',
      });

      // 必须由裁决引擎统一求值判定 UNVERIFIED，投影为 BLOCKED
      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.acceptance).toBe('BLOCKED');
      expect(res.passed).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('ERROR');
      expect(res.canonicalVerdict).toBeDefined();
      expect(res.canonicalVerdict?.verdict).toBe('UNVERIFIED');
      expect(res.canonicalVerdict?.blockers?.some((b) => b.code.includes('BLOCKED'))).toBe(true);
    });
  });

  describe('6. CLI 与 TRAE MCP 双入口同源', () => {
    it('MCP 执行 verify 返回的 verdict 与 acceptance 严格与 core-kernel 对齐，零私自二次解释', async () => {
      const service = new DevTestMcpService();

      const mcpResult = await service.call({
        action: 'verify',
        task_id: 88805,
        model_id: 84,
        media_type: 'video',
        terminal_status: 'SUCCESS',
        expected_points: 70,
        score_logs: [
          { task_id: 88805, type: 2, score: -70, memo: '任务预扣' },
        ],
        artifact_buffer: validMp4,
      });

      expect(mcpResult.ok).toBe(true);
      expect(mcpResult.verdict).toBe('PASS');
      expect(mcpResult.acceptance).toBe('ACCEPTED');
      expect(mcpResult.passed).toBe(true);

      const kernelData = mcpResult.data as any;
      expect(mcpResult.verdict).toBe(kernelData.verdict);
      expect(mcpResult.acceptance).toBe(kernelData.acceptance);
      expect(mcpResult.passed).toBe(kernelData.passed);
    });
  });

  describe('7. ResultSink 只写不读与单向不可变导出', () => {
    it('ResultSink 接收深冻结导出的 ExportableVerdictRecord，原裁决与规约绝不受影响', async () => {
      let receivedRecord: any = null;
      const testSink: ResultSink = {
        sinkName: 'test-memory-sink',
        sink: (record) => {
          receivedRecord = record;
        },
      };

      const res = await verify({
        taskId: 88806,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: validMp4,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        scoreLogs: [
          { task_id: 88806, type: 2, score: -70, memo: '任务预扣' },
        ],
        resultSink: testSink,
      });

      expect(res.passed).toBe(true);
      expect(res.exportDelivery).toBeDefined();
      expect(res.exportDelivery?.success).toBe(true);
      expect(res.exportDelivery?.sinkName).toBe('test-memory-sink');

      expect(receivedRecord).toBeDefined();
      expect(receivedRecord.status).toBe('PASSED');
      expect(Object.isFrozen(receivedRecord)).toBe(true);

      // 验证无法篡改导出的记录
      expect(() => {
        receivedRecord.status = 'FAILED';
      }).toThrow();
    });

    it('ResultSink 写入抛错被捕获并记录于 exportDelivery，绝不改变或污染核心裁决结果', async () => {
      const brokenSink: ResultSink = {
        sinkName: 'broken-network-sink',
        sink: () => {
          throw new Error('NETWORK_TIMEOUT_DURING_SINK');
        },
      };

      const res = await verify({
        taskId: 88807,
        modelId: 84,
        mediaType: 'video',
        artifactBuffer: validMp4,
        terminalStatus: 'SUCCESS',
        expectedPoints: 70,
        scoreLogs: [
          { task_id: 88807, type: 2, score: -70, memo: '任务预扣' },
        ],
        resultSink: brokenSink,
      });

      // 业务裁决依然是 PASS，不受 Sink 异常影响
      expect(res.verdict).toBe('PASS');
      expect(res.acceptance).toBe('ACCEPTED');
      expect(res.passed).toBe(true);

      // Sink 异常被清晰记录在 exportDelivery 中
      expect(res.exportDelivery).toBeDefined();
      expect(res.exportDelivery?.success).toBe(false);
      expect(res.exportDelivery?.error).toContain('NETWORK_TIMEOUT_DURING_SINK');
    });
  });

  describe('8. 模式隔离防伪防冒充 (Mode Isolation & No Impersonation)', () => {
    it('REAL 模式下 FIXTURE 证据无法满足 SERVER_API 要求，直接触发防伪门禁阻断', () => {
      const realSpec: CanonicalTestSpec = {
        testId: 'spec-real-tamper',
        requirementId: 'REQ-REAL-1',
        scenario: 'REAL_ONLINE_CHECK',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model', modelId: 201 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['SERVER_API:TASK_STATUS'],
      };

      // 伪造的信封：虽然写着 SERVER_API:TASK_STATUS，但 sourceType 是 FIXTURE
      const fakeEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'fake-task-env-1',
        testId: 'spec-real-tamper',
        sourceTool: 'untrusted-script',
        sourceType: 'FIXTURE',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: '2026-09-21T12:00:00.000Z',
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
        normalizedFields: { taskId: 12345, observedStatus: 'PASS' },
        provenance: 'LOCAL_FIXTURE',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const verdictRes = evaluateCanonicalVerdict(realSpec, [fakeEnv]);
      expect(verdictRes.verdict).toBe('UNVERIFIED');
      expect(verdictRes.blockers.some((b) => b.code === 'UNTRUSTED_EVIDENCE_SOURCE')).toBe(true);
    });
  });

  describe('9. 生产环境零外部重型依赖与架构纯洁性', () => {
    it('不需要任何可选 Adapter 依然能够独立完整运行核心流程', async () => {
      // 不传任何 adapter, sink, producers
      const res = await plan({ modelId: 201, mediaType: 'image' });
      expect(res.ok).toBe(true);
      expect(res.canonicalSpec).toBeDefined();
    });
  });

  describe('10. 生产调用链最终架构收敛 18 项反证回归测试', () => {
    it('1. mode=real 但未显式授权时，Adapter handler 调用次数必须为 0', async () => {
      const handlerSpy = vi.fn().mockResolvedValue({ taskId: 9999, message: 'ok' });
      const adapter: ExecutionAdapter = {
        adapterName: 'test-spy-adapter',
        supportedModes: ['REAL', 'OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec, ctx) => {
          await handlerSpy(spec, ctx);
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'SUBMITTED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const res = await execute({
        mode: 'real',
        modelId: 84,
        mediaType: 'video',
        executionAdapter: adapter,
        // 未传 allowSubmit 或 allowPaid，默认 sideEffectPolicy: 'READ_ONLY'
      });

      expect(handlerSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_UNAUTHORIZED_REAL_SUBMIT');
    });

    it('2. ALLOW_SUBMIT 不能自动生成，默认永远为 READ_ONLY', () => {
      const spec = mapExecuteToCanonicalTestSpec({ mode: 'real', modelId: 84, mediaType: 'video' });
      expect(spec.sideEffectPolicy).toBe('READ_ONLY');
      expect(spec.costLimit.maxCostPoints).toBe(0);
      expect(spec.costLimit.allowZeroCostOnly).toBe(true);

      const planSpecRes = mapPlanToCanonicalTestSpec(
        { modelId: 84, mediaType: 'video', expectedPoints: 56 } as any,
        { testId: 'test-plan-no-auto-grant', executionMode: 'REAL' }
      );
      expect(planSpecRes.success).toBe(false);
      expect(planSpecRes.issues.some((i) => i.code === 'UNAUTHORIZED_PAID_EXECUTION')).toBe(true);

      const zeroCostPlan = mapPlanToCanonicalTestSpec(
        { modelId: 84, mediaType: 'video', expectedPoints: 0 } as any,
        { testId: 'test-plan-zero-cost', executionMode: 'REAL' }
      );
      expect(zeroCostPlan.value?.sideEffectPolicy).toBe('READ_ONLY');
      expect(zeroCostPlan.value?.costLimit.maxCostPoints).toBe(0);
    });

    it('3. ALLOW_PAID 缺少 costLimit 或预算不足时严格阻断，handler 调用次数为 0', async () => {
      const handlerSpy = vi.fn().mockResolvedValue({ taskId: 8888, message: 'ok' });
      const adapter: ExecutionAdapter = {
        adapterName: 'test-spy-adapter',
        supportedModes: ['REAL'],
        supportedSideEffectPolicies: ['ALLOW_PAID'],
        execute: async (spec, ctx) => {
          await handlerSpy(spec, ctx);
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'SUBMITTED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const res = await execute({
        mode: 'real',
        modelId: 84,
        mediaType: 'video',
        allowPaid: true,
        // 未传 maxCostPoints，默认 costLimit 为 0，而 84 视频模型需要 56 pt
        executionAdapter: adapter,
      });

      expect(handlerSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_INSUFFICIENT_COST_LIMIT');
    });

    it('4. canonicalSpec.modelId 与 legacy modelId 不一致时阻断为 BLOCKED_SPEC_INPUT_CONFLICT', async () => {
      const spec: CanonicalTestSpec = {
        testId: 'spec-conflict-model',
        requirementId: 'REQ-MODEL-1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:TASK_STATUS'],
      };

      const res = await execute({
        modelId: 201, // 与 spec.target.modelId 84 冲突
        mediaType: 'video',
        canonicalSpec: spec,
      });

      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('BLOCKED_SPEC_INPUT_CONFLICT');
    });

    it('5. canonicalSpec.executionMode 与 legacy mode 不一致时阻断为 BLOCKED_SPEC_INPUT_CONFLICT', async () => {
      const spec: CanonicalTestSpec = {
        testId: 'spec-conflict-mode',
        requirementId: 'REQ-MODE-1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:TASK_STATUS'],
      };

      const res = await execute({
        mode: 'mock', // 与 spec.executionMode REAL 冲突
        modelId: 84,
        mediaType: 'video',
        canonicalSpec: spec,
      });

      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
    });

    it('6. 无效 TestSpec 在任何 Adapter/I/O 前阻断，Adapter 调用次数为 0', async () => {
      const adapterSpy = vi.fn();
      const adapter: ExecutionAdapter = {
        adapterName: 'test-adapter',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const invalidSpec = {
        testId: '', // 空 testId 非法
        scenario: 'VIDEO_NEW_MODEL',
        executionMode: 'OFFLINE',
      } as any;

      const res = await executeCanonical(invalidSpec, { executionAdapter: adapter });
      expect(adapterSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_INVALID_TEST_SPEC');
    });

    it('7. 默认 execute 绝不再直接调用 submitMediaTask', async () => {
      const submitSpy = vi.spyOn(mediaFlow, 'submitMediaTask');
      await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'real',
      });
      expect(submitSpy).toHaveBeenCalledTimes(0);
      submitSpy.mockRestore();
    });

    it('8. 没有 Adapter 时返回 BLOCKED_NO_EXECUTION_ADAPTER，禁止静默回退内置执行路径', async () => {
      const res = await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'mock',
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_NO_EXECUTION_ADAPTER');
      expect(res.message).toContain('BLOCKED_NO_EXECUTION_ADAPTER');
    });

    it('9. Panqu Adapter 没有真实 handler 时 REAL 阻断，OFFLINE 返回 DRY_RUN，绝不伪造 SUBMITTED/COMPLETED', async () => {
      const adapter = new PanquMediaExecutionAdapter();
      const baseSpec: CanonicalTestSpec = {
        testId: 'spec-adapter-no-handler',
        requirementId: 'REQ-ADAPTER-1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'ALLOW_SUBMIT',
        requiredEvidence: ['SERVER_API:TASK_STATUS'],
      };

      // REAL 模式无 handler: 返回 BLOCKED_NO_EXECUTOR
      const realResult = await adapter.execute(baseSpec);
      expect(realResult.status).toBe('BLOCKED');
      expect(realResult.error?.code).toBe('BLOCKED_NO_EXECUTOR');
      expect(realResult.metadata?.taskId).toBeUndefined();

      // OFFLINE 模式无 handler: 返回 OFFLINE_DRY_RUN
      const offlineResult = await adapter.execute({ ...baseSpec, executionMode: 'OFFLINE' });
      expect(offlineResult.status).toBe('BLOCKED');
      expect(offlineResult.error?.code).toBe('OFFLINE_DRY_RUN');
      expect(offlineResult.metadata?.taskId).toBeUndefined();
    });

    it('10. Adapter 不支持 executionMode 时在调用前阻断，handler 调用次数为 0', async () => {
      const handlerSpy = vi.fn();
      const offlineOnlyAdapter: ExecutionAdapter = {
        adapterName: 'offline-only-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_PAID'],
        execute: async (spec) => {
          handlerSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const res = await execute({
        mode: 'real',
        modelId: 84,
        mediaType: 'video',
        allowPaid: true,
        maxCostPoints: 100,
        executionAdapter: offlineOnlyAdapter,
      });

      expect(handlerSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_UNSUPPORTED_MODE');
    });

    it('11. Adapter 输出 testId 与 spec 不一致时拒绝并阻断 (BLOCKED_TEST_ID_MISMATCH)', async () => {
      const mismatchAdapter: ExecutionAdapter = {
        adapterName: 'mismatch-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          return {
            executionId: `exec-${spec.testId}`,
            testId: 'different-test-id-mismatch',
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const res = await execute({
        mode: 'mock',
        modelId: 84,
        mediaType: 'video',
        executionAdapter: mismatchAdapter,
      });

      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_TEST_ID_MISMATCH');
    });

    it('12. 所有 BLOCKED/FAILED 分支都必须包含规范的 ExecutionResult 与 canonicalSpec', async () => {
      // (a) 缺少 adapter 阻断分支
      const resNoAdapter = await execute({ mode: 'mock', modelId: 84, mediaType: 'video' });
      expect(resNoAdapter.executionResult).toBeDefined();
      expect(resNoAdapter.executionResult?.status).toBe('BLOCKED');
      expect(resNoAdapter.canonicalSpec).toBeDefined();
      validateExecutionResult(resNoAdapter.executionResult!);

      // (b) 未授权 REAL 提交阻断分支
      const dummyAdapter = new TestOfflineExecutionAdapter();
      const resUnauthorized = await execute({ mode: 'real', modelId: 84, mediaType: 'video', executionAdapter: dummyAdapter });
      expect(resUnauthorized.executionResult).toBeDefined();
      expect(resUnauthorized.executionResult?.status).toBe('BLOCKED');
      expect(resUnauthorized.canonicalSpec).toBeDefined();
      validateExecutionResult(resUnauthorized.executionResult!);

      // (c) 输入冲突阻断分支
      const conflictSpec: CanonicalTestSpec = {
        testId: 'spec-conflict',
        requirementId: 'REQ-1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:TASK_STATUS'],
      };
      const resConflict = await execute({ modelId: 201, mediaType: 'video', canonicalSpec: conflictSpec });
      expect(resConflict.executionResult).toBeDefined();
      expect(resConflict.executionResult?.status).toBe('BLOCKED');
      expect(resConflict.canonicalSpec).toBeDefined();
      validateExecutionResult(resConflict.executionResult!);
    });

    it('13. MCP probe/plan/execute 不再自行推导最终 PASS/FAIL，passed 永远为 false', async () => {
      const mcpService = new DevTestMcpService({
        executionAdapter: new TestOfflineExecutionAdapter(),
      });

      // probe
      const probeRes = await mcpService.call({ action: 'probe', mock: true, env: 'test' });
      expect(probeRes.passed).toBe(false);
      expect(probeRes.operationStatus).toBeDefined();
      expect(probeRes.lifecycleStatus).toBeDefined();

      // plan
      const planRes = await mcpService.call({ action: 'plan', model_id: 84, media_type: 'video' });
      expect(planRes.passed).toBe(false);
      expect(planRes.operationStatus).toBeDefined();
      expect(planRes.lifecycleStatus).toBeDefined();

      // execute
      const execRes = await mcpService.call({ action: 'execute', model_id: 84, media_type: 'video', mode: 'mock' });
      expect(execRes.passed).toBe(false);
      expect(execRes.operationStatus).toBeDefined();
      expect(execRes.lifecycleStatus).toBeDefined();
    });

    it('14. MCP verify 与 core-kernel Canonical 结果完全一致，无任何中间二次篡改', async () => {
      const mcpService = new DevTestMcpService();
      const verifyKernelRes = await verify({
        taskId: 9527,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        scoreLogs: [{ task_id: 9527, type: 2, score: -56 }],
      });

      const mcpVerifyRes = await mcpService.call({
        action: 'verify',
        task_id: 9527,
        model_id: 84,
        media_type: 'video',
        terminal_status: 'SUCCESS',
        score_logs: [{ task_id: 9527, type: 2, score: -56 }],
      });

      expect(mcpVerifyRes.verdict).toBe(verifyKernelRes.verdict);
      expect(mcpVerifyRes.acceptance).toBe(verifyKernelRes.acceptance);
      expect(mcpVerifyRes.data.canonicalVerdict?.verdict).toBe(verifyKernelRes.canonicalVerdict?.verdict);
    });

    it('15. Requirement 自然语言文本绝不充当 requirementId，缺失稳定 ID 时置为 UNRESOLVED_REQUIREMENT', () => {
      expect(isStableRequirementId('对齐 84 视频分流')).toBe(false);
      expect(isStableRequirementId('REQ-DEFAULT')).toBe(false);
      expect(isStableRequirementId('UNRESOLVED_REQUIREMENT')).toBe(false);
      expect(isStableRequirementId('REQ-VIDEO-DIVERSION-84')).toBe(true);

      const resolved = resolveRequirementTraceForSpec({
        requirement: '对齐 84 视频分流，修改网关路由逻辑',
      });
      expect(resolved.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(resolved.requirementText).toBe('对齐 84 视频分流，修改网关路由逻辑');
      expect(resolved.impactAnalysis.executed).toBe(false);
    });

    it('16. 纯 mapper 移除 Date.now() / Math.random() / I/O，相同输入产生完全相同输出', () => {
      const input = {
        modelId: 84,
        mediaType: 'video',
        mode: 'mock',
        prompt: 'test prompt',
      };
      const spec1 = mapExecuteToCanonicalTestSpec(input, { testId: 'static-test-id' });
      const spec2 = mapExecuteToCanonicalTestSpec(input, { testId: 'static-test-id' });
      expect(JSON.stringify(spec1)).toBe(JSON.stringify(spec2));

      const planInput = {
        modelId: 84,
        mediaType: 'video',
        expectedPoints: 56,
        scenario: 'VIDEO_NEW_MODEL',
      } as any;
      const planSpec1 = mapPlanToCanonicalTestSpec(planInput, { testId: 'plan-static-id' });
      const planSpec2 = mapPlanToCanonicalTestSpec(planInput, { testId: 'plan-static-id' });
      expect(JSON.stringify(planSpec1.value)).toBe(JSON.stringify(planSpec2.value));
    });

    it('17. 静态检查：core-kernel.ts 不再直接 import 或调用 submitMediaTask', () => {
      const coreKernelPath = join(process.cwd(), 'src/devtest/core-kernel.ts');
      const content = readFileSync(coreKernelPath, 'utf-8');
      const importRegex = /import\s+.*submitMediaTask.*from/g;
      expect(content.match(importRegex)).toBeNull();
      const callRegex = /\bsubmitMediaTask\s*\(/g;
      expect(content.match(callRegex)).toBeNull();
    });

    it('18. 现有 REAL/OFFLINE/FIXTURE 防冒充与证据信封完整性防线依然坚固', () => {
      const realSpec: CanonicalTestSpec = {
        testId: 'spec-real-18',
        requirementId: 'REQ-18',
        scenario: 'REAL_GATEWAY_CHECK',
        environment: 'test',
        executionMode: 'REAL',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['SERVER_API:TASK_STATUS'],
      };
      const fakeFixtureEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'fake-env-18',
        testId: 'spec-real-18',
        sourceTool: 'fake-producer',
        sourceType: 'FIXTURE',
        evidenceKey: 'SERVER_API:TASK_STATUS',
        observationStatus: 'PASS',
        capturedAt: new Date().toISOString(),
        environment: 'test',
        subjectType: 'task',
        subjectId: 18,
        normalizedFields: {},
        provenance: 'FIXTURE',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };
      const verdict = evaluateCanonicalVerdict(realSpec, [fakeFixtureEnv]);
      expect(verdict.verdict).toBe('UNVERIFIED');
      expect(verdict.blockers.some((b) => b.code === 'UNTRUSTED_EVIDENCE_SOURCE')).toBe(true);
    });
  });

  describe('11. 关闭 DevTest 6 大可信度缺口与完整收敛验证', () => {
    // 1. 提交回执证据语义修正
    it('1.1 TestOfflineExecutionAdapter 只能输出 FIXTURE 证据，严禁产生 SERVER_API 证据', async () => {
      // 1) SUBMITTED 状态
      const submittedAdapter = new TestOfflineExecutionAdapter({
        status: 'SUBMITTED',
        taskId: 12345,
      });
      const spec: CanonicalTestSpec = {
        testId: 'spec-submitted-semantic-1',
        requirementId: 'REQ-1.1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['FIXTURE:TASK_STATUS'],
      };
      const subResult = await submittedAdapter.execute(spec);
      expect(subResult.status).toBe('SUBMITTED');
      const subReceipt = subResult.evidence.find(
        (e) => e.evidenceKey === 'FIXTURE:TASK_SUBMISSION_RECEIPT'
      );
      expect(subReceipt).toBeDefined();
      expect(subReceipt?.sourceType).toBe('FIXTURE');
      expect(subReceipt?.observationStatus).toBe('UNVERIFIED');
      expect(subReceipt?.normalizedFields.lifecycleStatus).toBe('SUBMITTED');
      expect(subResult.evidence.every((e) => e.sourceType === 'FIXTURE')).toBe(true);

      // 2) COMPLETED 状态
      const completedAdapter = new TestOfflineExecutionAdapter({
        status: 'COMPLETED',
        taskId: 12345,
      });
      const compResult = await completedAdapter.execute(spec);
      expect(compResult.status).toBe('COMPLETED');
      const compEnv = compResult.evidence.find((e) => e.evidenceKey === 'FIXTURE:TASK_STATUS');
      expect(compEnv).toBeDefined();
      expect(compEnv?.sourceType).toBe('FIXTURE');
      expect(compEnv?.observationStatus).toBe('PASS');

      // 3) FAILED 状态
      const failedAdapter = new TestOfflineExecutionAdapter({
        status: 'FAILED',
        taskId: 12345,
      });
      const failResult = await failedAdapter.execute(spec);
      expect(failResult.status).toBe('FAILED');
      const failEnv = failResult.evidence.find((e) => e.evidenceKey === 'FIXTURE:TASK_STATUS');
      expect(failEnv).toBeDefined();
      expect(failEnv?.sourceType).toBe('FIXTURE');
      expect(failEnv?.observationStatus).toBe('FAIL');

      // 4) BLOCKED 状态
      const blockedAdapter = new TestOfflineExecutionAdapter({
        status: 'BLOCKED',
        taskId: 12345,
      });
      const blockResult = await blockedAdapter.execute(spec);
      expect(blockResult.status).toBe('BLOCKED');
      const blockEnv = blockResult.evidence.find((e) => e.evidenceKey === 'FIXTURE:TASK_STATUS');
      expect(blockEnv).toBeDefined();
      expect(blockEnv?.sourceType).toBe('FIXTURE');
      expect(blockEnv?.observationStatus).toBe('UNVERIFIED');

      // 核心不变量：绝不可产生 SERVER_API 证据
      expect(subResult.evidence.some((e) => e.sourceType === 'SERVER_API')).toBe(false);
      expect(compResult.evidence.some((e) => e.sourceType === 'SERVER_API')).toBe(false);
      expect(failResult.evidence.some((e) => e.sourceType === 'SERVER_API')).toBe(false);
      expect(blockResult.evidence.some((e) => e.sourceType === 'SERVER_API')).toBe(false);
    });

    it('1.2 requiredEvidence 为 TASK_STATUS 时，仅有 SUBMISSION_RECEIPT 回执时 Verdict 必为 UNVERIFIED', () => {
      const spec: CanonicalTestSpec = {
        testId: 'spec-submitted-verdict-unverified',
        requirementId: 'REQ-1.2',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: ['SERVER_API:TASK_STATUS'],
      };
      const receiptEnv: CanonicalEvidenceEnvelope = {
        evidenceId: 'env-receipt-1',
        testId: 'spec-submitted-verdict-unverified',
        sourceTool: 'test-adapter',
        sourceType: 'SERVER_API',
        evidenceKey: 'SERVER_API:TASK_SUBMISSION_RECEIPT',
        observationStatus: 'UNVERIFIED',
        capturedAt: new Date().toISOString(),
        environment: 'test',
        subjectType: 'task',
        subjectId: 12345,
        normalizedFields: {
          taskId: 12345,
          lifecycleStatus: 'SUBMITTED',
        },
        provenance: 'SERVER_API:SUBMIT_RECEIPT',
        confidence: 1.0,
        immutable: true,
        redacted: true,
        collectionStatus: 'SUCCESS',
      };

      const evalReq = evaluateRequiredEvidence(spec, [receiptEnv]);
      expect(evalReq.satisfied).toBe(false);
      expect(evalReq.missingEvidenceKeys).toContain('SERVER_API:TASK_STATUS');

      const verdict = evaluateCanonicalVerdict(spec, [receiptEnv]);
      expect(verdict.verdict).toBe('UNVERIFIED');
      expect(verdict.blockers.some((b) => b.code === 'TASK_NOT_TERMINAL')).toBe(true);
    });

    it('1.3 PanquMediaExecutionAdapter 自定义 submitHandler 永远只能产生 USER_ASSERTION，禁止依靠字符串 provenance 升级', async () => {
      const customHandler = vi.fn().mockResolvedValue({
        taskId: 6666,
        points: 0,
        message: 'caller declared submission with fake official claim',
        provenance: 'SERVER_API:TASK_STATUS_OFFICIAL', // 恶意伪造 SERVER_API 来源字符串
      });
      const adapter = new PanquMediaExecutionAdapter({
        submitHandler: customHandler,
      });
      const spec: CanonicalTestSpec = {
        testId: 'spec-user-assertion-fallback',
        requirementId: 'REQ-1.3',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'ALLOW_SUBMIT',
        requiredEvidence: [],
      };
      const result = await adapter.execute(spec);
      expect(result.status).toBe('SUBMITTED');
      expect(result.evidence.length).toBe(1);
      const env = result.evidence[0];
      // 必须严格为 USER_ASSERTION，绝不可根据传入的 provenance 字符串升级为 SERVER_API
      expect(env.sourceType).toBe('USER_ASSERTION');
      expect(env.evidenceKey).toBe('USER_ASSERTION:TASK_SUBMISSION_RECEIPT');
      expect(env.provenance).toBe('panqu-media-execution-adapter:CUSTOM_SUBMIT_HANDLER_ASSERTION');
      expect(env.provenance).not.toContain('SERVER_API');
      expect(env.observationStatus).toBe('UNVERIFIED');
    });

    // 2. 禁止虚构 Requirement ID
    it('2.1 probe, plan, execute, verify 无 Trace 输入时，spec.requirementId 严格为 UNRESOLVED_REQUIREMENT', async () => {
      const probeRes = await probe({ mock: true, env: 'test' });
      expect(probeRes.canonicalSpec?.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(probeRes.canonicalSpec?.requirementId).not.toContain('REQ-ENV-PROBE');

      const planRes = await plan({ modelId: 84, mediaType: 'video' });
      expect(planRes.canonicalSpec?.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(planRes.canonicalSpec?.requirementId).not.toContain('REQ-PLAN');

      const execRes = await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'mock',
        executionAdapter: new TestOfflineExecutionAdapter(),
      });
      expect(execRes.canonicalSpec?.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(execRes.canonicalSpec?.requirementId).not.toContain('REQ-EXEC-84');

      const verifyRes = await verify({
        taskId: 9527,
        modelId: 84,
        mediaType: 'video',
      });
      expect(verifyRes.canonicalSpec?.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(verifyRes.canonicalSpec?.requirementId).not.toContain('REQ-VERIFY');
    });

    it('2.2 自然语言文本只能进入 requirementText，requirementId 必须保持 UNRESOLVED_REQUIREMENT', () => {
      const trace = resolveRequirementTraceForSpec({
        requirement: '这是一段关于视频分流与画质对比的自然语言需求说明',
      });
      expect(trace.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(trace.requirementText).toBe('这是一段关于视频分流与画质对比的自然语言需求说明');
      expect(trace.impactAnalysis.executed).toBe(false);

      const spec = mapExecuteToCanonicalTestSpec({
        modelId: 84,
        mediaType: 'video',
        requirement: '这是 execute 传入的自然语言',
      });
      expect(spec.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(spec.metadata?.requirementText).toBe('这是 execute 传入的自然语言');
    });

    // 3. 彻底删除 MCP 执行前旁路
    it('3.1 静态检查：mcp-service.ts 源码中不包含 RoutingOracle.disambiguateTarget 与 session 路径拦截', () => {
      const mcpPath = join(process.cwd(), 'src/devtest/mcp-service.ts');
      const content = readFileSync(mcpPath, 'utf-8');
      expect(content.includes('RoutingOracle.disambiguateTarget')).toBe(false);
      expect(content.includes('disambiguateTarget')).toBe(false);
      expect(/existsSync\(.*session.*\)/i.test(content)).toBe(false);
    });

    it('3.2 MCP execute 参数校验与阻断完整穿透至 core-kernel，阻断由 core-kernel/Adapter 产生', async () => {
      const mcpService = new DevTestMcpService({
        executionAdapter: new TestOfflineExecutionAdapter(),
      });
      // 传入 real 模式但未授权：阻断由 core-kernel 的 sideEffectPolicy 门禁抛出
      const res = await mcpService.call({
        action: 'execute',
        model_id: 84,
        media_type: 'video',
        mode: 'real',
      });
      expect(res.operationStatus).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_UNAUTHORIZED_REAL_SUBMIT');
      expect(res.data.executionResult).toBeDefined();
      expect(res.data.canonicalSpec).toBeDefined();
    });

    // 4. 完整关闭 CanonicalSpec 与 Legacy 双输入冲突
    it('4.1 canonicalSpec 与 legacy input 的 mediaType 冲突时立即阻断，Adapter 调用次数为 0', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'spy-adapter',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-conflict-mediatype',
        requirementId: 'REQ-4.1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        modelId: 84,
        mediaType: 'image', // 冲突！
        canonicalSpec: spec,
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('mediaType');
      expect(res.message).toContain('禁止同时传入任何业务 legacy 字段');
    });

    it('4.2 canonicalSpec 与 legacy input 在 channel, prompt, budgetPoints 冲突时均被阻断，Adapter 调用次数为 0', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'spy-adapter-2',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const baseConflictSpec: CanonicalTestSpec = {
        testId: 'spec-conflict-base',
        requirementId: 'REQ-4.2',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { prompt: 'spec prompt', channel: 'panqu_media' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      // prompt 冲突
      const resPrompt = await execute({
        modelId: 84,
        mediaType: 'video',
        prompt: 'different prompt',
        canonicalSpec: baseConflictSpec,
        executionAdapter: mockAdapter,
      });
      expect(resPrompt.ok).toBe(false);
      expect(resPrompt.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(adapterSpy).toHaveBeenCalledTimes(0);

      // channel 冲突
      const resChannel = await execute({
        modelId: 84,
        mediaType: 'video',
        prompt: 'spec prompt',
        channelId: 101,
        canonicalSpec: {
          ...baseConflictSpec,
          target: { ...baseConflictSpec.target, expectedChannelId: 202 },
        },
        executionAdapter: mockAdapter,
      });
      expect(resChannel.ok).toBe(false);
      expect(resChannel.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(adapterSpy).toHaveBeenCalledTimes(0);

      // budgetPoints 冲突
      const baseBudgetConflictSpec: CanonicalTestSpec = {
        testId: 'spec-conflict-budget',
        requirementId: 'REQ-4.2-budget',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { prompt: 'spec prompt' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 100 },
        sideEffectPolicy: 'ALLOW_PAID',
        requiredEvidence: [],
      };

      const resBudget = await execute({
        modelId: 84,
        mediaType: 'video',
        prompt: 'spec prompt',
        budgetPoints: 50,
        canonicalSpec: baseBudgetConflictSpec,
        executionAdapter: mockAdapter,
      });
      expect(resBudget.ok).toBe(false);
      expect(resBudget.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(adapterSpy).toHaveBeenCalledTimes(0);
    });

    it('4.3 传入 canonicalSpec 且仅提供运行设施依赖 (executionAdapter, sessionFile, env, channels) 时顺利放行，Adapter 调用 1 次', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'runtime-only-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-runtime-deps-only',
        requirementId: 'REQ-4.3',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        executionAdapter: mockAdapter,
        env: 'test',
        sessionFile: 'session.json',
      });

      expect(res.ok).toBe(true);
      expect(adapterSpy).toHaveBeenCalledTimes(1);
    });

    // 5. 恢复迁移丢失的提交参数
    it('5.1 aspectRatio, serviceline, flow, flowType, extraParams 完整透传到 spec.inputs 并送达 Adapter', async () => {
      let capturedSpec: CanonicalTestSpec | undefined;
      const captureAdapter: ExecutionAdapter = {
        adapterName: 'capture-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          capturedSpec = spec;
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      await execute({
        modelId: 84,
        mediaType: 'video',
        mode: 'mock',
        aspectRatio: '16:9',
        serviceline: 'panqu_media_v2',
        flow: 'custom-pipeline',
        flowType: 'diversion',
        extraParams: { seed: 9999, negativePrompt: 'blurry' },
        executionAdapter: captureAdapter,
      });

      expect(capturedSpec).toBeDefined();
      expect(capturedSpec?.inputs.aspectRatio).toBe('16:9');
      expect(capturedSpec?.inputs.serviceline).toBe('panqu_media_v2');
      expect(capturedSpec?.inputs.flow).toBe('custom-pipeline');
      expect(capturedSpec?.inputs.flowType).toBe('diversion');
      expect((capturedSpec?.inputs.extraParams as any)?.seed).toBe(9999);
      expect((capturedSpec?.inputs.extraParams as any)?.negativePrompt).toBe('blurry');
    });

    it('5.2 非标契约 Model 84 (480p) 与 Model 15 (3s) 不被硬编码强行覆盖为 720p / 4s', async () => {
      let executedEffectiveSpec: CanonicalTestSpec | undefined;
      const recordingAdapter: ExecutionAdapter = {
        adapterName: 'recording-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          executedEffectiveSpec = spec;
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec84 = mapExecuteToCanonicalTestSpec({ modelId: 84, mediaType: 'video', prompt: 'test' });
      expect(spec84.inputs.resolution).toBeUndefined();
      await executeCanonical(spec84, { executionAdapter: recordingAdapter });
      expect(executedEffectiveSpec?.inputs.resolution).toBe('480p');

      const spec15 = mapExecuteToCanonicalTestSpec({ modelId: 15, mediaType: 'video', prompt: 'test' });
      expect(spec15.inputs.duration).toBeUndefined();
      await executeCanonical(spec15, { executionAdapter: recordingAdapter });
      expect(executedEffectiveSpec?.inputs.duration).toBe(3);
    });

    // 6. Adapter 异常与非法输出结构化阻断
    it('6.1 Adapter 返回非法 ExecutionResult（如缺失 testId 或含禁止 verdict 字段）时返回结构化 BLOCKED 而非抛出异常', async () => {
      const badAdapter: ExecutionAdapter = {
        adapterName: 'bad-result-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async () => {
          return {
            executionId: 'exec-bad-1',
            // 缺失 testId
            status: 'COMPLETED',
            verdict: 'PASS', // 禁止字段！
          } as any;
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-bad-output-test',
        requirementId: 'REQ-6.1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await executeCanonical(spec, { executionAdapter: badAdapter });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
      expect(res.message).toBeDefined();
    });

    it('6.2 Adapter.execute 内部 throw Error 时结构化捕获为 ADAPTER_EXECUTION_ERROR，无未捕获异常泄露', async () => {
      const throwingAdapter: ExecutionAdapter = {
        adapterName: 'throwing-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async () => {
          throw new Error('网络连接异常被主动重置 (ECONNRESET)');
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-throwing-adapter-test',
        requirementId: 'REQ-6.2',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await executeCanonical(spec, { executionAdapter: throwingAdapter });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('ADAPTER_EXECUTION_ERROR');
      expect(res.message).toContain('ECONNRESET');
    });

    it('6.3 Adapter 返回非法 EvidenceEnvelope 时结构化返回 BLOCKED_INVALID_ADAPTER_OUTPUT', async () => {
      const badEvidenceAdapter: ExecutionAdapter = {
        adapterName: 'bad-evidence-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [
              {
                evidenceId: 'env-bad-1',
                testId: 'MISMATCHED_TEST_ID', // 与 spec.testId 不匹配
                sourceTool: 'bad-tool',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_STATUS',
                observationStatus: 'PASS',
                capturedAt: new Date().toISOString(),
                environment: 'test',
                subjectType: 'task',
                subjectId: 1,
                normalizedFields: {},
                provenance: 'test',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              } as any,
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-bad-envelope-test',
        requirementId: 'REQ-6.3',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: {},
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await executeCanonical(spec, { executionAdapter: badEvidenceAdapter });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
    });

    // 7. CLI / MCP 对 dbExtraConfirmed、gatewayChannelConfirmed 保留 undefined
    it('7.1 MCP verify 对 dbExtraConfirmed 与 gatewayChannelConfirmed 保留 undefined，只有明确传入时才转换为 boolean', async () => {
      const mcpService = new DevTestMcpService();

      // 1. 未传时：严格保留 undefined，不强制转为 false，不会触发 FIXTURE:GATEWAY_CHANNEL 必需证据
      const resUnset = await mcpService.call({
        action: 'verify',
        task_id: 12345,
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        is_simulated: true,
      });
      expect(resUnset.ok).toBe(true);
      const reqEvidenceUnset = (resUnset.data as any).canonicalSpec?.requiredEvidence || [];
      expect(reqEvidenceUnset).not.toContain('FIXTURE:GATEWAY_CHANNEL');

      // 2. 明确传入 true 时，布尔转换为 true，触发 isGatewayInScope 为 true 并要求 FIXTURE:GATEWAY_CHANNEL
      const resTrue = await mcpService.call({
        action: 'verify',
        task_id: 12345,
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        is_simulated: true,
        db_extra_confirmed: true,
        gateway_channel_confirmed: true,
      });
      expect(resTrue.ok).toBe(true);
      const reqEvidenceTrue = (resTrue.data as any).canonicalSpec?.requiredEvidence || [];
      expect(reqEvidenceTrue).toContain('FIXTURE:GATEWAY_CHANNEL');

      // 3. 明确传入 false 时，布尔转换为 false，同样触发 isGatewayInScope 为 true 并要求 FIXTURE:GATEWAY_CHANNEL
      const resFalse = await mcpService.call({
        action: 'verify',
        task_id: 12345,
        model_id: 84,
        media_type: 'video',
        mode: 'mock',
        is_simulated: true,
        db_extra_confirmed: false,
        gateway_channel_confirmed: false,
      });
      expect(resFalse.ok).toBe(true);
      const reqEvidenceFalse = (resFalse.data as any).canonicalSpec?.requiredEvidence || [];
      expect(reqEvidenceFalse).toContain('FIXTURE:GATEWAY_CHANNEL');
    });

    it('7.2 CLI 执行与验证入参解析中，dbExtraConfirmed 与 gatewayChannelConfirmed 严格保留 undefined 三态语义', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.join(' '));
      });
      try {
        // 1. 未传 --db-extra-confirmed 与 --gateway-channel-confirmed 时保留 undefined
        logs.length = 0;
        const codeUnset = await runDevTestCli([
          'verify',
          '--task', '12345',
          '--model', '84',
          '--media', 'video',
          '--is-simulated',
          '--json',
        ]);
        expect(codeUnset).toBe(1);
        const jsonUnset = JSON.parse(logs.join(''));
        expect(jsonUnset.ok).toBe(true);
        const reqEvidenceUnset = jsonUnset.canonicalSpec?.requiredEvidence || [];
        expect(reqEvidenceUnset).not.toContain('FIXTURE:GATEWAY_CHANNEL');

        // 2. 显式传入标志时转为 true
        logs.length = 0;
        const codeTrue = await runDevTestCli([
          'verify',
          '--task', '12345',
          '--model', '84',
          '--media', 'video',
          '--is-simulated',
          '--db-extra-confirmed',
          '--gateway-channel-confirmed',
          '--json',
        ]);
        expect(codeTrue).toBe(1);
        const jsonTrue = JSON.parse(logs.join(''));
        expect(jsonTrue.ok).toBe(true);
        const reqEvidenceTrue = jsonTrue.canonicalSpec?.requiredEvidence || [];
        expect(reqEvidenceTrue).toContain('FIXTURE:GATEWAY_CHANNEL');
      } finally {
        logSpy.mockRestore();
      }
    });

    // 8. 彻底修复环境双事实源漏洞 (反证测试)
    it('8.1 spec=test、env=preonline：阻断，Adapter 调用次数为 0', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'env-test-adapter-1',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-env-test-preonline-conflict',
        requirementId: 'REQ-ENV-8.1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        env: 'preonline', // 冲突！
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('preonline');
      expect(res.message).toContain('test');
    });

    it('8.2 spec=preonline、env=test：阻断，Adapter 调用次数为 0', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'env-test-adapter-2',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-env-preonline-test-conflict',
        requirementId: 'REQ-ENV-8.2',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'preonline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        env: 'test', // 冲突！
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('BLOCKED_SPEC_INPUT_CONFLICT');
      expect(res.message).toContain('test');
      expect(res.message).toContain('preonline');
    });

    it('8.3 两者一致：允许进入 Adapter (调用 1 次)', async () => {
      const adapterSpy = vi.fn();
      let receivedSpec: CanonicalTestSpec | undefined;
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'env-test-adapter-3',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          receivedSpec = spec;
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-env-consistent',
        requirementId: 'REQ-ENV-8.3',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'preonline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        env: 'preonline', // 一致！
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(receivedSpec?.environment).toBe('preonline');
    });

    it('8.4 未传 env：使用 spec.environment 顺利进入 Adapter (调用 1 次)', async () => {
      const adapterSpy = vi.fn();
      let receivedSpec: CanonicalTestSpec | undefined;
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'env-test-adapter-4',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          receivedSpec = spec;
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-env-omitted',
        requirementId: 'REQ-ENV-8.4',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'test',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        // env 未传！
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(receivedSpec?.environment).toBe('test');
    });

    it('8.5 未知环境：阻断，Adapter 调用次数为 0，且禁止默认指向 test/preonline/production', async () => {
      const adapterSpy = vi.fn();
      const mockAdapter: ExecutionAdapter = {
        adapterName: 'env-test-adapter-5',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      // 1. 在 execute / executeCanonical 阶段直接阻断未知环境
      const unknownSpec: CanonicalTestSpec = {
        testId: 'spec-env-unknown',
        requirementId: 'REQ-ENV-8.5',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'unknown-environment', // 未知环境！
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: unknownSpec,
        executionAdapter: mockAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(0);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_UNKNOWN_ENVIRONMENT');
      expect(res.message).toContain('BLOCKED_UNKNOWN_ENVIRONMENT');
      expect(res.message).toContain('unknown-environment');

      // 2. 纯映射函数 fail-closed 穷尽反证：production/prod 严禁默认支持或指向
      const prodRes = mapCanonicalEnvironmentToPanquSessionEnv('production');
      expect(prodRes.ok).toBe(false);
      if (!prodRes.ok) {
        expect(prodRes.blockerCode).toBe('BLOCKED_UNKNOWN_ENVIRONMENT');
      }

      const emptyRes = mapCanonicalEnvironmentToPanquSessionEnv('');
      expect(emptyRes.ok).toBe(false);
      if (!emptyRes.ok) {
        expect(emptyRes.blockerCode).toBe('BLOCKED_UNKNOWN_ENVIRONMENT');
      }

      const nullRes = mapCanonicalEnvironmentToPanquSessionEnv(undefined);
      expect(nullRes.ok).toBe(false);
      if (!nullRes.ok) {
        expect(nullRes.blockerCode).toBe('BLOCKED_UNKNOWN_ENVIRONMENT');
      }
    });

    it('8.6 断言实际选择环境与所有 Evidence Envelope.environment 一致，禁止 context.env 覆盖', async () => {
      // 1. PanquMediaExecutionAdapter 真实网络分支：实际 session 环境完全来自 spec.environment，彻底忽略 context.env
      const loadSessionSpy = vi.spyOn(mediaFlow, 'loadPanquSession').mockResolvedValue({
        env: 'preonline',
        base_url: 'https://panqu-preonline.internal.api',
        cookie_string: 'PHPSESSID=session_preonline_123',
        csrf_token: 'csrf_preonline_456',
        project_id: 1001,
      });
      const submitTaskSpy = vi.spyOn(mediaFlow, 'submitMediaTask').mockResolvedValue({
        ok: true,
        taskId: 8888,
        durationMs: 100,
        message: 'Preonline task submit success',
      });

      try {
        const adapter = new PanquMediaExecutionAdapter({
          enableLiveSubmit: true,
          sessionFile: 'mock-session.json',
        });

        const preonlineSpec: CanonicalTestSpec = {
          testId: 'spec-live-preonline',
          requirementId: 'REQ-ENV-8.6',
          scenario: 'VIDEO_NEW_MODEL',
          environment: 'preonline', // 规范环境为 preonline
          executionMode: 'REAL',
          target: { targetType: 'model', modelId: 84 },
          inputs: { mediaType: 'video' },
          deterministicAssertions: [],
          costLimit: { maxCostPoints: 0 },
          sideEffectPolicy: 'ALLOW_SUBMIT',
          requiredEvidence: [],
        };

        // 恶意传入 context.env = 'test' 企图覆盖执行环境
        const execResult = await adapter.execute(preonlineSpec, {
          env: 'test', // 必须被彻底忽略！
          sessionFile: 'mock-session.json',
        });

        // 实际加载的会话环境必须是 preonline，绝对不可被 context.env 覆盖成 test
        expect(loadSessionSpy).toHaveBeenCalledWith('mock-session.json', 'preonline');
        expect(loadSessionSpy).not.toHaveBeenCalledWith('mock-session.json', 'test');

        // 断言所有生成的 Evidence Envelope.environment 必须严格等于实际选择的环境 preonline
        expect(execResult.status).toBe('SUBMITTED');
        expect(execResult.evidence.length).toBeGreaterThan(0);
        for (const envEnvelope of execResult.evidence) {
          expect(envEnvelope.environment).toBe('preonline');
          expect(envEnvelope.environment).toBe(preonlineSpec.environment);
        }
      } finally {
        loadSessionSpy.mockRestore();
        submitTaskSpy.mockRestore();
      }
    });

    // 9. 修复 Adapter 证据环境篡改边界 (execute 阶段立即阻断)
    it('9.1 恶意 Adapter：spec=preonline 证据=test，execute 阶段立即阻断为 BLOCKED_INVALID_ADAPTER_OUTPUT，Adapter 只调用 1 次且错误证据不得泄露', async () => {
      const adapterSpy = vi.fn();
      const maliciousAdapter: ExecutionAdapter = {
        adapterName: 'malicious-env-adapter',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [
              {
                evidenceId: 'malicious-env-evidence-1',
                testId: spec.testId,
                sourceTool: 'malicious-tool',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_STATUS',
                observationStatus: 'PASS',
                capturedAt: new Date().toISOString(),
                environment: 'test', // 恶意篡改：spec 是 preonline，但证据声称来自 test！
                subjectType: 'task',
                subjectId: 12345,
                normalizedFields: { taskId: 12345, lifecycleStatus: 'COMPLETED' },
                provenance: 'malicious-adapter',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              },
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-preonline-tampered-evidence',
        requirementId: 'REQ-ENV-TAMPER-9.1',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'preonline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        executionAdapter: maliciousAdapter,
      });

      // 1. 阻断状态与阻断码
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');

      // 2. 错误信息包含 evidenceId、实际环境和期望环境
      expect(res.message).toContain('malicious-env-evidence-1');
      expect(res.message).toContain('test');
      expect(res.message).toContain('preonline');

      // 3. Adapter 只调用 1 次，不得重试
      expect(adapterSpy).toHaveBeenCalledTimes(1);

      // 4. 错误证据不得出现在返回结果中 (evidence 必须为 [])
      expect(res.executionResult?.evidence).toEqual([]);
    });

    it('9.2 spec 与证据环境一致时正常通过', async () => {
      const adapterSpy = vi.fn();
      const compliantAdapter: ExecutionAdapter = {
        adapterName: 'compliant-env-adapter',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [
              {
                evidenceId: 'compliant-env-evidence-1',
                testId: spec.testId,
                sourceTool: 'compliant-tool',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_STATUS',
                observationStatus: 'PASS',
                capturedAt: new Date().toISOString(),
                environment: 'preonline', // 严格一致！
                subjectType: 'task',
                subjectId: 12345,
                normalizedFields: { taskId: 12345, lifecycleStatus: 'COMPLETED' },
                provenance: 'compliant-adapter',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              },
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-preonline-compliant',
        requirementId: 'REQ-ENV-TAMPER-9.2',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'preonline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        executionAdapter: compliantAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(res.status).toBe('SUCCESS');
      expect(res.executionResult?.status).toBe('COMPLETED');
      expect(res.executionResult?.evidence.length).toBe(1);
      expect(res.executionResult?.evidence[0].environment).toBe('preonline');
    });

    it('9.3 多条证据中任意一条环境不一致，整批阻断，所有证据均不得泄露', async () => {
      const adapterSpy = vi.fn();
      const mixedEvidenceAdapter: ExecutionAdapter = {
        adapterName: 'mixed-env-adapter',
        supportedModes: ['OFFLINE', 'REAL'],
        supportedSideEffectPolicies: ['READ_ONLY', 'ALLOW_SUBMIT', 'ALLOW_PAID'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [
              {
                evidenceId: 'legit-envelope-1',
                testId: spec.testId,
                sourceTool: 'tool-1',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_SUBMISSION_RECEIPT',
                observationStatus: 'UNVERIFIED',
                capturedAt: new Date().toISOString(),
                environment: 'preonline', // 合法
                subjectType: 'task',
                subjectId: 100,
                normalizedFields: { taskId: 100 },
                provenance: 'tool-1',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              },
              {
                evidenceId: 'corrupted-envelope-2',
                testId: spec.testId,
                sourceTool: 'tool-2',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_STATUS',
                observationStatus: 'PASS',
                capturedAt: new Date().toISOString(),
                environment: 'test', // 污染环境！
                subjectType: 'task',
                subjectId: 100,
                normalizedFields: { taskId: 100 },
                provenance: 'tool-2',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              },
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-mixed-evidence-tampered',
        requirementId: 'REQ-ENV-TAMPER-9.3',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'preonline',
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        executionAdapter: mixedEvidenceAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
      expect(res.message).toContain('corrupted-envelope-2');
      expect(res.message).toContain('test');
      expect(res.message).toContain('preonline');
      // 整批阻断，哪怕第 1 个信封合法，也不得返回任何证据
      expect(res.executionResult?.evidence).toEqual([]);
    });

    it('9.4 OFFLINE/FIXTURE 模式下同样执行该规则，不得例外', async () => {
      const adapterSpy = vi.fn();
      const offlineTamperedAdapter: ExecutionAdapter = {
        adapterName: 'offline-tampered-adapter',
        supportedModes: ['OFFLINE'],
        supportedSideEffectPolicies: ['READ_ONLY'],
        execute: async (spec) => {
          adapterSpy();
          return {
            executionId: `exec-${spec.testId}`,
            testId: spec.testId,
            status: 'COMPLETED',
            evidence: [
              {
                evidenceId: 'fixture-tampered-1',
                testId: spec.testId,
                sourceTool: 'offline-tool',
                sourceType: 'FIXTURE',
                evidenceKey: 'FIXTURE:TASK_STATUS',
                observationStatus: 'PASS',
                capturedAt: new Date().toISOString(),
                environment: 'test', // 篡改：spec 是 offline，证据声称来自 test！
                subjectType: 'task',
                subjectId: 999,
                normalizedFields: { taskId: 999 },
                provenance: 'offline-tool',
                confidence: 1.0,
                immutable: true,
                redacted: true,
                collectionStatus: 'SUCCESS',
              },
            ],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      };

      const spec: CanonicalTestSpec = {
        testId: 'spec-offline-tampered',
        requirementId: 'REQ-ENV-TAMPER-9.4',
        scenario: 'VIDEO_NEW_MODEL',
        environment: 'offline', // OFFLINE 模式下的离线环境
        executionMode: 'OFFLINE',
        target: { targetType: 'model', modelId: 84 },
        inputs: { mediaType: 'video' },
        deterministicAssertions: [],
        costLimit: { maxCostPoints: 0 },
        sideEffectPolicy: 'READ_ONLY',
        requiredEvidence: [],
      };

      const res = await execute({
        canonicalSpec: spec,
        executionAdapter: offlineTamperedAdapter,
      });

      expect(adapterSpy).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(false);
      expect(res.status).toBe('BLOCKED');
      expect(res.blockerCode).toBe('BLOCKED_INVALID_ADAPTER_OUTPUT');
      expect(res.message).toContain('fixture-tampered-1');
      expect(res.message).toContain('test');
      expect(res.message).toContain('offline');
      expect(res.executionResult?.evidence).toEqual([]);
    });
  });
});
