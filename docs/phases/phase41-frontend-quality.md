# Phase 41 报告（二）：前端质量——可访问性 / 响应式 / 性能 / API 治理

> 版本：v4.16.0 ｜ 日期：2026-08-20 ｜ 覆盖 41.14 - 41.20

## 一、可访问性（41.14，axe-core，WCAG 2.1 AA）

对登录 / QA Home / Run Detail / Defects / Suites / Plans / Templates / Approvals / Projects / 分享报告逐页运行 axe（`wcag2a/wcag2aa/wcag21a/wcag21aa/best-practice`），断言无 critical / serious 违规、恰好一个 `<h1>`、存在 `<main>` 地标、全部表单控件具备可访问名。

修复项：

| 问题 | 严重度 | 修复 |
| --- | --- | --- |
| `a.link` 使用 `--accent`（#3b6fe0 on #1a2333 ≈ 3.4:1） | serious | 新增 `--accent-text: #6d9bff`（≈ 5.0:1）用于链接/品牌/标题文字，按钮仍用 `--accent` |
| `.btn-danger/.btn-success` 白字填充对比度不足 | serious | 新增 `--err-deep:#c62f41`（≈ 5.4:1）、`--ok-deep:#14804a`（≈ 5.0:1）并应用到按钮填充 |
| `.badge-err` 徽标文字对比度不足 | serious | 新增 `--err-soft:#ff8f9d` 提亮 tinted 背景上的错误文字 |
| `link-in-text-block`：文本块内链接仅靠颜色区分 | serious | `a.link` 默认下划线（`rgba(109,155,255,.45)` 低饱和），hover 加深 |
| 登录页无 `<h1>` 主标题 | critical | `login-title` div → `<h1>` |
| 键盘焦点不可见（41.15） | serious | `:focus-visible` 统一 2px 描边 + offset，不干扰鼠标点击 |
| 表单控件无可访问名 | serious | 逐页补齐 `label for` / `aria-label`（登录、评论输入、缺陷表单等） |

## 二、键盘导航（41.15）

- 全部交互控件（按钮 / 链接 / 输入 / 选择）Tab 可达，焦点环可见（`focus-visible`）。
- 用例覆盖：登录表单 Tab 顺序、缺陷登记表单 Tab 可达 + 回车提交、列表操作按钮可达。
- 测试采用"目标定位"而非硬编码 Tab 次数，侧栏导航项增减不破坏用例。

## 三、响应式（41.16）

五档视口（1440×900 / 1280×720 / 1024×768 / 390×844 / 375×812）断言无 `documentElement` 级水平溢出、核心指标与导航可达。

修复项：

| 问题 | 修复 |
| --- | --- |
| 窄屏 `.nav` 用 `flex:none` → 17 个链接强制单行 893px 溢出 | `flex:1 1 auto + min-width:0`，内部链接随 `flex-wrap` 换行 |
| `.btn-group` 单行溢出 | 补 `flex-wrap: wrap` |
| 长 Run ID 撑宽表格 | 窄屏 `.mono { word-break: break-all }`、`.table td { word-break: break-word }` |
| 侧栏桌面列式 → 移动端 | `@media (max-width:768px)` 侧栏转横向 wrap，`grid-2` 单列，登录卡片自适应 |

## 四、前端性能与轮询治理（41.17）

- 首屏：登录 / QA Home / Run Detail 在阈值内渲染出关键内容，无 console error。
- 轮询治理：QA Home 3s 轮询在 7.5s 窗口内 `qa-home` 请求数有界（1~5）；Run Detail 2s 轮询不触发 429（此前死循环修复的回归防线）。
- 产物体积：主 JS 包 < 1MB（当前约 221KB）。
- `usePolling` 定时器随组件卸载清理，避免泄漏；Run Detail 报告/评论改为挂载时加载一次（`useEffect([id])`）。

## 五、API Client 治理（41.18）

`web/src/api.ts` 统一错误处理：

| 场景 | 处理 |
| --- | --- |
| HTTP 401 | 清会话（`clearSession`）并引导重登录 |
| 网络失败 / 超时（AbortError） | 归一为 `network_error` / `timeout` 结构化错误 |
| 非 2xx（403/404/429/5xx） | 透出服务端 `message`，页面呈现 `error-banner` 而非白屏 |
| 轮询期间错误 | 保留上次数据 + 显示错误，不闪空 / 不死循环 |

## 六、CI 接入（41.20）

`package.json` 新增脚本：

- `web:e2e:test`：构建平台 + 构建 Web + Playwright 全量 E2E
- `web:e2e:server`：单独启动种子服务器（调试用）
- `web:e2e`：等价 `web:e2e:test`
- `phase41:test`：`phase40:test && web:e2e:test`（旧能力 + 新 Web E2E 一站式回归）

## 七、测试文件结构（41.19）

见《Phase 41 报告（一）》第三节：14 个 spec 文件按场景隔离，共享 `helpers.ts`，Playwright `webServer` 自动建种子环境，测试数据自动隔离互不污染。
