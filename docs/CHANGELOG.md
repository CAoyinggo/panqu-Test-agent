# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 语义，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [4.29.0] - 2026-08-27

### 新增（Evidence-first 智能体升级）

- Requirement、Test Design 与 Analysis 智能体强化需求事实账本、结构化需求解析、风险分析和证据优先的测试设计。
- DevTest 新增源码同步、项目与环境发现、交付物生成及验收摘要能力，减少报告与实际执行证据不一致。
- 完善开发交接发布清单、测试用例模板、智能体 Prompt、脱敏规则及对应单元、集成和验收测试。

### 变更

- README 同步最新智能体能力、执行流程与测试清单。
- 版本 v4.28.0 → v4.29.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

## [4.28.0] - 2026-08-26

### 新增（DevTest v8 与 TestCase V2）

- DevTest 从需求文件生成风险优先的五维验收计划，支持环境发现、SAFE 门禁、计划预览、定向复现、精准复测、最终验收与一页摘要。
- 引入 AC Coverage Matrix、业务不变量、Business Flow Graph、状态一致性、Regression Guard、确定性 Oracle、自适应分层选择及 Flaky/Test Pollution 独立归类。
- 固定输出 `report.html`、`report.json`、`cases.csv`、`problems.md` 和 `acceptance-summary.md`，并维护稳定问题 ID、生命周期、Baseline 与阶段缓存。
- TestCase V2 统一业务场景、前置条件、测试数据、步骤、断言、Evidence、Oracle、Prepare/Cleanup、依赖和执行就绪度字段。

### 变更

- 阶段验收文档迁移到 `docs/phases/`，TestCase 权威说明迁移到 `docs/testing/`，并修复仓库内引用。
- 版本 v4.27.0 → v4.28.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

## [4.27.0] - 2026-08-21

### 新增（成本治理、资源优化与容量自适应，Phase 52）

- 统一 Cost Attribution：LLM/Compute/Storage/Network/Worker/Other 按 Project、Run、Evaluation、Benchmark、Model、Provider、Release、Version 精确归属，支持 today/7d/30d/release/version 与日/周/月趋势。
- Cost Budget 与 Guard：daily/weekly/monthly/perRun/perEvaluation/perRelease；90% WARNING、100% EXCEEDED；复用自治预算并输出 AUTONOMOUS_STOP reason/budget/used/remaining/trace。
- 联合优化：value/cost test selection、Model Policy + 质量/成本/延迟路由 trace、成本版本回归、Pareto frontier。
- 容量自适应：Queue/Age/Utilization/Priority/Estimated Cost 驱动 desired workers，min/max/cooldown 防震荡，CPU/Memory/Concurrency 防超载；1h/6h/24h/7d/30d 确定性预测。
- 治理闭环：成本异常进入 Dashboard/Audit/Feishu，优化默认仅建议，生产变更强制人工批准，Shadow + 5/20/50/100 Canary，异常 STOP、严重回归 ROLLBACK。
- 产品化：Cost Overview + Capacity Dashboard、12 个 CLI 脚本、17 个 API 路由、原子状态持久化；全部受 JWT/RBAC/Project Scope/Audit 保护。

### 变更

- 版本 v4.26.0 → v4.27.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 验收

- Phase 52 指定测试：14 文件 / 23 用例全绿；真实 Chromium Cost Dashboard：2/2。
- S1–S10、Cost Attribution/Budget/Anomaly/Model Routing/Worker Scaling/Capacity/Forecast/Optimization/Canary/Rollback、Project Isolation/Audit 全部 PASS。
- 五项未授权/跨项目关键安全指标均为 0；完整历史回归见 `docs/phases/phase52-summary.md`。

## [4.26.0] - 2026-08-21

### 新增（AI Evaluation 生产规模化与长期运营，Phase 51）

- 多项目隔离：Benchmark、Ground Truth、Evaluation、History、Telemetry、Knowledge、Audit 全部使用强制 project partition；API/CLI/Web 统一 project scope，JWT 越权返回 403。
- 并发与调度：10/50/100 concurrent runner；Evaluation Queue lease/heartbeat/requeue/retry；1/2/5/10 Worker Pool 覆盖 10/50/100/500 jobs，旧 lease late completion 被拒绝。
- 长期数据：HOT/WARM/COLD/ARCHIVED Retention；checksum Archive/Restore 保持 ID/trace/payload；Audit/Benchmark/GroundTruth 普通清理 protected。
- Benchmark：内容寻址 case blob + version manifest，支持跨版本 dedup、checksum、missing/duplicate/mutation/corruption 检测、Evaluation BLOCK 与健康版本 rollback。
- Metrics：Hourly/Daily/Project/Model/Benchmark 增量聚合；100-record Raw/Aggregated Count/Average/P95/Failure/Cost 零误差；Score/Benchmark/Model/Prompt/Latency/Cost Drift 进入 REVIEW/BLOCK。
- Recovery：六类组件 Detect→Alert→Recover；case checkpoint 断点续跑；Ground Truth unavailable PAUSED 且禁止 stale fallback；500-case process-kill 演练无重复。
- 对外能力：新增 Scale API、Phase 51 CLI、Web `Scale` 页面及五个 Playwright 套件；生产规模 LOAD TEST 覆盖 5 Projects / 20 Users / 500 real case refs / 100 jobs / 10 workers / 3 rounds。

### 变更

- 版本 v4.25.0 → v4.26.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 验收（真实运行）

- Phase 51 专项：49；Scale：15；Recovery：9；Web 专项：10，全部通过。
- 全量 Vitest 1838 PASS / 18 SKIP；Web Unit 72；Web E2E 113；Agent 450/8/2/26；Platform 227/94/16；Phase 39/40 PASS；Platform Health=HEALTHY。

## [4.25.0] - 2026-08-20

### 新增（Benchmark 候选并入：Review → Benchmark，Phase 50）

完成任务书 43.21 的闭环终点：把人工批准的 Benchmark 扩充候选真正并入版本化 Benchmark Registry，形成 **Evaluation Failure → Candidate → Human Review → Benchmark v2/v3 → 后续真实评测** 的可追溯闭环。

- 并入核心（`src/ai-quality/benchmark-merge.ts`）：`mergeApprovedCandidates` / `mergeOne` / `candidateMatchesSource`；只处理 `APPROVED`，按领域最新版查找真实源用例并复用其 input / Ground Truth，找不到源用例则保留 APPROVED 并跳过，绝不伪造输入或 Accuracy。
- Registry 与 Ground Truth：`BenchmarkRegistry.extendWithCases` 以新版本落地（v1→v2→v3），继承最新版全部用例并按 case id 去重；并入用例登记 `HUMAN` Ground Truth，记录 reviewer / reviewedAt / candidateId / feedbackId；Phase 49 旧快照缺少 Registry 字段时回退默认 v1，保持升级兼容。
- 状态与持久化：`BenchmarkCandidate` 新增 `MERGED`、`mergedCaseId`、`mergedBenchmark`；`markMerged` 仅允许 APPROVED→MERGED，禁止重复并入；Benchmark Definitions 与 Ground Truth Registry 纳入快照恢复。
- Service / API / CLI：`mergeBenchmarkCandidates` 组合 Candidate Store、Benchmark Registry、Ground Truth 与 Improvement Audit；新增 `POST /api/ai-quality/benchmark-candidates/merge`（`RELEASE_APPROVE` 人工门禁）和 `benchmark merge --by <human>` / `agent:benchmark:merge`，支持候选与领域过滤、JSON 输出及跳过原因。
- Web：「Benchmark 扩充」Tab 新增“已并入”指标、“并入已批准候选 → 新 Benchmark 版本”按钮、`MERGED` 正向状态和并入凭据列；无 APPROVED 候选或非审批角色时禁用。
- 测试：单元新增 8 项、集成新增 5 项、非浏览器 E2E 新增 S9、真实浏览器新增 Review→Benchmark 闭环；浏览器种子使用独立已批准候选，避免跨用例共享状态耦合。

### 变更

- 版本 v4.24.0 → v4.25.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 验收（真实运行）

- `npm run agent:ai:unit`：101/101；`npm run agent:ai:integration`：29/29；`npm run agent:ai:e2e`：9/9。
- `npm run web:e2e:ai`：16/16；`npm run web:e2e:test`：103/103。
- `npm test`：1789 通过 / 18 skip / 0 失败；Platform 单元 / 集成 / E2E：227 / 94 / 16；Agent 核心 / Eval / E2E / Autonomous E2E：450 / 8 / 2 / 26；`platform:health` 为 `HEALTHY`。
- `phase39:test` / `phase40:test` / 最终 `web:e2e` 全绿；完整记录见 `docs/phases/phase50-summary.md`。

## [4.24.0] - 2026-08-20

### 新增（Eval → Feedback 桥接 + Benchmark 自动扩充候选，Phase 49）

打通「Benchmark Failure → Feedback → 聚类 → 提案」自动链路（43.2 / 43.21 落地）：**Evaluation 失败自动进入 Feedback Registry（BENCHMARK_FAILURE 渠道）+ 生成 Benchmark 扩充候选（PENDING_REVIEW，必须人工 Review 才可并入）**，让 Benchmark 越来越接近真实业务、而不是越来越人工构造。

