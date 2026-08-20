// Phase 44.1：新建 Run 页面 E2E（RunCreate.tsx）
// 覆盖：表单渲染 / 全参数提交创建 Run / 创建成功跳转 Run 详情（真实浏览器操作）。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL, expectErrorBanner } from './helpers.js';

test.describe('新建 Run（44.1）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('表单渲染（项目/环境/触发/创建按钮）', async ({ page }) => {
    await page.goto(`${BASE_URL}/runs/new`);
    await expect(page.getByRole('heading', { name: '新建 Run' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('项目 ID（必填）')).toBeVisible();
    await expect(page.getByLabel('环境（必选）')).toBeVisible();
    await expect(page.getByLabel('触发类型（必选）')).toBeVisible();
    await expect(page.getByRole('button', { name: '创建 Run' })).toBeVisible();
  });

  test('填写参数并创建 → POST /runs → 跳转 Run 详情', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/new`);
    await expect(page.getByRole('heading', { name: '新建 Run' })).toBeVisible({ timeout: 15_000 });
    // 项目框有默认值 wan3，直接选环境/触发即可（表单仅 test/preonline；qa-a 可访问 test）
    await page.getByLabel('环境（必选）').selectOption('test');
    await page.getByLabel('触发类型（必选）').selectOption('release');
    await page.getByLabel('Feature（可选）').fill('e2e-create-run');
    await page.getByLabel('Suite IDs（可选）').fill(s.suiteId);
    await page.getByRole('button', { name: '创建 Run' }).click();
    // 创建成功 → 跳转新 Run 详情页（执行详情）
    await expect(page).toHaveURL(/\/runs\/run-\d+/, { timeout: 15_000 });
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    // 新 Run 为 QUEUED，存在 Run Again / Clone 等操作
    await expect(page.getByRole('button', { name: /Run Again/ })).toBeVisible({ timeout: 15_000 });
  });

  test('提交失败（无效环境）→ 错误 banner 而非白屏', async ({ page }) => {
    // 通过 API 拦截，让 POST /runs 返回 500，验证前端展示错误 banner 且停留创建页
    await page.goto(`${BASE_URL}/runs/new`);
    await expect(page.getByRole('heading', { name: '新建 Run' })).toBeVisible({ timeout: 15_000 });
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error', message: '服务器内部错误，请重试' }) });
      } else {
        await route.continue();
      }
    });
    await page.getByRole('button', { name: '创建 Run' }).click();
    await expectErrorBanner(page, /服务器内部错误/);
    await expect(page).toHaveURL(/\/runs\/new$/);
  });
});
