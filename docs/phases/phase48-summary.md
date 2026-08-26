# Phase 48 总结：Continuous Evaluation 落地（Nightly / Weekly / Release 定时评测真正可运行）

> 版本：v4.23.0（被测平台）｜ 日期：2026-08-20 ｜ 前置：Phase 46（AI 质量优化闭环，v4.21.0）+ Phase 47（AI 改进页 E2E，v4.22.0）
> 本文档所有结论均来自真实运行结果：`npm run web:e2e:ai`（Playwright Chromium 13 用例全绿）+ 全量 `npm test`（1754 通过）+ `npm run agent:continuous:status`（Overall 93.62%、关键安全指标为 0）。禁止虚构。

## 一、目标

Phase 47 复扫发现（Phase 47 总结「下一步建议」第 2 项）：`src/ai-quality/ops.ts` 的 `CONTINUOUS_EVAL_SCHEDULES` **只有调度描述常量（nightly / weekly / release 的 cronLike 与说明），没有真正的 Runner、历史存储、回归判定、Alert / Block Release 联动**。即「Nightly Evaluation / Weekly Evaluation / Release Evaluation」在代码层并不可运行。

Phase 48 目标：把 Continuous Evaluation 从「只有常量」升级为**真正可运行的定时评测闭环**（43.20）——真实运行 Benchmark → Compare → Detect Regression → Alert + Block Release，并提供历史追踪（可追溯）、回归原因（可回答「为什么判回归」）、定向领域（Change Impact / Targeted Evaluation）、持久化（跨重启保留）、CLI / API / Web 三入口。

## 二、交付物清单

### 1. 核心实现（`src/ai-quality/continuous-eval.ts`，新增）

- `ContinuousEvalStore`：Continuous Evaluation 历史存储（`Map<id, run>`），提供 `add` / `get` / `list({ schedule })`（最新在前）/ `latest()`（作为下次 baseline）/ `size()` / `snapshot()` / `static import()`（快照往返持久化）。
- `runContinuousEvaluation(input, deps)`：一次评测运行的完整编排：
  1. **真实运行 Benchmark**：复用 Phase 45 `runAllEvaluation({ version, domains })`（确定性、零 token、不虚构分数）；`deps.report` 仅单元测试注入用，生产一律走真实评测。
  2. **Compare baseline**：`store.latest()` 取最近一次运行作为 baseline；**首次运行（无历史）只记录基线、不判回归**（避免把自身当回归）。
  3. **回归判定**：复用 Phase 46 `detectRegression`（`src/ai-quality/ops.ts`）——**Critical 指标上升（P0 Miss / False Pass / Unsafe Healing / Skipped Critical）→ verdict BLOCK + alertSent + releaseBlocked；普通 Overall 下降 → REVIEW；无回归 → PASS**。
  4. 记录当前各领域分（`domains`，可定向观察退化集中在哪个领域）、成本 / 延迟、`reportVersion`、`domainCount`、`triggeredBy`（SCHEDULE / MANUAL / RELEASE_GATE）。
- `ContinuousEvalRun` 契约：id / schedule / triggeredBy / baseline / current / domains / cost / latencyMs / regression（regression / criticalRegression / reasons / verdict）/ alertSent / releaseBlocked / reportVersion / domainCount / createdBy / createdAt。`reasons` 为逐条判定原因，可回答「为什么判回归」。

### 2. 调度常量（`src/ai-quality/ops.ts`）

| schedule | cronLike | 说明 |
| --- | --- | --- |
| nightly | `0 2 * * *` | 每日全量 Benchmark，检测回归 |
| weekly | `0 3 * * 1` | 每周一深度评测 + 错误聚类 |
| release | `release-trigger` | 发布前强制评测门禁 |

### 3. Service 集成（`src/ai-quality/service.ts`）