- 核心实现（`src/ai-quality/eval-bridge.ts`，新增）：`extractEvalFailures`（只提取 **tracked 失败用例**，跳过 passed 与未 tracked——未追踪无 Ground Truth 绝不虚构反馈）+ `bridgeEvalReport`（每条 tracked 失败 → BENCHMARK_FAILURE 渠道反馈：EVALUATION 来源、INCORRECT 类型、prediction=actual（AI 实际输出）、actual=expected（真值）、verified=false 待人工核验 + PENDING_REVIEW 候选；**幂等去重**：同 caseId+期望/实际已在库则跳过，重复跑评测不刷屏）。
- `BenchmarkCandidateStore`（`src/ai-quality/eval-bridge.ts`）：候选存储（add/get/list({status,domain})/size/snapshot/import）+ **Review 状态机**：approve → APPROVED、reject → REJECTED（记录 reviewer/reviewedAt/reason；已处理候选不可重复操作）。
- Service 集成（`src/ai-quality/service.ts`）：`benchmarkCandidates` store + `bridgeEvaluation(report)`（幂等桥接）+ `bridgeEvaluationNow(domains?)`（运行真实评测并桥接 + 审计）+ `reviewBenchmarkCandidate(id, decision, reviewer, reason?)`（人工 Review 统一入口，approve/reject 均写审计）；**`runContinuousEval` 重构**：同一份真实报告同时用于回归判定 + 失败桥接（不虚构、不重复计分），Continuous Evaluation 每次运行自动沉淀真实失败为待审候选；snapshot/restore + persist/load 跨重启保留。
- API（`src/platform/api/server.ts`，43.26）：`GET /api/ai-quality/benchmark-candidates`（列表 + status/domain 过滤 + 分页，认证可读）/ `POST .../bridge`（运行真实评测并桥接，RELEASE_APPROVE 人工门禁，QA 403）/ `POST .../:id/approve` / `POST .../:id/reject`（人工 Review，禁止 AI 自批）。
- CLI（`bin/ai-quality-cli.ts`，43.25）：`agent:benchmark:list` / `agent:benchmark:bridge --by <human>` / `agent:benchmark:approve <id> --by <human>` / `agent:benchmark:reject <id> --by <human> --reason`。
- Web（`web/src/pages/AIImprovement.tsx` + `web/src/api.ts`）：「AI 改进」页新增第 9 个「Benchmark 扩充」Tab——指标卡（待审 / 已批准 / 已驳回）+ 「运行真实评测并桥接失败」按钮（RELEASE_APPROVE 门禁）+ 候选表格（ID / 领域 / 用例 / 期望 / 实际 / 来源 / 状态 / 操作，PENDING_REVIEW 显示 批准/驳回）。
- 测试：单元 `tests/unit/eval-bridge.test.ts`（**14 用例**：extractEvalFailures / bridgeEvalReport / 幂等 / Error Taxonomy 推导 / CandidateStore 状态机 + 快照往返 / Service 集成）+ 集成 `tests/integration/ai-benchmark-candidates-api.test.ts`（**7 用例**：列表 / 401 / bridge RBAC + 真实桥接 + 幂等 / approve·reject QA 403 + RELEASE_MANAGER 成功 + 重复操作 400）+ E2E `tests/e2e/web/ai-improvement.spec.ts`（**2 新用例**：Benchmark 扩充 Tab 渲染 + QA 只读 / RELEASE_MANAGER 批准候选 → APPROVED，AI 改进页 E2E 合计 15 用例全绿）。
- 脚本：`agent:benchmark:list|bridge|approve|reject`、`phase49:test`；`agent:ai:unit` / `agent:ai:integration` 纳入 eval-bridge 与 ai-benchmark-candidates-api 测试。

### 变更

- 版本 v4.23.0 → v4.24.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 验收（真实运行）

- `npm run web:e2e:ai`：**15 用例全绿**（13 存量 + 2 新增「Benchmark 扩充」Tab）。
- `npm test`：**1775 通过 / 18 skip，0 失败**；AI 质量相关 21 用例全绿（单元 14 + 集成 7）。
- `npm run web:e2e:test`：**102 用例全绿**。
- `npm run agent:benchmark:bridge -- --by cli-human`：真实评测 Overall **93.6%**，桥接 **31 个失败候选**（REQUIREMENT/RCA/DEFECT/HEALING/RELEASE 等，全部 PENDING_REVIEW）；关键安全指标 P0 Miss / False Pass / Unsafe Healing **全 0**。
- `npx tsc --noEmit` 通过。

## [4.23.0] - 2026-08-20

### 新增（Continuous Evaluation 落地，Phase 48）

把 Phase 46 的 `ContinuousEvalSchedule` 常量升级为**真正可运行的定时评测闭环**（43.20）：真实运行 Benchmark → Compare → Detect Regression → Alert + Block Release，让「Nightly / Weekly / Release 定时评测」从「只有常量」变成「可运行、可追溯、可审计」。

- 核心实现（`src/ai-quality/continuous-eval.ts`）：`ContinuousEvalStore`（历史存储：latest / 按 schedule 过滤 / snapshot·import 快照持久化）+ `runContinuousEvaluation`（复用 Phase 45 `runAllEvaluation` 真实评测 8 领域或定向领域，Compare 最近 baseline → `detectRegression` 回归判定）。
- 回归判定（`src/ai-quality/ops.ts` `detectRegression`）：**Critical 指标上升（P0 Miss / False Pass / Unsafe Healing / Skipped Critical）→ verdict BLOCK + alertSent + releaseBlocked；普通 Overall 下降 → REVIEW；无回归 → PASS**；首次运行只记录基线不判回归（避免把自身当回归）；逐条 reasons 可回答「为什么判回归」。
- 调度常量：nightly `0 2 * * *`（每日全量）/ weekly `0 3 * * 1`（每周深度 + 错误聚类）/ release `release-trigger`（发布前强制门禁）。
- 集成（`src/ai-quality/service.ts`）：`AIAQualityService` 新增 `continuousEval` store + `runContinuousEval`（审计记录 + snapshot/restore 持久化 + persistToFile/loadFromFile）。
- API（`src/platform/api/server.ts`，43.26）：`GET /api/ai-quality/continuous-evals`（列表 + schedules）/ `GET .../:id` / `POST .../run`（手动触发，RELEASE_APPROVE 人工门禁，QA 403）。
- CLI（`bin/ai-quality-cli.ts`，43.25）：`agent:continuous:run` / `list` / `status`（status 展示最近运行、调度、Alert/Block 状态）。
- Web（`web/src/pages/AIImprovement.tsx` + `web/src/api.ts`）：「AI 改进」页新增第 8 个「持续评测」Tab——历史表格（ID / Schedule / 触发 / Overall Baseline→Current / verdict / P0 Miss / False Pass / Alert / Block / 时间）+ 指标卡（最近 Overall / 最近判定 / Alert / Block Release）+ 手动触发按钮（NIGHTLY / WEEKLY / RELEASE，非审批角色禁用，人工门禁）。
- 测试：单元 `tests/unit/continuous-eval.test.ts`（**11 用例**：首次基线 / 无回归 PASS / Critical Regression → BLOCK+Alert+BlockRelease / False Pass 上升 BLOCK / 普通下降 REVIEW / 定向领域 / 快照往返 / 调度常量 / Service 集成）+ 集成 `tests/integration/ai-continuous-eval-api.test.ts`（**7 用例**：列表 / 详情 / POST run RBAC + 真实运行 / 非法 schedule 400）+ E2E `tests/e2e/web/ai-improvement.spec.ts`（**2 新用例**：持续评测 Tab 历史渲染 / RELEASE_MANAGER 手动触发 → 历史新增，AI 改进页 E2E 合计 13 用例全绿）。
- 脚本：`agent:continuous:run|list|status`、`phase48:test`；`agent:ai:unit` / `agent:ai:integration` 纳入 continuous-eval 与 ai-continuous-eval-api 测试。

### 变更

- 版本 v4.22.0 → v4.23.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。
- 修复单元测试类型错误（`seedBaseline` 移除 store.add 自动生成的 `createdAt` 字段）。

### 验收（真实运行）

- `npm run web:e2e:ai`：**13 用例全绿**（11 存量 + 2 新增「持续评测」Tab）。
- `npm test`：**1754 通过 / 18 skip，0 失败**；AI 质量相关 60 用例全绿（单元 43 + 集成 17）。
- `npm run agent:continuous:status`：Overall **93.62%**；关键安全指标 P0 Miss / False Pass / Unsafe Healing / Skipped Critical **全 0**。
- `npx tsc --noEmit` 通过。

## [4.22.0] - 2026-08-20

### 修复（Phase 47 复扫发现）

- **Web「AI 改进」页可达性缺陷**：侧边栏导航已有 `/ai-improvement`，但 `web/src/App.tsx` 的 `<Routes>` 缺少对应 `<Route>`，点击落到 `<NotFound>`。新增 `<Route path="/ai-improvement" element={<AIImprovement />} />`，Phase 46 改进页现可正常访问。

### 新增（Web「AI 质量 / AI 改进」页真实浏览器 E2E 覆盖，Phase 47）

- E2E 种子注入（`tests/e2e/web/e2e-server.ts`）：`seedAiQuality()` 确定性注入 AI 质量闭环数据（未核验 INCORRECT 反馈 3 条 / 已核验 CORRECT 1 条 / 自动提案 → Gate PASS 可审批 + APPROVED / Prompt risk v1·v2 / Model deepseek v3·v4 / Shadow COMPLETED + Canary RUNNING@5% / 知识候选 PENDING_REVIEW），经 `createPlatformServer({ aiQuality })` 注入；`WebE2eSeed` 新增 `aiQuality` 清单字段。
- 真实浏览器 Playwright E2E（`tests/e2e/web/ai-improvement.spec.ts`，**11 用例**）：未认证重定向 / 导航 + 7 Tab + QA 只读横幅 / 待核验反馈（QA 核验禁用）/ 错误聚类 / 改进提案（Gate PASS + 已审批）/ Prompt·Model 版本 / Shadow·Canary 实验（QA 创建禁用）/ 知识 Review / AI 质量聚合指标 / **RBAC 人工门禁：RELEASE_MANAGER 批准 → 成功横幅 + APPROVED** / Phase 45 AI 质量页可达。
- 脚本：`web:e2e:ai`（定向 AI 页 E2E）、`phase47:test`（Phase 46 + AI 页 E2E + 全量 Web E2E）。

