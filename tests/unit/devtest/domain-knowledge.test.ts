import { describe, expect, it } from 'vitest';
import {
  PANQU_BUSINESS_ENTITIES,
  PANQU_API_KNOWLEDGE,
  PANQU_ORACLE_KNOWLEDGE,
  PANQU_TASK_KNOWLEDGE,
  PANQU_FAILURE_PATTERNS,
  resolveDomainContext,
  generateDomainExecutionPlan,
  evaluateBusinessVerification,
  createConfirmedFact,
  createObservedFact,
  createInferredFact,
  createUnknownFact,
} from '../../../src/devtest/domain-knowledge.js';
import { probe, plan, verify } from '../../../src/devtest/core-kernel.js';
import { createSyntheticValidMp4 } from '../../../src/devtest/media-inspector.js';

describe('DevTest 企业领域认知层 (Company Domain Knowledge)', () => {
  describe('1. 知识可信度边界 (Credibility Boundaries & Anti-Hallucination)', () => {
    it('CONFIRMED / OBSERVED / INFERRED / UNKNOWN 四级可信度严格区分', () => {
      const confirmed = createConfirmedFact('official_endpoint');
      expect(confirmed.credibility).toBe('CONFIRMED');
      expect(confirmed.value).toBe('official_endpoint');

      const observed = createObservedFact({ latencyMs: 120 });
      expect(observed.credibility).toBe('OBSERVED');
      expect(observed.value.latencyMs).toBe(120);

      const inferred = createInferredFact('video_gen', '根据用户提示词推导');
      expect(inferred.credibility).toBe('INFERRED');
      expect(inferred.rationale).toContain('推导');

      const unknownFact = createUnknownFact('worker_queue_concurrency', '未对外开放配置参数');
      expect(unknownFact.credibility).toBe('UNKNOWN');
      expect(unknownFact.value).toBeUndefined();
      expect(unknownFact.unknownReason).toContain('禁止模型自动补全');
    });

    it('实体定义中 UNKNOWN 缺口字段显式保留，严禁自行补全', () => {
      const projectEntity = PANQU_BUSINESS_ENTITIES.Project;
      expect(projectEntity.credibility).toBe('CONFIRMED');
      expect(projectEntity.unknownFields).toBeDefined();
      expect(projectEntity.unknownFields?.[0]).toContain('UNKNOWN');

      const taskEntity = PANQU_BUSINESS_ENTITIES.Task;
      expect(taskEntity.unknownFields?.[0]).toContain('UNKNOWN');
    });
  });

  describe('2. API Knowledge 领域表达与约束', () => {
    it('正确表达视频与生图提交、状态轮询与账单审计 API 结构', () => {
      const videoApi = PANQU_API_KNOWLEDGE.VIDEO_SUBMIT;
      expect(videoApi.endpoint).toBe('/aivideo/v2/generate/video');
      expect(videoApi.method).toBe('POST');
      expect(videoApi.parameters.some((p) => p.name === 'project_id' && p.required)).toBe(true);
      expect(videoApi.preconditions.length).toBeGreaterThan(0);
      expect(videoApi.testCaveats.some((c) => c.includes('code=1 仅代表排队接收成功'))).toBe(true);

      const pollApi = PANQU_API_KNOWLEDGE.TASK_STATUS_POLL;
      expect(pollApi.endpoint).toBe('/aivideo/v2/task_status/apiGetStatus');
      expect(pollApi.testCaveats.some((c) => c.includes('纯只读'))).toBe(true);
    });
  });

  describe('3. Oracle Knowledge 映射与不可信字段标记', () => {
    it('包含关键业务表结构与 API-DB 映射，将 HTTP 不可直查字段标记说明', () => {
      const aiTasks = PANQU_ORACLE_KNOWLEDGE.AI_TASKS;
      expect(aiTasks.table).toBe('ai_tasks');
      expect(aiTasks.keyFields).toContain('id');
      expect(aiTasks.fields.task_status.isStatusField).toBe(true);
      expect(aiTasks.statusField?.meanings[2]).toContain('成功完成');
      expect(aiTasks.statusField?.meanings[3]).toContain('业务失败');

      // extra 字段标记为不可直接依赖/需只读 DB 验真
      expect(aiTasks.untrustedFields.some((f) => f.field === 'extra')).toBe(true);
      expect(aiTasks.unknownDetails.length).toBeGreaterThan(0);
    });

    it('pq_score_log 准确定义积分变动类型与核销规则', () => {
      const scoreLog = PANQU_ORACLE_KNOWLEDGE.PQ_SCORE_LOG;
      expect(scoreLog.table).toBe('pq_score_log');
      expect(scoreLog.statusField?.meanings[2]).toContain('扣减/预扣');
      expect(scoreLog.statusField?.meanings[1]).toContain('增加/退款');
      expect(scoreLog.commonVerificationRules.some((r) => r.includes('防重复扣费'))).toBe(true);
    });
  });

  describe('4. Task Knowledge 生命周期与业务成功基准', () => {
    it('明确表达 API Response 成功与 Task 终态成功之间的本质差异', () => {
      const videoTask = PANQU_TASK_KNOWLEDGE.VIDEO_TASK;
      expect(videoTask.lifecycle.length).toBe(4);
      expect(videoTask.lifecycle.find((s) => s.status === 2)?.isSuccess).toBe(true);
      expect(videoTask.lifecycle.find((s) => s.status === 3)?.isSuccess).toBe(false);
      expect(videoTask.differenceFromApiResponse).toContain('Technical Acceptance');
      expect(videoTask.businessSuccessCriteria.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('5. probe 阶段的领域对象识别与上下文推导', () => {
    it('probe() 能够根据需求文本自动识别涉及的业务对象与 API 契约', async () => {
      const res = await probe({
        mock: true,
        requirement: '自测项目 10 中生成 Wan3.0 视频并归档至特定文件夹',
      });
      expect(res.ok).toBe(true);
      expect(res.domainAnalysis).toBeDefined();

      const analysis = res.domainAnalysis!;
      const objNames = analysis.identifiedObjects.map((o) => o.code);
      expect(objNames).toContain('PROJECT');
      expect(objNames).toContain('TASK');
      expect(objNames).toContain('FOLDER'); // 识别出文件夹需求
      expect(objNames).toContain('MEDIA_ASSET');
      expect(objNames).toContain('BILLING_LEDGER');

      expect(analysis.applicableApis.some((a) => a.endpoint === '/aivideo/v2/generate/video')).toBe(true);
      expect(analysis.unknowns.length).toBeGreaterThan(0);
      expect(analysis.riskWarnings.length).toBeGreaterThan(0);
    });
  });

  describe('6. plan 阶段基于领域知识生成业务链路测试方案', () => {
    it('plan() 生成包含前置条件、操作、API验证、Task验证、Oracle对账、产物验真的 6 步方案', async () => {
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        resolution: '720p',
        duration: 5,
        requirement: 'Wan 3.0 视频模型全链路业务测试',
      });

      expect(planRes.ok).toBe(true);
      expect(planRes.domainPlan).toBeDefined();

      const domainPlan = planRes.domainPlan!;
      expect(domainPlan.steps.length).toBe(6);

      const stages = domainPlan.steps.map((s) => s.stage);
      expect(stages).toEqual([
        'PRECONDITION',
        'OPERATION',
        'API_VERIFY',
        'TASK_VERIFY',
        'ORACLE_VERIFY',
        'BUSINESS_RESULT',
      ]);
      expect(domainPlan.steps[0].expectedOutcome).toContain('70 pt');
      expect(domainPlan.confidenceLevel).toBe('CONFIRMED');
    });
  });

  describe('7. verify 阶段真正的业务级验证 (Technical Success ≠ Business Success)', () => {
    it('[真实问题 1] API 返回成功 (code=1)，但 Task 实际失败 (status=3) → 判定业务 FAIL 并匹配 FP-001', async () => {
      const validBuffer = createSyntheticValidMp4({ durationSeconds: 2 });
      const res = await verify({
        taskId: 88001,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'FAILED', // Task 终态为失败
        apiResult: { ok: true, code: 1, message: '提交成功' }, // API 返回成功
        scoreLogs: [
          { id: 1, task_id: 88001, type: 2, score: 70 },
          { id: 2, task_id: 88001, type: 1, score: 70 }, // 失败等额退款
        ],
        expectedPoints: 70,
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.businessValidation).toBeDefined();
      expect(res.businessValidation!.businessSuccess).toBe(false);
      expect(res.businessValidation!.technicalSuccess).toBe(true); // API 层面技术成功
      expect(res.businessValidation!.matchedFailurePatterns).toContain('FP-001');
      expect(res.reasons.some((r) => r.includes('Technical Success ≠ Business Success'))).toBe(true);
    });

    it('[真实问题 2] Task 标记成功 (status=2)，但媒体产物损坏无法解码 → 判定业务 FAIL 并匹配 FP-002', async () => {
      const corruptedBuffer = Buffer.from('NOT_A_VALID_MP4_CORRUPTED_STREAM');
      const res = await verify({
        taskId: 88002,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: corruptedBuffer,
        scoreLogs: [
          { id: 1, task_id: 88002, type: 2, score: 70 },
        ],
        expectedPoints: 70,
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.businessValidation!.matchedFailurePatterns).toContain('FP-002');
      expect(res.reasons.some((r) => r.includes('FP-002') && r.includes('产物损坏无法解码'))).toBe(true);
    });

    it('[真实问题 3] 参数隐式业务关系违背 (folderId 不属于当前 projectId) → 判定业务 FAIL 并匹配 FP-003', async () => {
      const validBuffer = createSyntheticValidMp4({ durationSeconds: 2 });
      const res = await verify({
        taskId: 88003,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validBuffer,
        scoreLogs: [
          { id: 1, task_id: 88003, type: 2, score: 70 },
        ],
        expectedPoints: 70,
        projectId: 10,
        folderId: 999,
        isFolderInProject: false, // 跨项目文件夹违背
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.businessValidation!.matchedFailurePatterns).toContain('FP-003');
      expect(res.reasons.some((r) => r.includes('FP-003') && r.includes('不属于当前 projectId'))).toBe(true);
    });

    it('真实业务全通场景：API 成功 + Task 成功 + 媒体物理可解码 + 账单合规 → 判定业务 ALL PASS', async () => {
      const validBuffer = createSyntheticValidMp4({ durationSeconds: 2 });
      const res = await verify({
        taskId: 88004,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validBuffer,
        scoreLogs: [
          { id: 1, task_id: 88004, type: 2, score: 70 },
        ],
        expectedPoints: 70,
        apiResult: { ok: true, code: 1, message: '提交成功' },
        projectId: 10,
        folderId: 101,
        isFolderInProject: true,
      });

      expect(res.passed).toBe(true);
      expect(res.verdict).toBe('PASS');
      expect(res.businessValidation!.businessSuccess).toBe(true);
      expect(res.businessValidation!.status).toBe('PASS');
      expect(res.businessValidation!.matchedFailurePatterns.length).toBe(0);
      expect(res.evidence.business).toBeDefined();
    });
  });
});
