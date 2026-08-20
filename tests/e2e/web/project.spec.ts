// Phase 41.3：QA Home / Project E2E
// 覆盖：QA 工作台指标、Action Center、项目列表、失败 Run 可点入 Run Detail。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('QA Home / Project（41.3）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
  });

  test('Dashboard 展示真实聚合指标（今日 Runs / 失败 Runs / 待审批）', async ({ page }) => {
    // 种子：completed + failed + running + p0Block + reviewApprove + 待审批(2)
    await expect(page.getByText('今日 Runs').first()).toBeVisible();
    const todayRuns = page.getByText('今日 Runs').locator('..').locator('.metric-value');
    const failedRuns = page.getByText('失败 Runs').locator('..').locator('.metric-value');
    await expect(todayRuns).toHaveText(/^[0-9]+$/);
    await expect(failedRuns).toHaveText(/^[0-9]+$/);
    // 失败 Runs 数 ≥ 2（failed + p0Block）
    expect(Number(await failedRuns.innerText())).toBeGreaterThanOrEqual(2);
  });

  test('Action Center 渲染待处理事项且直达链接可用', async ({ page }) => {
    await expect(page.getByText(/Action Center/).first()).toBeVisible();
    // 待审批 CTA（RELEASE/APPROVAL category）
    const approveLinks = page.getByRole('link', { name: /去审批/ });
    await expect(approveLinks.first()).toBeVisible();
  });

  test('点击失败 Run 进入 Run Detail', async ({ page }) => {
    const s = seed();
    const failedId = s.runs.failed;
    const link = page.getByRole('link', { name: failedId });
    await expect(link.first()).toBeVisible({ timeout: 15_000 });
    await link.first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${failedId}$`));
    await expect(page.getByText('执行详情').first()).toBeVisible();
    await expect(page.getByText(failedId).first()).toBeVisible({ timeout: 15_000 });
  });

  test('我的项目列表包含 wan3 且可跳转 Runs', async ({ page }) => {
    await expect(page.getByText('我的项目').first()).toBeVisible();
    await expect(page.locator('text=wan3').first()).toBeVisible();
    const runsLink = page.getByRole('link', { name: /看 Runs/ }).first();
    await runsLink.click();
    await expect(page).toHaveURL(/\/runs\?project=wan3/);
  });
});
