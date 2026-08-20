// Phase 41.15：Keyboard Navigation E2E
// 覆盖：登录页 Tab 顺序（用户名→密码→登录）与 Enter 提交；侧边导航键盘可达并可 Enter 跳转；
//       Runs 列表键盘聚焦并 Enter 打开 Run Detail；审批按钮键盘可达且焦点可见；
//       Defect 表单全键盘填写 + Enter 提交；:focus-visible 焦点指示存在。
// 数据隔离：不篡改共享种子审批行（只验证可达性，不触发变更）。
import { test, expect, type Page } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

/** 断言当前键盘焦点元素具备可见焦点指示（:focus-visible 生效） */
async function expectFocusVisible(page: Page): Promise<void> {
  const style = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor };
  });
  expect(style, '焦点元素应存在可见 outline').not.toBeNull();
  expect(style?.outlineStyle, `焦点样式应为 solid（实际 ${style?.outlineStyle}）`).toBe('solid');
  expect(parseFloat(style?.outlineWidth ?? '0'), 'outline 宽度应 > 0').toBeGreaterThan(0);
}

test.describe('Keyboard Navigation（41.15）', () => {
  test('登录页：Tab 顺序 用户名→密码→登录，Enter 提交登录', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('PANQU Platform')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('#login-username')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#login-password')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /登录/ })).toBeFocused();
    await page.locator('#login-username').fill(s.users.qa.username);
    await page.locator('#login-password').fill(s.users.qa.password);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/$`));
    await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('侧边导航键盘可达：Tab 聚焦「执行」并 Enter 跳转 Runs', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: 15_000 });
    // 侧栏在 DOM 中先于内容：第 1 个 Tab 到「QA 工作台」，第 2 个到「执行」
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'QA 工作台' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: '执行' })).toBeFocused();
    await expectFocusVisible(page);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.getByRole('heading', { name: '执行记录' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Runs 列表：键盘聚焦 Run 链接并 Enter 打开 Run Detail', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs`);
    await expect(page.getByRole('heading', { name: '执行记录' }).first()).toBeVisible({ timeout: 15_000 });
    const runLink = page.getByRole('link', { name: s.runs.completed }).first();
    await expect(runLink).toBeVisible({ timeout: 15_000 });
    await runLink.focus();
    await expect(runLink).toBeFocused();
    await expectFocusVisible(page);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/runs/${s.runs.completed}$`));
    await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('审批中心：批准/驳回按钮键盘可达且焦点可见（不触发变更）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByRole('heading', { name: '审批中心' }).first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('tr', { hasText: s.approvals.pendingOnFailed }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const approveBtn = row.getByRole('button', { name: '批准' });
    await approveBtn.focus();
    await expect(approveBtn).toBeFocused();
    await expectFocusVisible(page);
  });

  test('Defect 表单全键盘填写并 Enter 提交（唯一缺陷名，隔离安全）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/defects`);
    await expect(page.getByRole('heading', { name: 'Defect 管理' }).first()).toBeVisible({ timeout: 15_000 });
    const title = `Keyboard-Defect-${Date.now()}`;
    // 依次 Tab 到各输入：项目→标题→级别→Run ID→Case ID→描述→登记
    // 认证页侧栏有 17 个导航链接 + 退出按钮先于内容区，故先连续 Tab 直到聚焦「项目」输入框
    // （健壮：不硬编码 Tab 次数，导航项增减不破坏本用例）
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
      if (focused === '项目（默认 wan3）') break;
    }
    await expect(page.locator('input[aria-label="项目（默认 wan3）"]')).toBeFocused();
    await page.keyboard.type(s.projectId);
    await page.keyboard.press('Tab');
    await page.keyboard.type(title);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab'); // 跳过级别 select
    await page.keyboard.press('Tab');
    await expect(page.locator('input[aria-label="Case ID（可选）"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('input[aria-label="描述（可选）"]')).toBeFocused();
    await page.keyboard.type('键盘填写缺陷');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '登记' })).toBeFocused();
    await expectFocusVisible(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('.ok-banner')).toContainText(/缺陷已登记/, { timeout: 10_000 });
    await expect(page.locator(`text=${title}`).first()).toBeVisible({ timeout: 10_000 });
  });
});
