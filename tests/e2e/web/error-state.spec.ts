// Phase 41.13：Error State E2E
// 覆盖：无效路由 → 404；无效 Run / 越权 Run → 明确错误而非白屏；后端 500 → error-banner；
//       API 网络失败（abort）→ 页面不崩溃、呈现错误态；无原始堆栈 / JSON 污染泄漏。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('Error State（41.13）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('无效路由 → 404 页面（非白屏）', async ({ page }) => {
    await page.goto(`${BASE_URL}/no-such-page-41x`);
    await expect(page.getByRole('heading', { name: '页面不存在' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('无效 Run ID → 明确错误横幅', async ({ page }) => {
    await page.goto(`${BASE_URL}/runs/run-not-exist-41x`);
    await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.error-banner')).toContainText(/不存在|错误|失败/, { timeout: 10_000 });
    // 不泄露内部堆栈
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('at ');
    expect(body).not.toContain('Error:');
  });

  test('后端 500 → 页面呈现错误态且不白屏', async ({ page }) => {
    await page.route('**/api/defects', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom', message: '模拟服务端异常', status: 500 }) }),
    );
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByRole('heading', { name: 'Defect 管理' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
  });

  test('API 网络失败（abort）→ 页面不崩溃', async ({ page }) => {
    await page.route('**/api/qa-home', (route) => route.abort('connectionrefused'));
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
  });

  test('API 429 限流 → 统一错误契约提示', async ({ page }) => {
    await page.route('**/api/runs', (route) =>
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', message: '请求过于频繁', status: 429 }) }),
    );
    await page.goto(`${BASE_URL}/runs`);
    await expect(page.getByRole('heading', { name: '执行记录' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.error-banner')).toContainText(/频繁|稍后/, { timeout: 10_000 });
  });
});
