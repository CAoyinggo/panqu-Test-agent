# Phase 41 报告（一）：Web 前端真实浏览器 E2E 测试

> 版本：v4.16.0 ｜ 日期：2026-08-20 ｜ 前置：v4.15.0（Phase 40，QA Workbench 工程化收尾）

## 一、目标

Phase 40 已完成 HTTP 层验证，但真实前端交互、路由、登录、分享页面、Dashboard 操作尚未经过浏览器级 E2E 验证。Phase 41 将 Web Dashboard 从"代码正确 + HTTP 正确"提升到"真实浏览器操作正确 + 用户流程完整 + UI 状态正确 + 可访问 + 可回归"。

## 二、基础设施

- 框架：Playwright（`@playwright/test@1.62.1`）+ Chromium，项目未预装时优先选用 Playwright。
- 测试服务器：`tests/e2e/web/e2e-server.ts`（内存态平台 + Web Dashboard 构建产物，`WEB_E2E_PORT=8799`），Playwright `webServer` 自动拉起并注入种子数据。
- 共享助手：`tests/e2e/web/helpers.ts`（种子清单读取 / UI 登录 / 会话注入 / API 认证头 / JSON 污染断言）。
- 运行方式：`npm run web:e2e:test`（构建平台 + 构建 Web + Playwright 全量）；`web:e2e:server` 单独起服务。

## 三、测试文件组织（41.19）

| 文件 | 覆盖 Phase | 场景 |
| --- | --- | --- |
| `auth.spec.ts` | 41.2 | 登录成功 / 错误密码 / Token 失效跳登录 |
| `project.spec.ts` | 41.3 | 项目列表 / Run 计数 / 失败计数展示 |
| `workflow.spec.ts` | 41.4 | 建 Suite + TestCase / 建 Test Plan / 对 Plan 执行 Run / 快速操作直达 |
| `run.spec.ts` | 41.5 / 41.6 | Run 状态 / 进度 / 风险 / 覆盖 / 失败明细 / RCA / 实时刷新 / 无效 ID 错误态 |
| `defect.spec.ts` | 41.7 | 从失败创建缺陷 / 状态流转 / 详情 |
| `report.spec.ts` | 41.8 | 报告关键指标 / 无 JSON 污染 / 导出 |
| `share.spec.ts` | 41.9 | 分享链接生成 / 无 Token 只读渲染 / 不泄漏 JWT / 非法 token 拒绝 |
| `approval.spec.ts` | 41.10 | 发布审批 / 驳回 / 职责分离（不能审批自己发起的申请） |
| `project-isolation.spec.ts` | 41.12 | qa-a 见 wan3 / qa-b 见 order / 跨项目 API 403 / 页面错误态不泄漏 |
| `error-state.spec.ts` | 41.13 | 404 / 网络失败 / 限流错误态可见而非白屏 |
| `accessibility.spec.ts` | 41.14 | axe-core（wcag2a/aa/21a/21aa/best-practice）逐页扫描，无 critical/serious |
| `keyboard.spec.ts` | 41.15 | Tab 可达全部表单控件 / 焦点可见 / 输入回车提交 |
| `responsive.spec.ts` | 41.16 | 1440/1280/1024/390/375 五档视口无 body 级水平溢出 |
| `performance.spec.ts` | 41.17 | 首屏加载阈值 / 轮询治理（请求数有界无 429）/ 无 console error / JS 包 < 1MB |

## 四、测试结果与发现

- 全量 Web E2E：**74 passed / 0 failed**（14 个 spec 文件）。
- 测试驱动修复的真实缺陷：
  1. 登录 Token 字段不一致：后端返回 `accessToken`，前端曾只读 `token` → 登录后跳转异常。
  2. `RunDetail` 无限循环刷爆限流：报告/评论在每次渲染时重复调用，`setReport` 触发重渲染形成死循环，2s 内触发 429 → 收敛为 `useEffect([id])` 挂载时加载一次。
  3. QA Home 快速操作死链：`/suites/new` 等指向 NotFound → 改指真实路由。
  4. 分享落地页路由：公开分享 URL 未走只读渲染 → 修正 `ReadOnlyRunReport` 分发。
  5. 审批职责分离：`release-mgr` 不能审批自己发起的申请（27.3），E2E 种子改为 `qa-a` 发起、`release-mgr` 决策。
  6. 项目作用域泄漏（41.12 真实 bug）：`QaHomeService` 仅过滤 projects/defects，Runs 与 Approvals 未按 scope 过滤 → qa-b（order 作用域）能看到 wan3 的进行中/失败 Runs 与审批；修复后按 `run.projectId` 与 `approval.runId → projectId` 映射过滤，Action Center 同步收敛。
  7. 响应式溢出（41.16）：窄屏 `.nav` 使用 `flex:none` 禁止收缩，17 个链接强制单行 893px 撑爆视口 → 改 `flex:1 1 auto + min-width:0` 允许内部换行；`.btn-group` 补 `flex-wrap`；长 Run ID 窄屏断行。
  8. 可访问性（41.14）：登录页无 `<h1>`；`.link`/按钮填充对比度不足（3.4:1 < 4.5:1）；文本块内链接仅靠颜色区分 → 逐项修复（详见《Phase 41 报告（二）：前端质量》）。

## 五、浏览器可用性声明

本机浏览器 WebView 可正常启动，Playwright + Chromium 全流程为真实浏览器 E2E，**未降级**为 HTTP Contract / 静态分析替代。