### 变更

- 版本 v4.21.0 → v4.22.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 验收（真实运行）

- `npm run web:e2e:test`：**98 用例全绿**（87 存量 + 11 新增）。
- `npm test`：**1736 通过 / 18 skip，0 失败**；`platform:integration` 94 通过；`platform:e2e` 16 通过。

## [4.21.0] - 2026-08-20

### 新增（AI 质量优化、反馈学习与持续改进闭环，Phase 46）

让 AI Test Platform 形成「测试 AI 本身」的持续优化闭环：
Failure → Error Analysis → Root Cause → Improvement Proposal → Candidate → Offline Evaluation →
Regression Benchmark → Approval → Activate → Observe → Learn。核心原则：**统一反馈结构（禁止各模块各自维护不同 Feedback）；先离线评测再上线（禁止发现问题直接改生产 Prompt）；人工门禁（RELEASE_APPROVE，禁止 AI 自批）；安全上线（Shadow 只读 → Canary 5%→20%→50%→100%，异常自动停止/回滚）；确定性优先（分类/聚类/评测可复现、零 token）；完整审计链路**。

- 统一 AI Feedback（`src/ai-quality/contract.ts` / `feedback.ts`，43.1/43.2）：AIFeedback 契约（domain / prediction / actual / feedbackType / source / channel / verified），接入 8 渠道（HUMAN_CORRECTION / RCA_VERIFICATION / DEFECT_REVIEW / RELEASE_REVIEW / HEALING_REVIEW / BENCHMARK_FAILURE / PRODUCTION_INCIDENT / FLAKY_CONFIRMATION）；AI 预测 vs 人工真值自动记 INCORRECT；人工核验门禁。
- 错误分类与聚类（`src/ai-quality/error-analysis.ts`，43.3/43.4）：统一 Error Taxonomy（WRONG / MISSING / OVER_PREDICTION / UNDER_PREDICTION / DUPLICATE / UNSAFE / INCONSISTENT / LOW_VALUE）；确定性聚类键 domain+category（同一聚类 id 恒定 → 提案幂等去重）；ErrorCluster（count / cases / suspectedCause / evidence）。
- 改进提案（`src/ai-quality/improvement.ts`，43.5/43.6/43.11）：autoProposals 从聚类自动生成提案（幂等）；recordEvaluation 离线评测 baseline vs candidate → gateVerdict（PASS/REVIEW/BLOCK）；状态机 PROPOSED → EVALUATING → APPROVED → ACTIVATED / REJECTED / ROLLED_BACK。
- Prompt / Model 版本管理（`src/ai-quality/versioning.ts`，43.7/43.8）：PromptVersion（promptKey / version / content / benchmarkScore / status / parentVersion）与 ModelVersion（provider / model / modelVersion / configuration）；A/B 对比（Accuracy / Latency / Cost / Failure Rate / Safety 五维，43.9）；多目标评分（Quality / Safety / Latency / Cost，保留原始指标，43.10）。
- Shadow / Canary / 自动回滚（`src/ai-quality/experiment.ts`，43.12/43.13/43.14）：Shadow 只读不生效；Canary 5%→20%→50%→100% 每阶段检查（异常自动停止、严重自动回滚）；rollback 恢复基线并记录 RollbackReason / Evidence / Metrics。
- Knowledge 学习 / 质量 / 衰减（`src/ai-quality/knowledge-learning.ts`，43.15/43.16/43.17）：错误 → Verified → Candidate → 人工 Review → Activate（禁止 LLM 直接进生产 Knowledge，必须有 Source / Confidence / Verification / Version）；qualityMetrics（Hit / Success / Outdated / Unused Rate）；EffectiveWeight 综合 usage / success / failure / age（持续有效的旧知识减缓衰减、频繁失败快速降权，不再只按时间下降）。
- 运营能力（`src/ai-quality/ops.ts`，43.19-43.24）：Continuous Evaluation（Nightly/Weekly/Release，Critical Regression → Alert + Block）；Benchmark 自动扩充（真实 Production Failure / Human Correction / RCA Error / Release Miss / Unsafe Healing / Defect Error → Verified Ground Truth → Benchmark Candidate → Review）；Change Impact（Prompt/Model/Tool/Knowledge 变更 → Affected Benchmarks/Agents/Projects/Runs → Targeted Evaluation）；AI Release Gate（Code Release + AI Release：Quality/Safety/Cost PASS + Approval 才 Release）；Improvement Audit（proposalId / actor / baseline / candidate / benchmark / approvalId / metrics / decision / timestamp）。
- 持久化（`src/ai-quality/service.ts`）：snapshot / restore + `persistToFile` / `loadFromFile`（原子写），改进闭环跨重启保留；server 配置 `aiQualityStateFile` 时启动自动加载、写操作（POST）后自动保存。
- API（`src/platform/api/server.ts`，43.26）：GET /api/ai-feedback、POST /api/ai-feedback/:id/verify、GET /api/ai-errors、GET /api/ai-improvements、POST /api/ai-improvements/:id/approve|reject、GET /api/prompts、GET /api/prompts/:id/versions、GET /api/models、GET /api/experiments、POST /api/experiments、GET /api/knowledge/review、GET /api/ai-quality、GET /api/ai-quality/trends；写操作统一 RELEASE_APPROVE 门禁（QA 403），未认证 401。
- CLI（`bin/ai-quality-cli.ts` + package.json，43.25）：agent:ai-quality / agent:feedback:list|verify / agent:eval:errors|improve / agent:prompt:list|compare / agent:model:list|compare / agent:improvement:list|approve|reject / agent:knowledge:review / agent:canary:status|promote|rollback。
- Web Dashboard（`web/src/pages/AIImprovement.tsx` + `web/src/App.tsx` + `web/src/api.ts`，43.18/43.22）：导航「AI 改进」页，7 Tab（待核验反馈 / 错误聚类 / 改进提案 / Prompt·Model 版本 / Shadow·Canary 实验 / 知识 Review / AI 质量）；审批类操作仅 RELEASE_MANAGER / ADMIN 可执行，非审批角色只读（按钮禁用）。
- 测试（86 新用例）：单元 feedback-registry(10) / error-analysis(5) / improvement-proposal(12) / prompt-model-version(6) / knowledge-learning(5) / shadow-canary(6) / ai-improvement-ops(12) / ai-quality-service(12 含持久化) + 集成 ai-improvement-api(10) + E2E ai-improvement-flow(4, S1-S8) + ai-quality-dashboard(4)。
- 文档：`docs/ai-quality/`（feedback / error-analysis / improvement / prompt-versioning / model-versioning / shadow-canary / knowledge-learning / rollback）+ `docs/phases/phase46-summary.md`。

### 变更

- 版本 v4.20.0 → v4.21.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 测试

- Phase 46 新增 11 测试文件 **86 / 86 passed**；关键安全指标（falsePass / p0Miss / unsafeHealing）为 0；人工门禁 QA 写操作 403、RELEASE_MANAGER 成功；未授权访问 401；持久化（persist/load）跨重启保留。
- 全量回归保持 PASS（`npm test` / `npm run platform:test` / `npm run platform:integration` / `npm run platform:e2e` 等）。

## [4.20.0] - 2026-08-20

### 新增（AI 测试质量评测，Phase 45）

解决「AI 到底测得好不好？」——建立 AI Test → Evaluation → Ground Truth → Score → Error Analysis → Benchmark → Improvement → Regression 的可量化、可比较、可回归、可证明闭环。核心原则：**没有 Ground Truth，就不能声称 Accuracy；有 GT → tracked=true；无 GT → tracked=false → score=null**；绝对禁止为 Dashboard 好看自动给 95%。

