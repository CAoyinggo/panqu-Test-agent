// Phase 41.10：Release / Approval E2E
// 覆盖：REVIEW Run → 审批中心 → 批准 → APPROVED；驳回 → REJECTED；P0 失败 → BLOCK 不执行发布。
//       RBAC：QA 不能审批 release（需 RELEASE_APPROVE），RELEASE_MANAGER 可批准。
import { test, expect } from '@playwright/test';
import { seed, injectSession, BASE_URL, expectErrorBanner } from './helpers.js';

test.describe('Approval / Release（41.10）', () => {
  test('RELEASE_MANAGER 批准 PENDING 审批 → 状态变 APPROVED', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByText('审批中心').first()).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr', { hasText: s.approvals.approve }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /批准/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已批准/, { timeout: 10_000 });
    // 行内状态刷新为 APPROVED
    await expect(row.locator('.badge', { hasText: 'APPROVED' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('RELEASE_MANAGER 驳回 PENDING 审批 → 状态变 REJECTED', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByText('审批中心').first()).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr', { hasText: s.approvals.p0Block }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /驳回/ }).click();
    await expect(page.locator('.ok-banner')).toContainText(/已驳回/, { timeout: 10_000 });
    await expect(row.locator('.badge', { hasText: 'REJECTED' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('历史已决审批（REJECTED）不再显示批准/驳回按钮', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.release);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByText('审批中心').first()).toBeVisible({ timeout: 15_000 });
    const row = page.locator('tr', { hasText: s.approvals.rejected }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('.badge', { hasText: 'REJECTED' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('button', { name: /批准|驳回/ })).toHaveCount(0);
  });

  test('RBAC：QA 无权审批 release → 错误提示', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/approvals`);
    await expect(page.getByText('审批中心').first()).toBeVisible({ timeout: 15_000 });
    // 41.10：用 pendingOnFailed（全程保持 PENDING）而非 approve——approve 会被「批准」用例改写成 APPROVED，
    //        单 worker 顺序执行下再对该行点批准会找不到按钮。数据隔离：每个用例只读/写自己专属的种子行。
    const row = page.locator('tr', { hasText: s.approvals.pendingOnFailed }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: /批准/ }).click();
    await expectErrorBanner(page, /无权|权限/);
  });

  test('P0 失败 Run：报告决策为 BLOCK（发布阻断）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    await page.goto(`${BASE_URL}/runs/${s.runs.p0Block}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=BLOCK').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=P0 失败，禁止发布').first()).toBeVisible({ timeout: 10_000 });
  });
});
