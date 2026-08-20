// Phase 44.1：测试资产页面 E2E（TestAssets.tsx）
// 覆盖：统计卡片（资产总数/复用/新接入/优先级）+ 资产列表 + 点击资产进入版本追溯页。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL, expectNoJsonJunk } from './helpers.js';

test.describe('测试资产（44.1）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('渲染统计卡片与资产列表（含 WAN3-CORE-001）', async ({ page }) => {
    await page.goto(`${BASE_URL}/assets`);
    await expect(page.getByRole('heading', { name: '测试资产' })).toBeVisible({ timeout: 15_000 });
    // 统计卡片
    await expect(page.locator('.metric-card', { hasText: '资产总数' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.metric-card', { hasText: '复用来源' })).toBeVisible();
    await expect(page.locator('.metric-card', { hasText: '新接入' })).toBeVisible();
    // 资产列表出现（wan3 目录已导入）
    await expect(page.getByRole('link', { name: 'WAN3-CORE-001' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Wan3.0 文生视频-落日海岸').first()).toBeVisible({ timeout: 10_000 });
    // 资产链接到版本追溯页
    await expect(page.getByRole('link', { name: 'WAN3-CORE-001' })).toHaveAttribute('href', '/assets/WAN3-CORE-001');
    await expectNoJsonJunk(page);
  });

  test('点击资产进入版本追溯页', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/assets`);
    await expect(page.getByRole('heading', { name: '测试资产' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: s.assetVersions.assetId }).click();
    await expect(page).toHaveURL(new RegExp(`/assets/${s.assetVersions.assetId}$`), { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: '资产版本追溯' })).toBeVisible({ timeout: 15_000 });
  });
});
