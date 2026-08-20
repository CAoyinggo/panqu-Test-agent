# Phase 43 报告：Web Dashboard 交互正确性 + Run 全生命周期 + 测试资产暴露

> 版本：v4.18.0 ｜ 日期：2026-08-20 ｜ 前置：Phase 42（Web 前端工程化：单元/组件测试 + CI + 跨浏览器回归）

## 一、目标

Phase 39-42 已为 Web Dashboard 建立测试基础设施（单元/组件测试 + 真实浏览器 E2E + CI + 跨浏览器回归），但 Web 界面仍存在三类缺口：写操作失败静默无反馈、Run 生命周期操作（新建/取消/指派）与测试资产未在 Web 界面暴露、评论提交存在契约缺陷（发 `{ text }` 导致正文恒为空）。Phase 43 修复交互正确性并补齐平台能力的 Web 呈现。

## 二、43.1 写操作错误处理与契约修复

- **Defect 管理写操作错误反馈**（`web/src/pages/Defects.tsx`）：此前 `doCreate` / `doStatus` / `doAssign` 无 try/catch，写操作失败表现为 unhandled rejection 且无任何用户反馈。统一增加 try/catch + `err` 错误 banner，成功仍复用 `msg` 成功 banner。
- **RunDetail 写操作统一错误/忙碌态**（`web/src/pages/RunDetail.tsx`）：新增 `runAction` 包装函数——统一处理错误 banner（`actionErr`）与按钮忙碌禁用（`busy`），失败不再静默吞掉；Run Again / Clone / Create Template / Share / Comment / Cancel / Assign 全部接入。
- **评论契约修复（关键缺陷）**：服务端 `addRunComment` 读取 `c.body.body`（string），此前前端发送 `{ text: comment }` → 200 但正文恒为空。改为发送 `{ body: comment }`，`api.test.ts` 断言契约（发 `{ body: '请确认模型服务' }`）。
- **API 客户端补 DELETE**（`web/src/api.ts`）：新增 `api.del`（DELETE 方法，带认证头），平台端点需删除资源时使用，`api.test.ts` 守护方法名与认证头透传。
- **Runs 页项目过滤**（`web/src/pages/Runs.tsx`）：此前 `?project=<id>` query 被忽略，表现为展示全部 Runs、项目过滤失效。改为解析 `useSearchParams` 并按 `projectId` 过滤，QA Home「看 Runs」直达项目视角；列表页新增「+ 新建 Run」入口与「项目过滤：X ✕」清除按钮。

## 三、43.2 Run 全生命周期管理（Web 呈现）

- **新建 Run 页面**（`web/src/pages/RunCreate.tsx`，路由 `/runs/new`）：支持全参数创建——项目 ID / 环境 / 触发类型 / Feature / Plan ID / Suite IDs / Template ID / 模式 / 预算 / Release 门禁 / 资产版本（JSON）。提交 `POST /runs` 成功后跳转 Run 详情；失败展示错误 banner（如 403 无权限）。导航与列表页均新增「新建 Run」入口。
- **取消 Run**（`RunDetail.tsx`）：`POST /runs/:id/cancel`，仅 `QUEUED` / `RUNNING` 状态显示 Cancel Run 按钮（PASS/FAILED/COMPLETED 不显示，终态不可取消），成功刷新数据。
- **指派 Run**（`RunDetail.tsx`）：`POST /runs/:id/assign`，逗号分隔多用户名（`zhangsan,lisi`），空输入禁用按钮，成功提示「已指派给 …」并清空输入。

## 四、43.3 测试资产 Web 暴露

- **测试资产页**（`web/src/pages/TestAssets.tsx`，路由 `/assets`）：并行拉取 `GET /test-assets` + `GET /test-assets/stats`，渲染统计卡片（资产总数 / 分类 / 优先级 / 来源分布）与资产列表；每条资产链接到版本追溯页；接口失败展示错误 banner。
- **资产版本追溯页**（`web/src/pages/AssetVersions.tsx`，路由 `/assets/:id`）：拉取 `GET /assets/:id/versions` 渲染版本历史（版本号 / 变更原因 / 登记人 / 时间）；版本 ≥2 时提供对比区，`GET /assets/:id/compare?from&to` 展示字段级差异（changed / added / removed / changes），失败展示独立错误区。
- **路由与导航**（`web/src/App.tsx`）：新增 `/runs/new`、`/assets`、`/assets/:id` 三条路由与导航项（「新建 Run」「测试资产」）。
- 后端端点已在 Phase 39-40 提供（`POST /runs/:id/cancel|assign`、`GET /test-assets|/stats`、`GET /assets/:id/versions|compare`），本次仅补 Web 呈现，零后端改动。

## 五、测试覆盖补强

- **RunDetail 回归测试扩展至 14 用例 → 行覆盖 100%**（`web/src/pages/RunDetail.test.tsx`）：
  - 评论契约 `{ body }`（防回退 `{ text }`）/ Cancel 按钮条件显示（RUNNING 显示、终态不显示）/ 点击 Cancel → POST /cancel + 成功 banner / Run Again → POST /rerun / 指派 Assign → 携带 `assignees` / Clone Configuration → POST /clone / Create Template → POST /template / Share Report → 展示分享链接 / 空评论 / 空指派 guard（不发请求）/ 写操作失败 → 错误 banner（不再静默吞掉）/ 报告与评论加载失败 → catch 降级不崩溃 / 报告含 failures + RCA + decisionTrace + cost → 渲染表格与 JsonBlock / 评论带 mentions → 渲染 @badge；审批记录 → 渲染表格。
- **新增页面测试**：`RunCreate.test.tsx`（3 用例：表单渲染 / 提交全参数契约 / 403 失败 banner）、`TestAssets.test.tsx`（2 用例：统计卡片 + 资产列表 + 链接 / 失败 banner）、`AssetVersions.test.tsx`（2 用例：版本历史渲染 / 版本对比差异表）。
- **整体结果**：10 个测试文件 **59 passed / 0 failed**，v8 覆盖率 **语句 93.8% / 分支 78.89% / 函数 93.22% / 行 95.12%**。关键文件：`RunDetail.tsx` 语句 98.86% / 行 100%、`TestAssets.tsx` 行 100%、`Login.tsx` 全覆盖、`RunCreate.tsx` 行 93.02%、`api.ts` 行 94.59%。
- **TypeScript 检查**：`tsc -b` 通过（测试文件从生产构建排除，不污染类型）。

## 六、验收

- `cd web && npx vitest run --coverage`：**59 passed / 0 failed**（10 个测试文件），行覆盖 95.12%。
- `npx tsc -b`：类型检查通过，无错误。
- 后端端点核对：`POST /runs`、`POST /runs/:id/cancel|assign|rerun|clone|template|share|comments`、`GET /test-assets|/stats`、`GET /assets/:id/versions|compare` 均已存在，前端零后端改动。
- 旧能力保持 PASS：Phase 42 单元/组件测试 + 构建无回归。