- 统一评测契约（`src/eval/contract.ts`）：8 领域（REQUIREMENT / TEST_DESIGN / RISK / SELECTION / RCA / DEFECT / HEALING / RELEASE）统一 Evaluation Case / Result / Report 结构；`tracked` 语义区分真实可判定结果与未跟踪（score=null）；`isPassed` / 评分标准统一。
- Ground Truth Registry（`src/eval/ground-truth.ts`）：来源 HUMAN / REAL_PRODUCTION / REAL_RUN / CURATED / GENERATED + 置信度（confident / likely / uncertain）+ 校验（isVerified / verifiedBy / verifiedAt / verificationEvidence）；注册即跟踪，禁止无来源的虚构真值。
- 8 领域版本化 Benchmark（`src/eval/benchmark/`）：Requirement 36 / Test Design 22 / Risk 32 / Selection 30 / RCA 38 / Defect 30 / Healing 20 / Release 30，共 **238 条 tracked 用例**；覆盖普通 / 复杂 / 模糊 / 缺字段 / 矛盾 / 异常等场景；Benchmark 版本化（REQUIREMENT_BENCHMARK_v1 等）。
- 确定性规则评测器（`src/eval/evaluator/` × 8 + `src/eval/runner.ts`）：模型 model=rules，零外部依赖、零 token 消耗、可离线确定性执行；每领域输出领域级 metrics + 逐条 Case 结果（expected / actual / errors / evidence）。
- 指标体系（`src/eval/metrics.ts` / `score.ts`）：Completeness / Precision / Recall / F1 / Coverage Score / Redundancy Score / Executability Score / Critical Miss Rate（P0 Miss）/ Recall@TopK / Precision@TopK / Top-1 / Top-3 Accuracy / Unknown Rate / False Root Cause Rate / Healing Success Rate / Unsafe Healing Rate / Rollback Success Rate / False Pass Rate / False Block Rate 等。
- 版本对比与回归门禁（`src/eval/regression.ts`）：compare / regression 支持 v4.19.0 vs v4.20.0 式对比，自动标记 Improved / Regressed / Unchanged；Critical 指标下降（P0 Recall / Unsafe Healing / False Pass）→ BLOCK（CLI 退出码 1）；普通小幅下降 → REVIEW。
- 决策 Replay（`src/eval/replay.ts`）：read-only、无 production mutation / defect create / release；确定性模块 same input → same output；LLM 模块记录 model / promptVersion / temperature / seed / tools / timestamp。
- 成本跟踪（`src/eval/cost.ts`）：每次评测记录 model / modelVersion / promptVersion / toolVersion / agentVersion + inputTokens / outputTokens / latencyMs / cost；报告同时呈现 Score + Cost。
- 安全治理（`src/eval/`）：Healing 评测区分 SAFE / RISKY / DANGEROUS（严禁自愈却产出建议 → DANGEROUS，掩盖真实 Bug 的高危自愈）；目标 Unsafe Healing Rate = 0；Release 评测重点 False Pass = 0。
- Web AI Quality Dashboard（`web/src/pages/AIQuality.tsx`）：/ai-quality 页展示 8 领域分数 + Overall + 四关键安全指标（P0 Miss / False Pass / Unsafe Healing / Skipped Critical）+ 每领域逐条 Case 明细（Expected / Actual / Errors）+ 成本信息；`web/src/api.ts` 新增 `getEvalReport`。
- API（`src/platform/api/server.ts`）：GET `/api/eval/report`（全量报告）/ GET `/api/eval/report/:domain`（单领域，未知领域 404）；权限同只读运维数据（OPS_READ）。
- CLI（`bin/eval-cli.ts` + package.json 脚本）：`agent:eval:all` / `agent:eval:report` / `agent:eval:compare --baseline` / `agent:eval:regression` / `agent:eval:unit` / `agent:eval:integration` / `agent:eval:e2e` / `agent:eval:test` / `phase45:test`；CLI run 默认保存报告到 `eval-reports/`（已 gitignore）。
- 测试：`tests/unit/evaluation-contract.test.ts`（11）/ `ground-truth.test.ts`（11）/ `evaluation-regression.test.ts`（15）/ `benchmark-registry.test.ts`（11）/ `decision-replay.test.ts`（9）= 57 单元用例 + `tests/integration/evaluation-api.test.ts`（4）+ `tests/e2e/evaluation-dashboard.test.ts`（3）+ `web/src/pages/AIQuality.test.tsx`（组件测试）全绿。
- 文档：`docs/evaluation/overview.md` / `benchmark.md` / `ground-truth.md` / `metrics.md` / `model-comparison.md` / `regression-gate.md` + `docs/phases/phase45-summary.md`。

### 变更

- 版本 v4.19.0 → v4.20.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。
- `src/agents/self-healing/healing-analyzer.ts` / `src/agents/analysis/failure-classifier.ts`：与评测框架对齐（供规则评测读取真实决策行为）。

### 测试

- 评测单元 57 passed；评测集成 4 passed；评测 E2E 3 passed；Web 组件（AIQuality）passed。
- `npm run agent:eval:all`：Overall 93.6%（238 条 tracked）；**关键安全指标 P0 Miss=0 / False Pass=0 / Unsafe Healing=0 / Skipped Critical=0**；8 领域全绿（Requirement 85.6 / Test Design 92.8 / Risk 100 / Selection 99.8 / RCA 89.5 / Defect 95.5 / Healing 95 / Release 93.3）。
- 全量回归：`npm test` 144 文件 1650 passed / 18 skipped；`npm run web:test` 11 文件 72 passed；`npm run build` 通过。

## [4.19.0] - 2026-08-20

### 新增（真实浏览器 E2E 覆盖收口 + 单元覆盖缺口闭合，Phase 44）

- RunCreate / Run 操作（Cancel / Assign / Retry）/ TestAssets / AssetVersions 4 个新 Playwright 套件，Chromium 87 E2E 全量全绿。
- 可访问性 / 键盘 / 响应式扩展至新页面（RunCreate、TestAssets、AssetVersions、Run Detail 全生命周期控件）。
- 单元覆盖缺口闭合：`api.test.ts` 登出契约 + RunCreate 全参数 + AssetVersions 单版本分支，68 用例 / 行覆盖 99.67%。
- `/assets/:id` SPA 路由冲突修复；测试资产 `{ items }` 契约对齐。

### 变更

- 版本 v4.18.0 → v4.19.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 测试

- Web 单元 68 passed / 行覆盖 99.67%；Web E2E Chromium 全量全绿；既有全量回归保持 PASS。
- 报告：`docs/phases/phase44-summary.md`。

## [4.18.0] - 2026-08-20

### 新增（Web 交互正确性 + Run 全生命周期 + 测试资产暴露，Phase 43）

- 写操作统一错误反馈：`Defects.tsx`（create/status/assign）与 `RunDetail.tsx`（Run Again / Clone / Template / Share / Comment / Cancel / Assign 经 `runAction` 包装）补 try/catch + 错误 banner，失败不再静默 unhandled rejection。
- **评论契约修复**：服务端读 `c.body.body`，此前前端发 `{ text }` → 200 但正文恒为空，改为 `{ body }`；`api.ts` 补 `del`（DELETE）；`Runs.tsx` 支持 `?project=` 项目过滤。
- Run 全生命周期 Web 呈现：新建 Run 页 `/runs/new`（全参数）/ Cancel（仅 QUEUED/RUNNING 显示）/ Assign（逗号分隔多用户，空输入禁用）。
- 测试资产 Web 暴露：`/assets`（TestAssets 统计+列表）+ `/assets/:id`（AssetVersions 版本历史+字段级对比），复用既有后端端点零改动。
- 测试覆盖补强：RunDetail 回归测试扩展至 14 用例 → 行覆盖 100%；新增 RunCreate（3）/ TestAssets（2）/ AssetVersions（2）；全量 59 用例 / 行覆盖 95.12%，`tsc -b` 通过。

### 变更

- 版本 v4.17.0 → v4.18.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 测试

- Web 单元/组件 59 passed / 行覆盖 95.12%；`cd web && npx vitest run --coverage`。
- 报告：`docs/phases/phase43-summary.md`。

## [4.17.0] - 2026-08-20

### 新增（Web 前端工程化：单元/组件测试 + CI 接入 + 跨浏览器回归，Phase 42）

补齐 Web Dashboard 的三层工程化保障，使前端具备与平台层同等强度的可回归性。

- Web 前端单元 / 组件测试（42.1）：Vitest 4.1 + jsdom + React Testing Library（`web/vitest.config.ts` 独立配置，显式 `jsdom.url`）；新增 6 个测试文件 37 条用例：`api.test.ts`（登录契约 accessToken/roles 归一化 / 会话存取 / Bearer+X-Trace-Id 头 / 401 自动登出 / 404 兜底 / 网络错误 / 15s 超时）、`usePolling.test.tsx`（三态 + 卸载清定时器）、`ui.test.tsx`（Card/Badge/StatusBadge/MetricCard/Table/Empty/JsonBlock/fmtTime/WindowSwitcher）、`Login.test.tsx`（表单渲染/错误提示/成功回调）、`env-mini` / `env-probe`（环境探针）。v8 覆盖率：语句 94.96% / 行 96.09%，`ui.tsx`、`usePolling.ts`、`Login.tsx` 语句 100%。
- 测试环境修复：Node ≥22 实验性 `localStorage`（`--localstorage-file` 未提供时为 `undefined`）不在 Vitest `populateGlobal` KEYS 白名单 → jsdom Web Storage 不被拷贝；`test-setup.ts` 安装内存版 `MemoryStorage` 兜底（同源键值对，行为与 Web Storage 一致），保证 `api.ts` 会话存取可测。
- 测试驱动修复：`StatusBadge` 空字符串 `??` 不兜底（`'' ?? '—'` 仍为 `''`）→ 改 `status ? status : '—'` 空态显示占位符；测试文件从生产 `tsc -b` 构建排除（`web/tsconfig.json` `exclude`）。
- CI 接入（42.2）：新增 `.github/workflows/web-e2e.yml` 三档分级——`web-unit`（PR/push 门禁：单元+覆盖率+构建）、`web-e2e-chromium`（PR/push 门禁：Chromium 全量 16 个 spec）、`web-e2e-cross-browser`（Nightly 定时：三浏览器全量，报告保留 14 天）；E2E 服务器为内存态平台，CI 可离线确定性执行，无需 Repository Secrets。新增脚本 `web:test` / `web:test:coverage` / `web:e2e:cross`。
- 跨浏览器回归（42.3）：`playwright.config.ts` 增加浏览器集合门控 `WEB_E2E_BROWSERS`（默认/`chromium` 仅 Chromium、`all` 三浏览器、逗号列表指定子集）；本机安装匹配版本（Playwright 1.62.1 → firefox v1538 / webkit v2336），firefox + webkit 冒烟覆盖登录/项目/报告核心链路通过。

### 变更

- 版本 v4.16.0 → v4.17.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。

### 测试

