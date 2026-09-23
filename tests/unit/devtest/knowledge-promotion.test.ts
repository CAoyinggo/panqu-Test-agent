import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  plan,
  verify,
  DevTestMcpService,
  loadConfirmedExperiences,
  promoteConfirmedExperiences,
} from '../../../src/devtest/index.js';

describe('Promotion Pipeline: Confirmed Experience -> Persistent Knowledge', () => {
  function setupTestEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-test-'));
    const sharedMemoryDir = path.join(tmpDir, 'shared-memory');
    const projectRoot = path.join(tmpDir, 'test-flow');

    // 搭建 shared-memory
    const candidatesDir = path.join(sharedMemoryDir, 'candidates');
    fs.mkdirSync(candidatesDir, { recursive: true });
    const inboxPath = path.join(candidatesDir, 'inbox.md');
    fs.writeFileSync(inboxPath, '# 候选记忆池\n\n## 待审候选列表\n', 'utf8');

    // 搭建 test-flow/.agents/skills/self-evolving-tester/references/
    const referencesDir = path.join(projectRoot, '.agents/skills/self-evolving-tester/references');
    fs.mkdirSync(referencesDir, { recursive: true });
    const candidatesJsonPath = path.join(referencesDir, 'knowledge_candidates.json');
    fs.writeFileSync(candidatesJsonPath, '[]\n', 'utf8');

    // 复制 SKILL.md 供 Test 8 校验
    const skillPath = path.join(projectRoot, '.agents/skills/self-evolving-tester/SKILL.md');
    fs.writeFileSync(skillPath, '# Self-Evolving Tester Skill Content\n', 'utf8');

    return {
      tmpDir,
      sharedMemoryDir,
      projectRoot,
      inboxPath,
      candidatesJsonPath,
      skillPath,
      cleanup: () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('Test 1: PENDING Candidate (- [ ]) 严禁被 Promotion，保持隔离防污染', () => {
    const env = setupTestEnv();
    try {
      // Arrange: 写入一个未确认的候选条目 (- [ ])
      const pendingEntry = `
- [ ] **[CAND-20260917-0001]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-005] 业务风险模式: 异步任务超时漏退款 (模型 #84)
  - **提议内容**: Task #88001 终态 TIMEOUT 缺少退款流水
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, pendingEntry, 'utf8');

      // Act
      const report = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      // Assert: 未勾选严禁晋升
      expect(report.totalScanned).toBe(1);
      expect(report.confirmedCount).toBe(0);
      expect(report.promotedCount).toBe(0);
      expect(report.skippedCount).toBe(1);
      expect(report.items[0].status).toBe('INVALID_CANDIDATE_SKIPPED');
      expect(report.items[0].reason).toContain('未勾选 - [x]');

      // JSON 文件保持为空，零污染
      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  it('Test 2: CONFIRMED Candidate (- [x]) 成功晋升并进入 Persistent Knowledge (knowledge_candidates.json)', () => {
    const env = setupTestEnv();
    try {
      // Arrange: 写入一个经人工审核批准的候选条目 (- [x])
      const confirmedEntry = `
- [x] **[CAND-20260917-0002]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-004] 业务风险模式: 高并发双笔预扣资损 (模型 #84)
  - **提议内容**: Task #88002 产生 2 笔预扣流水，违背 antiDoubleBilling 不变量
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');

      // Act
      const report = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      // Assert
      expect(report.totalScanned).toBe(1);
      expect(report.confirmedCount).toBe(1);
      expect(report.promotedCount).toBe(1);
      expect(report.items[0].status).toBe('PROMOTED');
      expect(report.items[0].knowledgeId).toMatch(/^KC-\d{8}-\d{2}/);

      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent).toHaveLength(1);
      expect(jsonContent[0].id).toBe(report.items[0].knowledgeId);
      expect(jsonContent[0].claim).toContain('[FP-004]');
      expect(jsonContent[0].confidence).toBe('CONFIRMED');
      expect(jsonContent[0].status).toBe('ACCEPTED');
      expect(jsonContent[0].domain).toBe('Billing');
    } finally {
      env.cleanup();
    }
  });

  it('Test 3: 晋升后的 Persistent Knowledge 严格包含 sourceCandidateId 来源溯源元数据', () => {
    const env = setupTestEnv();
    try {
      const confirmedEntry = `
- [x] **[CAND-20260917-0003]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-002] 业务风险模式: 视频产物损坏无法解码 (模型 #84)
  - **提议内容**: Task #88003 MP4 容器结构缺失 moov Box
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');

      promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent[0].sourceCandidateId).toBe('CAND-20260917-0003');
      expect(jsonContent[0].evidence[0].source).toBe('shared-memory/candidates/inbox.md');
      expect(jsonContent[0].evidence[0].location).toBe('CAND-20260917-0003');
      expect(jsonContent[0].promotedAt).toBeDefined();
    } finally {
      env.cleanup();
    }
  });

  it('Test 4: 幂等性保障 (Idempotency)：同一个 Candidate 重复 Promotion 必须返回 ALREADY_PROMOTED 且不产生重复知识', () => {
    const env = setupTestEnv();
    try {
      const confirmedEntry = `
- [x] **[CAND-20260917-0004]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-005] 业务风险模式: 任务失败漏退款 (模型 #84)
  - **提议内容**: Task #88004 netDeducted 仍为 70 积分
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');

      // 第一次 Promotion
      const report1 = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });
      expect(report1.promotedCount).toBe(1);

      // 第二次重复 Promotion
      const report2 = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });
      expect(report2.promotedCount).toBe(0);
      expect(report2.alreadyPromotedCount).toBe(1);
      expect(report2.items[0].status).toBe('ALREADY_PROMOTED');

      // 文件中严格只有一条记录
      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  it('Test 5: 内容去重 (Deduplication)：不同 CandidateId 但内容/模式完全相同者返回 DUPLICATE_CONTENT_SKIPPED', () => {
    const env = setupTestEnv();
    try {
      // 两个不同 ID，但内容与失败模式+模型完全相同的条目
      const entry1 = `
- [x] **[CAND-20260917-0005A]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-004] 业务风险模式: 预扣流水重复扣费 (模型 #84)
  - **提议内容**: 重复预扣 2 笔
  - **建议归宿**: L2-state/active-projects.md
`;
      const entry2 = `
- [x] **[CAND-20260917-0005B]** 来源: \`antigravity\` | 提交日期: 2026-09-17
  - **主题**: [FP-004] 业务风险模式: 预扣流水重复扣费 (模型 #84)
  - **提议内容**: 重复预扣 2 笔
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, entry1 + entry2, 'utf8');

      const report = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      expect(report.totalScanned).toBe(2);
      expect(report.promotedCount).toBe(1);
      expect(report.skippedCount).toBe(1);
      expect(report.items[0].status).toBe('PROMOTED');
      expect(report.items[1].status).toBe('DUPLICATE_CONTENT_SKIPPED');

      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  it('Test 6: 晋升后的 Persistent Knowledge 能被下一次 loadConfirmedExperiences() 正确读取并合并', () => {
    const env = setupTestEnv();
    try {
      const confirmedEntry = `
- [x] **[CAND-20260917-0006]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-005] 业务风险模式: 失败任务漏退款净扣未归零 (模型 #84)
  - **提议内容**: Task #88006 异常终态未退回积分
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');

      promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      // Act: 从 projectRoot 加载持久化知识库
      const experiences = loadConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      const matchedExp = experiences.find(
        (e) =>
          e.sourceCandidateId === 'CAND-20260917-0006' ||
          e.title.includes('CAND-20260917-0006') ||
          e.title.includes('失败任务漏退款净扣未归零'),
      );
      expect(matchedExp).toBeDefined();
      expect(matchedExp?.confidence).toBe('CONFIRMED');
      expect(matchedExp?.status).toBe('ACCEPTED');
      expect(matchedExp?.related_pattern_id).toBe('FP-005');
      expect(matchedExp?.related_model_id).toBe(84);
    } finally {
      env.cleanup();
    }
  });

  it('Test 7: Promotion 执行后，verify() 核心语义依然保持 100% 只读纯内存评估，零写盘副作用', async () => {
    const env = setupTestEnv();
    try {
      const inboxBefore = fs.readFileSync(env.inboxPath, 'utf8');
      const jsonBefore = fs.readFileSync(env.candidatesJsonPath, 'utf8');

      // Act: 调用核心 verify
      const verifyRes = await verify({
        taskId: 99881,
        modelId: 84,
        mediaType: 'video',
        terminalStatus: 'FAILED',
        scoreLogs: [{ id: 1, task_id: 99881, type: 2, score: -70 }],
        expectedPoints: 70,
      });

      // Assert
      expect(verifyRes.passed).toBe(false);
      expect(verifyRes.memoryCandidate).toBeDefined();

      // verify() 绝对不直接写 inboxPath 或 candidatesJsonPath
      const inboxAfter = fs.readFileSync(env.inboxPath, 'utf8');
      const jsonAfter = fs.readFileSync(env.candidatesJsonPath, 'utf8');
      expect(inboxAfter).toBe(inboxBefore);
      expect(jsonAfter).toBe(jsonBefore);
    } finally {
      env.cleanup();
    }
  });

  it('Test 8: Promotion 仅更新 knowledge_candidates.json，绝对不修改任何源码 (*.ts) 与 SKILL.md', () => {
    const env = setupTestEnv();
    try {
      const confirmedEntry = `
- [x] **[CAND-20260917-0008]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-003] 业务风险模式: 跨项目目录越权 (模型 #201)
  - **提议内容**: folderId 跨项目越权
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');

      const skillContentBefore = fs.readFileSync(env.skillPath, 'utf8');

      // Act: 执行晋升
      promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      // Assert
      const skillContentAfter = fs.readFileSync(env.skillPath, 'utf8');
      expect(skillContentAfter).toBe(skillContentBefore);

      // 仅 knowledge_candidates.json 产生合法增量
      const jsonContent = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(jsonContent).toHaveLength(1);
      expect(jsonContent[0].claim).toContain('[FP-003]');
    } finally {
      env.cleanup();
    }
  });

  it('Test 9: 完整端到端流转闭环 (verify -> Candidate -> [x] Confirmed -> Promotion -> Persistent Knowledge -> loadConfirmedExperiences -> plan 动态注入历史核验)', async () => {
    const env = setupTestEnv();
    try {
      const mcpService = new DevTestMcpService(env.projectRoot);

      // 1. verify 发现业务资损 (失败漏退款 FP-005) 并由 MCP 服务记录至 candidate 缓冲池
      const verifyCall = await mcpService.call({
        action: 'verify',
        task_id: 66001,
        model_id: 84,
        media_type: 'video',
        terminal_status: 'FAILED',
        score_logs: [{ id: 901, task_id: 66001, type: 2, score: -70 }],
        expected_points: 70,
        shared_memory_dir: env.sharedMemoryDir,
      });

      expect(verifyCall.ok).toBe(true);
      expect(verifyCall.summary).toContain('知识自学习: 自动沉淀失败模式提案');

      const inboxContentRaw = fs.readFileSync(env.inboxPath, 'utf8');
      expect(inboxContentRaw).toContain('- [ ] **[CAND-');
      expect(inboxContentRaw).toContain('[FP-005]');

      // 2. 模拟专家审核批准 (- [ ] 变为 - [x])
      const approvedInboxContent = inboxContentRaw.replace(/- \[ \] \*\*\[(CAND-[^\]]+)\]\*\*/, '- [x] **[$1]**');
      fs.writeFileSync(env.inboxPath, approvedInboxContent, 'utf8');

      // 3. 执行 Promotion Pipeline 将已确认经验晋升沉淀为 Persistent Knowledge
      const promoReport = await mcpService.promoteConfirmedExperiences({
        sharedMemoryDir: env.sharedMemoryDir,
      });

      expect(promoReport.promotedCount).toBe(1);
      expect(promoReport.items[0].status).toBe('PROMOTED');

      // 4. 验证 knowledge_candidates.json 确实持久化落盘
      const persistentKnowledgeList = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(persistentKnowledgeList).toHaveLength(1);
      expect(persistentKnowledgeList[0].claim).toContain('[FP-005]');
      expect(persistentKnowledgeList[0].sourceCandidateId).toMatch(/^CAND-/);

      // 5. 调用 plan(): 动态从 projectRoot 读取 Persistent Knowledge 并自动注入历史核验
      const planRes = await plan({
        modelId: 84,
        mediaType: 'video',
        projectRoot: env.projectRoot,
      });

      expect(planRes.ok).toBe(true);

      // 验证 domainPlan 包含了历史经验核验步骤
      const historySteps =
        planRes.domainPlan?.steps.filter(
          (s) => s.description.includes('[历史经验核验]') && s.description.includes('FP-005'),
        ) || [];
      expect(historySteps.length).toBeGreaterThanOrEqual(1);
      expect(historySteps[0].targetObject).toBe('BillingLedger');

      // 验证 testPlan.tests 动态注入了对应的历史防范测试用例
      const historyTests = planRes.testPlan.tests.filter(
        (t) => t.id.toLowerCase().includes('history-') || t.purpose.includes('FP-005'),
      );
      expect(historyTests.length).toBeGreaterThanOrEqual(1);
      expect(historyTests[0].purpose).toContain('[历史经验核验]');
      expect(historyTests[0].requiredEvidence).toContain('billing_reconciliation');

      // 验证契约目标同步更新
      expect(planRes.changeContract?.testObjectives.some((o) => o.includes('FP-005') || o.includes('history-'))).toBe(
        true,
      );
    } finally {
      env.cleanup();
    }
  });
});
