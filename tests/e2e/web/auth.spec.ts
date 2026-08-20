// Phase 41.2：Login E2E
// 覆盖：正确账号密码 → Dashboard；错误密码 → Login Failed；Token 失效 → 自动退出 → Login；
//       无 Token 访问受保护路由 → Login。
import { test, expect } from '@playwright/test';
import { seed, BASE_URL, loginViaUi, type Account } from './helpers.js';

test.describe('Login E2E（41.2）', () => {
  test('正确账号密码：登录成功进入 QA 工作台', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/`);
    // 未登录访问根路径 → 登录页
    await expect(page.getByText('PANQU Platform')).toBeVisible();
    await page.locator('input[autocomplete="username"]').fill(s.users.qa.username);
    await page.locator('input[type="password"]').fill(s.users.qa.password);
    await page.getByRole('button', { name: /登录/ }).click();
    await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/$`));
    await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
    // 侧边栏显示当前用户与角色
    await expect(page.getByText('qa-a').first()).toBeVisible();
    await expect(page.getByText('QA').first()).toBeVisible();
  });

  test('错误密码：显示登录失败且不进入 Dashboard', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/`);
    await page.locator('input[autocomplete="username"]').fill(s.users.qa.username);
    await page.locator('input[type="password"]').fill('wrong-password-123');
    await page.getByRole('button', { name: /登录/ }).click();
    await expect(page.locator('.error-banner')).toContainText(/用户名或密码错误|登录失败/, { timeout: 10_000 });
    await expect(page.getByText('PANQU Platform')).toBeVisible();
  });

  test('Token 失效：自动退出并回到登录页', async ({ page }) => {
    const s = seed();
    await loginViaUi(page, s.users.qa);
    // 篡改 Token 为无效值后刷新 → 首个 API 请求 401 → 自动退出回登录页
    await page.evaluate(() => localStorage.setItem('panqu_token', 'invalid-tampered-token'));
    await page.reload();
    await expect(page.getByText('PANQU Platform')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  });

  test('无 Token 访问受保护路由 → 重定向到登录页', async ({ page }) => {
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByText('PANQU Platform')).toBeVisible();
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  });

  test('登出：清除会话回到登录页', async ({ page }) => {
    const s = seed();
    await loginViaUi(page, s.users.qa);
    await page.getByRole('button', { name: /退出/ }).click();
    await expect(page.getByText('PANQU Platform')).toBeVisible({ timeout: 10_000 });
    const token = await page.evaluate(() => localStorage.getItem('panqu_token'));
    expect(token).toBeNull();
  });
});

test.describe('多角色登录（41.11 前置）', () => {
  for (const key of ['admin', 'qa', 'developer', 'release', 'viewer'] as const) {
    test(`角色 ${key} 可登录并进入 Dashboard`, async ({ page }) => {
      const s = seed();
      const acct: Account = s.users[key];
      await page.goto(`${BASE_URL}/`);
      await page.locator('input[autocomplete="username"]').fill(acct.username);
      await page.locator('input[type="password"]').fill(acct.password);
      await page.getByRole('button', { name: /登录/ }).click();
      await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/$`));
      await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(acct.role).first()).toBeVisible();
    });
  }
});
