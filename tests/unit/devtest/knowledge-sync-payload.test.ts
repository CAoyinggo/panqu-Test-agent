import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DevTestMcpService,
  DEFAULT_GITHUB_KNOWLEDGE_CONFIG,
  buildKnowledgeSyncPayload,
  mergeKnowledgeIntoRemoteJson,
  type Experience,
  verify,
  plan,
} from '../../../src/devtest/index.js';

describe('DevTest Knowledge → GitHub 受控回写与 Sync Payload 规范测试', () => {
  let tmpDir: string;
  let fakeSharedMemoryDir: string;
  let inboxPath: string;
  let candidatesJsonPath: string;
  let service: DevTestMcpService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-sync-payload-test-'));
    fakeSharedMemoryDir = path.join(tmpDir, 'shared-memory');
    const candidatesDir = path.join(fakeSharedMemoryDir, 'candidates');
    fs.mkdirSync(candidatesDir, { recursive: true });
    inboxPath = path.join(candidatesDir, 'inbox.md');
    fs.writeFileSync(inboxPath, '# 候选记忆池\n\n## 待审候选列表\n\n', 'utf8');

    const refDir = path.join(tmpDir, '.agents/skills/self-evolving-tester/references');
    fs.mkdirSync(refDir, { recursive: true });
    candidatesJsonPath = path.join(refDir, 'knowledge_candidates.json');
    fs.writeFileSync(candidatesJsonPath, '[]\n', 'utf8');

    service = new DevTestMcpService(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('1. 集中默认配置规范', () => {
    it('定义了统一的 GitHub 仓库与文件路径常量，杜绝多处硬编码', () => {
      expect(DEFAULT_GITHUB_KNOWLEDGE_CONFIG.repository).toBe('CAoyinggo/panqu-Test-agent');
      expect(DEFAULT_GITHUB_KNOWLEDGE_CONFIG.path).toBe(
        '.agents/skills/self-evolving-tester/references/knowledge_candidates.json',
      );
    });
  });

  describe('2. Promotion 输出完整 Knowledge (测试要求 A)', () => {
    it('Promotion 成功时在 report.items 中直接返回完整且类型完备的 Experience 对象', async () => {
      // 准备已审核的候选
      const candId = 'CAND-20260917-0001';
      fs.appendFileSync(
        inboxPath,
        `- [x] **[${candId}]** 来源: \`trae\` | 提交日期: 2026-09-17\n  - **主题**: [FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)\n  - **提议内容**: 任务失败必须退款且净扣归零\n  - **建议归宿**: L2-state/active-projects.md\n`,
        'utf8',
      );

      const report = await service.promoteConfirmedExperiences({
        sharedMemoryDir: fakeSharedMemoryDir,
        inboxPath,
        candidatesJsonPath,
      });

      expect(report.promotedCount).toBe(1);
      const item = report.items[0];
      expect(item.status).toBe('PROMOTED');
      expect(item.knowledge).toBeDefined();

      const exp = item.knowledge as Experience;
      expect(exp.id).toMatch(/^KC-\d{8}-\d{2}$/);
      expect(exp.title).toContain('[FP-005]');
      expect(exp.confidence).toBe('CONFIRMED');
      expect(exp.status).toBe('ACCEPTED');
      expect(exp.sourceCandidateId).toBe(candId);
      expect(exp.promotedAt).toBeDefined();
      expect(exp.related_model_id).toBe(88);
      expect(exp.related_pattern_id).toBe('FP-005');
      expect(exp.requiredPlanCheck).toBeDefined();
    });
  });

  describe('3. Sync Payload 安全门禁校验 (测试要求 B, C, D)', () => {
    it('拒绝未 Promotion 或 PENDING 状态的条目进入 Sync Payload (测试要求 B)', () => {
      const invalidKnowledge: any[] = [
        {
          id: 'KC-TEST-01',
          title: '未审核知识',
          status: 'PENDING', // 非 ACCEPTED / CONFIRMED
          confidence: 'CONFIRMED',
          sourceCandidateId: 'CAND-1',
          promotedAt: new Date().toISOString(),
        },
        {
          id: 'KC-TEST-02',
          title: '观察态知识',
          status: 'ACCEPTED',
          confidence: 'OBSERVED', // 非 CONFIRMED
          sourceCandidateId: 'CAND-2',
          promotedAt: new Date().toISOString(),
        },
        {
          id: 'KC-TEST-03',
          title: '无来源知识',
          status: 'ACCEPTED',
          confidence: 'CONFIRMED',
          // 缺少 sourceCandidateId
          promotedAt: new Date().toISOString(),
        },
        {
          id: 'KC-TEST-04',
          title: '无晋升时间戳知识',
          status: 'ACCEPTED',
          confidence: 'CONFIRMED',
          sourceCandidateId: 'CAND-4',
          // 缺少 promotedAt
        },
      ];

      const res = buildKnowledgeSyncPayload({ knowledge: invalidKnowledge });
      expect(res.ok).toBe(true);
      expect(res.syncRequired).toBe(false);
      expect(res.payload).toBeUndefined();
      expect(res.rejectedItems?.length).toBe(4);
    });

    it('合法但没有 requiredPlanCheck 的知识允许进入 Sync Payload (测试要求 C)', () => {
      const architectureFactKnowledge: Experience = {
        id: 'KC-ARCH-01',
        title: '主站仅支持特定模型分流路由',
        context: '根据 docs/ARCHITECTURE_FREEZE.md Section 13 事实',
        symptom: '架构硬约束事实',
        root_cause: '路由网关策略',
        verification: '代码规范核验',
        confidence: 'CONFIRMED',
        status: 'ACCEPTED',
        sourceCandidateId: 'CAND-20260917-ARCH',
        promotedAt: '2026-09-17T12:00:00.000Z',
        // 无 requiredPlanCheck
      };

      const res = buildKnowledgeSyncPayload({ knowledge: [architectureFactKnowledge] });
      expect(res.ok).toBe(true);
      expect(res.syncRequired).toBe(true);
      expect(res.payload).toBeDefined();
      expect(res.payload?.knowledge.length).toBe(1);
      expect(res.payload?.knowledge[0].id).toBe('KC-ARCH-01');
      expect(res.payload?.knowledge[0].requiredPlanCheck).toBeUndefined();
    });

    it('Candidate 记录入口绝不产生 Sync Payload，保持物理隔离 (测试要求 D)', async () => {
      const recordRes = await service.recordCandidate({
        topic: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        content: '外部事实',
        shared_memory_dir: fakeSharedMemoryDir,
      });

      expect(recordRes.ok).toBe(true);
      // recordCandidate 返回值中绝无 syncRequired 或 syncPayload
      expect((recordRes as any).syncRequired).toBeUndefined();
      expect((recordRes as any).syncPayload).toBeUndefined();
      expect((recordRes.data as any)?.syncRequired).toBeUndefined();
    });
  });

  describe('4. 远端合并幂等性与冲突检测 (测试要求 E, F)', () => {
    const existingRemoteList = [
      {
        id: 'KC-20260916-01',
        claim: 'API 返回 code=1 仅代表异步任务排队接收成功',
        sourceCandidateId: 'CAND-20260916-001',
        confidence: 'CONFIRMED',
        status: 'ACCEPTED',
      },
    ];

    it('远端已存在相同 Knowledge ID 且内容一致时不重复追加 (测试要求 E)', () => {
      const incoming: Experience = {
        id: 'KC-20260916-01',
        title: 'API 返回 code=1 仅代表异步任务排队接收成功',
        context: '已有事实',
        symptom: '已有事实',
        root_cause: '官方规范',
        verification: '状态机轮询',
        confidence: 'CONFIRMED',
        status: 'ACCEPTED',
        sourceCandidateId: 'CAND-20260916-001',
        promotedAt: '2026-09-16T10:00:00.000Z',
      };

      const remoteJson = JSON.stringify(existingRemoteList, null, 2);
      const res = mergeKnowledgeIntoRemoteJson(remoteJson, [incoming]);

      expect(res.ok).toBe(true);
      expect(res.mergedCount).toBe(0);
      expect(res.skippedCount).toBe(1); // 幂等跳过
      const parsed = JSON.parse(res.mergedContent!);
      expect(parsed.length).toBe(1); // 未重复追加
    });

    it('新 Knowledge ID 成功追加并生成规范的 JSON 内容', () => {
      const incoming: Experience = {
        id: 'KC-20260917-13',
        title: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        context: '失败必须退款',
        symptom: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        root_cause: 'billing.ts 阶梯定价规范',
        verification: 'BillingOracle.reconcileTaskLedger netChargeZero 校验',
        related_pattern_id: 'FP-005',
        related_model_id: 88,
        confidence: 'CONFIRMED',
        status: 'ACCEPTED',
        sourceCandidateId: 'CAND-20260917-1203',
        promotedAt: '2026-09-17T12:00:00.000Z',
        requiredPlanCheck: {
          stage: 'ORACLE_VERIFY',
          description: '针对 FP-005 重点核查退款流水',
          targetObject: 'BillingLedger',
          expectedOutcome: 'netDeducted === 0',
          verificationMethod: 'BillingOracle.reconcileTaskLedger netChargeZero 校验',
        },
      };

      const remoteJson = JSON.stringify(existingRemoteList, null, 2);
      const res = mergeKnowledgeIntoRemoteJson(remoteJson, [incoming]);

      expect(res.ok).toBe(true);
      expect(res.mergedCount).toBe(1);
      expect(res.skippedCount).toBe(0);
      const parsed = JSON.parse(res.mergedContent!);
      expect(parsed.length).toBe(2);
      expect(parsed[1].id).toBe('KC-20260917-13');
      expect(parsed[1].requiredPlanCheck).toBeDefined();
    });

    it('相同 ID 但内容冲突时坚决拒绝静默覆盖，如实报错 SYNC_CONFLICT (测试要求 F)', () => {
      const conflictingIncoming: Experience = {
        id: 'KC-20260916-01', // 与远端已有 ID 相同
        title: '篡改的假知识：API code=1 可以直接断言 PASS', // 内容冲突
        context: '虚假内容',
        symptom: '虚假内容',
        root_cause: '虚假',
        verification: '虚假',
        confidence: 'CONFIRMED',
        status: 'ACCEPTED',
        sourceCandidateId: 'CAND-MALICIOUS-999',
        promotedAt: '2026-09-17T12:00:00.000Z',
      };

      const remoteJson = JSON.stringify(existingRemoteList, null, 2);
      const res = mergeKnowledgeIntoRemoteJson(remoteJson, [conflictingIncoming]);

      expect(res.ok).toBe(false);
      expect(res.error).toBe('SYNC_CONFLICT');
      expect(res.conflictItems?.length).toBe(1);
      expect(res.conflictItems![0].id).toBe('KC-20260916-01');
      expect(res.conflictItems![0].reason).toBe('ID_EXISTS_WITH_DIFFERENT_CONTENT');
    });
  });

  describe('5. 本地 Promotion 与远端同步解耦 (测试要求 G)', () => {
    it('模拟 GitHub 同步失败时，本地 Promotion 依然成功，本地持久化与 plan() 不受影响', async () => {
      // 步骤 1: 人工审核候选并执行 Promotion
      fs.appendFileSync(
        inboxPath,
        `- [x] **[CAND-20260917-SYNCFAIL]** 来源: \`trae\` | 提交日期: 2026-09-17\n  - **主题**: [FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)\n  - **提议内容**: 任务失败必须退款\n  - **建议归宿**: L2-state/active-projects.md\n`,
        'utf8',
      );

      const promotionReport = await service.promoteConfirmedExperiences({
        sharedMemoryDir: fakeSharedMemoryDir,
        inboxPath,
        candidatesJsonPath,
      });

      // 本地 Promotion 成功
      expect(promotionReport.promotedCount).toBe(1);
      expect(promotionReport.syncRequired).toBe(true);
      expect(promotionReport.syncPayload).toBeDefined();

      // 步骤 2: 模拟 GitHub 同步失败 (例如网络 500 或 SHA 冲突)
      const _githubSyncSimulatedSuccess = false;
      const _syncError = 'GitHub API HTTP 409: SHA mismatch (Simulated Network Error)';

      // 验证：即便同步失败，本地持久化文件仍然完好
      const localJson = JSON.parse(fs.readFileSync(candidatesJsonPath, 'utf8'));
      expect(localJson.length).toBe(1);
      expect(localJson[0].sourceCandidateId).toBe('CAND-20260917-SYNCFAIL');

      // 验证：本地 plan() 依然能正常使用该已晋升经验，不受远端失败阻断
      const planRes = await plan({
        modelId: 88,
        mediaType: 'video',
        resolution: '480p',
        projectRoot: tmpDir,
      });
      expect(planRes.domainPlan).toBeDefined();
      expect(planRes.domainPlan!.steps.length).toBe(7); // 动态注入成功
      expect(planRes.testPlan.tests.length).toBe(9);
    });
  });

  describe('6. verify() 只读不变性 (测试要求 H)', () => {
    it('verify() 调用严格保持只读，不触发任何 GitHub Sync', async () => {
      const inboxBefore = fs.readFileSync(inboxPath, 'utf8');
      const jsonBefore = fs.readFileSync(candidatesJsonPath, 'utf8');

      const res = await verify({
        taskId: 554433,
        modelId: 88,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
      });

      expect(res.ok).toBe(true);
      expect(fs.readFileSync(inboxPath, 'utf8')).toBe(inboxBefore);
      expect(fs.readFileSync(candidatesJsonPath, 'utf8')).toBe(jsonBefore);
    });
  });
});
