# Phase 49 总结：Eval → Feedback 桥接 + Benchmark 自动扩充候选（Benchmark 越来越接近真实业务）

> 版本：v4.24.0（被测平台）｜ 日期：2026-08-20 ｜ 前置：Phase 48（Continuous Evaluation 落地，v4.23.0）
> 本文档所有结论均来自真实运行结果：`npm test`（1775 通过）+ `npm run web:e2e:ai`（Playwright Chromium 15 用例全绿）+ `npm run web:e2e:test`（102 用例全绿）+ `agent:benchmark:bridge`（真实评测 Overall 93.6%、桥接 31 个失败候选）。禁止虚构。

## 一、目标

Phase 48 总结「下一步建议」第 2 项：**Evaluation 失败结果与 Feedback / Benchmark 扩充之间存在断点**——Continuous Evaluation 跑完只记录历史与回归判定，失败用例没有进入 Feedback Registry（43.1/43.2 的 BENCHMARK_FAILURE 渠道），也没有变成 Benchmark 扩充候选（43.21）。即「Benchmark Failure → Feedback → 聚类 → 提案」的自动链路缺失。

Phase 49 目标：**打通 Evaluation → Feedback → Benchmark 扩充候选 → 人工 Review** 闭环，让 Benchmark 越来越接近真实业务、而不是越来越人工构造。核心铁律：**失败用例桥接为候选一律 PENDING_REVIEW，必须人工 Review（approve/reject）后才可并入 Benchmark，禁止 AI 自动并库、禁止自批**。

## 二、交付物清单

### 1. 核心实现（`src/ai-quality/eval-bridge.ts`，新增）

- `extractEvalFailures(report)`：从 `EvalReport` 提取 **tracked 失败用例**（跳过 passed 与未 tracked——未追踪无 Ground Truth 绝不虚构反馈）。
- `bridgeEvalReport(deps, report)`：把每一条 tracked 失败用例桥接为：
  - **BENCHMARK_FAILURE 渠道反馈**（EVALUATION 来源、INCORRECT 类型；`prediction=actual`（AI 实际输出）、`actual=expected`（Ground Truth）；`verified=false` 待人工核验）。
  - **Benchmark 扩充候选**（`PENDING_REVIEW`）。
  - **幂等去重**：同一 `caseId + expected/actual` 已在库则跳过（重复跑评测不刷屏）。
- `BenchmarkCandidateStore`：候选存储（`add` / `get` / `list({ status, domain })` / `size` / `snapshot` / `import`）+ **Review 状态机**：`approve(id, reviewer)` → APPROVED、`reject(id, reviewer, reason)` → REJECTED；**已处理候选不可重复 approve/reject**（抛错）。reviewer / reviewedAt / reason 全记录。

### 2. Service 集成（`src/ai-quality/service.ts`）

- `AIAQualityService` 新增 `benchmarkCandidates` store 依赖（缺省 `new BenchmarkCandidateStore()`，测试可注入）。
- 新增 `bridgeEvaluation(report)`：桥接一份 EvalReport（幂等）。
- 新增 `bridgeEvaluationNow(domains?)`：运行一次真实评测（复用 `runAllEvaluation`）并把失败桥接为反馈 + 候选，写审计（ingested / candidates / skippedDupes）。
- 新增 `reviewBenchmarkCandidate(id, decision, reviewer, reason?)`：人工 Review 统一入口，approve/reject 均写入 `ImprovementAudit`（完整链路 43.19）。
- **`runContinuousEval` 重构**：先跑一次真实评测，**同一份报告同时用于回归判定 + 失败桥接**（不虚构、不重复计分）；审计 decision 含桥接数量。这样 Continuous Evaluation 每次运行都会自动沉淀真实失败为待审候选。
- `snapshot()` / `restore()` 新增 `benchmarkCandidates`，随 `persistToFile` / `loadFromFile` 跨重启保留。

### 3. API（`src/platform/api/server.ts`，43.26）

- `GET /api/ai-quality/benchmark-candidates`：候选列表（可 `?status=` / `?domain=` 过滤，支持分页）；认证即可读。
- `POST /api/ai-quality/benchmark-candidates/bridge`：运行真实评测并把失败桥接为反馈 + 待审候选；**RELEASE_APPROVE 人工门禁**（QA 403，禁止自动并库）。
- `POST /api/ai-quality/benchmark-candidates/:id/approve`：人工批准候选（RELEASE_APPROVE 门禁，记录 reviewer + 审计）。
- `POST /api/ai-quality/benchmark-candidates/:id/reject`：人工驳回候选（RELEASE_APPROVE 门禁，记录 reason + 审计）。

### 4. CLI（`bin/ai-quality-cli.ts`，43.25）

- `agent:benchmark:list [--status] [--domain] [--json]`：候选列表（期望/实际紧凑 JSON 展示）。
- `agent:benchmark:bridge --by <human>`：运行真实评测并桥接失败（必须显式 `--by <human>`）。
- `agent:benchmark:approve <id> --by <human>`：批准候选进入已验证 Ground Truth 池。
- `agent:benchmark:reject <id> --by <human> --reason <...>`：驳回候选。

### 5. Web（`web/src/pages/AIImprovement.tsx` + `web/src/api.ts`）

- 「AI 改进」页新增第 9 个 **「Benchmark 扩充」Tab**：
  - 指标卡：待审 / 已批准（进入已验证 Ground Truth 池）/ 已驳回。
  - 「运行真实评测并桥接失败」按钮（RELEASE_APPROVE 门禁，QA 禁用）。
  - 候选表格：ID / 领域 / 用例 / 期望 / 实际 / 来源 / 状态 / 操作（PENDING_REVIEW 显示 批准/驳回；已处理显示 `by reviewer`）。
  - 空态提示。
