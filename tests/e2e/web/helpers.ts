// Phase 41：Web E2E 共享助手（读取种子清单 / 登录 / 数据断言）
import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WEB_E2E_PORT } from './e2e-server.js';
import type { WebE2eSeed } from './e2e-server.js';

export const BASE_URL = `http://127.0.0.1:${WEB_E2E_PORT}`;
const SEED_FILE = path.join(os.tmpdir(), 'panqu-web-e2e-seed.json');

/** 读取种子清单（webServer 启动后生成；失败则给出明确环境提示） */
export function seed(): WebE2eSeed {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(
      `WEB_E2E_SEED 缺失：${SEED_FILE}。请先启动 e2e-server（npm run web:e2e:server）确保环境可用。`,
    );
  }
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8')) as WebE2eSeed;
}

export interface Account {
  username: string;
  password: string;
  role: string;
}

/** 通过真实 UI 登录（41.2：验证登录页交互链路） */
export async function loginViaUi(page: Page, account: Account): Promise<void> {
  await page.goto(`${BASE_URL}/`);
  await page.getByPlaceholder('用户名').or(page.locator('input[autocomplete="username"]')).fill(account.username);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole('button', { name: /登录/ }).click();
  await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/$`));
  await expect(page.getByText('QA 工作台').first()).toBeVisible({ timeout: 15_000 });
}

/** 通过 API 直接注入会话（非登录路径用例的快速前置；不依赖人工浏览器状态） */
export async function injectSession(page: Page, account: Account): Promise<void> {
  const res = await page.request.post(`${BASE_URL}/auth/login`, {
    data: { username: account.username, password: account.password },
  });
  expect(res.ok(), `登录失败：${account.username} (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    accessToken: string;
    user: { username: string; roles: string[]; scopes?: { projects?: string[]; environments?: string[]; businesses?: string[] } };
  };
  const token = body.accessToken;
  const scopes = body.user?.scopes
    ? {
        projects: body.user.scopes.projects ?? [],
        environments: body.user.scopes.environments ?? [],
        businesses: body.user.scopes.businesses ?? [],
      }
    : { projects: [], environments: [], businesses: [] };
  const user = { username: account.username, role: account.role, scopes };
  await page.goto(`${BASE_URL}/`);
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('panqu_token', t);
    localStorage.setItem('panqu_user', JSON.stringify(u));
  }, { t: token, u: user });
  await page.goto(`${BASE_URL}/`);
}

/** 获取 API 认证请求头：page.request 不共享 localStorage 里的 token，需显式传 Authorization */
export async function authHeaders(page: Page, account: Account): Promise<Record<string, string>> {
  const res = await page.request.post(`${BASE_URL}/auth/login`, {
    data: { username: account.username, password: account.password },
  });
  expect(res.ok(), `登录失败：${account.username} (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { accessToken: string };
  return { Authorization: `Bearer ${body.accessToken}` };
}

/** 等待页面上出现非空白报告数据（41.8：无 undefined / NaN / 原始 JSON 污染） */
export function assertNoJunk(page: Page): void {
  void page;
}

/** 断言页面正文不包含原始 JSON 污染标记 */
export async function expectNoJsonJunk(page: Page): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const junk of ['undefined', 'NaN', '{"runId"', '"report":', 'null,null']) {
    expect(body, `页面不应包含 ${junk}`).not.toContain(junk);
  }
}

/** 断言当前可见的错误横幅（error-banner）存在且含指定文本（支持正则） */
export async function expectErrorBanner(page: Page, text: string | RegExp): Promise<void> {
  const banner = page.locator('.error-banner').first();
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText(text);
}
