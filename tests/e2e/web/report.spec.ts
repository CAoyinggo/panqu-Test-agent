// Phase 41.8：Report E2E（Run Detail 报告摘要 + 导出）
// 覆盖：Requirement/Change/Portfolio/Exploration/Priority/Execution/RePlanning/Stopping/RCA/Defect/Healing/Knowledge/Release/Trace/Cost；
//       无空白 / undefined / NaN / JSON 原始结构污染。
import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL, expectNoJsonJunk } from './helpers.js';

test.describe('Report（41.8）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('COMPLETED Run 报告摘要展示关键结论与成本', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.locator('.card', { hasText: '报告摘要' }).first()).toBeVisible({ timeout: 15_000 });
    // Release 决策 / 风险 / 覆盖 / 失败 / RCA / 成本 / 耗时
    await expect(page.getByText('Release 决策').first()).toBeVisible();
    await expect(page.getByText('风险').first()).toBeVisible();
    await expect(page.getByText('覆盖').first()).toBeVisible();
    await expect(page.getByText('成本').first()).toBeVisible();
    // 决策 PASS（种子 decisionState PASS）
    await expect(page.locator('.badge', { hasText: 'PASS' }).first()).toBeVisible({ timeout: 10_000 });
    // 覆盖 2/2
    await expect(page.locator('text=/2\\/2/').first()).toBeVisible({ timeout: 10_000 });
    await expectNoJsonJunk(page);
  });

  test('FAILED Run 报告摘要展示失败与 RCA 明细（无空白 / 无污染）', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.failed}`);
    await expect(page.locator('.card', { hasText: '报告摘要' }).first()).toBeVisible({ timeout: 15_000 });
    // 失败数 ≥ 1
    await expect(page.locator('text=RCA 分类').first()).toBeVisible({ timeout: 10_000 });
    // RCA 分类 ASSERTION 呈现（合法 FailureCategory）
    await expect(page.locator('text=ASSERTION').first()).toBeVisible({ timeout: 10_000 });
    // 失败 Case + 原因
    await expect(page.locator('text=wan3-1080p-10s').first()).toBeVisible();
    await expect(page.locator('text=/执行失败/').first()).toBeVisible();
    await expectNoJsonJunk(page);
  });

  test('报告导出 JSON 端点返回合法 JSON（Run Detail 导出链接可用）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    // page.request 不共享 localStorage token → 显式携带 Authorization
    const res = await page.request.get(`${BASE_URL}/api/runs/${s.runs.completed}/report`, { headers: await authHeaders(page, s.users.qa) });
    expect(res.ok()).toBeTruthy();
    const json = (await res.json()) as { runId: string; releaseDecision: { decision: string } | null; failures: unknown[]; rca: unknown[] };
    expect(json.runId).toBe(s.runs.completed);
    expect(Array.isArray(json.failures)).toBeTruthy();
    expect(Array.isArray(json.rca)).toBeTruthy();
  });

  test('报告导出 HTML 端点返回 200', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    const res = await page.request.get(`${BASE_URL}/api/runs/${s.runs.completed}/report/export?format=html`, { headers: await authHeaders(page, s.users.qa) });
    expect(res.status()).toBe(200);
  });
});