- `AIAQualityService` 新增 `continuousEval` store 依赖（缺省 `new ContinuousEvalStore()`，测试可注入）。
- 新增 `runContinuousEval(input)`：调用 `runContinuousEvaluation`，并写入 `ImprovementAudit`（action=CREATED，decision 含 Overall 与 verdict，metrics 含 overall / p0Miss / falsePass / unsafeHealing）；随 `snapshot()` / `restore()` + `persistToFile` / `loadFromFile` 持久化（跨重启保留）。

### 4. API（`src/platform/api/server.ts`，43.26）

- `GET /api/ai-quality/continuous-evals`：运行列表（可 `?schedule=` 过滤）+ `schedules` 调度描述；认证即可读。
- `GET /api/ai-quality/continuous-evals/:id`：单次运行详情；404 兜底。
- `POST /api/ai-quality/continuous-evals/run`：手动触发一次评测（`{ schedule }`，NIGHTLY / WEEKLY / RELEASE），**RELEASE_APPROVE 人工门禁**（QA 403，禁止 AI 自批）；返回真实运行记录（verdict / alert / releaseBlocked）。

### 5. CLI（`bin/ai-quality-cli.ts`，43.25）

- `agent:continuous:run [--schedule NIGHTLY|WEEKLY|RELEASE]`：触发一次真实评测并打印判定（含 Alert / Block Release 提示），`--json` 输出完整记录。
- `agent:continuous:list [--schedule]`：历史列表（Overall Baseline→Current / verdict / Alert / Block）。
- `agent:continuous:status`：最近运行状态 + 调度描述。

### 6. Web（`web/src/pages/AIImprovement.tsx` + `web/src/api.ts`）

- 「AI 改进」页新增第 8 个 **「持续评测」Tab**：
  - 指标卡：最近 Overall / 最近判定（PASS / REVIEW / BLOCK + 原因）/ Alert / Block Release。
  - 历史表格：ID / Schedule（RELEASE warn / 其余 info 徽标）/ 触发 / Overall Baseline→Current / verdict（BLOCK err / REVIEW warn / PASS ok）/ P0 Miss / False Pass / Alert / Block / 时间。
  - 手动触发区：NIGHTLY / WEEKLY / RELEASE 三个按钮；**非审批角色（QA 等）禁用**（只读横幅 + disabled），RELEASE_MANAGER / ADMIN 可触发（人工门禁）。
  - 空态提示「暂无运行记录。可手动触发一次以建立基线。」
- `web/src/api.ts`：新增 `ContinuousEvalRunItem` / `ContinuousEvalList` 类型 + `getContinuousEvals` / `runContinuousEval` / `getContinuousEvalDetail` / `getAIQualityTrends`。

### 7. E2E 种子（`tests/e2e/web/e2e-server.ts`）

- `seedAiQuality()` 新增第 10 步：确定性运行 3 次 Continuous Evaluation（NIGHTLY 由 release-mgr 手动 / WEEKLY 由 SYSTEM 调度 / RELEASE 由 RELEASE_GATE 触发），全部真实 Benchmark（verdict PASS，Overall 93.62%）。
- `WebE2eSeed.aiQuality` 新增 `continuousEval` 字段（最近 RELEASE 运行 id），供用例读取。

## 三、测试

### 单元（`tests/unit/continuous-eval.test.ts`，11 用例）

| 用例 | 断言 |
| --- | --- |
| 首次运行 | 只记录基线、不判回归（verdict PASS）、不 Alert / 不 Block |
| 连续运行 | 真实 Benchmark 确定性、无回归 PASS |
| Critical Regression（P0 Miss 0→1） | BLOCK + Alert + BlockRelease + 原因含「P0 Miss 上升」 |
| Critical Regression（False Pass 0→1） | BLOCK + BlockRelease |
| 普通指标下降（Overall -5%） | REVIEW、不 Alert / 不 Block |
| 无回归且关键持平 | PASS、不 Alert |
| 定向领域（Targeted Evaluation） | 只评测指定领域（domainCount < 8） |
| Store 排序 / 过滤 / 快照往返 | latest / 按 schedule / snapshot·import |
| 调度常量 | NIGHTLY / WEEKLY / RELEASE 与 cronLike |
| Service 集成 | 运行 + 审计 + 快照/恢复保留历史 |
| RELEASE 门禁触发 | triggeredBy=RELEASE_GATE、releaseBlocked 与 verdict 一致 |

