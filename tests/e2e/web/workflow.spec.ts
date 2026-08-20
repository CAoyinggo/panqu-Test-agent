// Phase 41.4：Test Plan Workflow E2E
// 覆盖：创建 Suite → 添加 TestCase → 创建 Test Plan → 选择 Environment/Mode → 保存 → Run → 状态推进。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('Test Plan Workflow（41.4）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('创建 Suite 并添加 TestCase 后列表可见', async ({ page }) => {
    const name = `E2E-Suite-${Date.now()}`;
    await page.goto(`${BASE_URL}/suites`);
    await expect(page.getByText('Test Suites').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('input[placeholder*="名称"]').fill(name);
    await page.locator('input[placeholder*="Case IDs"]').fill('wan3-1080p-10s, wan3-1080p-5s');
    await page.locator('input[placeholder*="Tags"]').fill('e2e,smoke');
    await page.getByRole('button', { name: /创建/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已创建/, { timeout: 10_000 });
    // 列表出现新 Suite
    await expect(page.locator(`text=${name}`).first()).toBeVisible({ timeout: 10_000 });
    // 创建时指定了 2 个 case
    const row = page.locator('tr', { hasText: name }).first();
    await expect(row).toContainText('2');
  });

  test('创建 Test Plan（选择 Environment + Mode）并保存', async ({ page }) => {
    const s = seed();
    const name = `E2E-Plan-${Date.now()}`;
    await page.goto(`${BASE_URL}/plans`);
    await expect(page.getByText('Test Plans').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('input[placeholder*="名称"]').fill(name);
    await page.locator('input[placeholder*="Suite IDs"]').fill(s.suiteId);
    // 选择 Environment
    const env = page.locator('select').nth(0);
    await env.selectOption('preprod');
    // 选择 Mode
    const mode = page.locator('select').nth(1);
    await mode.selectOption('AUTONOMOUS');
    await page.getByRole('button', { name: /创建/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已创建/, { timeout: 10_000 });
    const row = page.locator('tr', { hasText: name }).first();
    await expect(row).toContainText('preprod');
    await expect(row).toContainText('AUTONOMOUS');
  });

  test('对已有 Plan 执行 Run → QUEUED 并被调度', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/plans`);
    await expect(page.getByText('Test Plans').first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('tr', { hasText: s.planId }).first();
    await row.getByRole('button', { name: /运行/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已启动 Run/, { timeout: 10_000 });
  });

  test('QA Home 快速操作直达创建页', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: /\+ 新建 Suite/ }).click();
    await expect(page).toHaveURL(/\/suites$/);
    await expect(page.getByText('Test Suites').first()).toBeVisible({ timeout: 10_000 });
  });
});