- `web/src/api.ts`：新增 `BenchmarkCandidateItem` / `BenchmarkBridgeResult` 类型 + `getBenchmarkCandidates` / `bridgeBenchmarkCandidates` / `approveBenchmarkCandidate` / `rejectBenchmarkCandidate`。

### 6. E2E 种子（`tests/e2e/web/e2e-server.ts`）

- `seedAiQuality()` 新增第 11 步：直接生成一个确定性 Benchmark 候选（RISK / `risk-bridge-e2e`，PENDING_REVIEW，EVALUATION 来源）。
- `WebE2eSeed.aiQuality` 新增 `benchmarkCandidate` 字段。

## 三、测试

### 单元（`tests/unit/eval-bridge.test.ts`，14 用例）

| 用例 | 断言 |
| --- | --- |
| extractEvalFailures | 只提取 tracked 失败（跳过 passed 与未 tracked）；无失败 → 空 |
| bridgeEvalReport | 失败 → BENCHMARK_FAILURE 反馈（INCORRECT / prediction=actual / actual=expected / 待核验）+ PENDING_REVIEW 候选 |
| 幂等 | 重复桥接同报告不重复入库（仅去重跳过） |
| 错误分类推导 | 桥接的 RCA 失败反馈 deriveErrorTaxonomy → WRONG |
| CandidateStore 状态机 | approve → APPROVED + reviewer；reject → REJECTED + reason；已处理不可重复操作；list 过滤 + 快照/导入往返 |
| Service 集成 | bridgeEvaluation + reviewBenchmarkCandidate（审计）/ reject 审计 / 快照恢复 / bridgeEvaluationNow 真实评测 / runContinuousEval 自动桥接且幂等 |

### 集成（`tests/integration/ai-benchmark-candidates-api.test.ts`，7 用例）

- GET 列表（初始空）/ 未认证 401 / bridge QA 403 / **bridge RELEASE_MANAGER → 真实桥接（全部 PENDING_REVIEW + EVALUATION 来源 + 反馈入库 + 幂等重试）** / approve（QA 403 / RELEASE_MANAGER 成功 + reviewer + 审计 / 重复批准 400 / 不存在 400）/ reject（原因 + 审计）/ 列表 status/domain 过滤。

### E2E（`tests/e2e/web/ai-improvement.spec.ts`，新增 2 用例，AI 改进页合计 15 全绿）

| 用例 | 断言 |
| --- | --- |
| Benchmark 扩充 Tab 渲染 + QA 只读 | 种子候选行（PENDING_REVIEW）+ 桥接/批准/驳回按钮禁用 |
| RELEASE_MANAGER 批准候选 | 成功横幅 + 状态 APPROVED + `by release-mgr`（禁止 AI 自批） |

## 四、验收结果

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 编译 | `npx tsc --noEmit` | 通过 |
| AI 质量相关测试 | `npx vitest run tests/unit/eval-bridge.test.ts tests/integration/ai-benchmark-candidates-api.test.ts` | **21 用例全绿**（14 单元 + 7 集成） |
| AI 改进页 E2E | `npm run web:e2e:ai` | **15 用例全绿**（13 存量 + 2 新增） |
| 全量单测 | `npm test` | **1775 通过 / 18 skip，0 失败** |
| 全量 Web E2E | `npm run web:e2e:test` | **102 用例全绿** |
| CLI 真实桥接 | `node dist/bin/ai-quality-cli.js benchmark bridge --by cli-human` | 真实评测 Overall **93.6%**，桥接 **31 个失败候选**（REQUIREMENT/RCA/DEFECT/HEALING/RELEASE 等，全部 PENDING_REVIEW） |
| 关键安全指标 | bridge 输出 + 全量测试 | P0 Miss / False Pass / Unsafe Healing 保持 **0** |
| 版本同步 | `package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` | 全部 v4.24.0 |

## 五、安全与质量说明

- **人工门禁（禁止 AI 自批）**：bridge / approve / reject 均需 RELEASE_APPROVE（RELEASE_MANAGER / ADMIN）；QA 只读（403 / 按钮禁用）。候选**不会自动并入 Benchmark**，必须人工 Review。
- **不虚构 Ground Truth**：桥接只搬运真实 EvalReport 的 tracked 失败用例；未 tracked（无 Ground Truth）绝不产生反馈；幂等去重避免重复刷屏。
- **失败即反馈**：每次 Continuous Evaluation 都自动把真实失败沉淀为 BENCHMARK_FAILURE 反馈 + 待审候选——Benchmark 持续向真实业务演进。
- **可追溯**：候选全链路记录 feedbackId / reviewer / reviewedAt / reason / 审计；approve 后进入「已验证 Ground Truth 池」备并入。

## 六、下一步建议（Phase 50 候选）

1. **Approved 候选并入 Benchmark 注册表**：人工批准后真正把用例写入 Benchmark 数据集（`src/eval/benchmark/data/*` 或 registry），形成「Review → Benchmark」最终落地。
2. **Canary 自动推进**：订阅平台运行遥测自动按 5%→20%→50%→100% 推进（43.14）。
3. **真实定时调度器**：接入平台 scheduler / cron 让 Nightly / Weekly 自动运行 + 自动桥接 + 落盘报告（43.20）。
4. **跨浏览器回归**：将 ai-improvement（含 Benchmark 扩充 Tab）纳入 `web:e2e:cross`（firefox / webkit）门控。
