import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Phase 51 Benchmark integrity', () => {
  test('Web 展示 HEALTHY checksum/caseCount，API 返回 valid', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/scale`);
    const panel = page.getByTestId('benchmark-integrity');
    await expect(panel).toContainText('HEALTHY', { timeout: 15_000 });
    await expect(panel).toContainText(s.evaluationScale.benchmark);
    const headers = await authHeaders(page, s.users.qa);
    const response = await page.request.get(`${BASE_URL}/api/benchmarks/${s.evaluationScale.benchmark}/integrity?projectId=wan3`, { headers });
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ projectId: 'wan3', valid: true });
  });

  test('Benchmark integrity endpoint 拒绝跨项目读取', async ({ page }) => {
    const s = seed();
    const headers = await authHeaders(page, s.users.qaB);
    const response = await page.request.get(`${BASE_URL}/api/benchmarks/${s.evaluationScale.benchmark}/integrity?projectId=wan3`, { headers });
    expect(response.status()).toBe(403);
  });
});
