// Phase 41.17：Frontend Performance E2E
// 覆盖：
//  - 关键页面首屏加载指标（DOMContentLoaded / load / 渲染出内容）在合理阈值内；
//  - 轮询治理：QA Home 3s 轮询在 7.5s 窗口内请求数有界（无重复/泄漏/风暴——此前 RunDetail 死循环刷爆限流 429）；
//  - 关键页面无 console error（脚本异常 / 资源加载失败）；
//  - 产物体积：主 JS 包小于 1MB（避免打包失控拖慢首屏）。
import { test, expect, type Page } from '@playwright/test';
import { seed, injectSession, BASE_URL } from './helpers.js';

// 阈值（CI 环境宽松取值，避免抖动误报）
const NAV_MS = 5_000; // 导航完成（load）上限
const CONTENT_MS = 6_000; // 关键内容可见上限（页面含轮询+渲染）

async function loadTimings(page: Page): Promise<{ dcl: number; load: number }> {
  const t = await page.evaluate(() => {
    const n = performance.timing;
    return {
      dcl: n.domContentLoadedEventEnd - n.navigationStart,
      load: n.loadEventEnd - n.navigationStart,
    };
  });
  return t;
}

async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  return errors;
}

test.describe('Frontend Performance（41.17）', () => {
  test('登录页首屏加载在阈值内且无 console error', async ({ page }) => {
    const errors = await collectConsoleErrors(page);
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByText('PANQU Platform')).toBeVisible({ timeout: CONTENT_MS });
    const t = await loadTimings(page);
    expect(t.dcl, `DOMContentLoaded 超时（${t.dcl}ms > ${NAV_MS}ms）`).toBeLessThanOrEqual(NAV_MS);
    expect(errors, `登录页存在 console error：${errors.join(' | ')}`).toEqual([]);
  });

  test('QA Home 首屏 + 3s 轮询治理：请求数有界、无泄漏风暴', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    const qaHomeHits: number[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/qa-home')) qaHomeHits.push(Date.now());
    });
    await page.goto(`${BASE_URL}/`);
    await expect(page.getByRole('heading', { name: 'QA 工作台' }).first()).toBeVisible({ timeout: CONTENT_MS });
    const t0 = Date.now();
    await page.waitForTimeout(7_500); // 初始 + 3s + 6s 轮询窗口
    const windowHits = qaHomeHits.filter((ts) => ts >= t0);
    expect(windowHits.length, `7.5s 窗口内 qa-home 请求应约 2-3 次（3s 轮询），实际 ${windowHits.length} 次`).toBeGreaterThanOrEqual(1);
    expect(windowHits.length, `qa-home 请求异常频繁（${windowHits.length} 次）→ 轮询未治理`).toBeLessThanOrEqual(5);
  });

  test('Run Detail 轮询治理：2s 轮询不刷爆（无 429 风暴）', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    const detailHits: number[] = [];
    const four29: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes(`/api/runs/${s.runs.running}/detail`)) detailHits.push(Date.now());
      if (r.status() === 429) four29.push(r.url().slice(0, 120));
    });
    await page.goto(`${BASE_URL}/runs/${s.runs.running}`);
    await expect(page.getByRole('heading', { name: '执行详情' }).first()).toBeVisible({ timeout: CONTENT_MS });
    await page.waitForTimeout(7_000); // 2s 轮询 → 约 4 次
    expect(detailHits.length, `Run Detail 轮询请求异常频繁（${detailHits.length} 次）`).toBeLessThanOrEqual(8);
    expect(four29, `触发 429 限流（${four29.length} 次）：${four29[0] ?? ''}`).toEqual([]);
  });

  test('关键页面无 console error', async ({ page }) => {
    const s = seed();
    await injectSession(page, s.users.qa);
    const errors = await collectConsoleErrors(page);
    for (const [path, heading] of [
      ['/', 'QA 工作台'],
      [`/runs/${s.runs.completed}`, '执行详情'],
      ['/defects', 'Defect 管理'],
      ['/suites', 'Test Suites'],
    ] as const) {
      await page.goto(`${BASE_URL}${path}`);
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: CONTENT_MS });
      await page.waitForTimeout(400);
    }
    expect(errors, `关键页面存在 console error：${errors.join(' | ')}`).toEqual([]);
  });

  test('主 JS 产物体积 < 1MB', async ({ request }) => {
    const html = await (await request.get(`${BASE_URL}/`)).text();
    const match = html.match(/src="([^"]+\.js)"/);
    expect(match, 'index.html 应引用 JS 产物').not.toBeNull();
    const jsUrl = new URL(match![1], BASE_URL).href;
    const res = await request.get(jsUrl);
    expect(res.ok()).toBeTruthy();
    const bytes = (await res.body()).length;
    expect(bytes, `主 JS 包过大（${(bytes / 1024 / 1024).toFixed(2)}MB）`).toBeLessThan(1_000_000);
  });
});
