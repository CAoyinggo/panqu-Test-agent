// Phase 41：Web E2E Playwright 配置
// webServer：启动种子服务器（内存态平台 + Web Dashboard），自动构建。
// 每个 worker 独立浏览器上下文；用例通过 seed() 读取种子清单。
// 说明：testDir 指向编译产物 dist/tests/e2e/web（先 npm run build），
//       避免 Playwright 自带 esbuild 转译源码时引入整个平台 TS 链路（ESM 命名导出无法解析）。
//
// Phase 42.3：跨浏览器回归。浏览器集合由环境变量 WEB_E2E_BROWSERS 门控：
//   默认（未设置 / 'chromium'）→ 仅 Chromium（PR 门禁快速反馈）
//   'all'                            → chromium + firefox + webkit（Nightly 全量）
//   'chromium,firefox' 等逗号列表    → 指定子集（本地定向调试）
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 项目根目录（webServer.command 需相对根目录执行）
// 注意：本配置被编译到 dist/tests/e2e/web/playwright.config.js 后再由 Playwright 加载，
//       因此需向上 4 级（dist -> tests -> e2e -> web -> 根）才能回到项目根目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const WEB_E2E_PORT = Number(process.env.WEB_E2E_PORT ?? 8799);

/** 42.3：解析 WEB_E2E_BROWSERS 门控，返回要运行的浏览器项目名集合 */
function resolveBrowsers(): string[] {
  const raw = (process.env.WEB_E2E_BROWSERS ?? 'chromium').toLowerCase().trim();
  if (raw === 'all') return ['chromium', 'firefox', 'webkit'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ['chromium', 'firefox', 'webkit'].includes(s))
    .filter((s, i, a) => a.indexOf(s) === i);
}

function buildProjects(): Array<{ name: string; use: Record<string, unknown> }> {
  const wanted = resolveBrowsers();
  const all: Array<{ name: string; use: Record<string, unknown> }> = [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          firefoxUserPrefs: {
            // 受限 macOS 沙箱环境（sandbox_init Operation not permitted）下 Firefox 内容进程
            // 会随机 SIGSEGV（Target crashed）。稳定化预置：关闭内容沙箱 + 软件渲染 + 禁 JIT/GPU 进程，
            // 仅作用于 Playwright 自动化浏览器（不校验渲染性能，不影响断言正确性）。
            'security.sandbox.content.level': 0,
            'gfx.webrender.software': true,
            'gfx.webrender.force-disabled': true,
            'layers.gpu-process.enabled': false,
            'javascript.options.jit.content': false,
            'javascript.options.baselinejit': false,
            'javascript.options.ion': false,
          },
        },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ];
  return all.filter((p) => wanted.includes(p.name));
}

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
  projects: buildProjects(),
  webServer: {
    command: 'node dist/tests/e2e/web/e2e-server.js',
    cwd: ROOT,
    url: `http://127.0.0.1:${WEB_E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
