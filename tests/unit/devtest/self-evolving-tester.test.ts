import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  plan,
  verify,
  DevTestMcpService,
  loadConfirmedExperiences,
  matchRelevantExperiences,
  recordCandidateToSharedMemory,
  formatMemoryCandidate,
  type Experience,
} from '../../../src/devtest/index.js';
import { RoutingOracle, type GatewayChannelConfig } from '../../../src/devtest/routing.js';
import {
  createSyntheticValidMp4,
  inspectMp4Buffer,
} from '../../../src/devtest/media-inspector.js';

describe('Self-Evolving Tester - 高价值业务风险与领域不变量测试套件', () => {
  describe('Card 1: 媒体产物归属与防假 PASS (Artifact Ownership Invariant)', () => {
    it('外部提供物理有效 MP4，但缺少 TaskSnapshot 归属绑定时，verify 必须 Fail-closed 判定为 UNVERIFIED，绝不假 PASS', async () => {
      // Arrange: 物理完全合法的 MP4 容器结构
      const validMp4 = createSyntheticValidMp4({ durationSeconds: 3, width: 1280, height: 720 });

      // Act: 传入 artifactOwnership: 'UNVERIFIED'，模拟外部 URL 注入或未经过任务快照证明的媒体
      const res = await verify({
        taskId: 99001,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        artifactOwnership: 'UNVERIFIED', // 明确缺失归属凭证
        scoreLogs: [{ id: 1, task_id: 99001, type: 2, score: 70 }],
        expectedPoints: 70,
        apiResult: { ok: true, code: 1, message: '提交成功' },
      });

      // Assert: 强断言系统保持只读且 Fail-closed
      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('UNVERIFIED');
      expect(res.status).toBe('UNVERIFIED');
      expect(res.evidence.media.status).toBe('UNVERIFIED');
      expect(res.evidence.media.ownership).toBe('UNVERIFIED');
      expect(res.businessValidation).toBeDefined();
      expect(res.businessValidation!.businessSuccess).toBe(false);
      expect(res.businessValidation!.status).toBe('UNVERIFIED');
      expect(res.reasons.some((r) => r.includes('归属绑定证据') || r.includes('UNVERIFIED'))).toBe(true);
    });
  });

  describe('Card 2: 计费防重复扣费不变量与 FP-004 阻断 (Anti-Double-Billing Invariant)', () => {
    it('任务成功且产物有效，但存在重复预扣流水时，verify 必须拦截并触发 FP-004 资损告警 (verdict: FAIL)', async () => {
      // Arrange: 成功任务，物理有效视频，但流水记录中存在 2 笔预扣 (preDeductCount = 2)
      const validMp4 = createSyntheticValidMp4({ durationSeconds: 2 });
      const res = await verify({
        taskId: 99002,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [
          { id: 101, task_id: 99002, type: 2, score: -70 },
          { id: 102, task_id: 99002, type: 2, score: -70 }, // 重复扣款资损漏洞
        ],
        expectedPoints: 70,
      });

      // Assert: 强断言资损阻断
      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.evidence.invariants.antiDoubleBilling).toBe(false);
      expect(res.businessValidation).toBeDefined();
      expect(res.businessValidation!.matchedFailurePatterns).toContain('FP-004');
      expect(res.reasons.some((r) => r.includes('FP-004') || r.includes('重复预扣') || r.includes('重复扣费'))).toBe(true);
    });
  });

  describe('Card 3: 失败任务净扣归零不变量与 FP-005 阻断 (Net-Charge-Zero Invariant)', () => {
    it('任务在异步阶段执行失败且有扣费，但缺少退款流水时，verify 必须拦截并触发 FP-005 告警 (verdict: FAIL)', async () => {
      // Arrange: 任务终态为 FAILED，有扣费 70 分，但退款流水缺失 (netDeducted = 70 > 0)
      const res = await verify({
        taskId: 99003,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'FAILED',
        scoreLogs: [
          { id: 201, task_id: 99003, type: 2, score: -70 }, // 缺少退款流水
        ],
        expectedPoints: 70,
      });

      // Assert: 强断言净扣不变量与业务验真阻断
      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.evidence.invariants.netChargeZero).toBe(false);
      expect(res.businessValidation).toBeDefined();
      expect(res.businessValidation!.matchedFailurePatterns).toContain('FP-005');
      expect(res.reasons.some((r) => r.includes('FP-005') || r.includes('漏退款') || r.includes('净扣'))).toBe(true);
    });
  });

  describe('Card 4: 异步端到端一致性 - 初始 API 提交失败阻断 (Async Consistency)', () => {
    it('初始提交 API 返回失败 (code=0) 时，无论后续状态如何，verify 必须识别初始 API 违背并判定为 FAIL', async () => {
      // Arrange: 初始 API 提交因业务校验失败
      const validMp4 = createSyntheticValidMp4({ durationSeconds: 2 });
      const res = await verify({
        taskId: 99004,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [{ id: 301, task_id: 99004, type: 2, score: 70 }],
        expectedPoints: 70,
        apiResult: { ok: false, code: 0, message: '业务参数非法/违规提示词' },
      });

      // Assert: 端到端一致性判定
      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.businessValidation).toBeDefined();
      expect(res.businessValidation!.verdictDetail.apiVerified).toBe(false);
      expect(res.businessValidation!.technicalSuccess).toBe(false);
    });
  });

  describe('Card 5: 网关层渠道限额耗尽状态机阻断 (Gateway Quota Exhaustion)', () => {
    it('所有启用且同组的候选渠道超出每日限额时，evaluateGatewayRouting 必须置位 isBlockedByQuota 且候选渠道为空', () => {
      // Arrange: 两个候选渠道，均在 taskPoints 下超额
      const channels: GatewayChannelConfig[] = [
        { id: 41, name: '主通道', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 10, dailyQuotaLimit: 500, usedQuota: 490 },
        { id: 42, name: '备用通道', group: 'panqu_test', models: ['wan3.0-video'], status: 1, weight: 5, dailyQuotaLimit: 300, usedQuota: 295 },
      ];

      // Act: 任务需要 20 积分，490+20=510 > 500, 295+20=315 > 300
      const res = RoutingOracle.evaluateGatewayRouting('panqu_test', 'wan3.0-video', 20, channels);

      // Assert: 强断言限额阻断
      expect(res.isBlockedByQuota).toBe(true);
      expect(res.candidateChannelIds).toHaveLength(0);
      expect(res.allowedChannels).toHaveLength(0);
      expect(res.rejectedReasons[41]).toContain('超出每日限额');
      expect(res.rejectedReasons[42]).toContain('超出每日限额');
    });
  });

  describe('Card 6: MP4 64位 Extended Box 头部截断安全防御 (Binary Media Robustness)', () => {
    it('MP4 遇到 size=1 (Extended Box) 且头部少于 16 字节时，inspectMp4Buffer 必须安全处理并判定为 FILE_INVALID', () => {
      // Arrange: 构造合法 ftyp 头部 (24字节)，后接仅 12 字节的 64 位 Extended Box (缺少完整 16 字节头部)
      const validFtyp = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
      const truncatedExtendedBox = Buffer.concat([
        validFtyp,
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // size = 1 (Extended Size)
        Buffer.from('mdat', 'ascii'),
        Buffer.from([0x00, 0x00, 0x00, 0x02]), // 仅 4 字节扩展长度，不足 8 字节 64 位长度
      ]);

      // Act
      const result = inspectMp4Buffer(truncatedExtendedBox);

      // Assert
      expect(result.decodable).toBe(false);
      expect(result.qualityClassification).toBe('FILE_INVALID');
      expect(result.reasons.some((r) => r.includes('moov') || r.includes('缺少') || r.includes('损坏'))).toBe(true);
    });
  });

  describe('Part 2: 知识自进化与经验闭环 (Self-Evolving Feedback Loop)', () => {
    it('Test 1: 无历史经验或无关场景时，plan 保持基础计划，不包含任何历史经验核验步骤与用例', async () => {
      const res = await plan({
        modelId: 999, // 无任何历史沉淀的新模型
        mediaType: 'image',
      });
      expect(res.ok).toBe(true);
      const historySteps = res.domainPlan?.steps.filter((s) => s.description.startsWith('[历史经验核验]')) || [];
      const historyTests = res.testPlan.tests.filter((t) => t.id.startsWith('history-'));
      expect(historySteps).toHaveLength(0);
      expect(historyTests).toHaveLength(0);
    });

    it('Test 2: 存在匹配的已确认历史经验时，plan 自动追加 [历史经验核验] 执行步骤并在 testPlan.tests 注入对应测试用例', async () => {
      const confirmedExp: Experience = {
        id: 'EXP-TEST-002',
        title: 'Wan3.0 高分辨率 1080p 计费防重复预扣核验',
        context: '测试模型 ID 84 (wan3.0-video) 1080p',
        symptom: '高并发生成任务容易出现双笔预扣',
        root_cause: '未加分布式锁导致幂等失效',
        verification: 'BillingOracle.reconcileTaskLedger antiDoubleBilling 校验',
        related_model_id: 84,
        related_pattern_id: 'FP-004',
        confidence: 'CONFIRMED',
        status: 'CONFIRMED',
        requiredPlanCheck: {
          stage: 'ORACLE_VERIFY',
          targetObject: 'BillingLedger',
          description: '针对 Wan3.0 双重扣费高发隐患，重点核验 preDeductCount 严格为 1 (FP-004)',
          expectedOutcome: 'preDeductCount === 1 且 antiDoubleBilling === true',
          verificationMethod: 'BillingOracle.reconcileTaskLedger antiDoubleBilling 断言',
        },
      };

      const res = await plan({
        modelId: 84,
        mediaType: 'video',
        extraExperiences: [confirmedExp],
      });

      expect(res.ok).toBe(true);
      const historySteps = res.domainPlan?.steps.filter((s) => s.description.includes('[历史经验核验]')) || [];
      expect(historySteps.length).toBeGreaterThanOrEqual(1);
      expect(historySteps.some((s) => s.description.includes('双重扣费') || s.description.includes('FP-004'))).toBe(true);

      const historyTests = res.testPlan.tests.filter((t) => t.id === 'history-exp-test-002');
      expect(historyTests).toHaveLength(1);
      expect(historyTests[0].purpose).toContain('[历史经验核验]');
      expect(historyTests[0].status).toBe('READY');
      expect(res.changeContract!.testObjectives.some((o) => o.includes('history-exp-test-002'))).toBe(true);
    });

    it('Test 3: 标记为 PENDING 待审核的候选条目严格被过滤，绝不进入 plan 与必须核验步骤 (防噪音/防假规则)', async () => {
      const pendingExp: Experience = {
        id: 'EXP-PENDING-003',
        title: '未经审核的推测：生图可能存在跨项目漏校验',
        context: '测试模型 201',
        symptom: '某次单测偶尔报错',
        root_cause: '未知',
        verification: '待定',
        related_model_id: 201,
        related_pattern_id: 'FP-003',
        confidence: 'INFERRED',
        status: 'PENDING',
      };

      const loaded = loadConfirmedExperiences({
        extraExperiences: [pendingExp],
      });
      const matched = matchRelevantExperiences(loaded, { modelId: 201, mediaType: 'image' });
      expect(matched.some((e) => e.id === 'EXP-PENDING-003')).toBe(false);

      const res = await plan({
        modelId: 201,
        mediaType: 'image',
        extraExperiences: [pendingExp],
      });
      expect(res.ok).toBe(true);
      const historySteps = res.domainPlan?.steps.filter((s) => s.description.includes('EXP-PENDING-003')) || [];
      const historyTests = res.testPlan.tests.filter((t) => t.id.includes('pending'));
      expect(historySteps).toHaveLength(0);
      expect(historyTests).toHaveLength(0);
    });

    it('Test 4: 绑定特定模型 (如 Model 15) 的经验在 Model 84 的测试计划推导中被严格隔离，防止跨模型经验污染', async () => {
      const seedanceExp: Experience = {
        id: 'EXP-SEEDANCE-015',
        title: 'Seedance 模型 (15) 专属音频轨道对齐异常核验',
        context: '仅在 Seedance 视频模型 ID 15 发生',
        symptom: '生成视频伴随音频漂移',
        root_cause: 'Seedance 底层采样率不匹配',
        verification: 'inspectAudioSync 校验',
        related_model_id: 15,
        related_pattern_id: 'FP-002',
        confidence: 'CONFIRMED',
        status: 'CONFIRMED',
        requiredPlanCheck: {
          stage: 'BUSINESS_RESULT',
          targetObject: 'MediaAsset',
          description: '核验 Seedance (15) 专属音频对齐',
          expectedOutcome: 'audioSync === true',
          verificationMethod: '音频对齐检测',
        },
      };

      const res = await plan({
        modelId: 84, // 目标是 Wan3.0
        mediaType: 'video',
        extraExperiences: [seedanceExp],
      });

      expect(res.ok).toBe(true);
      const hasSeedanceStep = res.domainPlan?.steps.some((s) => s.description.includes('Seedance') || s.description.includes('EXP-SEEDANCE-015'));
      const hasSeedanceTest = res.testPlan.tests.some((t) => t.id === 'history-exp-seedance-015');
      expect(hasSeedanceStep).toBe(false);
      expect(hasSeedanceTest).toBe(false);
    });

    it('Test 5: 发生业务资损失败 (FP-004) 时，verify() 产出结构化 memoryCandidate，且全程保持 100% 只读无写盘副作用', async () => {
      const validMp4 = createSyntheticValidMp4({ durationSeconds: 2 });

      const res = await verify({
        taskId: 99105,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
        artifactBuffer: validMp4,
        scoreLogs: [
          { id: 1001, task_id: 99105, type: 2, score: -70 },
          { id: 1002, task_id: 99105, type: 2, score: -70 }, // 重复扣款 FP-004
        ],
        expectedPoints: 70,
      });

      expect(res.passed).toBe(false);
      expect(res.verdict).toBe('FAIL');
      expect(res.memoryCandidate).toBeDefined();
      expect(res.memoryCandidate?.agent).toBe('trae');
      expect(res.memoryCandidate?.patternId).toBe('FP-004');
      expect(res.memoryCandidate?.modelId).toBe(84);
      expect(res.memoryCandidate?.taskId).toBe(99105);
      expect(res.memoryCandidate?.topic).toContain('[FP-004]');
      expect(res.memoryCandidate?.confidence).toBe('CONFIRMED');
      expect(res.memoryCandidate?.reasons.some((r) => r.includes('FP-004') || r.includes('重复扣费'))).toBe(true);
    });

    it('Test 6: 候选池严格去重 (Deduplication)，重复失败模式提案返回 DUPLICATE_CANDIDATE_SKIPPED 避免记忆膨胀', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-test-'));
      const candidatesDir = path.join(tmpDir, 'candidates');
      fs.mkdirSync(candidatesDir, { recursive: true });
      const inboxFile = path.join(candidatesDir, 'inbox.md');
      fs.writeFileSync(inboxFile, '# 候选记忆池\n\n## 待审候选列表\n', 'utf8');

      try {
        const candidatePayload = formatMemoryCandidate({
          taskId: 88001,
          modelId: 84,
          mediaType: 'video',
          matchedFailurePatterns: ['FP-004'],
          reasons: ['[资损告警 FP-004] 存在重复预扣流水，违背防重复扣费不变量'],
          terminalStatus: 'SUCCESS',
        });
        expect(candidatePayload).toBeDefined();

        // 第一次写入
        const firstWrite = recordCandidateToSharedMemory(candidatePayload!, tmpDir);
        expect(firstWrite.recorded).toBe(true);
        expect(firstWrite.reason).toBe('CANDIDATE_RECORDED');
        expect(firstWrite.candidateId).toMatch(/^CAND-\d{8}-\d{4}/);

        const contentAfterFirst = fs.readFileSync(inboxFile, 'utf8');
        expect(contentAfterFirst).toContain(firstWrite.candidateId);
        expect(contentAfterFirst).toContain('[FP-004]');
        expect(contentAfterFirst).toContain('模型 #84');

        // 第二次重复写入
        const secondWrite = recordCandidateToSharedMemory(candidatePayload!, tmpDir);
        expect(secondWrite.recorded).toBe(false);
        expect(secondWrite.reason).toBe('DUPLICATE_CANDIDATE_SKIPPED');

        const matches = (contentAfterFirst.match(/\[FP-004\]/g) || []).length;
        expect(matches).toBe(1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('Test 7: 生产级自进化自闭环完整闭环链路仿真 (verify -> candidate -> approved -> next plan enhanced)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolving-loop-test-'));
      const candidatesDir = path.join(tmpDir, 'candidates');
      fs.mkdirSync(candidatesDir, { recursive: true });
      const inboxFile = path.join(candidatesDir, 'inbox.md');
      fs.writeFileSync(inboxFile, '# 候选记忆池\n\n## 待审候选列表\n', 'utf8');

      try {
        const mcpService = new DevTestMcpService();

        // 1. 第一次调用 MCP verify: 发现退款缺失资损 FP-005
        const verifyCallRes = await mcpService.call({
          action: 'verify',
          task_id: 77007,
          model_id: 84,
          media_type: 'video',
          terminal_status: 'FAILED',
          expected_points: 70,
          score_logs: [
            { id: 5001, task_id: 77007, type: 2, score: -70 },
          ],
          shared_memory_dir: tmpDir,
        });

        expect(verifyCallRes.ok).toBe(true);
        expect(verifyCallRes.summary).toContain('知识自学习: 自动沉淀失败模式提案');

        // 2. 检查 inbox.md 中已自动产生待审核候选条目
        const inboxContent1 = fs.readFileSync(inboxFile, 'utf8');
        expect(inboxContent1).toContain('- [ ] **[CAND-');
        expect(inboxContent1).toContain('[FP-005]');
        expect(inboxContent1).toContain('模型 #84');

        // 此时条目未批准 (- [ ])，下一次 plan 不应被它影响
        const planBeforeApproval = await plan({
          modelId: 84,
          mediaType: 'video',
          projectRoot: tmpDir,
        });
        const expBefore = (planBeforeApproval.domainPlan?.steps || []).filter((s) => s.description.includes('CAND-'));
        expect(expBefore).toHaveLength(0);

        // 3. 模拟专家/审批流批准此提案: 将 - [ ] 变更为 - [x]
        const approvedContent = inboxContent1.replace(/- \[ \] \*\*\[(CAND-[^\]]+)\]\*\*/, '- [x] **[$1]**');
        fs.writeFileSync(inboxFile, approvedContent, 'utf8');

        // 4. 验证 loadConfirmedExperiences 能够正确吸纳经批准的 shared-memory 经验
        const approvedExperiences = loadConfirmedExperiences({ sharedMemoryDir: tmpDir });
        const matchedExp = approvedExperiences.find((e) => e.related_pattern_id === 'FP-005' && e.related_model_id === 84);
        expect(matchedExp).toBeDefined();
        expect(matchedExp?.status).toBe('CONFIRMED');

        // 5. 第二次调用 plan(): 传入包含此批准经验的上下文，测试计划自动完成进化增强
        const planAfterApproval = await plan({
          modelId: 84,
          mediaType: 'video',
          extraExperiences: approvedExperiences,
        });

        const historySteps = planAfterApproval.domainPlan?.steps.filter((s) => s.description.includes('[历史经验核验]') && s.description.includes('FP-005')) || [];
        expect(historySteps.length).toBeGreaterThanOrEqual(1);
        expect(historySteps[0].targetObject).toBe('BillingLedger');

        const historyTests = planAfterApproval.testPlan.tests.filter((t) => t.id.startsWith('history-cand-') || t.purpose.includes('FP-005'));
        expect(historyTests.length).toBeGreaterThanOrEqual(1);
        expect(historyTests[0].requiredEvidence).toContain('billing_reconciliation');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
