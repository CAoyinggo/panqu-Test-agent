# Phase 42 报告：Web 前端工程化（单元/组件测试 + CI 接入 + 跨浏览器回归）

> 版本：v4.17.0 ｜ 日期：2026-08-20 ｜ 前置：Phase 41（Web 真实浏览器 E2E 与体验质量）

## 一、目标

Phase 41 完成了 Web Dashboard 的真实浏览器 E2E、体验质量与可访问性建设，但 Web 前端仍缺少三层工程化保障：前端单元/组件测试（快速反馈）、CI 持续集成（回归自动化）、跨浏览器回归（非 Chromium 兼容性）。Phase 42 补齐这三层，使 Web 前端具备与平台层同等强度的可回归性。

## 二、42.1 Web 前端单元 / 组件测试

- 框架：Vitest 4.1 + jsdom + React Testing Library（`@testing-library/react` / `jest-dom` / `user-event`），与根目录平台测试同一 Vitest 版本，独立 `web/vitest.config.ts`（`environment: 'jsdom'` + 显式 `jsdom.url`）。
- 测试环境修复（关键）：Node ≥22 自带实验性 `localStorage`（未提供 `--localstorage-file` 时值为 `undefined`），且其不在 Vitest `populateGlobal` 的 KEYS 白名单内 → jsdom 的真实 Web Storage 不会被拷贝到 `globalThis`。`web/src/test-setup.ts` 安装内存版 `MemoryStorage`（同源键值对，行为与 Web Storage 一致），保证 `api.ts` 的 token / user / traceId 会话存取可测；并补 `matchMedia` 桩 + 用例间 `localStorage.clear()`。
- 测试文件与覆盖：

| 文件 | 覆盖对象 | 用例数 |
| --- | --- | --- |
| `src/api.test.ts` | API 客户端：登录契约（accessToken 主用 / token 别名 / roles 归一化）、会话存取、Bearer+X-Trace-Id 头透传、401 自动登出、404 兜底文案、object 形态 error 解析、网络错误、15s 超时 | 13 |
| `src/hooks/usePolling.test.tsx` | 轮询 Hook：挂载即拉取、数据/loading/error 三态、卸载清定时器、不重复轮询 | 5 |
| `src/components/ui.test.tsx` | UI 组件：Card / Badge / StatusBadge / MetricCard / Table / Empty / JsonBlock / fmtTime / WindowSwitcher | 14 |
| `src/pages/Login.test.tsx` | 登录页：标题与表单渲染、错误密码提示、登录成功回调 | 3 |
| `src/env-mini.test.ts` / `src/env-probe.test.ts` | 环境探针：确认 jsdom + MemoryStorage 安装正确（防环境回归） | 2 |

- 结果：**37 passed / 0 failed**；v8 覆盖率 **语句 94.96% / 分支 81.03% / 函数 87.5% / 行 96.09%**（`ui.tsx` 语句 100%、`usePolling.ts` 语句 100%、`Login.tsx` 全覆盖、`api.ts` 语句 91%）。
- 测试驱动修复：`StatusBadge` 空字符串时 `??` 不兜底（`'' ?? '—'` 仍为 `''`）→ 改为 `status ? status : '—'`，空态显示占位符。
- 构建隔离：测试文件从生产 `tsc -b` 构建中排除（`web/tsconfig.json` 增 `exclude`），Vitest 独立编译测试文件，避免 `beforeEach` 等测试全局类型污染生产构建。

## 三、42.2 CI 接入

- 新增工作流 `.github/workflows/web-e2e.yml`，三档分级：
  - `web-unit`（PR / push main 门禁）：`npm run web:test` + `web:test:coverage` + `web:build`（tsc 类型检查 + vite），上传覆盖率报告。
  - `web-e2e-chromium`（PR / push main 门禁）：安装 Playwright Chromium → `npm run web:e2e:test` 全量 16 个 spec，上传 HTML 报告。
  - `web-e2e-cross-browser`（Nightly 定时 / 手动触发）：安装三浏览器 → `WEB_E2E_BROWSERS=all npm run web:e2e:test`，上传报告保留 14 天。
- 新增 npm 脚本：`web:test` / `web:test:coverage`（根目录透传 Web 端 Vitest）、`web:e2e:cross`（三浏览器全量）。
- E2E 服务器为内存态平台（`e2e-server.ts`），无外部依赖，CI 可离线确定性执行，无需 Repository Secrets。

## 四、42.3 跨浏览器回归

- `playwright.config.ts` 增加浏览器集合门控（环境变量 `WEB_E2E_BROWSERS`）：
  - 默认 / `chromium`：仅 Chromium（PR 门禁快速反馈）。
  - `all`：chromium + firefox + webkit（Nightly 全量）。
  - `chromium,firefox` 等逗号列表：指定子集（本地定向调试）。
- 本机验证：安装匹配版本（Playwright 1.62.1 → firefox v1538 / webkit v2336），Chromium 全量 74 passed；firefox + webkit 冒烟验证覆盖登录 / 项目 / 报告核心链路。
- 稳定化修复（关键）：受限 macOS 沙箱（`sandbox_init Operation not permitted`）下 Firefox 内容进程随机 SIGSEGV（Target crashed）。`playwright.config.ts` 的 firefox 项目增加 `firefoxUserPrefs` 预置——关闭内容沙箱（`security.sandbox.content.level: 0`）+ 软件渲染（`gfx.webrender.software` / `force-disabled`）+ 禁 GPU 进程（`layers.gpu-process.enabled: false`）+ 禁 JIT（`javascript.options.jit.content` / `baselinejit` / `ion`），仅作用于自动化浏览器，不校验渲染性能、不影响断言正确性。firefox 全量套件稳定通过。

## 五、验收

- `npm run web:test`：37 passed / 0 failed（6 个测试文件）。
- `npm run web:test:coverage`：语句 94.96% / 行 96.09%。
- `npm run web:e2e:test`：74 passed / 0 failed（Chromium）。
- 跨浏览器全量：`WEB_E2E_BROWSERS=firefox` **74 passed**（1.3m，无崩溃）；`WEB_E2E_BROWSERS=webkit` **74 passed**（1.1m）。三浏览器（chromium + firefox + webkit）各 74 用例全绿，键盘导航 / 可访问性 / 响应式等跨浏览器差异用例均通过。
- 旧能力保持 PASS：`phase41:test` 全链路（平台构建 + Web 构建 + 平台回归 + Chromium E2E）无回归。
