# Phase 21 Readiness 分析报告

> 依据任务书第二十六节，实施前先扫描 Phase 20 最终代码，输出 readiness 清单后从 Phase 21.1 开始。
> 扫描范围：`src/agents/`、`src/core/`、`src/cases/`、`src/plugins/`、`src/reports/`、`src/config/`、
> `src/integrations/`、`tests/`、`bin/run-agent.ts`、`package.json`。

## 1. 当前多业务扩展能力

| 扩展点 | 现状 | 评价 |
|---|---|---|
| feature（用例归属） | ✅ `src/cases/<feature>/` 目录约定，loader 从路径第一级子目录自动推断 | 纯文件系统插件点，零侵入 |
| scene（场景处理器） | ✅ `SceneHandler` 接口 + `autoLoadScenes()` 扫描 `src/plugins/scenes/*.js` 自动注册 | 最成熟的插件点，放入文件即注册 |
| adapter（业务断言） | ❌ `TaskDef.adapter` 硬编码联合类型 `'wan3' \| 'default'`；`runAdapterAssertions` 是硬编码 switch | 无注册表，新业务需改 core |
| 默认断言集 | ❌ `pipeline.ts` 无条件运行 7 个 wan3 专用断言（db-check / billing-check 等） | 对新业务会误报 |
| 环境配置 | ❌ `environments.json` 六个 URL 字段为视频业务定制，`validate()` 强制校验；`status_text` 为视频状态码 | 新业务端点形态不同会校验失败 |
| Agent 推断 | ❌ `testcase-schema.ts` 的 `inferScene` 硬编码 `wan3 → video` | agents 层业务耦合 |
| 数据工厂 / 钩子 | ✅ `registerDataFactory`、`HookRegistry`（8 钩子）已是通用注册机制 | 可复用 |

**既有业务仅 wan3 一个**（AI 视频生成）：9 个 TS 用例 + 4 个遗留 JSON；scene=video（文生/图生/全能参考/首尾帧）。

## 2. 当前 Test DSL 能力

- `TaskDef`：scene / adapter / assert / tags / dataFactory / extra / uploads / manual_cases / onFail
- 断言 DSL：target ∈ {response, submit, billing, headers, env, metrics, custom}，mode = all/any/soft，
  支持嵌套组、重试、超时；操作符库 `assertion-operators.ts`
- Agent 侧 Test DSL：`validateTestCase` / `normalizeTestCase` / `toTaskDef` / `toLoadedCase`，
  生成的用例可直接进入执行引擎
- 用例筛选：`--grep`（tags）/ `--filter`（名称）/ `--scene` 三维 AND

## 3. 当前 Memory 能力

- `TestMemory` 接口：`save / query / getSimilarFailures / querySimilarCase / queryHistoricalRisk /
  queryKnownIssue / queryCoverageGap`；`JsonMemoryStore` 持久化（追加写 + 原子替换）
- 记录类型 12 种：execution / failure / root-cause / environment-change / model-change / api-change /
  flaky / test-data / test-design / manual-confirmation / defect / coverage-gap
- 相似失败检索为朴素关键词打分（非向量）
- **缺口**：`MemoryRecord` 无 confidence / usageCount / lastUsedAt / source / validUntil 知识治理字段；
  无 ACTIVE → STALE → EXPIRED 生命周期；无去重与排序

## 4. 当前 Regression 能力

- `TestSelectionAgent`：确定性选择（P0/P1 全量 + P2/P3 风险/历史/flaky 直选 + 参数覆盖抽样 +
  历史失败提优 + 预算反向裁剪），每条决定带 reasons
- `CoverageAgent`：7 维度覆盖分析 + gaps + recommendedCases
- `FlakyAgent`：分类状态 STABLE / FLAKY / UNSTABLE / BROKEN + quarantine 标记，
  **但未接入 pipeline，无生命周期流转持久化**
- CI 六态：`computeCiResult`（PASS/FAIL/WARNING/BLOCKED/KNOWN_ISSUE/FLAKY），
  knownIssues 为手工传入映射
- **缺口**：无 Regression Scheduler / Planner / Trigger / History；无 Change Impact Analysis；
  无 runId 贯穿（taskId 由需求文本前 20 字符生成，非唯一运行 ID）

## 5. 当前 CLI 能力

- `run-agent.ts` 四模式：A 全流程 / B plan-only / C analyze+rca / D resume；另有 `--ci-status`、
  `--ci`（六态）、预算参数 7 个、LLM 参数 5 个、阶段开关 10 个
- `run-test.ts` 26 参数（task/env/reporter/grep/filter/scene/concurrency/watch/dry-run 等）
- **无 `--suite` 参数**；无 `agent:dashboard` 命令

## 6. 当前 Report 能力

- Reporter 注册表：html / json / junit（可逗号分隔多选）；另有 allure 结果、OSS 上传
- Agent KPI Dashboard：`output/<date>/agent-summary.json`（需求/用例/执行/分析/覆盖/可观测六段 KPI）
- 输出结构：`output/<日期>/<func>/`，并发按 caseId 隔离

## 7. 当前 CI/CD 能力

- 4 个 GitHub Actions 工作流：test.yml（传统回归）、agent-test.yml（P0/P1 门禁 + P2/P3 Nightly +
  六态门禁脚本）、security.yml（audit/SAST/secrets/trivy/license）、release.yml（安全门禁 → 镜像 → 部署 → 通知）
- 另有 `.gitlab-ci.yml`、Dockerfile / docker-compose

## 8. Phase 21 已存在能力（可直接复用，禁止重建）

