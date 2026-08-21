import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Phase 51 Drift', () => {
  test('wan3 Score Drift 自动进入 REVIEW，Dashboard 展示 signal', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    await page.goto(`${BASE_URL}/scale`);
    await expect(page.getByText('Drift Signals')).toBeVisible({ timeout: 15_000 });
    const score = page.locator('tr').filter({ has: page.getByText('SCORE', { exact: true }) });
    await expect(score).toContainText('REVIEW');
    await expect(score).toContainText('score drop');
  });

  test('order baseline 无变化 → PASS 且 project isolated', async ({ page }) => {
    const s = seed();
    const headers = await authHeaders(page, s.users.qaB);
    const response = await page.request.get(`${BASE_URL}/api/metrics/drift?projectId=order`, { headers });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.projectId).toBe('order');
    expect(body.verdict).toBe('PASS');
  });
});