- Web 单元/组件：`npm run web:test` 37 passed / 0 failed；`npm run web:test:coverage` 语句 94.96%。
- Web E2E：`npm run web:e2e:test` Chromium 全量 74 passed / 0 failed；`WEB_E2E_BROWSERS=all` 三浏览器全量 PASS。
- 既有 Vitest 全量回归与 `phase41:test` 链路保持 PASS（构建 + 平台回归 + Web 构建 + Chromium E2E）。
- 报告：`docs/phases/phase42-web-engineering-report.md`。

## [4.16.0] - 2026-08-20

### 新增（Web 真实浏览器 E2E 与体验质量，Phase 41）

把 Web Dashboard 从「代码正确 + HTTP 正确」提升到「真实浏览器操作正确 + 用户流程完整 + UI 状态正确 + 可访问 + 可回归」，Playwright 真实浏览器 E2E 全量覆盖登录 → 项目 → QA Home → Plan → Run → Run Detail → Failure/RCA → Defect → Report → Share → Release/Approval → 权限隔离 → 错误态 → 可访问性 → 键盘 → 响应式 → 性能。

- Web E2E 基础设施（41.1）：Playwright（`@playwright/test@1.62.1`）+ Chromium；`tests/e2e/web/` 内存态测试服务器（`e2e-server.ts`，`WEB_E2E_PORT=8799`，Playwright `webServer` 自动拉起 + 种子数据）+ 共享助手（`helpers.ts`：种子清单读取 / UI 登录 / 会话注入 / API 认证头 / JSON 污染断言）+ `playwright.config.ts`；新增脚本 `web:e2e:test` / `web:e2e:server` / `web:e2e` / `phase41:test`（41.20 CI 接入）。
- 14 个 E2E 套件覆盖 17 项关键功能验收（41.2-41.17）：`auth`（登录成功/错误密码/Token 失效跳登录）、`project`（项目列表/Run 计数/失败计数）、`workflow`（建 Suite + TestCase → 建 Plan → 对 Plan 执行 Run → 快速操作直达）、`run`（状态/进度/风险/覆盖/失败明细/RCA/实时刷新/无效 ID 错误态）、`defect`（从失败创建缺陷/状态流转/详情）、`report`（关键指标/无 JSON 污染/导出）、`share`（分享链接/无 Token 只读/不泄漏 JWT/非法 token 拒绝）、`approval`（发布审批/驳回/职责分离）、`project-isolation`（qa-a 见 wan3 / qa-b 见 order / 跨项目 API 403 / 页面错误态不泄漏）、`error-state`（404/网络失败/限流错误态可见而非白屏）、`accessibility`（axe-core wcag2a/aa/21a/21aa/best-practice 逐页扫描无 critical/serious）、`keyboard`（Tab 可达/焦点可见/回车提交）、`responsive`（1440/1280/1024/390/375 五档视口无溢出）、`performance`（首屏阈值/轮询治理无 429 风暴/无 console error/JS 包 < 1MB）。
- 可访问性修复（41.14）：新增 `--accent-text`（#6d9bff ≈ 5.0:1）供链接/品牌/标题文字、`--ok-deep`（#14804a ≈ 5.0:1）/ `--err-deep`（#c62f41 ≈ 5.4:1）供按钮填充、`--err-soft`（#ff8f9d）供 tinted 徽标文字；`a.link` 默认下划线（文本块内链接不能仅靠颜色区分）；登录页 div 改 `<h1>`；`:focus-visible` 统一 2px 描边 + offset；逐页补齐表单控件 `label for` / `aria-label`。
- 响应式修复（41.16）：`.nav` 允许收缩 + 换行（17 个链接 893px 宽不再溢出）、`.content` 加 `min-width:0`、网格窄屏单列、长 ID / 超长路径 `word-break: break-all`。
- 真实缺陷修复：登录 token 字段对齐（`accessToken` 优先，回退 `token`）；RunDetail 死循环刷爆限流 429（改 useEffect `[id]` 驱动加载）；QA Home Runs/Approvals 按项目作用域过滤（41.12 修复 qa-b 可跨项目看到 wan3 数据）；分享页路由与只读渲染；API 客户端统一错误处理（41.18）。

### 变更

- 版本 v4.15.0 → v4.16.0（`package.json` / `package-lock.json` / `src/platform/version.ts` / `README.md` / `CHANGELOG.md` 同步）。
- `.gitignore` 新增 Playwright 测试产物（`test-results/` / `playwright-report/`）。

### 测试

- 新增 14 个 Playwright 套件（`tests/e2e/web/*.spec.ts`，14 个测试文件满足「至少 10 个」要求）+ `e2e-server.ts` / `helpers.ts` / `playwright.config.ts`；验收：`npm run web:e2e:test`（构建平台 + 构建 Web + Playwright 全量，17 项关键功能 PASS）。
- 既有 Vitest 全量回归保持 **1586 passed / 18 skipped**（141 个测试文件）；`platform:integration` / `platform:e2e` / `phase40:test` 保持 PASS。
- 报告：`docs/phases/phase41-web-e2e-report.md`（E2E 测试）/ `docs/phases/phase41-frontend-quality.md`（可访问性/响应式/性能/API 治理）/ `docs/phases/phase41-acceptance-report.md`（17 项验收）。

## [4.15.0] - 2026-08-19

### 修复与加固（QA Workbench 工程化收尾，Phase 40）

基于 Explore 扫描出的 Critical / High 缺口逐项修复，覆盖安全越权、缺陷管理缺失、前端断点、数据真实性、聚合性能五类问题。

- 安全 Critical（Phase 40.1）：单资源读端点补 Project Scope——`getSuite / getPlan / planCases / getTemplate / assetVersions / listApprovals` 六处服务层与对应路由透传 `scopes`，JWT 用户不能跨项目读取他人资源；`assetVersions` 通过资产类型（suite/plan/test-case）解析归属项目后校验；审批列表按 `approval → run → projectId` 解析过滤；`listRunComments` 默认读权限由 QA 放宽为 VIEWER。
- 缺陷管理真实化（Phase 40.2）：新增 `src/platform/workflow/defects.ts`（Defect 实体 + 状态机 OPEN/IN_PROGRESS/RESOLVED/CLOSED/WONT_FIX + severity critical/high/medium/low + 指派）；`POST/GET/PATCH` 缺陷 API、`DefectCreated` 事件 + `audit('defect')` 写入、`defect` CLI 命令组、Web 缺陷页面（列表/新建/详情/状态流转/指派）、QA Home `recentDefects` 返回真实缺陷实体。
- 前端断点（Phase 40.3）：`POST /runs/:id/share` 修正（原 GET 404）；Settings `/api/version` 双前缀修复；新增公开分享落地页——无 JWT 携带 `?share=<token>` 可读报告与 JSON/HTML 导出（share token 防跨项目猜测，非法 token 403）；无 Token 访问自动跳登录，分享链接自动进入只读报告页；QA Home Action Center RCA 死链修复。
- 数据真实性（Phase 40.4）：run-report `failures` 由真实遥测 execution（`case:` 失败）与 RCA 事件聚合，`coverage.failed` 真实计数；`decisionTrace` 可读化（summary + 决策/风险/原因 + 步骤列表），无数据返回占位不虚构。
- 聚合性能（Phase 40.5）：QA Home 与 run-report 增加 TTL 内存缓存（QA Home 按用户资源作用域隔离，防跨用户泄漏），削减 3s 轮询下的全量聚合开销。

### 测试

- 新增 `tests/integration/phase40-scope.test.ts`（14 项：跨项目越权 403、资产版本/审批隔离、Defect 全链路、QA Home 契约、分享落地页公开访问与非法 token、failures 真实填充、decisionTrace 可读化、QA Home/run-report 缓存命中与隔离）+ `tests/unit/defects.test.ts`（10 项：CRUD/状态机/权限/事件/审计/recentDefects）。
- `share` 由 GET 改 POST 同步更新 `report-share.test.ts` 与 `qa-workflow.test.ts`；新增 `phase40:test` 专用脚本。
- 全量回归：1586 passed / 18 skipped；`platform:integration` / `platform:e2e` / `phase39:test` 保持 PASS。

## [4.14.0] - 2026-08-19

### 新增（QA 工作流产品化，Phase 39）

把"能力很多的 AI Test Platform"升级为"QA 每天真正愿意使用的 AI Test Workbench"：QA 从「选项目 → 选测试计划 → 一键运行 → AI 自动执行 → 自动分析/归因/缺陷/回归/Release 决策 → 查看报告 → 协作处理」全流程可追踪 / 审计 / 恢复 / 复用 / 版本化 / 权限控制 / 自动化。

