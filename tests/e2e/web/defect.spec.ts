// Phase 41.7：Defect E2E
// 覆盖：从失败页创建 Defect（Title/Severity/Description/Assignee）→ 缺陷已登记 → QA Home Recent Defects 出现真实数据。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL, expectNoJsonJunk } from './helpers.js';

test.describe('Defect（41.7）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('登记缺陷：填写完整字段后列表与 QA Home 出现真实数据', async ({ page }) => {
    const title = `E2E 缺陷 ${Date.now()}`;
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByText('Defect 管理').first()).toBeVisible({ timeout: 15_000 });

    // 填写登记表单
    await page.locator('input[placeholder*="项目"]').fill('wan3');
    await page.locator('input[placeholder*="标题"]').fill(title);
    await page.locator('select').first().selectOption('high');
    await page.locator('input[placeholder*="Run ID"]').fill(seed().runs.failed);
    await page.locator('input[placeholder*="Case ID"]').fill('wan3-1080p-10s');
    await page.locator('input[placeholder*="描述"]').fill('E2E 自动登记：转码花屏缺陷');
    await page.getByRole('button', { name: /登记/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/缺陷已登记/, { timeout: 10_000 });

    // 列表出现新缺陷（真实数据）
    await expect(page.locator(`text=${title}`).first()).toBeVisible({ timeout: 10_000 });
    await expectNoJsonJunk(page);

    // QA Home → Recent Defects 出现该缺陷标题
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('最近缺陷').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`text=${title}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test('已有种子缺陷详情可打开并展示关联 Run', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/defects/${s.defects[0]}`);
    await expect(page.getByText(/返回缺陷列表/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=1080p 转码偶发花屏').first()).toBeVisible();
    await expect(page.getByRole('link', { name: s.runs.failed }).first()).toBeVisible({ timeout: 10_000 });
    // 状态操作按钮存在
    await expect(page.getByRole('button', { name: 'OPEN' })).toBeVisible();
  });

  test('缺陷列表显示状态流转操作', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByText('Defect 管理').first()).toBeVisible({ timeout: 15_000 });
    // 种子缺陷存在
    await expect(page.locator('text=1080p 转码偶发花屏').first()).toBeVisible({ timeout: 10_000 });
    // OPEN 状态缺陷有「开始处理」操作
    await expect(page.getByRole('button', { name: /开始处理/ }).first()).toBeVisible({ timeout: 10_000 });
  });
});
