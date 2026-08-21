import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Phase 52 Cost & Capacity Dashboard', () => {
  test('成本归因、过滤、趋势、预算、预测、异常与容量完整渲染', async ({ page }) => {
    await injectSession(page, seed().users.admin);
    await page.goto(`${BASE_URL}/cost`);
    await expect(page.getByText('Cost Overview').first()).toBeVisible({ timeout: 15_000 });
    for (const label of ['Total Cost', 'Cost / Run', 'Cost / Evaluation', 'Cost / Benchmark', 'Cost / Project', 'Forecast 30d', 'Budget', 'Anomaly']) await expect(page.getByText(label).first()).toBeVisible();
    await expect(page.getByLabel('Cost Project')).toHaveValue('wan3');
    await page.getByLabel('Cost Range').selectOption('30d');
    await page.getByLabel('Trend Grain').selectOption('weekly');
    await page.getByLabel('Cost Model').fill('gpt-4o-mini');
    await expect(page.getByText('Weekly Cost Trend')).toBeVisible();
    await expect(page.getByText('Cost Anomalies')).toBeVisible();
    await expect(page.getByText('Capacity Dashboard')).toBeVisible();
    await expect(page.getByText('Desired Workers')).toBeVisible();
    const headers = await authHeaders(page, seed().users.admin);
    for (const endpoint of ['/api/cost/summary?projectId=wan3', '/api/cost/forecast?projectId=wan3', '/api/cost/anomalies?projectId=wan3', '/api/budgets?projectId=wan3', '/api/workers/capacity']) expect((await page.request.get(`${BASE_URL}${endpoint}`, { headers })).ok()).toBeTruthy();
  });

  test('QA 只能查看自己的 Project 且预算修改被拒绝', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    const headers = await authHeaders(page, seed().users.qa);
    expect((await page.request.get(`${BASE_URL}/api/cost/projects/wan3`, { headers })).ok()).toBeTruthy();
    expect((await page.request.get(`${BASE_URL}/api/cost/projects/order`, { headers })).status()).toBe(403);
    expect((await page.request.post(`${BASE_URL}/api/budgets?projectId=wan3`, { headers, data: { daily: 1 } })).status()).toBe(403);
  });
});
