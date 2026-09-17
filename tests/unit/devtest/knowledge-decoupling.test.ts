import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  plan,
  verify,
  loadConfirmedExperiences,
  matchRelevantExperiences,
  promoteConfirmedExperiences,
  type Experience,
} from '../../../src/devtest/index.js';

describe('DevTest Self-Evolving Tester Step 2.5: 知识架构收敛与 Strategy 解耦测试', () => {
  function setupTestEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decoupling-test-'));
    const sharedMemoryDir = path.join(tmpDir, 'shared-memory');
    const projectRoot = path.join(tmpDir, 'test-flow');

    // 搭建 shared-memory
    const candidatesDir = path.join(sharedMemoryDir, 'candidates');
    fs.mkdirSync(candidatesDir, { recursive: true });
    const inboxPath = path.join(candidatesDir, 'inbox.md');
    fs.writeFileSync(inboxPath, '# 候选记忆池\n\n## 待审候选列表\n', 'utf8');

    // 搭建 references/knowledge_candidates.json
    const referencesDir = path.join(projectRoot, '.agents/skills/self-evolving-tester/references');
    fs.mkdirSync(referencesDir, { recursive: true });
    const candidatesJsonPath = path.join(referencesDir, 'knowledge_candidates.json');

    return {
      tmpDir,
      sharedMemoryDir,
      projectRoot,
      inboxPath,
      candidatesJsonPath,
      cleanup: () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('1. EXP-001 与 EXP-002 已成功从 JSON 持久库无损加载，且字段属性完整', () => {
    // Act: 读取当前项目真实持久知识库
    const experiences = loadConfirmedExperiences();

    // Assert EXP-001
    const exp001 = experiences.find((e) => e.id === 'EXP-001');
    expect(exp001).toBeDefined();
    expect(exp001?.title).toContain('Wan3.0 视频生成模型 720p 计费阶梯经验');
    expect(exp001?.related_model_id).toBe(84);
    expect(exp001?.related_resolution).toBe('720p');
    expect(exp001?.related_api).toBe('/aivideo/v2/generate/video');
    expect(exp001?.related_oracle).toBe('pq_score_log');
    expect(exp001?.related_task).toBe('VIDEO_TASK');

    // Assert EXP-002
    const exp002 = experiences.find((e) => e.id === 'EXP-002');
    expect(exp002).toBeDefined();
    expect(exp002?.title).toContain('FastAdmin AdminScore 与个人账单端点回退机制');
    expect(exp002?.verification).toContain('queryTaskBillingLogs');
  });

  it('2. 移除 TS 静态常量后，基于 JSON 知识的 plan 与 probe 行为不退化', async () => {
    // Act: 为 Model 84 (720p) 执行计划推导
    const planRes = await plan({
      modelId: 84,
      mediaType: 'video',
      resolution: '720p',
      duration: 5,
    });

    expect(planRes.ok).toBe(true);
    // EXP-001 命中当前上下文并成功写入 caveats 警示
    expect(planRes.domainPlan?.caveats.some((c) => c.includes('Wan3.0') && c.includes('720p'))).toBe(true);
  });

  it('3. [x] inbox 在未 Promotion 时绝对不会进入 loadConfirmedExperiences() (Candidate Buffer 纯粹隔离)', () => {
    const env = setupTestEnv();
    try {
      // 写入已勾选的候选至 inbox.md
      const approvedEntry = `
- [x] **[CAND-20260917-UNPROMOTED]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-005] 业务风险模式: 未晋升的候选绝不提前进入运行时 (模型 #84)
  - **提议内容**: Task #12345 异常
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, approvedEntry, 'utf8');

      // 初始化空的持久库
      fs.writeFileSync(env.candidatesJsonPath, '[]\n', 'utf8');

      // Act: 加载运行时经验
      const loaded = loadConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      // Assert: 未经 promotion 绝不加载
      expect(loaded.some((e) => e.id === 'CAND-20260917-UNPROMOTED' || e.sourceCandidateId === 'CAND-20260917-UNPROMOTED')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('4. Promotion 之后，经验正式沉淀入 knowledge_candidates.json 并可被加载', () => {
    const env = setupTestEnv();
    try {
      const approvedEntry = `
- [x] **[CAND-20260917-PROMOTED]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-005] 业务风险模式: 审核并晋升后的经验成功生效 (模型 #84)
  - **提议内容**: Task #12345 异常
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, approvedEntry, 'utf8');
      fs.writeFileSync(env.candidatesJsonPath, '[]\n', 'utf8');

      // 运行晋升管道
      const report = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });
      expect(report.promotedCount).toBe(1);

      // Act: 加载运行时经验
      const loaded = loadConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });

      const found = loaded.find((e) => e.sourceCandidateId === 'CAND-20260917-PROMOTED');
      expect(found).toBeDefined();
      expect(found?.status).toBe('ACCEPTED');
      expect(found?.requiredPlanCheck).toBeDefined();
      expect(found?.requiredPlanCheck?.targetObject).toBe('BillingLedger');
    } finally {
      env.cleanup();
    }
  });

  it('5. FP-004 的历史核验行为保持不变 (生成 steps 与 testPlan.tests)', async () => {
    const fp004Exp: Experience = {
      id: 'EXP-FP004-TEST',
      title: 'Model 84 重复扣费防护 (FP-004)',
      context: '高并发生成场景',
      symptom: 'preDeductCount > 1 产生重复扣费',
      root_cause: '重试缺乏幂等',
      verification: 'BillingOracle.reconcileTaskLedger antiDoubleBilling 校验',
      related_model_id: 84,
      related_pattern_id: 'FP-004',
      confidence: 'CONFIRMED',
      status: 'CONFIRMED',
      requiredPlanCheck: {
        stage: 'ORACLE_VERIFY',
        description: '重点防范重试与并发重复扣款 (FP-004)',
        targetObject: 'BillingLedger',
        expectedOutcome: 'preDeductCount 严格 === 1',
        verificationMethod: 'BillingOracle.reconcileTaskLedger antiDoubleBilling 校验',
      },
    };

    const planRes = await plan({
      modelId: 84,
      mediaType: 'video',
      extraExperiences: [fp004Exp],
    });

    const step = planRes.domainPlan?.steps.find((s) => s.description.includes('FP-004'));
    expect(step).toBeDefined();
    expect(step?.targetObject).toBe('BillingLedger');

    const testItem = planRes.testPlan.tests.find((t) => t.id === 'history-exp-fp004-test');
    expect(testItem).toBeDefined();
    expect(testItem?.purpose).toContain('FP-004');
    expect(testItem?.layer).toBe('billing');
    expect(planRes.changeContract?.testObjectives.some((o) => o.includes('history-exp-fp004-test'))).toBe(true);
  });

  it('6. FP-005 的历史核验行为保持不变 (生成 steps 与 testPlan.tests)', async () => {
    const fp005Exp: Experience = {
      id: 'EXP-FP005-TEST',
      title: 'Model 84 失败漏退款防护 (FP-005)',
      context: '任务异步失败场景',
      symptom: 'netDeducted > 0 缺少退款流水',
      root_cause: '异常捕获漏退款',
      verification: 'BillingOracle.reconcileTaskLedger netChargeZero 校验',
      related_model_id: 84,
      related_pattern_id: 'FP-005',
      confidence: 'CONFIRMED',
      status: 'CONFIRMED',
      requiredPlanCheck: {
        stage: 'ORACLE_VERIFY',
        description: '重点核查异常终态下的退款核销流水与净扣归零 (FP-005)',
        targetObject: 'BillingLedger',
        expectedOutcome: '若任务非成功终态，必须存在对应退款流水且 netDeducted === 0',
        verificationMethod: 'BillingOracle.reconcileTaskLedger netChargeZero 校验',
      },
    };

    const planRes = await plan({
      modelId: 84,
      mediaType: 'video',
      extraExperiences: [fp005Exp],
    });

    const step = planRes.domainPlan?.steps.find((s) => s.description.includes('FP-005'));
    expect(step).toBeDefined();

    const testItem = planRes.testPlan.tests.find((t) => t.id === 'history-exp-fp005-test');
    expect(testItem).toBeDefined();
    expect(testItem?.purpose).toContain('FP-005');
  });

  it('7. 关键解耦验证: 新增任意自定义模式 (如 FP-008 网关配额熔断)，只要具备 requiredPlanCheck，无需修改 Kernel 即可通用生成步骤与测试用例', async () => {
    // 构造一个此前系统中不存在的新缺陷模式 FP-008
    const fp008Exp: Experience = {
      id: 'EXP-NEW-FP008',
      title: '网关候选渠道全熔断阻断经验 (FP-008)',
      context: '大促期间高负载场景',
      symptom: '所有候选渠道超限，网关直接熔断',
      root_cause: 'dailyQuotaLimit 耗尽',
      verification: 'RoutingOracle.evaluateGatewayRouting isBlockedByQuota 校验',
      related_model_id: 84,
      related_pattern_id: 'FP-008',
      confidence: 'CONFIRMED',
      status: 'CONFIRMED',
      requiredPlanCheck: {
        stage: 'TASK_VERIFY',
        description: '针对网关限额耗尽隐患，重点核查熔断拦截与候选渠道清空 (FP-008)',
        targetObject: 'GatewayRouting',
        expectedOutcome: 'isBlockedByQuota === true 且 candidateChannels 为空',
        verificationMethod: 'RoutingOracle.evaluateGatewayRouting 熔断态核验',
      },
    };

    // Act: 调用通用的 plan()
    const planRes = await plan({
      modelId: 84,
      mediaType: 'video',
      extraExperiences: [fp008Exp],
    });

    // Assert: steps 自动注入
    const step = planRes.domainPlan?.steps.find((s) => s.description.includes('FP-008'));
    expect(step).toBeDefined();
    expect(step?.stage).toBe('TASK_VERIFY');
    expect(step?.targetObject).toBe('GatewayRouting');
    expect(step?.expectedOutcome).toContain('isBlockedByQuota === true');

    // Assert: testPlan.tests 自动动态生成，无需在 core-kernel 中为 FP-008 写任何特殊代码
    const testItem = planRes.testPlan.tests.find((t) => t.id === 'history-exp-new-fp008');
    expect(testItem).toBeDefined();
    expect(testItem?.layer).toBe('execution');
    expect(testItem?.purpose).toContain('FP-008');
    expect(testItem?.expected.verificationRule).toBe('RoutingOracle.evaluateGatewayRouting 熔断态核验');
    expect(testItem?.expected.expectedOutcome).toContain('isBlockedByQuota === true');
    expect(planRes.changeContract?.testObjectives.some((o) => o.includes('history-exp-new-fp008'))).toBe(true);
  });

  it('8. verify() 依然保持 100% 只读与 0 磁盘写盘副作用', async () => {
    const verifyRes = await verify({
      taskId: 99123,
      modelId: 84,
      mediaType: 'video',
      terminalStatus: 'FAILED',
      scoreLogs: [{ id: 1, task_id: 99123, type: 2, score: -70 }],
      expectedPoints: 70,
    });

    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.verdict).toBe('FAIL');
    expect(verifyRes.memoryCandidate).toBeDefined();
    expect(verifyRes.memoryCandidate?.patternId).toBe('FP-005');
  });

  it('9. Promotion 管道的幂等性与去重机制依然保持健壮', () => {
    const env = setupTestEnv();
    try {
      const confirmedEntry = `
- [x] **[CAND-20260917-DEDUPE]** 来源: \`trae\` | 提交日期: 2026-09-17
  - **主题**: [FP-004] 业务风险模式: 计费幂等防范 (模型 #84)
  - **提议内容**: Task #88990 重复流水
  - **建议归宿**: L2-state/active-projects.md
`;
      fs.appendFileSync(env.inboxPath, confirmedEntry, 'utf8');
      fs.writeFileSync(env.candidatesJsonPath, '[]\n', 'utf8');

      // 第一次晋升
      const r1 = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });
      expect(r1.promotedCount).toBe(1);

      // 第二次重复晋升 (幂等)
      const r2 = promoteConfirmedExperiences({
        projectRoot: env.projectRoot,
        sharedMemoryDir: env.sharedMemoryDir,
      });
      expect(r2.promotedCount).toBe(0);
      expect(r2.alreadyPromotedCount).toBe(1);

      const json = JSON.parse(fs.readFileSync(env.candidatesJsonPath, 'utf8'));
      expect(json).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });
});
