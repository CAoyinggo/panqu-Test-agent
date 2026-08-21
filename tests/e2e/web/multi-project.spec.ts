// Phase 51.1：Web + API 多项目 Evaluation 隔离。
import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Multi-project AI Evaluation isolation', () => {
  test('qa-a 仅看到 wan3 Evaluation 分区，跨项目 API 被拒绝', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/ai-improvement`);

    const selector = page.getByLabel('Evaluation Project');
    await expect(selector).toHaveValue('wan3');
    await expect(selector.locator('option')).toHaveCount(1);
    await expect(page.locator('tr', { hasText: s.aiQuality.feedbackUnverified }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText(s.orderEvaluation.feedbackUnverified);

    const headers = await authHeaders(page, s.users.qa);
    const forbidden = await page.request.get(`${BASE_URL}/api/evaluation/scope?projectId=order`, { headers });
    expect(forbidden.status()).toBe(403);
  });

  test('qa-b 自动进入 order 分区，Web 不泄露 wan3 Evaluation 数据', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qaB);
    await page.goto(`${BASE_URL}/ai-improvement`);

    const selector = page.getByLabel('Evaluation Project');
    await expect(selector).toHaveValue('order');
    await expect(selector.locator('option')).toHaveCount(1);
    await expect(page.locator('tr', { hasText: s.orderEvaluation.feedbackUnverified }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).not.toContainText(s.aiQuality.feedbackUnverified);

    const headers = await authHeaders(page, s.users.qaB);
    const scope = await page.request.get(`${BASE_URL}/api/evaluation/scope?projectId=order`, { headers });
    expect(scope.ok()).toBeTruthy();
    expect((await scope.json()).projectId).toBe('order');
  });
});