- 新增 `src/platform/workflow/` 模块（8 个文件）：`test-suite.ts`（TestSuite：创建/修改/复制/归档/恢复/增删 Case/按 Tag 过滤，只维护 caseIds 引用不复制数据）、`test-plan.ts`（TestPlan：Plan → Suite → TestCase，mode MANUAL/REGRESSION/AUTONOMOUS）、`run-template.ts`（RunTemplate：Save as Template → Run Template，只复制 Configuration，不复制 Execution Result/RCA/Release Decision）、`asset-versioning.ts`（AssetVersion：version/changeReason/snapshot + Compare/Rollback/History，TestRun 固定 assetVersion）、`collaboration.ts`（Comment/Mention/Assignment/Watcher，@user 触发通知）、`run-report.ts`（RunReportSummary：Release Decision/Risk/Coverage/Failures/RCA/Cost/Duration + DecisionTrace 透出 + share/export JSON/HTML）、`qa-home.ts`（QA Home：我的项目/今日 Runs/失败/待审批/常用 Plan/Template/Flaky/高风险 + Action Center 告诉 QA 现在该做什么）、`index.ts`（WorkflowService 门面）。
- 零新增基础设施：全部复用既有 `PlatformService` / `Repository` / `RBAC` / `Notification` / `Audit` / `Telemetry` / `Run`；新增实体仅走既有三层改动模式（实体定义 → factory `reg()` → `ALL_COLLECTIONS` 追加，迁移/回滚/备份/恢复自动覆盖）。
- 新增 QA Workflow API（25+ 路由）：`/test-suites`（CRUD + archive/restore/copy/cases/tags）、`/test-plans`（CRUD + run/cases）、`/run-templates`（CRUD + run）、`/assets/:id/versions|compare|version`、`/runs/:id/rerun|clone|template|share|comments|assign`、`/qa-home`；分页/鉴权/错误契约沿用既有 API 标准。
- 新增 CLI 命令组：`suite list/create/get/archive/restore/copy`、`plan list/create/get/run/cases`、`template list/create/get/run`、`run rerun|clone`、`report get/share/export`（CLI 与 Web 共用 Service Layer）。
- 新增 Web QA Workbench 页面：QAHome（Action Center + 快速操作）、TestSuites、TestPlans、RunTemplates、RunDetail 增强（报告摘要卡 / Run Again / Clone Configuration / Create Template / Share + Export / 协作评论 @mention）。
- 权限语义化：权限/作用域拒绝（RBAC 不足 / 项目环境越权）由 400 提升为 403 Forbidden；Project Scope + RBAC 双重校验跨项目报告隔离（不能通过 URL 猜到其它项目报告）。
- 产品体验指标真实采集：报告成本 `tracked` 仅在存在真实 CostLedgerEntry 时置 true，无数据返回 tracked=false，不虚构 KPI。

### 测试

- 新增 8 个测试文件：5 个单元（test-suite / test-plan / run-template / asset-versioning / collaboration，30 项）+ 2 个集成（test-workflow-api / report-share）+ 1 个 E2E（qa-workflow，8 个核心场景 S1-S8：Suite→Plan→Run→Template→版本 Compare→评论@通知→分享→跨项目隔离→QA Home Action Center）。
- 全量回归：1562 passed / 18 skipped（较 v4.13.1 新增 49 项）；`platform:integration` 与 `platform:e2e` 脚本纳入新测试；新增 `platform:workflow:test` / `phase39:test` 专用脚本。
- 既有备份/恢复/迁移回滚断言改为动态 `ALL_COLLECTIONS.length`（22 集合），未来新增集合不再需要手动改数字。

## [4.13.1] - 2026-08-19

### 安全加固（非法 X-Role 拒绝，Phase 36 范围补全）

- 关闭 `api/server.ts` 静态身份路径的 `role as Role` 不安全类型断言：静态 Token 返回的 role 必须经 `rbac.isRole` 校验，非法 `X-Role`（如 `HACKER`）直接拒绝（401），不再被当作合法角色——防身份伪造升级 / 防越权。
- 新增 `rbac.isRole` 类型守卫与 `ROLES` 角色清单（Role 单一权威源，防角色漂移）；`resolveStaticIdentity` 保持返回 string（security 模块维持零依赖），角色收窄收敛到 API 边界。
- 新增测试：`tests/unit/identity-resolution-guard.test.ts`（isRole 守卫正反例 + ROLES/ROLE_PERMISSIONS 一致性 + 结构性守护：server.ts 禁止 `ident.role as Role` 硬断言）；`tests/integration/api-auth.test.ts`（非法 X-Role → 401）。

## [4.13.0] - 2026-08-19

### 新增（E2E 时序卫生治理，Phase 37）

- DEBT-13 已解决（**技术债清零**：TECH-DEBT 12 项债务全部关闭）：审计确认 E2E / 集成测试已普遍采用健壮模式——随机端口（`server.listen()` 无参 / `listen(0)`）、固定时钟注入（`FIXED_ISO`，固定输入→固定输出，非 flaky）、`Date.now()` 生成唯一 ID、轮询 + 超时等待；未发现硬编码端口、运行时时间戳固定字面量断言或固定长 sleep 残留。
- 新增脚本 `phase37:test`（构建 + 时序卫生守护 + 代表性 E2E / 集成回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-13（慢 / 易碎测试）已解决，开放债务归零。

### 测试

- 新增 `tests/unit/e2e-timing-hygiene.test.ts`（4 项）结构性守护：全部 E2E / 集成测试文件（1）无硬编码监听端口（`listen(<数字>)`）、（2）无对时间字段的固定 ISO 字面量断言（`FIXED_ISO` 注入除外）、（3）无 ≥1000ms 固定 sleep（应为轮询 + 超时）、（4）现状基线确认（随机端口 + FIXED_ISO + 超时轮询模式存在）；全量回归：1508 passed / 18 skipped（131 个测试文件）。

### 最终验收（Phase 38，PROJECT COMPLETE）

- 依据任务书最终完成标准七大类（功能完整 / 可靠性 / 测试 / 生产 / AI 验证 / 工程质量 / 可维护性）完成最终完成度评估：逐项核对全部满足，判定 **PROJECT COMPLETE**。
- 新增 `docs/FINAL-PROJECT-ACCEPTANCE-REPORT.md`：执行摘要（v4.13.0 / 43 commits / 1508 passed / src 36,577 行 / tests 22,291 行 / 平台 18 模块 / 变异 98.96% / 技术债清零）、七大类 A-G 逐项核对、技术债清零确认表（12 项 DEBT 对应解决 Phase）、诚实披露 4 项已知限制、最终结论与维护态变更规范。
- 本阶段为纯完成度评估（无代码变更），版本保持 v4.13.0；项目进入维护态。

## [4.12.0] - 2026-08-19

### 新增（身份解析统一 + 防伪造不可绕过，Phase 36）

- DEBT-12 已解决：审计确认 `resolvePrincipal` 为唯一身份解析实现（无历史版本残留）；同时将「静态身份来源」的守卫与解析真正收敛到 security 模块——新增 `resolveStaticIdentity(mode, headers)`：production 返回 `null`（防身份伪造不可绕过），其余模式从 X-Actor/X-Role 头解析（数组取首项；无 actor 默认 `api`，无 role 默认 `VIEWER`）。
- `api/server.ts` 静态 Token 回退改调 `resolveStaticIdentity`，不再直接读取 `x-actor` / `x-role` 头——**平台层 X-Actor/X-Role 头读取仅存在于 security 模块**（结构上固化，防新 API 入口绕过生产关闭）。
- 新增脚本 `phase36:test`（构建 + 身份解析守护 + security / auth / RBAC 相关回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-12（身份解析重复实现残留）已解决。

### 测试

- 新增 `tests/unit/identity-resolution-guard.test.ts`（8 项）：`resolveStaticIdentity` 功能（生产关闭 / 各模式解析 / 默认回退 / 数组首项 / 空字符串回退 / 非字符串字符串化）+ 结构性守护（`src/platform/**` 中 X-Actor/X-Role 头读取仅存在于 security 模块）+ `resolvePrincipal` 唯一实现守护 + 集成语义（production 关闭不可绕过，staging 为生产演练模式仍允许静态身份）；全量回归：1504 passed / 18 skipped（130 个测试文件）。

## [4.11.0] - 2026-08-19

### 新增（类型级反向依赖上移 core，Phase 35）

- 消除平台层对 agents 域的类型反向依赖（DEBT-11 已解决）：失败分类共享模型（`FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory`）从 agents 域 `agents/analysis/root-cause-schema.ts` 上移至 **core 层唯一权威来源** `core/failure-category.ts`（core 为最底层、可被任意域依赖，符合依赖规则）。
- agents 域 `root-cause-schema.ts` 改为从 core 导入并 **re-export**（既有 API 完全兼容，`root-cause-agent.ts` 的 `FailureCategory` / `FAILURE_CATEGORIES` 使用不受影响）；`autonomous` 域经 agents 正常使用。
- 平台层 3 处 `import type { FailureCategory }` 改从 core 导入：`telemetry/telemetry-types.ts`、`telemetry/telemetry-service.ts`、`ops/real-run.ts`——**平台层至此对 agents 域零依赖**（结构上已由守护测试固化）。
- 新增脚本 `phase35:test`（构建 + 失败分类模型 + RCA / defect / telemetry / real-run 相关回归）。

### 变更

- `vitest.config.ts` coverage include 纳入 `src/core/failure-category.ts`（新模块计入覆盖率门禁）。
- `docs/TECH-DEBT.md`：DEBT-11（类型级反向依赖）已解决。

### 测试

- 新增 `tests/unit/core-failure-category.test.ts`（6 项）：分类清单完整性 / 守卫正反例 / core 与 agents re-export 同一权威源（同一数组引用，防双源漂移）/ agents 兼容可用 / core 分类清单与 RCA JSON Schema enum 完全一致（防分类改动漂移）/ **结构性依赖守护**（`src/platform/**` 全部源文件无 agents 域 import，防回归）；全量回归：1496 passed / 18 skipped（129 个测试文件）。

## [4.10.0] - 2026-08-19

### 新增（断言可视化接入 HTML 报告，Phase 34）

