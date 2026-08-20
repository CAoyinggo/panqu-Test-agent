// Phase 41.14：Accessibility E2E（axe-core）
// 覆盖：主要用户流页面（登录 / QA Home / Runs / Run Detail / Suites / Plans / Templates / Defects /
//       Approvals / Projects / 分享报告）逐页运行 axe-core，断言：
//       - 无 critical / serious 违规（标签、对比度、ARIA、表单控件可访问名等）
//       - 每页恰好一个 <h1> 主标题（heading-order 友好）
//       - 存在 <main> 地标（landmark）
//       - 全部表单控件具备可访问名称（label / aria-label）
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { seed, injectSession, BASE_URL } from './helpers.js';

/** 运行 axe-core 并断言无 critical / serious 违规 */
async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const summary = bad.map((v) => `${v.id}(${v.impact}): ${v.nodes.length} 处`).join('; ');
  expect(bad, `[${label}] 存在严重可访问性违规：${summary}`).toEqual([]);
}

/** 断言页面有且仅有一个 h1 主标题 */
async function expectSingleH1(page: Page): Promise<void> {
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1').first()).toBeVisible();
}

/** 断言存在 main 地标且表单控件均有可访问名称（label 或 aria-label） */
async function expectMainLandmarkAndNamedControls(page: Page): Promise<void> {
  await expect(page.locator('main').first()).toBeVisible();
  const unnamed = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea, button'));
    return controls
      .filter((el) => {
        const elTag = el.tagName.toLowerCase();
        if (elTag === 'button') {
          const hasText = (el.textContent ?? '').trim().length > 0 || el.getAttribute('aria-label');
          return !hasText;
        }
        const labelable = el as HTMLInputElement;
        const id = el.id ? `#${el.id}` : null;
        const hasLabel = id ? document.querySelector(`label[for="${CSS.escape(id.slice(1))}"]`) : null;
        const aria = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby');
        const isHidden = el.getAttribute('type') === 'hidden';
        return !isHidden && !hasLabel && !aria;
      })
      .map((el) => el.tagName.toLowerCase());
  });
  expect(unnamed, '存在无可访问名称的表单控件').toEqual([]);
}

test.describe('Accessibility（41.14）', () => {
  test('登录页无严重 axe 违规', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('PANQU Platform')).toBeVisible();
    await expectAxeClean(page, 'login');
    await expectSingleH1(page);
  });

  test('QA 工作台无严重 axe 违规', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(page, 'qa-home');
    await expectSingleH1(page);
    await expectMainLandmarkAndNamedControls(page);
  });

  test('Run Detail 无严重 axe 违规', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(page, 'run-detail');
    await expectSingleH1(page);
    await expectMainLandmarkAndNamedControls(page);
  });

  test('Defect 管理无严重 axe 违规（表单控件均有可访问名）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByRole('heading', { name: 'Defect 管理' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(page, 'defects');
    await expectSingleH1(page);
    await expectMainLandmarkAndNamedControls(page);
  });

  test('Test Suites / Plans / Templates 无严重 axe 违规', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    for (const [path, heading] of [
      ['/suites', 'Test Suites'],
      ['/plans', 'Test Plans'],
      ['/templates', 'Run Templates'],
    ] as const) {
      await page.goto(`${BASE_URL}${path}`);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 15_000 });
      await expectAxeClean(page, heading);
      await expectSingleH1(page);
      await expectMainLandmarkAndNamedControls(page);
    }
  });

  test('审批中心无严重 axe 违规', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByRole('heading', { name: '审批中心' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(page, 'approvals');
    await expectSingleH1(page);
    await expectMainLandmarkAndNamedControls(page);
  });

  test('项目管理无严重 axe 违规', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/projects`);
    await expect(page.getByRole('heading', { name: '项目管理' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(page, 'projects');
    await expectSingleH1(page);
    await expectMainLandmarkAndNamedControls(page);
  });

  test('分享报告（未登录）无严重 axe 违规', async ({ page, browser }) => {
    const s = seed();
    const ctx = await browser.newContext();
    const guest = await ctx.newPage();
    await guest.goto(`${BASE_URL}/runs/${s.runs.completed}/report?share=${s.share.token}`);
    await expect(guest.getByRole('heading', { name: '分享报告' }).first()).toBeVisible({ timeout: 15_000 });
    await expectAxeClean(guest, 'share-report');
    await expectSingleH1(guest);
    await ctx.close();
  });
});
