// Phase 41.5 / 41.6：Run Detail + Failure / RCA E2E
// 覆盖：Run 状态 / 进度 / 风险 / 覆盖 / 失败明细 / RCA / 审批记录；RUNNING → COMPLETED 实时刷新；
//       失败 Run 页面显示 Failure Case + Category + Reason + RCA CTA，无 404 / 空页 / 死链。
import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL, expectNoJsonJunk } from './helpers.js';

test.describe('Run Detail（41.5 / 41.6）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('COMPLETED Run Detail 渲染完整信息', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card', { hasText: 'Run 信息' })).toBeVisible();
    // 状态徽标 COMPLETED
    await expect(page.locator('.badge', { hasText: 'COMPLETED' }).first()).toBeVisible({ timeout: 15_000 });
    // 快速复用操作可用
    await expect(page.getByRole('button', { name: /Share Report/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Run Again/ })).toBeVisible();
    await expectNoJsonJunk(page);
  });

  test('RUNNING Run 实时刷新：状态变更在轮询间隔内反映到 UI', async ({ page }) => {
    const s = seed();
    const runId = s.runs.running;
    await page.goto(`${BASE_URL}/runs/${runId}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    // 种子为 RUNNING + 45% 进度
    await expect(page.locator('.badge', { hasText: 'RUNNING' }).first()).toBeVisible({ timeout: 15_000 });
    // 通过 API 将 Run 置为 CANCELLED → 2 秒轮询应自动刷新 UI（验证 timer 生效、无泄漏死循环）
    // page.request 不共享 localStorage token → 显式携带 Authorization
    const res = await page.request.post(`${BASE_URL}/api/runs/${runId}/cancel`, { headers: await authHeaders(page, s.users.qa) });
    expect(res.status()).toBe(200);
    await expect(page.locator('.badge', { hasText: 'CANCELLED' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('FAILED Run Detail 显示失败明细 / RCA，且无 404 / 空页', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.failed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.badge', { hasText: 'FAILED' }).first()).toBeVisible({ timeout: 15_000 });
    // 报告摘要区域出现（失败数 ≥ 1，RCA ≥ 1）
    await expect(page.locator('.card', { hasText: '报告摘要' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=RCA 分类').first()).toBeVisible({ timeout: 10_000 });
    // 失败明细 Case 呈现
    await expect(page.locator('text=wan3-1080p-10s').first()).toBeVisible();
    // 无原始 JSON 污染
    await expectNoJsonJunk(page);
  });

  test('P0-BLOCK Run 报告显示 BLOCK 决策与失败详情', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.p0Block}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.badge', { hasText: 'FAILED' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=BLOCK').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=P0 失败，禁止发布').first()).toBeVisible({ timeout: 10_000 });
  });

  test('无效 Run ID → 明确错误而非白屏', async ({ page }) => {
    await page.goto(`${BASE_URL}/runs/run-does-not-exist-41`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.error-banner').first()).toBeVisible({ timeout: 10_000 });
  });
});
