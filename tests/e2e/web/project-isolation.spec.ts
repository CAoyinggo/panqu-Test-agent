// Phase 41.12：Project Isolation E2E
// 覆盖：qa-a（scope=wan3）只见 wan3 / 不见 order；qa-b（scope=order）只见 order / 不见 wan3；
//       跨项目 Run API 访问被拒 403；本作用域 Run 可读 200。
import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Project Isolation（41.12）', () => {
  test('qa-a（wan3 作用域）：QA Home 看到 wan3、看不到 order 项目', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('我的项目').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=wan3').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=ORDER 订单系统').first()).toHaveCount(0);
  });

  test('qa-b（order 作用域）：QA Home 看到 order、看不到 wan3', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qaB);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=ORDER 订单系统').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=wan3').first()).toHaveCount(0);
  });

  test('qa-a 无法读取 order 项目的 Run（API 403）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    const res = await page.request.get(`${BASE_URL}/api/runs/${s.orderProject.runId}`, { headers: await authHeaders(page, s.users.qa) });
    expect(res.status()).toBe(403);
  });

  test('qa-b 可读取 order 项目的 Run（API 200）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qaB);
    const res = await page.request.get(`${BASE_URL}/api/runs/${s.orderProject.runId}`, { headers: await authHeaders(page, s.users.qaB) });
    expect(res.status()).toBe(200);
  });

  test('qa-a 访问 order 项目 Run 详情页面 → 错误态而非泄露数据', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.orderProject.runId}`);
    await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('ORDER');
  });
});
