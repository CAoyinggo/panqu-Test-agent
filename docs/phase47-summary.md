# Phase 47 总结：Web「AI 质量 / AI 改进」页可达性修复 + 真实浏览器 E2E 覆盖

> 版本：v4.22.0（被测平台）｜ 日期：2026-08-20 ｜ 前置：Phase 46（AI 质量优化与持续改进闭环，v4.21.0）
> 本文档所有结论均来自真实运行结果：`npm run build` + `npm run web:e2e:test`（Playwright Chromium 98 用例全绿）+ 全量 `npm test`（1736 通过）。禁止虚构。

## 一、目标

Phase 46 建立了 AI 质量闭环后端与「AI 改进」Web Dashboard，但复扫发现两个真实缺口：

1. **可达性缺陷（Bug）**：侧边栏导航已加入「AI 改进」（`/ai-improvement`），但 `web/src/App.tsx` 的 `<Routes>` 缺少对应 `<Route>`，点击后落到 `<NotFound>` —— Phase 46 的改进页在 Web UI 上不可达。
2. **真实浏览器覆盖缺口**：Phase 41-44 建立了 Playwright 真实浏览器 E2E 纪律（87 用例覆盖 18 个页面），但 Phase 45 的「AI 质量」页与 Phase 46 的「AI 改进」页均无 `.spec.ts` 覆盖；E2E 种子服务器也未注入任何 AI 质量数据，无法对闭环页面做端到端断言。

Phase 47 目标：修复路由缺陷 + 建立 AI 质量闭环页面的真实浏览器 E2E 覆盖，让「测试 AI 本身」的闭环在 Web UI 层可验证、可回归。

## 二、交付物清单

### 1. 路由缺陷修复（`web/src/App.tsx`）

- 新增 `<Route path="/ai-improvement" element={<AIImprovement />} />`，修复导航 → NotFound 缺陷。
- 影响：侧边栏「AI 改进」现可正常进入 Phase 46 改进页（7 Tab 全量可用）。

### 2. E2E 种子注入（`tests/e2e/web/e2e-server.ts`）

- 新增 `seedAiQuality()`：确定性注入 AI 质量闭环数据（`createAIQualityService` + 人工审批链，禁止 AI 自批）：
  - 未核验 INCORRECT 反馈（RISK P2→P0 / RCA NETWORK→MODEL / RELEASE PASS→BLOCK，来源 HUMAN_CORRECTION / RCA_VERIFICATION / PRODUCTION_INCIDENT）+ 1 条已核验 CORRECT。
  - `autoProposals()` 自动提案 → `recordEvaluation`（Baseline 90% / Candidate 94%，critical 全 0 → Gate PASS）→ 1 条保持 EVALUATING（可审批）；另 1 条离线评测后人工 `approve('release-mgr')` → APPROVED（创建实验数据源）。
  - Prompt 版本：`risk` v1 ACTIVE(0.90) + v2 DRAFT(0.94)；Model 版本：`deepseek:deepseek-chat@v3` ACTIVE + `v4` DRAFT。
  - 实验：Shadow COMPLETED + Canary RUNNING@5%；知识候选 1 条 PENDING_REVIEW。
- `WebE2eSeed` 新增 `aiQuality` 清单字段（feedbackUnverified / proposalApprovable / proposalApproved / promptKey / shadowExperiment / canaryExperiment / knowledgeCandidate），经 `createPlatformServer({ aiQuality })` 注入，供用例读取。

### 3. 真实浏览器 E2E（`tests/e2e/web/ai-improvement.spec.ts`，11 用例全绿）

| 用例 | 断言 |
| --- | --- |
| 未认证访问 /ai-improvement → 登录页 | 重定向 + 登录表单可见 |
| 导航「AI 改进」→ 页面 + 7 Tab + QA 只读横幅 | 路由可达、标题、7 Tab、只读提示 |
| 待核验反馈 Tab | 未核验 INCORRECT 反馈行 + QA 核验按钮禁用 |
| 错误聚类 Tab | 聚类行 + UNDER_PREDICTION 分类徽标 |
| 改进提案 Tab | Gate PASS 可审批提案 + 已审批/进行中列表 |
| Prompt / Model Tab | risk Prompt 版本 + deepseek Model 版本行 |
| Shadow / Canary Tab | Shadow/Canary 实验行 + 创建实验区 QA 只读禁用 |
| 知识 Review Tab | 候选行 + PENDING_REVIEW + 质量指标 |
| AI 质量 Tab | Accuracy / False Pass / P0 Miss / RCA / Selection / Defect / Healing 指标 |
| RBAC 人工门禁（RELEASE_MANAGER） | 批准 Gate PASS 提案 → 成功横幅 + 状态 APPROVED |
| Phase 45 AI 质量页可达 | /ai-quality 渲染「AI 质量」 |

## 三、验收结果

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build` + `web` `npm run build` | 通过（tsc + vite 无错误） |
| 新 AI 改进 E2E | `npm run web:e2e:ai` | 11 用例全绿 |
| 全量 Web E2E | `npm run web:e2e:test` | **98 用例全绿**（87 存量 + 11 新增） |
| 全量单测 | `npm test` | **1736 通过 / 18 skip，0 失败** |
| 平台集成 | `npm run platform:integration` | 94 通过 |
| 平台 E2E | `npm run platform:e2e` | 16 通过 |
| 版本同步 | `package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` | 全部 v4.22.0 |

## 四、安全与质量说明

- 人工门禁在真实浏览器层验证：QA 只读（核验 / 批准 / 创建实验按钮全部禁用 + 只读横幅）；RELEASE_MANAGER 才可审批，成功即横幅提示 + 状态 APPROVED。禁止 AI 自批。
- 所有种子数据确定性、可重复：内存态平台 + 每次 webServer 重启全量重建，无残留、无人工登录态。
- 关键安全指标目标保持：False Pass / P0 Miss / Unsafe Healing 为 0（AI 质量 Tab 断言）。

## 五、下一步建议

1. **跨浏览器回归**：将 `ai-improvement.spec.ts` 纳入 `web:e2e:cross`（firefox / webkit）门控。
2. **Continuous Evaluation 定时器**：当前 `ops.ts` 仅记录 nightly/weekly/release 调度描述，建议接入真实定时器（平台 scheduler）让 Nightly Evaluation 自动运行并落盘报告。
3. **Eval → Feedback 桥接**：当前 Evaluation 失败不会自动进入 Feedback Registry（BENCHMARK_FAILURE 渠道为手工接入），建议在 eval runner 失败时自动生成 EVALUATION-source 反馈，打通「Benchmark Failure → Feedback → 聚类 → 提案」自动链路。
4. **Canary 扩展观察**：Canary 各阶段目前为 API 驱动；可在平台事件系统订阅运行遥测，自动按 5%→20%→50%→100% 推进。