### 集成（`tests/integration/ai-continuous-eval-api.test.ts`，7 用例）

- GET 列表（含 schedules）/ GET 详情 / GET 404 / POST run 非法 schedule 400 / POST run QA 403（无 RELEASE_APPROVE）/ **POST run RELEASE_MANAGER → 200 真实运行记录**（verdict / alert / releaseBlocked）+ 入库 + 审计 / 持久化往返。

### E2E（`tests/e2e/web/ai-improvement.spec.ts`，新增 2 用例，AI 改进页合计 13 全绿）

| 用例 | 断言 |
| --- | --- |
| 持续评测 Tab 历史渲染 | 3 次运行历史（含 RELEASE 种子行）+ verdict PASS + Alert/Block 否 + 指标卡 + QA 手动触发按钮禁用 |
| RELEASE_MANAGER 手动触发 RELEASE | 成功横幅 + 历史新增一行 |

## 四、验收结果

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 编译 | `npx tsc --noEmit` | 通过 |
| AI 质量相关单测 | `npx vitest run tests/unit/continuous-eval.test.ts tests/integration/ai-continuous-eval-api.test.ts` | 18 用例全绿 |
| AI 改进页 E2E | `npm run web:e2e:ai` | **13 用例全绿**（11 存量 + 2 新增） |
| 全量单测 | `npm test` | **1754 通过 / 18 skip，0 失败** |
| Continuous Evaluation CLI | `npm run agent:continuous:status` + `continuous run --schedule NIGHTLY --json` | 真实运行，Overall **93.62%** |
| 关键安全指标 | continuous run 输出 | P0 Miss / False Pass / Unsafe Healing / Skipped Critical **全 0** |
| 版本同步 | `package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` | 全部 v4.23.0 |

## 五、安全与质量说明

- **人工门禁**：POST `/continuous-evals/run` 与 Web 手动触发均需 RELEASE_APPROVE（RELEASE_MANAGER / ADMIN）；QA 只读（403 / 按钮禁用 + 只读横幅），禁止 AI 自批。
- **不虚构分数**：所有 Overall / critical / cost / latency 均来自真实 `runAllEvaluation` 输出；`deps.report` 注入仅限单元测试模拟回归场景。
- **首次运行不误报**：无历史 baseline 时只记录基线、verdict PASS，避免把首次运行当成回归。
- **回归判定可解释**：逐条 `reasons` 记录判定依据，可回答「为什么判回归」「为什么认为它错了」。
- **关键安全指标保持**：P0 Miss = 0 / False Pass = 0 / Unsafe Healing = 0 / Skipped Critical = 0。

## 六、下一步建议（Phase 49 候选）

1. **真实定时调度器**：当前调度是「常量 + 手动触发（CLI/API）」；可接入平台 scheduler / cron 让 Nightly / Weekly 自动运行并落盘报告。
2. **Eval → Feedback 桥接**：Evaluation 失败自动进入 Feedback Registry（BENCHMARK_FAILURE 渠道自动生成 EVALUATION-source 反馈），打通「Benchmark Failure → Feedback → 聚类 → 提案」自动链路。
3. **Canary 自动推进**：Canary 各阶段订阅平台运行遥测，自动按 5%→20%→50%→100% 推进。
4. **跨浏览器回归**：将 `ai-improvement.spec.ts`（含持续评测 Tab）纳入 `web:e2e:cross`（firefox / webkit）门控。
