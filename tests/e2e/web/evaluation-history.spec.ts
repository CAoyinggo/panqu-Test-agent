import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Phase 51 Evaluation history', () => {
  test('History API 支持 pagination 且保持 project scope', async ({ page }) => {
    const s = seed();
    const headers = await authHeaders(page, s.users.qa);
    const response = await page.request.get(`${BASE_URL}/api/evaluation/history?projectId=wan3&page=1&pageSize=1`, { headers });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.projectId).toBe('wan3');
    expect(body.runs.items).toHaveLength(1);
    expect(body.runs.pagination.pageSize).toBe(1);
    const cross = await page.request.get(`${BASE_URL}/api/evaluation/history?projectId=order&page=1&pageSize=1`, { headers });
    expect(cross.status()).toBe(403);
  });

  test('Scale 页面使用聚合历史而非 raw telemetry', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    await page.goto(`${BASE_URL}/scale`);
    await expect(page.getByText('Aggregated Evaluation History')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table tbody tr').first()).toBeVisible();
    await expect(page.getByText('Average Score').first()).toBeVisible();
  });
});
