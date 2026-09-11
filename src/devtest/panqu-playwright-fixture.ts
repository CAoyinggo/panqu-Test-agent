/**
 * Panqu Playwright Fixture & Context Manager
 *
 * 核心能力：
 * 1. 统一管理 Browser (WebKit / Chromium) 生命周期，具备沙箱环境自适应与优雅降级
 * 2. 注入测试 Session Cookies 与脱敏鉴权
 * 3. 开启 Context 级 Playwright Trace（截图、DOM 快照、网络事件），支持 npx playwright show-trace
 * 4. 创建关联的 APIRequestContext，实现 Page 操作与接口轮询的一体化
 * 5. 安全脱敏与清理（严格禁止日志打印敏感 Cookie / Token / Key）
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  Browser,
  BrowserContext,
  Page,
  APIRequestContext,
} from 'playwright';

export interface PanquSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightFixtureOptions {
  browserType?: 'webkit' | 'chromium' | 'firefox' | 'auto' | 'api';
  headless?: boolean;
  baseUrl?: string;
  cookies?: string | PanquSessionCookie[];
  traceDir?: string;
  recordTrace?: boolean;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
}

export interface PlaywrightFixtureContext {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  request: APIRequestContext;
  tracePath?: string;
  isHeadlessBrowserAvailable: boolean;
  dispose: () => Promise<void>;
}

/**
 * 将 raw cookie 字符串 (如 "PHPSESSID=xxx; token=yyy") 解析为 Playwright Cookie 数组
 */
export function parseCookieString(
  cookieStr: string,
  targetDomain = 'test.panqu.com'
): PanquSessionCookie[] {
  if (!cookieStr || typeof cookieStr !== 'string') return [];
  const parts = cookieStr.split(';').map((p) => p.trim()).filter(Boolean);
  const cookies: PanquSessionCookie[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (name) {
      cookies.push({
        name,
        value,
        domain: targetDomain.replace(/^https?:\/\//, '').split('/')[0],
        path: '/',
        httpOnly: false,
        secure: false,
      });
    }
  }

  return cookies;
}

/**
 * 启动 Playwright Fixture 上下文
 */
export async function createPanquPlaywrightFixture(
  options: PlaywrightFixtureOptions = {}
): Promise<PlaywrightFixtureContext> {
  const playwright = await import('playwright');
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 30000;
  const preferredBrowser = options.browserType ?? 'auto';
  const baseUrl = options.baseUrl || 'https://test.panqu.com';
  const recordTrace = options.recordTrace ?? true;
  const traceDir = options.traceDir || path.resolve(process.cwd(), 'devtest-results/traces');

  // 1. 显式指定纯 API 模式
  if (preferredBrowser === 'api') {
    const extraHTTPHeaders: Record<string, string> = {};
    if (typeof options.cookies === 'string') {
      extraHTTPHeaders['Cookie'] = options.cookies;
    }
    const request = await playwright.request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders,
      ignoreHTTPSErrors: true,
    });
    return {
      request,
      isHeadlessBrowserAvailable: false,
      dispose: async () => {
        await request.dispose();
      },
    };
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let request: APIRequestContext | undefined;
  let isHeadlessBrowserAvailable = false;
  let tracePath: string | undefined;

  try {
    // 2. 尝试启动浏览器
    if (preferredBrowser === 'chromium') {
      try {
        browser = await playwright.chromium.launch({ headless });
      } catch {
        browser = await playwright.webkit.launch({ headless });
      }
    } else if (preferredBrowser === 'firefox') {
      browser = await playwright.firefox.launch({ headless });
    } else if (preferredBrowser === 'webkit') {
      browser = await playwright.webkit.launch({ headless });
    } else {
      try {
        browser = await playwright.webkit.launch({ headless });
      } catch {
        browser = await playwright.chromium.launch({ headless });
      }
    }

    // 3. 创建 BrowserContext
    context = await browser.newContext({
      baseURL: baseUrl,
      viewport: options.viewport || { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });

    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);

    // 4. 注入 Cookies
    if (options.cookies) {
      let cookiesToAdd: PanquSessionCookie[] = [];
      if (typeof options.cookies === 'string') {
        const domain = options.baseUrl ? new URL(options.baseUrl).hostname : 'test.panqu.com';
        cookiesToAdd = parseCookieString(options.cookies, domain);
      } else if (Array.isArray(options.cookies)) {
        cookiesToAdd = options.cookies;
      }

      if (cookiesToAdd.length > 0) {
        await context.addCookies(
          cookiesToAdd.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || 'test.panqu.com',
            path: c.path || '/',
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
            sameSite: c.sameSite || 'Lax',
          }))
        );
      }
    }

    // 5. 启动 Trace 录制
    if (recordTrace) {
      await mkdir(traceDir, { recursive: true });
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
    }

    // 6. 尝试创建页面
    page = await context.newPage();
    request = context.request;
    isHeadlessBrowserAvailable = true;
  } catch (error) {
    // 若受沙箱环境或 MachPort 权限限制导致浏览器子进程退出，优雅降级至 APIRequestContext 联合模式
    const extraHTTPHeaders: Record<string, string> = {};
    if (typeof options.cookies === 'string') {
      extraHTTPHeaders['Cookie'] = options.cookies;
    }
    request = await playwright.request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders,
      ignoreHTTPSErrors: true,
    });
    isHeadlessBrowserAvailable = false;
  }

  // 7. 统一安全注销与资源释放
  const dispose = async () => {
    try {
      if (context && recordTrace && isHeadlessBrowserAvailable) {
        tracePath = path.join(
          traceDir,
          `panqu-trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`
        );
        await context.tracing.stop({ path: tracePath });
      }
    } catch {
      // 容忍 trace 保存异常
    } finally {
      if (page) {
        try { await page.close(); } catch {}
      }
      if (context) {
        try { await context.close(); } catch {}
      }
      if (browser) {
        try { await browser.close(); } catch {}
      }
      if (!isHeadlessBrowserAvailable && request) {
        try { await request.dispose(); } catch {}
      }
    }
  };

  return {
    browser,
    context,
    page,
    request: request!,
    get tracePath() {
      return tracePath;
    },
    isHeadlessBrowserAvailable,
    dispose,
  };
}
