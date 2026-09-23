import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DevTestMcpService,
  DEVTEST_MCP_TOOL,
  DEVTEST_RECORD_CANDIDATE_TOOL,
  plan,
  verify,
  loadConfirmedExperiences,
} from '../../../src/devtest/index.js';

describe('DevTest MCP 受控 Knowledge Candidate 记录入口测试', () => {
  let tmpDir: string;
  let fakeSharedMemoryDir: string;
  let inboxPath: string;
  let candidatesJsonPath: string;
  let service: DevTestMcpService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-mcp-candidate-test-'));
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

  describe('1. Schema 与核心契约隔离', () => {
    it('四大核心动作保持永久冻结，DEVTEST_MCP_TOOL 仅允许 probe, plan, execute, verify', () => {
      expect(DEVTEST_MCP_TOOL.name).toBe('devtest');
      const actionEnum = DEVTEST_MCP_TOOL.inputSchema.properties.action.enum;
      expect(actionEnum).toEqual(['probe', 'plan', 'execute', 'verify']);
      expect(actionEnum).not.toContain('learn');
      expect(actionEnum).not.toContain('record_candidate');
    });

    it('受控 Candidate 记录入口独立暴露为 DEVTEST_RECORD_CANDIDATE_TOOL', () => {
      expect(DEVTEST_RECORD_CANDIDATE_TOOL.name).toBe('devtest_record_candidate');
      expect(DEVTEST_RECORD_CANDIDATE_TOOL.inputSchema.required).toEqual(['topic', 'content']);
      expect(DEVTEST_RECORD_CANDIDATE_TOOL.inputSchema.properties.topic).toBeDefined();
      expect(DEVTEST_RECORD_CANDIDATE_TOOL.inputSchema.properties.content).toBeDefined();
    });

    it('service.call 核心测试动作路由坚决拒绝非四大核心动作', async () => {
      const res = await service.call({ action: 'record_candidate', topic: 'test' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Unsupported action');
    });
  });

  describe('2. Candidate API 正常写入与初始状态校验', () => {
    it('参数不完整时安全拦截', async () => {
      const res1 = await service.recordCandidate({ topic: '' });
      expect(res1.ok).toBe(false);
      expect(res1.status).toBe('INVALID_ARGUMENTS');

      const res2 = await service.recordCandidate({ topic: 'Some Topic', content: '' });
      expect(res2.ok).toBe(false);
      expect(res2.status).toBe('INVALID_ARGUMENTS');
    });

    it('合法结构化 Candidate 成功写入 inbox.md 且初始状态严格为待审 [ ]', async () => {
      const res = await service.recordCandidate({
        topic: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        content: '根据 CAoyinggo/panqu-Test-agent 源码 src/devtest/billing.ts，任务失败时必须退款',
        agent: 'trae',
        pattern_id: 'FP-005',
        model_id: 88,
        source: 'github',
        repository: 'CAoyinggo/panqu-Test-agent',
        shared_memory_dir: fakeSharedMemoryDir,
      });

      expect(res.ok).toBe(true);
      expect(res.status).toBe('RECORDED_PENDING_CONFIRMATION');
      expect(res.candidateId).toMatch(/^CAND-\d{8}-\d{4}$/);
      expect(res.data?.status).toBe('PENDING_CONFIRMATION');
      expect(res.data?.nextStep).toContain('Review entry in shared-memory/candidates/inbox.md');

      // 验证文件内容
      const inboxContent = fs.readFileSync(inboxPath, 'utf8');
      expect(inboxContent).toContain(res.candidateId);
      expect(inboxContent).toContain('- [ ] **[' + res.candidateId + ']**');
      expect(inboxContent).not.toContain('- [x]'); // 严禁自动成为已确认
      expect(inboxContent).toContain('来源: `trae` (repo: CAoyinggo/panqu-Test-agent)');
      expect(inboxContent).toContain('[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)');
    });
  });

  describe('3. 内容去重防重复追加', () => {
    it('相同主题或相同模式+模型的候选再次记录时安全跳过', async () => {
      const payload = {
        topic: '[FP-004] 业务风险模式: 任务重复扣费资损缺陷 (模型 #84)',
        content: '检测到重复流水',
        pattern_id: 'FP-004',
        model_id: 84,
        shared_memory_dir: fakeSharedMemoryDir,
      };

      const first = await service.recordCandidate(payload);
      expect(first.ok).toBe(true);
      expect(first.status).toBe('RECORDED_PENDING_CONFIRMATION');

      const second = await service.recordCandidate(payload);
      expect(second.ok).toBe(true);
      expect(second.status).toBe('DUPLICATE_CANDIDATE_SKIPPED');
      expect(second.summary).toContain('跳过重复追加');
      expect(second.data?.recorded).toBe(false);

      // inbox 中仅有 1 处记录
      const inboxContent = fs.readFileSync(inboxPath, 'utf8');
      const matches = inboxContent.match(/\[FP-004\]/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe('4. 不绕过 Promotion 门禁', () => {
    it('调用 recordCandidate 之后，knowledge_candidates.json 绝不会自动生成对应条目', async () => {
      await service.recordCandidate({
        topic: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        content: '来自 GitHub 仓库审查事实',
        pattern_id: 'FP-005',
        model_id: 88,
        shared_memory_dir: fakeSharedMemoryDir,
      });

      const jsonRaw = fs.readFileSync(candidatesJsonPath, 'utf8');
      const jsonList = JSON.parse(jsonRaw);
      expect(jsonList).toEqual([]); // 保持为空，严禁直接写入长期知识库
    });

    it('未人工审核 (- [ ]) 时执行 Promotion，该候选被跳过', async () => {
      const recordRes = await service.recordCandidate({
        topic: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        content: '来自 GitHub 仓库审查事实',
        pattern_id: 'FP-005',
        model_id: 88,
        shared_memory_dir: fakeSharedMemoryDir,
      });

      const report = await service.promoteConfirmedExperiences({
        sharedMemoryDir: fakeSharedMemoryDir,
        inboxPath,
        candidatesJsonPath,
      });

      expect(report.totalScanned).toBe(1);
      expect(report.promotedCount).toBe(0);
      expect(report.skippedCount).toBe(1);
      expect(report.items[0].candidateId).toBe(recordRes.candidateId);
      expect(report.items[0].status).toBe('INVALID_CANDIDATE_SKIPPED');

      // 长期知识库仍然为空
      const jsonList = JSON.parse(fs.readFileSync(candidatesJsonPath, 'utf8'));
      expect(jsonList.length).toBe(0);
    });
  });

  describe('5. 人工确认 → Promotion → Loader 加载与 Plan 动态联动全闭环', () => {
    it('人工将 - [ ] 修改为 - [x] 后执行 Promotion，knowledge_candidates.json 出现新知识且 Plan 动态演化', async () => {
      // 步骤 1: 记录候选
      const recordRes = await service.recordCandidate({
        topic: '[FP-005] 业务风险模式: 任务失败未退款资损缺陷 (模型 #88)',
        content: 'CAoyinggo/panqu-Test-agent 源码 src/devtest/billing.ts: 异常状态下必须退款',
        pattern_id: 'FP-005',
        model_id: 88,
        shared_memory_dir: fakeSharedMemoryDir,
      });
      expect(recordRes.ok).toBe(true);

      // 步骤 2: 模拟人工审核通过 (- [ ] -> - [x])
      let inboxContent = fs.readFileSync(inboxPath, 'utf8');
      inboxContent = inboxContent.replace('- [ ]', '- [x]');
      fs.writeFileSync(inboxPath, inboxContent, 'utf8');

      // 步骤 3: 触发 Promotion
      const promotionReport = await service.promoteConfirmedExperiences({
        sharedMemoryDir: fakeSharedMemoryDir,
        inboxPath,
        candidatesJsonPath,
      });
      expect(promotionReport.promotedCount).toBe(1);
      const promotedKnowledgeId = promotionReport.items[0].knowledgeId;
      expect(promotedKnowledgeId).toBeDefined();

      // 步骤 4: 验证持久化 JSON 完整性
      const jsonList = JSON.parse(fs.readFileSync(candidatesJsonPath, 'utf8'));
      expect(jsonList.length).toBe(1);
      const entry = jsonList[0];
      expect(entry.id).toBe(promotedKnowledgeId);
      expect(entry.sourceCandidateId).toBe(recordRes.candidateId);
      expect(entry.related_pattern_id).toBe('FP-005');
      expect(entry.related_model_id).toBe(88);
      expect(entry.requiredPlanCheck).toBeDefined();
      expect(entry.requiredPlanCheck.stage).toBe('ORACLE_VERIFY');
      expect(entry.requiredPlanCheck.verificationMethod).toContain(
        'BillingOracle.reconcileTaskLedger netChargeZero 校验',
      );

      // 步骤 5: 验证 loadConfirmedExperiences 读取
      const loaded = loadConfirmedExperiences({ projectRoot: tmpDir });
      expect(loaded.some((e) => e.id === promotedKnowledgeId)).toBe(true);

      // 步骤 6: 验证下一次 plan() 动态演化
      // Model 88 (匹配)
      const planRes = await plan({
        modelId: 88,
        mediaType: 'video',
        resolution: '480p',
        duration: 4,
        projectRoot: tmpDir,
      });

      // 验证步骤增加且插入了历史经验核验
      expect(planRes.domainPlan).toBeDefined();
      expect(planRes.domainPlan!.steps.length).toBe(7); // 基线 6 + 1
      const histStep = planRes.domainPlan!.steps.find((s) => s.description.includes('[历史经验核验]'));
      expect(histStep).toBeDefined();
      expect(histStep?.stage).toBe('ORACLE_VERIFY');

      // 验证测试计划中生成了专项用例
      const histTest = planRes.testPlan.tests.find((t) => t.id === `history-${promotedKnowledgeId?.toLowerCase()}`);
      expect(histTest).toBeDefined();
      expect(histTest?.expected.verificationRule).toContain('netChargeZero');

      // 验证契约目标同步扩充
      expect(planRes.changeContract?.testObjectives.length).toBe(9); // 基线 8 + 1

      // 步骤 7: 模型隔离验证 (Model 999 不受影响)
      const otherPlan = await plan({
        modelId: 999,
        mediaType: 'video',
        resolution: '720p',
        projectRoot: tmpDir,
      });
      expect(otherPlan.domainPlan).toBeDefined();
      expect(otherPlan.domainPlan!.steps.length).toBe(6);
      expect(otherPlan.testPlan.tests.some((t) => t.id === `history-${promotedKnowledgeId?.toLowerCase()}`)).toBe(
        false,
      );
    });
  });

  describe('6. verify() 永久只读语义保持', () => {
    it('verify() 调用不会在 shared-memory 或磁盘产生未授权写入', async () => {
      const inboxBefore = fs.readFileSync(inboxPath, 'utf8');

      const res = await verify({
        taskId: 998877,
        modelId: 88,
        mediaType: 'video',
        terminalStatus: 'SUCCESS',
      });

      expect(res.ok).toBe(true);
      expect(res.evidence).toBeDefined();

      // verify 本身内核不调用写磁盘
      const inboxAfter = fs.readFileSync(inboxPath, 'utf8');
      expect(inboxAfter).toBe(inboxBefore);
    });
  });
});
