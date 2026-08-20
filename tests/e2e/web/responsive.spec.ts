// Phase 41.16：Responsive E2E
// 覆盖：1440 / 1280 / 1024 / 390 / 375 五档视口下——登录页表单完整可见且无溢出；
//       QA Home 与 Run Detail 无 body 级水平溢出、核心指标可见、侧栏导航可达。
import { test, expect, type Page } from '@playwright/test';
import { seed, loginViaUi, BASE_URL } from './helpers.js';

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 720 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-375', width: 375, height: 812 },
] as const;

/** 断言文档级无水平溢出（table 内滚动不算 body 溢出） */
async function assertNoBodyOverflow(page: Page): Promise<void> {
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  expect(sw, `body 不应水平溢出（scrollWidth=${sw} > innerWidth=${iw}）`).toBeLessThanOrEqual(iw + 1);
}

test.describe('Responsive（41.16）', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}：登录页表单完整可见且无溢出`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/`);
      await expect(page.getByText('PANQU Platform')).toBeVisible();
      const box = await page.locator('.login-card').boundingBox();
      expect(box, '登录卡片应渲染').not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
      }
      await assertNoBodyOverflow(page);
      await ctx.close();
    });
  }

  test('QA Home：五档视口无水平溢出、核心指标与导航可见', async ({ browser }) => {
    const s = seed();
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await loginViaUi(page, s.users.qa);
      await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('今日 Runs').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('link', { name: '执行' }).first()).toBeVisible();
      await assertNoBodyOverflow(page);
      await ctx.close();
    }
  });

  test('Run Detail：五档视口下报告指标可见且无溢出', async ({ browser }) => {
    const s = seed();
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await loginViaUi(page, s.users.qa);
      await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
      await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Release 决策').first()).toBeVisible({ timeout: 15_000 });
      await assertNoBodyOverflow(page);
      await ctx.close();
    }
  });
});