- 变废为用（DEBT-05 已解决）：将此前「仅被自身测试引用」的 `utils/assertion-visualizer.ts` 断言可视化引擎接入 `reports/html-reporter.ts`，HTML 报告新增 **4.4 断言可视化** 节，复用其 Diff View（JSON/TEXT/NUMERIC/BOOLEAN/SCHEMA 节点级差异）与 Assertion Heatmap（热度权重 0 绿 / 1-3 黄橙 / 4-5 红 + Flakiness Index）两大协议。
- 报告 4.4 节渲染内容：失败断言逐条输出节点级 Diff 明细表（路径/变更类型/期望/实际/说明），全通过时显示「无失败差异视图」；断言热力图矩阵表（断言/目标/路径/操作符/权重/失败率/运行数）覆盖全部声明式断言。
- 新增脚本 `phase34:test`（构建 + 断言可视化接入相关测试：html-reporter-visualization + assertion-visualizer + assertion-engine + path-extractor）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-05（`utils/assertion-visualizer.ts` 未使用模块）已解决——接入 HTML 报告器对外提供能力，消除唯一「未使用模块」开放债。

### 测试

- 新增 `tests/unit/html-reporter-visualization.test.ts`（4 项）：失败断言输出 Diff 视图 / 全通过时无失败差异视图但输出热力图 / 无声明式断言时无可视化数据 / HTML 特殊字符转义防注入；全量回归：1490 passed / 18 skipped（128 个测试文件）。

## [4.9.0] - 2026-08-19

### 新增（环境策略职责边界与跨层一致性，Phase 33）

- 新增跨层一致性契约（DEBT-01 已解决）：平台层 `environmentTypeToTier`（dev/test→test、staging/preprod→preonline、production→production）与 `environmentTypeToMode`（dev→development、test→test、staging/preprod→staging、production→production）映射函数 + `PRODUCTION_LIKE_GUARD_TIERS`，作为 agent 层启用守卫 / 平台层动作分级 / 安全模块运行模式加固三层策略的互操作契约。
- **修复跨层漂移缺口**：agent 层 `resolveEnvironmentTier` 不识别平台层 `preprod` 环境名，此前 `preprod` 被解析为 test 档（危险动作可放行）；现正确归入 preonline 档（危险动作拒绝）。
- 新增职责边界文档 `docs/environment-policy-boundaries.md`：三层模型表、职责划分、互操作契约、5 条不变量、变更检查单。
- 新增脚本 `phase33:test`（构建 + 跨层一致性 + 相关回归）。

### 变更

- `docs/TECH-DEBT.md`：DEBT-01（双环境策略源）已解决（保留 + 边界文档化 + 跨层一致性校验）。

### 测试

- 新增 `tests/unit/environment-policy-coherence.test.ts`（15 项）：跨层映射契约与解析一致 / 生产类环境三模型一致（平台 isProductionLike ⇒ agent 生产类档位 ⇒ 运行模式生产安全） / 危险动作跨层拒绝一致（禁止动作清单全覆盖） / 纵深防御不变量（平台 deny ⇒ agent 必拒绝） / 禁止动作清单完整性 / 运行模式别名对齐；扩展 `tests/unit/environment-policy.test.ts`（preprod 档位）。

## [4.8.0] - 2026-08-19

### 新增（变异测试，Phase 32）

- 引入变异测试基础设施（Stryker + `@stryker-mutator/vitest-runner`，Vitest `related` 模式 + perTest 覆盖率分析，仅运行与变异点相关的测试）；新增 `stryker.config.mjs`：变异目标集聚焦平台 Critical 决策逻辑（生产安全 / RBAC / 审批中心 / Run 状态机 7 个源文件），`excludedMutations` 排除 `StringLiteral`，`concurrency=4`。
- 新增变异分数门禁（`thresholds: high=80 / low=70 / break=60`）：总体变异分数 98.96%（191 杀死 / 2 存活 / 0 无覆盖），高于 high 阈值；子模块 security 100% / approval-center 100% / rbac 98.44% / runs 96.55%。
- 新增脚本：`phase32:test`（构建 + 相关单测 + 完整变异门禁）/ `mutation:test` / `mutation:dry`（仅校验测试环境）。
- 变异报告落盘 `reports/mutation/mutation.html`（已入 `.gitignore`，与 `coverage/` 一致不入版本库）。

### 变更

- 依据变异测试甄别的真实缺口补齐测试（首次变异 85.49% → 补测后 98.96%）：访问决策四分支全字段形状断言（`{verdict, requiresApproval, rbacPassed, policy}`，防布尔字段被翻转）、`DEVELOPER`/`SERVICE_ACCOUNT` 权限矩阵、`listPermissions`、PlatformGate 审批不存在/无审批权限抛错与 reason/evidence 回退默认值、`resolvePlatformMode` trim/大小写规范化、静态身份来源 detail、审批 `clear()` 与 evidence 默认空数组、Run 状态机六状态完整转移表与终态空转移。
- `docs/TECH-DEBT.md`：DEBT-07（无变异测试与 Critical 变异门禁）已解决。

### 测试

- 新增 `tests/unit/run-schema.test.ts`（5 项：状态转移表 / 终态空转移 / canTransition 正反例 / transitionRun / isTerminal）+ 扩展现有 rbac/security/approval-center 测试；全量回归：1471 passed / 18 skipped（126 个测试文件）。
- 已知等价存活 2 项（已甄别）：`platform-gate.ts:43` evidence 回退 `??`→`&&`（perTest 覆盖率映射的保守假象，实测行为不同且新测试可杀死）、`run-schema.ts:75` runId 月份算术（需 mock Date 才能测，实践等价）。

## [4.7.0] - 2026-08-19

### 新增（迁移 down / 回滚，Phase 31）

- `Migration` 接口新增 `revert`（down）实现；`v1/base-schema` 回滚 = 删除全部 16 个集合表（`_migrations` 表保留为基础设施，记录由回滚流程删除）。
- 新增回滚核心：`resolveRevertTarget`（无已应用 → null；未指定取最新；指定必须为最新，禁止跳级回滚；目标迁移必须存在且实现 revert）与 `revertSqliteMigration` / `revertPostgresMigration`（回滚后同步删除 `_migrations` 记录，返回回滚迁移 id；可再次应用恢复）。
- CLI `migrate` 新增 `down` 子命令：`migrate down sqlite|postgres [--id <id>]`（回滚最新已应用迁移）与 `migrate down check`（展示两端已应用与可回滚状态）。
- 验证 backup→migrate→rollback→restore 完整链：升级前 `collectSnapshot` 备份 → 回滚 schema（集合表 + 记录删除）→ 重新应用迁移恢复 → `restoreSnapshot` + `verifyRestore` 三一致（Count / Checksum / Key ID）。结论：只要升级前有备份，迁移回滚不会造成数据永久丢失。

### 变更

- `docs/TECH-DEBT.md`：DEBT-09（迁移框架缺口：无 down/回滚）已解决。

### 测试

- 新增 `tests/unit/migrations-down.test.ts`（5 项：SQLite 回滚闭环/幂等空操作/目标解析边界/mock Pool 回滚/Postgres 空态）+ `tests/integration/migrations-rollback.test.ts`（2 项：真实 SQLite 回滚闭环 + `_migrations` 基础设施保留）；全量回归：1452 passed / 18 skipped（125 个测试文件）。

## [4.6.0] - 2026-08-19

### 新增（覆盖率补齐，Phase 30）

- `vitest.config.ts` coverage include 纳入 `src/platform/**`（DEBT-08 已解决）：平台层与核心/智能层共用同一门禁（行/函数/语句 ≥ 80，分支 ≥ 75）；`perf-harness.ts` 由独立性能套件（`tests/perf` + `vitest.perf.config.ts`）运行，排除以免以 0% 虚假稀释平台层覆盖率。
- 新增集中补测 `tests/unit/platform-coverage-gap.test.ts`（15 项）：覆盖平台层此前低于门槛的缺口模块——
  - EventBus：`clear` / `listenerCount(type|无参)` / `totalPublished`；
  - NotificationDispatcher：`notifyEvent` 模板与上下文后缀分支（含/省略 environment/projectId）、`buildNotificationMessage` 覆盖全部模板类型；
  - Migrations：PostgreSQL 迁移（`ensurePostgresMigrationsTable` / `listAppliedPostgres` / `applyPostgresMigrations` 幂等，mock Pool 规避 pg-mem 多列约束 DDL 局限）与 SQLite 迁移落盘验证；
  - EnvironmentPolicy：`describeDecision` 三种决策、无 custom 时回退单一策略源、`isProductionLike` 各档位；
  - Scheduler：`pause`/`resume` 非执行态边界、`requeueRetries` 环境过滤、`isJobTerminal`、`clear`；
  - WorkerRegistry：`count` / `getExecutor` / 未注册健康判定 / `healthyWorkers` 过滤 / `release` 下界 / down 心跳恢复 / 缺省选项构造；
  - WorkerPool：执行器抛非 Error 值 → FAILED 记录原文、`recoverOrphans` 回收无主 RUNNING Job；
  - CheckpointStore：`delete`（含不存在静默）/ `clear` / 空查询返回 null。
- 新增脚本 `phase30:test`（构建 + 平台层相关测试 + 完整覆盖率门禁校验）。

### 变更

- 平台层纳入覆盖率统计后，全量门禁（行/函数/语句 ≥ 80，分支 ≥ 75）在所有平台子模块均成立：events 96.66/100/90/100、notifications 95.65/95.5/100/100、scheduler 94.87/91.07/100/100、runs 96.82/90.32/100/100、ops 94.3/78.73/95.12/94.68、workers 93.51/81.81/96.55/98.88、api 89.66/77.91/90.54/92.57 等。
- `docs/TECH-DEBT.md`：DEBT-08（覆盖率缺口）已解决。

### 测试

- 新增 `tests/unit/platform-coverage-gap.test.ts`（15 项）；全量覆盖率：Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03；全量回归：1445 passed / 18 skipped。

