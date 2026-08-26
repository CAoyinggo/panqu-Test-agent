# Phase 40 总结：QA Workbench 工程化收尾

> 版本：v4.15.0 ｜ 日期：2026-08-19 ｜ 前置：v4.14.0（Phase 39，QA 工作流产品化）

## 一、目标

基于 3 个 Explore 子代理扫描出的 Critical / High 缺口逐项修复，覆盖五类问题：安全越权、缺陷管理缺失、前端断点、数据真实性、聚合性能。约束：不重建基础设施、不新增 Agent、不重写既有模块，全部复用既有 Service Layer / Repository / RBAC / Telemetry / Audit。

## 二、实施前差距分析（扫描结论）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 单资源读端点缺 Project Scope | Critical：`getSuite/getPlan/planCases/getTemplate/assetVersions/listApprovals` 可跨项目读取他人资源 |
| 2 | 缺陷管理 | `/defects` 空 stub；`DefectCreated` 事件无人发布；QA Home `recentDefects` 恒空 |
| 3 | 前端断点 | `GET /runs/:id/share` 404（应为 POST）；Settings `/api/api/version` 双前缀；无分享落地页；无 Token 不跳登录；QAHome RCA 死链 |
| 4 | 数据真实性 | run-report `failures` 恒空数组 |
| 5 | 聚合性能 | QA Home 每次全量聚合；run-report 每次 4 次遥测查询 |

## 三、5 个子阶段交付

| 子阶段 | 交付 | 验证 |
| --- | --- | --- |
| 40.1 安全加固 | 6 处服务层 + 6 处路由透传 scopes；`resolveAssetProject`（suite/plan/test-case 解析归属）；审批按 `approval→run→projectId` 过滤；`listRunComments` 默认 VIEWER | `phase40-scope.test.ts`（越权 403/资产版本隔离/审批过滤） |
| 40.2 Defect 平台化 | `workflow/defects.ts`（实体+状态机+severity+指派）；API CRUD；`DefectCreated` 事件+audit；Web 缺陷页；CLI `defect` 组；QA Home `recentDefects` 真实数据 | `tests/unit/defects.test.ts`（10）+ 集成（HTTP 全链路/隔离/契约） |
| 40.3 前端断点 | `POST /runs/:id/share`；Settings 单前缀；公开分享落地页（无 JWT+share token 校验+导出直链）；无 Token 跳登录/分享页分发；RCA 死链修复 | `phase40-scope.test.ts`（share POST/公开访问/非法 token 403/401） |
| 40.4 数据真实性 | `failures` 由真实 execution（`case:` 失败）+RCA 事件聚合；`coverage.failed` 真实计数；`decisionTrace` 可读化（summary+步骤），无数据占位不虚构 | `phase40-scope.test.ts`（2 项） |
| 40.5 性能 | QA Home TTL 缓存（按 scopes 隔离防泄漏）；run-report TTL 缓存 | `phase40-scope.test.ts`（引用相等命中+隔离） |

## 四、关键设计决策

- **分享落地页安全模型**：分享 URL `/runs/:id/report?share=<token>` 无 JWT 可读，但 share token 不可猜测（`tok-` 前缀随机串），服务端 `verifyShare(runId, token)` 校验，非法 token 403；无 share 参数仍走完整认证流程（401）。支持 `/api` 前缀（前端 baseURL）；浏览器直链（Accept: text/html）放行给 SPA fallback，由前端 `ReadOnlyRunReport` 只读渲染。
- **缓存隔离**：QA Home 缓存 key 为用户资源作用域 projects 集合（无 scope 用 `*`），防止 qa-a 读到 admin 视图数据；TTL 2s（QA Home 3s 轮询）/ 5s（报告），容量上限 64 / 256 防内存膨胀。
- **failures 真实来源**：不虚构，复用真实遥测——execution 事件（`phase='case:<id>'` + `result='failed'`）给出失败 case，rca 事件（metadata.caseId + predictedCategory）给出分类；pipeline 汇总失败不计入。
- **shareRun 返回契约**：顶层 `{ token, url }`（前端 RunDetail 依赖）同时保留 `share` 字段（CLI / report-share 测试兼容）。

## 五、验收

- 全量回归：**1586 passed / 18 skipped**（141 测试文件），较 v4.14.0 新增 7 项。
- `phase40:test` 专用脚本（workflow + integration + e2e + defects + phase40-scope）PASS。
- `platform:integration` / `platform:e2e` / `phase39:test` 保持 PASS。
- 版本 v4.14.0 → v4.15.0（package.json / package-lock / version.ts / README / CHANGELOG 同步）。