| Phase 21 目标 | 已有基础 |
|---|---|
| Multi-Business | SceneHandler 自动注册机制（可作 business registry 范本）、feature 目录约定 |
| Test Asset Management | TestMemory 12 种记录类型、TestCase schema、任务记录（output/tasks） |
| Continuous Regression | TestSelectionAgent、CoverageAgent、CI 六态、Nightly 工作流 |
| Defect Lifecycle | IssueTracker 抽象 + 5 适配器 + 三重门禁、DefectDraft、Approval |
| Knowledge Optimization | TestMemory 查询接口、memory-bridge 历史风险注入 |
| Cost Optimization | AgentTracer（token/cost 字段）、AgentBudget、estimateCost |
| Quality Optimization | eval 五维评分、coverage 7 维、flaky 分类、六态结论 |
| Production Operations | agent-summary.json Dashboard、preflight、health |
| Release Gate | CI 六态 + P0 阻断规则（computeCiResult） |
| Model Evaluation | eval 三档（Offline/Real LLM/Real API）+ ModelRouter |

## 9. 缺失模块（Phase 21 需新增）

| 缺失项 | 归属子阶段 |
|---|---|
| `src/business/`（registry / schema / loader / adapters + 6 业务定义） | 21.1 |
| `src/test-assets/`（统一资产模型 + 版本/归档/关联/影响追踪链） | 21.2 |
| Change Impact Analysis + Impact Graph（变更 → 受影响功能/场景/用例/风险） | 21.2/21.3 |
| Test Reuse Engine（相似资产检索 + Gap 分析 + 只生成缺少用例） | 21.2 |
| `src/regression/`（Scheduler / Planner / Trigger / History） | 21.3 |
| 统一 Test Run ID（runId 贯穿 case/execution/trace/defect/knowledge） | 21.3 |
| Defect 状态机（DRAFT→…→VERIFIED + Known Issue / Duplicate 判定） | 21.4 |
| 知识治理字段与生命周期（confidence / usageCount / validUntil / ACTIVE→STALE→EXPIRED） | 21.5 |
| 知识参与决策（历史失败率 → 风险权重 / 执行优先级） | 21.5 |
| 成本数据通路（recordLLM/addLLMCall 当前无任何调用方，token/cost 实测恒 0） | 21.6 |
| 成本优化器（Cost/Case、最小成本测试集合） | 21.6 |
| Test Quality Score / Feature Quality Score + 趋势 | 21.7 |
| Flaky Lifecycle（SUSPECTED→QUARANTINED→FIXED→STABLE 流转与自动恢复） | 21.7 |
| Suite 策略（smoke/sanity/regression/release/… + `--suite`） | 21.7/21.8 |
| Model Evaluation 横向对比模式 | 21.8 |
| Release Gate（P0/P1/Coverage/Critical Defect 门禁） | 21.8 |
| `npm run agent:dashboard`（统一运维视图） | 21.8 |

## 10. 重复实现风险（明确禁止）

| 风险 | 规避方式 |
|---|---|
| 重建 adapter switch | 建立 adapter 注册表时复用既有 `registerAssertion` 断言注册表 |
| 重建 Memory | 知识治理在 `MemoryRecord` 上扩展字段，不新建存储 |
| 重建回归选择 | Regression Planner 复用 `TestSelectionAgent` / `selectTestCases` |
| 重建 Known Issue 判定 | 复用 `ci-result.ts` 的 knownIssues 归一化，与 issue-tracker/memory 打通 |
| 重建 Flaky 分类 | 复用 `classifyStatus` / `flakinessIndex`，只加生命周期流转 |
| 重建 Dashboard | 运维视图聚合既有 `buildAgentDashboard` + health + eval 数据 |
| 重建六态门禁 | Release Gate 基于 `computeCiResult` 扩展，不另起判定逻辑 |

## 11. Breaking Change 风险

| 风险点 | 影响 | 缓解 |
|---|---|---|
| `TaskDef.adapter` 由 `'wan3'\|'default'` 放宽为 `string` | 类型使用点需检查 | 放宽为 string 是向后兼容超集，既有值不变 |
| `pipeline.ts` 无条件运行 wan3 默认断言改为按业务路由 | wan3 用例行为必须不变 | wan3 业务注册时保留原默认断言集，行为对齐后再切换 |
| `environments.json` validate() 强制 6 URL 字段 | 新业务配置形态不同 | 校验规则按业务定义分级，wan3 保持原校验 |
| `inferScene` 硬编码替换 | Agent 用例生成 scene/adapter 推断 | 改为查询 business registry，wan3 映射结果不变 |
| `MemoryRecord` 字段扩展 | 旧 memory JSON 文件兼容 | 新字段全部可选，读取时补默认值 |
| runId 引入 | 既有 taskId 语义 | runId 作为新增字段并存，不替换 taskId |

## 12. 结论

Phase 20 基线完整：单轮流水线、确定性兜底、审批门禁、观测/预算骨架、CI 六态、IssueTracker、
TestMemory 均已就绪。Phase 21 缺口集中在「规模化基础设施」：业务注册中心、测试资产体系、
影响分析、持续回归编排、缺陷/知识/Flaky 生命周期、成本数据通路与统一 runId。

按任务书顺序从 **Phase 21.1 Multi-Business（业务注册中心）** 开始：新增 `src/business/`，
注册 wan3 + image-generation / chat / music / digital-human / workflow 六个业务，
新增业务仅通过 Business Definition + Adapter 接入，不修改 core / pipeline / assertion。