## [4.5.0] - 2026-08-19

### 新增（性能与容量基线，Phase 29）

- 新增性能基准测量模块 `src/platform/ops/perf-harness.ts`（唯一测量源）：覆盖 10/50/100/500 Runs 生命周期（createRun → Scheduler → Worker → startRun/completeRun）吞吐/延迟、Scheduler 队列吞吐、Audit 写入吞吐（含脱敏）、Telemetry 事件写入吞吐与内存稳定性；计时统一 `performance.now()`（µs），每项取 min-of-3 滤除 GC/调度抖动。
- 新增性能门禁 CLI `scripts/perf/run-perf.mjs`：`--baseline`（固化 `perf/baseline.json`）/ `--gate`（相对基线回归判定，延迟 > 2× / 吞吐 < 50% 即失败）/ `--json`。
- 新增 `tests/perf/platform-perf.test.ts`（Vitest sanity 门禁）+ `vitest.perf.config.ts`（`tests/perf/` 独立于默认 `npm test` 运行）。
- 新增脚本：`phase29:test` / `perf:test` / `perf:baseline` / `perf:gate` / `perf:report`。

### 修复（性能基准暴露的真实缺陷）

- **高吞吐下 ID 碰撞缺陷**：审计 / 调度 Job / 遥测事件 / 实体 / Run ID 原用 `Date.now().toString(36) + Math.random().toString(36).slice()` 组合，在容量基线（10 万+ ops/s 写入）下会碰撞导致「实体已存在」。新增 `src/core/id.ts`（`generateId`，crypto.randomUUID 128 bit 熵），统一替换 `audit-log` / `scheduler` / `telemetry-store` / `storage/repository` / `run-schema` 五处生成器；`generatePlatformRunId` 随机尾由 4 位 base36 升级为 32 位 hex。
- 新增回归守卫 `tests/unit/id.test.ts`（4 项）：同一毫秒内 10000 个 ID 无重复、`generatePlatformRunId` 5000 个无重复、格式断言。

### 变更

- 默认 `npm test` 通过 `vitest.config.ts` exclude 排除 `tests/perf/**`（性能套件单独运行，不影响全量回归计数与时长）。
- `docs/TECH-DEBT.md`：DEBT-06（性能基线缺失）与 DEBT-14（ID 碰撞）已解决。

### 测试

- 新增 `tests/unit/id.test.ts`（4 项）+ `tests/perf/platform-perf.test.ts`（2 项，sanity 门禁）；全量回归：1430 passed / 18 skipped（122 个测试文件）；`agent:test` 450 通过；性能门禁连续多轮 PASS（基线：500 Runs 生命周期 ~11k runs/s、create p95 < 3ms、Audit/Telemetry 10 万+ ops/s、内存增长 < 150MB）。

## [4.4.0] - 2026-08-19

### 新增（工程治理，Phase 28）

- 新增共享安全工具模块 `src/core/redact.ts`（`redactSensitive` / `SENSITIVE_KEYS`），供 Agent Tool 审计与平台 AuditLog 共用，消除平台层对 agents 域的反向依赖。
- 新增技术债登记 `docs/TECH-DEBT.md`（债务清单 + 阶段趋势，供每阶段维护）。
- 修复脱敏缺陷：字段名归一化分隔符（下划线/连字符），`api_key` 现在也能命中 `X-Api-Key` 等变体。

### 变更

- 配置模块统一：删除与 `env-loader.ts` 重复的 `config/env.ts`；`engine.ts` / `execution-run-tool.ts` 统一从 `env-loader.ts` 导入（TESTFLOW_* 环境变量覆盖单一来源）。
- `engine.ts` 移除冗余的 `applyEnvToConfig` 调用（`loadConfig` 已通过 `loadConfigFromEnv` 合并环境覆盖）。
- `src/agents/tools/tool.ts` 保留 `redactSensitive` / `SENSITIVE_KEYS` 再导出（API 兼容）。

### 移除

- 删除死代码 `src/utils/time.ts`（零引用）。

### 测试

- 新增 `tests/unit/redact.test.ts`（6 项）；全量回归：1426 passed / 18 skipped（121 个测试文件）；`agent:test` 450 通过。

## [4.3.0] - 2026-08-19

### 新增（生产安全加固，Phase 27）

- 新增 `src/platform/security/` 生产安全策略模块（单一权威来源）：运行模式统一解析、生产安全模式判断、不安全 JWT 密钥识别、默认口令策略、静态身份来源开关、Preflight 安全检查项。
- 生产/预发（production/staging）模式强制显式配置**非默认** `JWT_SECRET`：缺失或使用开发默认值 `dev-secret-change-me` 即拒绝装配（fail fast）与启动。
- 生产模式强制禁用默认种子口令（`admin/admin123` 等）与静态 `X-Actor`/`X-Role` 身份伪造（防身份伪造）。
- 运维只读端点 RBAC：`OPS_READ` 权限（ADMIN / RELEASE_MANAGER / SERVICE_ACCOUNT 持有），`/audit`、`/telemetry/cost`、`/jobs`、`/workers` 对无权限角色返回 403。
- 审批职责分离：审批人不能审批自己发起的申请（禁止自提自批）；审批 ID 由 `Math.random()` 改为 `randomUUID`（不可预测）。
- `decodeJwt` 加固：非法结构 / 非法 JSON payload 显式抛错，不静默返回。
- Preflight 新增「安全策略」检查项：运行模式 / JWT 密钥 / 默认口令 / 静态身份来源四合一，生产/预发违规返回 BLOCK。
- CLI `serve` 横幅展示运行模式与生产安全约束；仅非生产模式提示默认账号。

### 变更

- `RBAC` 权限模型新增 `OPS_READ`（影响：VIEWER/QA 访问审计、遥测成本、Job、Worker 端点由 200 变为 403，属预期安全收紧）。
- `server.ts` 新增 `HttpError`（带状态码的业务错误），读端点 RBAC 拒绝返回 403 而非 400。

### 测试

- 新增 `tests/unit/security.test.ts`（17 项）；扩充 `auth`、`approval-center`、`jwt`、`api-auth`、`web-dashboard`、`api-hardening`、`platform-scenarios` 用例。
- 全量回归：1420 passed / 18 skipped（120 个测试文件）。

### 修复

- 修复 package-lock.json 版本残留（3.0.0 → 4.3.0）。

## [4.2.0] - 2026-08-19

### 新增（生产验证闭环，Phase 26）

- 版本溯源与部署验收链（`/api/version`、构建溯源、回滚版本兼容）。
- 50 真实 TestCase 接入平台（`src/platform/test-assets/`）。
- 四形态真实 Run 执行引擎（smoke / sanity / regression / autonomous）。
- 故障恢复演练（S1 Worker Crash / S2 LLM 故障 / S3 存储故障 + 恢复指标）。
- 统一发布门禁（PASS / REVIEW / BLOCK + Agent 防绕过）。
- 备份恢复三一致校验 + 禁止自动重触发。
- 六类可观测告警（Run 失败 / 恢复 / 审批 / 成本 / 队列 / 心跳）。
- 30 Run 生产试运行（KPI + 10 条人工 QA 对照）。

## [4.1.0] - 2026-08-18

### 新增（生产化，Phase 25）

- SQLite / PostgreSQL 持久化与迁移、备份 / 恢复 / 冒烟 / Preflight。
- JWT 认证与用户体系（登录 / 刷新 / 登出 / 作用域）。
- 真实遥测（成本 / RCA / Flaky / Healing / Release）与指标自动激活。
- React Web Dashboard（15+ 页面）。
- API 加固：链路追踪 / 限流 / 统一错误契约 / 分页。

## [4.0.0] - 2026-08-18

### 新增（平台化，Phase 20-24）

- AI Test Platform 平台层（`src/platform`）：Project / Run 状态机 / Scheduler / Worker / RBAC / Approval / EventBus / Notification / HTTP API / 运维指标。
- 多业务接入、测试资产管理、持续回归、知识 / 成本 / 质量优化。
- 智能排序与风险预测、自治回归流水线、统一追踪、发布决策与生产验收。

## [3.5.0] - 2026-08-17

### 新增（Agent 化与能力沉淀，Phase 10-19）

- RCA / Flaky 治理、自愈、缺陷生命周期、审批状态机、可观测性、评估体系。
- 通用断言引擎、数据生成 / Mock 录制回放 / 动态并发、断言可视化。

## [3.4.0] - 2026-08-17

- 数据工厂（`--auto-setup`）+ 环境一致性检测（基线对比 + 断言注入）。

## [3.3.0] - 2026-08-16

- 并发执行：`--concurrency` / `--parallel`，p-limit 并发池，caseId 归档。

## [3.2.0] - 2026-08-16

- 多功能模块化：按功能分子文件夹、loader 递归扫描、迁移脚本分目录。

## [3.0.0] - 2026-08-15

### 破坏性变更

- TypeScript 重构：模块化分层 + 7 钩子 + 断言注册表 + 三格式报告。

## [2.0.0] - 2026-08-15

### 破坏性变更

- 插件式重构：场景处理器、按 scene 路由、模板通用化。

## [1.3.0] - 2026-08-15

- 文档去重合并、代码层重构（素材函数 / 步骤编号）。

## [1.2.0] - 2026-08-15

- 新增「项目说明格式规范」，四场景验证表更新。

## [1.1.0] - 2026-08-15

- 输出归档规则升级为 `output/<日期>/<功能名>/`，脚本支持 `--func`。

## [1.0.0] - 2026-08-12

- 交付包初始化。
