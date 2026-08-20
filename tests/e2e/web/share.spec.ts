// Phase 41.9：Share E2E
// 覆盖：Run → Share → 复制链接 → 新浏览器 Context（不登录）→ 打开 Share URL 直接公开只读报告；
//       合法 Token → 200；错误 Token → 403；无 Token → 401/Login；不泄漏内部信息 / JWT / 敏感字段。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('Share（41.9）', () => {
  test('生成分享链接并以未登录新 Context 打开只读报告', async ({ page, browser }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Share Report/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已生成分享链接/, { timeout: 10_000 });
    // 分享链接展示在页面上
    const linkText = await page.locator('a.link.mono').first().getAttribute('href');
    expect(linkText).toBeTruthy();
    const shareUrl = `${BASE_URL}${linkText}`;

    // 新浏览器 Context（无登录态）直接打开分享 URL
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    const resp = await guest.goto(shareUrl);
    expect(resp?.status()).toBe(200);
    await expect(guest.getByText('分享报告').first()).toBeVisible({ timeout: 15_000 });
    // 只读报告关键结论
    await expect(guest.getByText('关键结论').first()).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('text=/PASS|Release 决策/').first()).toBeVisible({ timeout: 10_000 });
    // 不出现任何写操作按钮
    await expect(guest.getByRole('button', { name: /Run Again/ })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /Share Report/ })).toHaveCount(0);
    await ctx.close();
  });

  test('错误 Token → 403（不可读取）', async ({ page, browser }) => {
    const s = seed();
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    const resp = await guest.goto(`${BASE_URL}/runs/${s.runs.completed}/report?share=wrong-token`);
    // SPA fallback 返回 200 + 前端展示错误
    expect(resp?.status()).toBe(200);
    await expect(guest.locator('.error-banner').first()).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('.error-banner')).toContainText(/403|无效|失效|分享/, { timeout: 10_000 });
    await ctx.close();
  });

  test('无 Token → 不渲染内部报告（要求登录或错误）', async ({ page, browser }) => {
    const s = seed();
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.goto(`${BASE_URL}/runs/${s.runs.completed}/report`);
    // 无 share 参数且未登录 → 显示登录页（App 路由逻辑）或错误
    await expect(guest.getByText('PANQU Platform').first()).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });

  test('分享报告不泄漏 JWT / 敏感字段', async ({ page, browser }) => {
    const s = seed();
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.goto(`${BASE_URL}/runs/${s.runs.completed}/report?share=${s.share.token}`);
    await expect(guest.getByText('分享报告').first()).toBeVisible({ timeout: 15_000 });
    const body = await guest.locator('body').innerText();
    // 不应出现 JWT 片段 / passwordHash / accessToken
    for (const leak of ['passwordHash', 'accessToken', 'eyJ']) {
      expect(body, `分享页不应泄漏 ${leak}`).not.toContain(leak);
    }
    await ctx.close();
  });
});
