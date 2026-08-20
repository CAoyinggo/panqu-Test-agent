// Phase 44.1：Run 生命周期操作 E2E（Cancel / Assign）
// 覆盖：RUNNING Run 显示 Cancel 按钮且取消成功 / COMPLETED Run 不显示 Cancel（终态不可取消）/
//       指派 Assign 携带用户名并展示成功提示（真实浏览器操作）。
// 数据隔离：取消用例通过 API 新建独立 QUEUED Run 再取消，不触碰共享种子 RUNNING Run
//       （否则会破坏 run.spec.ts 的 RUNNING 实时刷新断言，测试间相互污染）。
import { test, expect } from '@playwright/test';
import { seed, injectSession, authHeaders, BASE_URL } from './helpers.js';

test.describe('Run 生命周期操作（44.1）', () => {
  test.beforeEach(async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
  });

  test('RUNNING Run 显示 Cancel Run 按钮并取消成功', async ({ page }) => {
    const s = seed();
    // 新建独立 QUEUED Run（qa-a 作用域：test/staging）→ Cancel 对 QUEUED/RUNNING 均可用
    const res = await page.request.post(`${BASE_URL}/api/runs`, {
      headers: await authHeaders(page, s.users.qa),
      data: { projectId: 'wan3', environment: 'staging', trigger: 'manual' },
    });
    expect(res.status()).toBe(200);
    const created = (await res.json()) as { runId: string; status: string };
    expect(created.status).toBe('QUEUED');
    const runId = created.runId;
    await page.goto(`${BASE_URL}/runs/${runId}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    // QUEUED → Cancel 按钮可见
    await expect(page.getByRole('button', { name: 'Cancel Run' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Cancel Run' }).click();
    // 成功 banner：已取消 Run
    await expect(page.locator('.ok-banner')).toContainText(/已取消 Run/, { timeout: 10_000 });
    // 2 秒轮询刷新后状态变为 CANCELLED
    await expect(page.locator('.badge', { hasText: 'CANCELLED' }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('COMPLETED Run 不显示 Cancel Run 按钮（终态不可取消）', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.completed}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.badge', { hasText: 'COMPLETED' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Cancel Run' })).toHaveCount(0);
  });

  test('指派 Assign → 携带用户名并展示成功提示', async ({ page }) => {
    const s = seed();
    await page.goto(`${BASE_URL}/runs/${s.runs.running}`);
    await expect(page.getByText('执行详情').first()).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('指派给（逗号分隔用户名）').fill('zhangsan,lisi');
    await page.getByRole('button', { name: '指派 Assign' }).click();
    // 成功 banner：已指派给 zhangsan、lisi
    await expect(page.locator('.ok-banner')).toContainText(/已指派给 zhangsan、lisi/, { timeout: 10_000 });
  });
});
