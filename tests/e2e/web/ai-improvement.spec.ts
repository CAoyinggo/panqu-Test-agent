// Phase 47：AI 改进页（Phase 46 AI 质量闭环 Dashboard）真实浏览器 E2E
// 覆盖：可达性（nav → 路由） / 7 Tab 数据渲染 / RBAC 人工门禁（QA 只读、RELEASE_MANAGER 可核验·审批） /
//       未认证重定向 / Phase 45 AI 质量页可达。
// 数据由 e2e-server 种子注入（seedAiQuality），确定性可重复。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('AI Improvement（47.1 / 46 改进闭环 Web）', () => {
  test('未认证访问 /ai-improvement → 重定向登录页', async ({ page }) => {
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByPlaceholder('用户名').or(page.locator('input[autocomplete="username"]'))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /登录/ })).toBeVisible();
  });

  test('导航「AI 改进」→ 页面渲染 + 7 Tab + QA 只读横幅', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/`);
    await page.getByRole('link', { name: 'AI 改进' }).click();
    await expect(page).toHaveURL(new RegExp(`/ai-improvement$`));
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    // QA 只读视角横幅（人工门禁，禁止 AI 自批）
    await expect(page.locator('.info-banner', { hasText: '只读视角' }).first()).toBeVisible();
    // 8 个 Tab（48.1：新增「持续评测」）
    for (const label of ['待核验反馈', '错误聚类', '改进提案', 'Prompt / Model', 'Shadow / Canary', '持续评测', '知识 Review', 'AI 质量']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('待核验反馈 Tab：未核验 INCORRECT 反馈可读（QA 核验按钮禁用）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    // 待核验列表包含种子反馈 id（未核验 INCORRECT）
    const row = page.locator('tr', { hasText: s.aiQuality.feedbackUnverified }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('INCORRECT');
    await expect(row.getByRole('button', { name: /核验/ })).toBeDisabled();
  });

  test('错误聚类 Tab：聚类行渲染（分类 / 次数 / 疑似根因）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '错误聚类' }).click();
    await expect(page.getByText(/错误聚类（\d+）/).first()).toBeVisible({ timeout: 15_000 });
    // 至少一个聚类行 + 分类徽标
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('UNDER_PREDICTION').first()).toBeVisible({ timeout: 10_000 });
  });

  test('改进提案 Tab：Gate PASS 可审批提案 + 已审批/进行中列表', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '改进提案' }).click();
    // 可审批提案卡片标题含 Gate PASS；可审批提案行（Baseline/Candidate）可见
    await expect(page.getByText(/可审批提案（Gate PASS/).first()).toBeVisible({ timeout: 15_000 });
    const appRow = page.locator('tr', { hasText: s.aiQuality.proposalApprovable }).first();
    await expect(appRow).toBeVisible({ timeout: 15_000 });
    // 已审批 / 进行中列表含 APPROVED 提案
    const approvedRow = page.locator('tr', { hasText: s.aiQuality.proposalApproved }).first();
    await expect(approvedRow).toBeVisible({ timeout: 15_000 });
  });

  test('Prompt / Model Tab：版本行渲染', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Prompt / Model' }).click();
    // Prompt 版本（risk key v1 ACTIVE / v2 DRAFT）
    await expect(page.getByText(`Prompt Versions`).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr', { hasText: s.aiQuality.promptKey }).first()).toBeVisible();
    // Model 版本（deepseek）
    await expect(page.getByText('Model Versions').first()).toBeVisible();
    await expect(page.locator('tr', { hasText: 'deepseek' }).first()).toBeVisible();
  });

  test('Shadow / Canary Tab：实验行渲染', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Shadow / Canary' }).click();
    await expect(page.getByText(/Shadow \/ Canary 实验（\d+）/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr', { hasText: s.aiQuality.shadowExperiment }).first()).toBeVisible();
    await expect(page.locator('tr', { hasText: s.aiQuality.canaryExperiment }).first()).toBeVisible();
    // 已审批提案可创建实验（QA 只读禁用）：创建实验表在实验表之后，用 last() 定位
    await expect(page.getByText(/创建实验（已审批提案）/).first()).toBeVisible({ timeout: 15_000 });
    const createRow = page.locator('tr', { hasText: s.aiQuality.proposalApproved }).last();
    await expect(createRow).toBeVisible({ timeout: 15_000 });
    await expect(createRow.getByRole('button', { name: 'Shadow' })).toBeDisabled();
  });

  test('知识 Review Tab：候选 + 质量指标渲染', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '知识 Review' }).click();
    await expect(page.getByText(/知识 Review/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr', { hasText: s.aiQuality.knowledgeCandidate }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('PENDING_REVIEW').first()).toBeVisible();
  });

  test('AI 质量 Tab：聚合指标（Accuracy / False Pass / P0 Miss / RCA / Selection / Defect / Healing）', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'AI 质量' }).click();
    await expect(page.getByText('AI Quality 聚合').first()).toBeVisible({ timeout: 15_000 });
    // 关键安全指标显示为 0（目标：不增加）
    await expect(page.locator('text=False Pass').first()).toBeVisible();
    await expect(page.locator('text=P0 Miss').first()).toBeVisible();
    await expect(page.getByText('RCA Accuracy').first()).toBeVisible();
    await expect(page.getByText('Healing Safety').first()).toBeVisible();
  });

  test('RBAC 人工门禁：RELEASE_MANAGER 批准 Gate PASS 提案 → 成功横幅 + 状态 APPROVED', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '改进提案' }).click();
    const row = page.locator('tr', { hasText: s.aiQuality.proposalApprovable }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const approveBtn = row.getByRole('button', { name: /批准/ });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();
    await expect(page.locator('.success-banner', { hasText: /已批准/ }).first()).toBeVisible({ timeout: 10_000 });
    // 提案移入「已审批 / 进行中」，状态 APPROVED
    await expect(page.locator('tr', { hasText: s.aiQuality.proposalApprovable }).last()).toContainText('APPROVED', { timeout: 15_000 });
  });

  test('持续评测 Tab：Continuous Evaluation 历史渲染（Schedule / Overall / verdict / Alert / Block）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '持续评测' }).click();
    // 运行历史（3 次：NIGHTLY / WEEKLY / RELEASE）+ 指标卡
    await expect(page.getByText(/Continuous Evaluation（\d+ 次运行）/).first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('tr', { hasText: s.aiQuality.continuousEval }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('RELEASE');
    await expect(row).toContainText('PASS');
    await expect(row).toContainText('否');
    // 指标卡（最近判定 / Alert / Block Release）
    await expect(page.getByText('最近判定').first()).toBeVisible();
    await expect(page.getByText('Block Release').first()).toBeVisible();
    // 手动触发区：QA 只读 → 三个运行按钮禁用
    const nightBtn = page.getByRole('button', { name: '运行 NIGHTLY' });
    await expect(nightBtn).toBeVisible();
    await expect(nightBtn).toBeDisabled();
  });

  test('持续评测 Tab：RELEASE_MANAGER 手动触发 RELEASE → 成功横幅 + 历史新增一行', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/ai-improvement`);
    await expect(page.getByText('AI Improvement').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '持续评测' }).click();
    const before = await page.locator('table tbody tr').count();
    const btn = page.getByRole('button', { name: '运行 RELEASE' });
    await expect(btn).toBeEnabled();
    await btn.click();
    // 成功横幅（手动触发需 RELEASE_APPROVE 人工门禁）
    await expect(page.locator('.success-banner', { hasText: /运行完成/ }).first()).toBeVisible({ timeout: 15_000 });
    // 历史新增一行（before + 1）
    await expect(async () => {
      const count = await page.locator('table tbody tr').count();
      expect(count).toBeGreaterThan(before);
    }).toPass({ timeout: 15_000 });
  });

  test('Phase 45 AI 质量页可达（导航渲染）', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    await page.goto(`${BASE_URL}/ai-quality`);
    await expect(page.getByText('AI 质量').first()).toBeVisible({ timeout: 15_000 });
  });
});
