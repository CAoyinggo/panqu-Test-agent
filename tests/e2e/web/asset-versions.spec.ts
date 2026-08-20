// Phase 44.1：资产版本追溯页 E2E（AssetVersions.tsx）
// 覆盖：版本历史渲染（初版/补充校验步骤）+ 字段级对比差异表。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

test.describe('资产版本追溯（44.1）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('渲染版本历史（v1 初版 / v2 补充校验步骤）', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/assets/${s.assetVersions.assetId}`);
    await expect(page.getByRole('heading', { name: '资产版本追溯' })).toBeVisible({ timeout: 15_000 });
    // 版本历史表
    await expect(page.locator('tr', { hasText: '初版' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr', { hasText: '补充校验步骤' })).toBeVisible({ timeout: 10_000 });
    // 版本对比区出现（版本 ≥2）
    await expect(page.getByRole('button', { name: '对比' })).toBeVisible({ timeout: 10_000 });
  });

  test('点击对比 → 展示字段级差异表', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/assets/${s.assetVersions.assetId}`);
    await expect(page.getByRole('heading', { name: '资产版本追溯' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr', { hasText: '初版' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '对比' }).click();
    // 差异摘要 + 字段级差异表（v1→v2：steps 与 expected 两字段变化）
    await expect(page.locator('text=变更 2 项').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('tr', { hasText: 'steps' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('tr', { hasText: 'expected' })).toBeVisible({ timeout: 10_000 });
  });
});
