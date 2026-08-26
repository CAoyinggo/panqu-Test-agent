# Phase 44 报告：真实浏览器 E2E 覆盖收口 + 单元覆盖缺口闭合

> 版本：v4.19.0 ｜ 日期：2026-08-20 ｜ 前置：Phase 43（Web 交互正确性 + Run 全生命周期 + 测试资产暴露）

## 一、目标

Phase 43 为 Web Dashboard 新增了 Run 创建 / 取消 / 指派与测试资产 / 资产版本追溯等能力，但仅以单元/组件测试覆盖（mock fetch），缺少真实浏览器端到端验证；同时 API 客户端与若干组件仍存在覆盖缺口。Phase 44 为目标能力补齐真实浏览器 E2E（Chromium 门禁 + Firefox/WebKit 跨浏览器）、扩展可访问性 / 键盘导航 / 响应式测试覆盖新页面、并闭合单元测试覆盖缺口。

## 二、44.1 真实浏览器 E2E（新增 4 套件，覆盖 Phase 43 新能力）

- **`tests/e2e/web/run-create.spec.ts`（新建 Run）**：表单渲染 / 全参数填写并创建 → `POST /runs` → 跳转新 Run 详情（QUEUED + Run Again 可复用）/ 提交失败（API 拦截 500）→ 错误 banner 而非白屏。
- **`tests/e2e/web/run-ops.spec.ts`（Run 生命周期操作）**：Cancel Run 按钮条件显示与取消成功（取消后 2 秒轮询刷新为 CANCELLED）/ COMPLETED 终态不显示 Cancel / 指派 Assign 携带用户名并展示成功提示。
- **`tests/e2e/web/test-assets.spec.ts`（测试资产）**：统计卡片 + 资产列表（含 WAN3-CORE-001）渲染 / 点击资产进入版本追溯页。
- **`tests/e2e/web/asset-versions.spec.ts`（资产版本追溯）**：版本历史渲染（v1 初版 / v2 补充校验步骤）/ 点击对比 → 字段级差异表（steps + expected 两字段变化）。
- **既有套件扩展到新页面**：`accessibility.spec.ts` 新增「新建 Run / 测试资产 / 资产版本追溯」axe-core 无严重违规 + 单 h1 + main 地标 + 控件可访问名；`keyboard.spec.ts` 新增「新建 Run 表单全键盘填写并 Enter 提交」（含 WebKit 分支）；`responsive.spec.ts` 新增「新建 Run / 测试资产」五档视口（1440/1280/1024/390/375）无水平溢出。
- **种子扩展**（`tests/e2e/web/e2e-server.ts`）：`importCatalog` 导入 wan3 真实用例目录 + 对 `WAN3-CORE-001` 记录 v1/v2 两版本（变更原因 / 创建人 / 快照），并暴露 `assetVersions.assetId` 供用例读取。

## 三、44.2 单元覆盖缺口闭合

- **`RunCreate.test.tsx`**：新增「携带 Template ID / 模式 / 资产版本 JSON」——断言 `POST /runs` 请求体携带 `templateId` / `mode` / `assetVersion` 对象；新增「资产版本 JSON 非法」——断言错误 banner 且不发请求。JSON 含花括号，`user-event` 会将其解析为特殊键语法，改用 `fireEvent.change` 直接设值。
- **`AssetVersions.test.tsx`**：新增「只有一个版本 → 不渲染对比区」——收口版本数 < 2 的分支（无「版本对比」卡片、无「对比」按钮）。
- **`api.test.ts`**：修正登出用例 URL 断言（改为断言 fetch 的 `input` 参数而非 `init.url`），补齐登出 `POST /logout` + Bearer + 清会话契约守护。
- **`TestAssets.test.tsx`**：对齐后端 `{ items }` 契约形态更新 mock。

## 四、E2E 稳定化修复（Phase 44 运行中定位的缺陷）

1. **`/assets/:id` SPA 路由与 vite 产物目录冲突（关键缺陷）**：`serveStatic` 将 `/assets/WAN3-CORE-001` 误判为 `web/dist/assets/*` 下的静态文件，文件不存在直接 404，导致资产版本追溯页整页不可达（`/assets/WAN3-CORE-001 不存在`）。修复：文件不存在时带扩展名（真实静态资源缺失）才 404，无扩展名回退 SPA fallback 返回 index.html。
2. **测试资产列表恒为空**：后端 `/test-assets` 返回 `{ items, source }`（与 `/knowledge` 契约一致），前端按裸数组解析导致列表为空。修复：`TestAssets.tsx` 解包 `items` 并兼容裸数组。
3. **新建 Run E2E 环境选择越权**：用例选 `preonline`，而 qa-a 作用域仅 `test/staging`，且表单下拉仅 `test/preonline` → 改选 `test`。
4. **取消用例污染共享种子 RUNNING Run**：`run-ops.spec.ts` 直接取消种子 RUNNING Run，破坏后续 `run.spec.ts` 的 RUNNING 实时刷新断言。修复：通过 API 新建独立 QUEUED Run（Cancel 对 QUEUED/RUNNING 均可用）再取消，共享种子保持 RUNNING 不变。
5. **资产对比差异数断言错误**：种子 v1→v2 实为 steps 与 expected 两字段变化，用例断言「变更 1 项」→ 修正为「变更 2 项」并补 expected 行断言。

## 五、结果

- **Web 单元/组件测试**：10 个测试文件 **68 passed / 0 failed**；v8 覆盖率 **语句 98.23% / 分支 82.14% / 函数 98.3% / 行 99.67%**。关键文件：`api.ts` 行 100%、`Login.tsx` / `ui.tsx` 全覆盖、`RunCreate.tsx` 行 100%、`RunDetail.tsx` 行 100%、`TestAssets.tsx` 行 100%、`AssetVersions.tsx` 行 97.5%。
- **Web E2E（真实浏览器）**：Chromium 全量 **87 passed / 0 failed**；受影响 44.1 新页面套件在 **Firefox 与 WebKit 各 10/10 全绿**（跨浏览器回归门禁）。
- **TypeScript**：`tsc -b` 通过；平台 API / Web Dashboard 集成测试（25 用例）无回归。

## 六、验收

- `cd web && npx vitest run --coverage`：68 passed / 0 failed，行覆盖 99.67%。
- `npx playwright test -c dist/tests/e2e/web/playwright.config.js`（Chromium 门禁）：87 passed / 0 failed。
- `WEB_E2E_BROWSERS=firefox|webkit` 定向 44.1 套件：10/10 全绿。
- 旧能力保持 PASS：Phase 43 组件测试、Phase 42 构建与既有 E2E 无回归。
