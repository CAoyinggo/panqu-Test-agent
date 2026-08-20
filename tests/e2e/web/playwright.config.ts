// Phase 41：Web E2E Playwright 配置
// webServer：启动种子服务器（内存态平台 + Web Dashboard），自动构建。
// 每个 worker 独立浏览器上下文；用例通过 seed() 读取种子清单。
// 说明：testDir 指向编译产物 dist/tests/e2e/web（先 npm run build），
//       避免 Playwright 自带 esbuild 转译源码时引入整个平台 TS 链路（ESM 命名导出无法解析）。
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录（webServer.command 需相对根目录执行）
// 注意：本配置被编译到 dist/tests/e2e/web/playwright.config.js 后再由 Playwright 加载，
//       因此需向上 4 级（dist -> tests -> e2e -> web -> 根）才能回到项目根目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const WEB_E2E_PORT = Number(process.env.WEB_E2E_PORT ?? 8799);

export default defineConfig({
  testDir: path.join(ROOT, 'dist/tests/e2e/web'),
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_E2E_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node dist/tests/e2e/web/e2e-server.js',
    cwd: ROOT,
    url: `http://127.0.0.1:${WEB_E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
