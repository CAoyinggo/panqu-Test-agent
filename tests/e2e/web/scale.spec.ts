import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Phase 51 Scale Dashboard', () => {
  test('项目/时间/模型/Benchmark Filter 与容量指标渲染', async ({ page }) => {
    await injectSession(page, seed().users.qa);
    await page.goto(`${BASE_URL}/scale`);
    await expect(page.getByText('Evaluation Scale').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Scale Project')).toHaveValue('wan3');
    for (const label of ['Evaluation Throughput', 'Active Workers', 'Queue', 'P95', 'Cost', 'Data Growth', 'Archive', 'Drift', 'Recovery']) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    await page.getByLabel('Time Range').selectOption('7d');
    await page.getByLabel('Model Filter').selectOption('rules-v1');
    await page.getByLabel('Benchmark Filter').selectOption('RCA_BENCHMARK_v1');
    await expect(page.getByText('Worker / Queue Capacity')).toBeVisible();
    await expect(page.getByText('Aggregated Evaluation History')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive' })).toBeDisabled();
    const headers = await authHeaders(page, seed().users.qa);
    for (const endpoint of [
      '/api/evaluation/queue?projectId=wan3', '/api/evaluation/workers?projectId=wan3',
      '/api/evaluation/scale?projectId=wan3', '/api/metrics/aggregated?projectId=wan3&dimension=project',
      '/api/metrics/drift?projectId=wan3', '/api/recovery/status?projectId=wan3',
    ]) {
      expect((await page.request.get(`${BASE_URL}${endpoint}`, { headers })).ok(), endpoint).toBeTruthy();
    }
    expect((await page.request.post(`${BASE_URL}/api/data/archive`, { headers, data: { projectId: 'wan3' } })).status()).toBe(403);
  });

  test('RELEASE_MANAGER Archive → Archived stats → Restore，操作有明确反馈', async ({ page }) => {
    await injectSession(page, seed().users.release);
    await page.goto(`${BASE_URL}/scale`);
    await expect(page.getByText('Evaluation Scale').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.locator('.success-banner')).toContainText('Archive 完成');
    await expect(page.getByText(/ARCHIVED 1/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('.success-banner')).toContainText('Restore 完成');
    await expect(page.getByText(/ARCHIVED 0/).first()).toBeVisible();
    const headers = await authHeaders(page, seed().users.release);
    const audit = await page.request.get(`${BASE_URL}/api/evaluation/scale/audit?projectId=wan3`, { headers });
    expect(audit.ok()).toBeTruthy();
    expect((await audit.json()).audit.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(['DATA_ARCHIVE', 'DATA_RESTORE']));
  });
});
