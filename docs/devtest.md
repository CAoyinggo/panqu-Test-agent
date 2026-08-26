# DevTest Mode：需求驱动·开发者自助测试

DevTest 是开发者入口，不是新的执行引擎。它把现有 Requirement Parser、Fact
Ledger、Objective/Scenario、Contract Resolver、API Binding、Scenario Runner、
Processor、Assertion、Evidence 和 Acceptance Report 组织成一条可审计的自测链。

```text
Requirement
  → Requirement Model（EXPLICIT / DERIVED / UNKNOWN）
  → Feature Model（Actor/Resource/Operation/UI/State/Constraint/Side Effect）
  → Route/Controller/OpenAPI/Frontend/UI 只读发现
  → Acceptance dry-run / Contract Preflight
  → Requirement + Risk + Contract 五维适用性
  → Test Value Score 风险优先选择（默认最多 20）
  → 同一 Acceptance Execution Plan 的授权子集
  → Executable Test Contract / SAFE Runner / Evidence Plan
  → UI/API/State Evidence → Deterministic Oracle
  → Acceptance Trace / Six-class Issue Classification
  → Problem Confirmation / Root Cause Cluster / Minimal Reproduction
  → Business Flow / State Consistency / Cross-Case Invariant
  → Regression Guard / Baseline / Version Comparison / Dev Confidence
  → READY / NOT_READY / BLOCKED
  → Deterministic Oracle / Adaptive Selection / Reliability
  → Report v8 + Acceptance Summary 固定五类产物
```

## 使用

最小命令：

```bash
npm run devtest -- requirements/new-feature.md

# 修复后优先复测上一轮失败、阻断和受影响 Case
npm run devtest -- requirements/new-feature.md --rerun

# 只检查环境与当前可执行能力
npm run devtest -- requirements/new-feature.md --preflight

# 只生成测试计划，不执行业务请求、不覆盖 Baseline
npm run devtest -- requirements/new-feature.md --plan

# 定向复现和复测
npm run devtest -- requirements/new-feature.md --repro P001
npm run devtest -- requirements/new-feature.md --rerun P001
npm run devtest -- requirements/new-feature.md --rerun failed
npm run devtest -- requirements/new-feature.md --rerun blocked
npm run devtest -- requirements/new-feature.md --rerun regression

# 完整最终验收
npm run devtest -- requirements/new-feature.md --final

# 默认 P0/Critical 失败即停；只读无共享状态 Case 最多 4 并发
npm run devtest -- requirements/new-feature.md --final --concurrency 4

# 调试时关闭 fail-fast，并限制单请求、总运行时间和估算成本
npm run devtest -- requirements/new-feature.md --final --no-fail-fast \
  --timeout 10000 --max-runtime 120000 --budget 30

# 终端只看一页结论；日常默认 Tier 0 + Tier 1，--deep 才执行 Tier 2
npm run devtest -- requirements/new-feature.md --summary
npm run devtest -- requirements/new-feature.md --deep
```

常用参数：

```bash
npm run devtest -- requirements/new-feature.md \
  --env test \
  --mode safe \
  --base-url https://test.example.com \
  --output ./devtest-results \
  --max-cases 20
```

可用 `--no-ui`、`--no-api`、`--no-data-isolation`、
`--no-parameter-validation` 显式关闭维度。关闭决定会进入报告，不会静默丢失。
源码发现默认以当前目录为项目根；可用 `--project-root` 指向实际项目。发现结果只有在
Route/Controller/OpenAPI 等权威来源精确或高置信映射时才进入 Contract 附录；前端请求
只能作为候选，无法唯一映射时保持 UNKNOWN。

## 高价值选择

每个 canonical Acceptance Case 都会得到 0~100 的 Test Value Score，包含 Risk、
Business Impact、Likelihood、Detectability、Execution Cost。选择顺序先保证适用维度
覆盖，再优先 P0/P1 的高风险、可安全执行、低成本场景。分数与选择原因进入 JSON/CSV，
不会为了达到数量生成无追溯 Case。

执行前会按 Requirement、Action、Input、Expected、Contract 计算 Case 相似度，重复项只
保留信息量最高、风险最高且执行成本最低的一条。随后自动识别 Happy Path、Core
Validation、Authorization、Persistence、Data Isolation 五类核心 Case。只有所有适用的
核心 Case 都有真实执行、有效断言和 Evidence，最终结论才可能是 `READY`。

`--plan` 会输出 Feature、Risk、五维适用性、预计 Case/执行/BLOCKED 数、核心 Case、
副作用、去重结果、Git 影响范围与缓存状态。

## 五维测试

| 维度 | 生成依据 | Fail-closed 边界 |
| --- | --- | --- |
| API | 权威 Method + Path、认证/授权、Request/Response | Contract/Binding 不可靠时 BLOCKED |
| FUNCTIONAL | Requirement 业务行为、状态和副作用 | 不能只用 HTTP 200 证明业务成立 |
| UI | Requirement 明确的页面、组件和交互 | 无 Browser Processor 时 NOT_EXECUTED |
| DATA_ISOLATION | User/Tenant/Project/Role/Resource | 无独立后置状态证据时 BLOCKED |
| PARAMETER_VALIDATION | required/null/type/enum/format/min/max/length | 只保留高信息量确定性边界 |

`dimensionApplicability` 会记录每一维为何 REQUIRED、RECOMMENDED、OPTIONAL 或
NOT_APPLICABLE。DevTest 不为凑齐五维而猜测需求。

五维不是固定模板。仅当 Requirement、Risk 或提取出的业务不变量明确要求时，计划才会
标记 `IDEMPOTENCY / STATE_MACHINE / BILLING / PROVIDER / AUDIT` 扩展维度；否则明确记录
`NOT_APPLICABLE`，不会为增加 Case 数量而生成。

## Requirement Coverage 与业务不变量

Report v8 把每条 AC 展开为 `Actor / Action / Input / Expected Response / Expected State /
Expected Side Effect`，并形成 Requirement Coverage Matrix。状态分为 `COVERED /
UNCOVERED / AMBIGUOUS / BLOCKED`，所有核心 AC 都进入覆盖率分母。

如果需求声明“403 后数据不能修改”但 Case 只有状态码断言，系统会生成
`MISSING_POST_STATE_ASSERTION`，补充 Non-Mutation 设计断言并保持 BLOCKED，直到独立状态
证据可用。余额非负、Tenant 隔离、失败不扣费、幂等创建、删除后不可访问、状态迁移和审计
等规则会被提取为跨 Case Invariant。

## SAFE 规则

默认 `SAFE`，只读请求可直接进入执行门禁；任何 POST/PUT/PATCH/DELETE（包括预期 4xx 的
负向探针）都不能因为“理论上会被拒绝”而绕过 Mutation Guard。写路径默认挂起；只有本机 Sandbox、隔离测试租户、Cleanup/Rollback
等条件满足时才具备放行资格。以下类型默认在 HTTP/Data Prepare 前阻断：

- production 或未知环境；
- UNKNOWN / CONFLICT / STALE / EXPIRED / CONTRACT_DRIFT；
- 真实扣费、充值、Provider 生成、发布、消息、正式删除；
- 缺少 Processor、Assertion、Evidence、Actor、Origin 或 Cleanup；
- `LIVE` 未提供可审计 Approval。

普通写路径即使传入 `--confirm-mutations` 也不会单独放行；SAFE 还要求显式
`--sandbox`，或由调用方注入真实 Cleanup/Rollback。DELETE、Billing、Provider 仍默认阻断。

`--mode dry-run` 只规划和生成报告，零 HTTP 请求。`BLOCKED/NOT_EXECUTED` 永远
不能被其他 PASS 数量平均为 READY。

## Environment Preflight

每次运行先检查 Base URL、Health、API、Authentication、Browser 与 Database。
候选来源依次为开发者显式 `--base-url`、专用环境变量、项目测试配置和本机
`127.0.0.1/localhost`。只有一个候选可访问时才自动选择；多个可访问候选会输出
`AMBIGUOUS_ENVIRONMENT`，要求开发者显式选择。Preflight 只使用 GET/HEAD 探针，
不会为了探测环境触发写入、删除、扣费或 Provider。

## Feature Result

- `READY`：全部适用核心 Case 真实执行并 PASS，Required Evidence 完整，无关键 Unknown。
- `NOT_READY`：存在真实执行、明确断言和 Evidence 确认的产品缺陷。
- `BLOCKED`：核心能力无法真实验证，或全部 P0 均没有可信执行证据。

对外失败分类固定为 `PRODUCT_BUG / REQUIREMENT_GAP / TEST_DESIGN_ERROR /
ENVIRONMENT_ERROR / EXECUTION_ERROR / NOT_TESTED`；内部仍保留 `CONFIRMED_BUG / LIKELY_BUG`
等证据置信度。Confidence 由 Execution、Assertion、Evidence、Contract、
Environment、Reproducibility 六项自动校准。HTTP 500、Timeout、Environment Error 和
BLOCKED 不会单独构成产品 Bug。

首次有 Requirement + Contract + Execution + Assertion + Evidence 的异常仍只标记
`LIKELY_BUG`；只有 `--repro P001` 再次稳定复现，Reproducibility 证据完整后才升级为
`CONFIRMED_BUG`。相同根因的失败合并为一个 Problem，并列出所有 Affected Cases 和结构化
Minimal Reproduction。

`Dev Confidence (0~100)` 由 Core AC、执行、证据、问题可信度、Unknown 和 Blocked P0
计算。它只解释结论，不能覆盖 Fail-Closed：存在关键阻断时，即使分数高也不能 READY。

五类报告始终先完整落盘。CLI 退出码同样 fail-closed：只有 `READY` 返回 `0`；
`NOT_READY`、`BLOCKED` 返回 `1`；输入或配置错误返回 `2`。`--preflight` 在环境
READY/PARTIAL 时返回 `0`，环境 BLOCKED 时返回 `1`。

## 固定产物

每次运行只在 `devtest-results/<runId>/`（或 `--output`）生成：

```text
report.html
report.json
cases.csv
problems.md
acceptance-summary.md
```

`report.json` 使用 `devtest.report.v8`，固定包含 run、feature model、summary、Requirement
Coverage Matrix、Invariant、五维与动态维度、discovery、contracts、cases、problems、
Business Flow Graph、State Consistency、Regression Guard、execution estimate、dataLifecycle、
versionComparison、unknowns、baseline，以及逐 Case 的 `acceptanceTraces`、`requirementModel`
和 `deliveryCoverage`。`cases.csv` 包含 expected/actual/problemId/confidence/
contract/executed/evidence/valueScore，可直接筛选。`problems.md` 按根因去重，包含严重度、
可信度、开发者分类、复现、预期、实际、Evidence 和建议。

`acceptance-summary.md` 是面向开发者的短结论，只保留最终结果、核心需求、业务流程、
不变量、回归守卫、Top Risks 和下一步动作；详细 Evidence 与 Contract 留在分层报告中。

每次运行会在输出根目录维护同一 Requirement 的 baseline。`--rerun` 只执行上一轮
FAIL、BLOCKED、NOT_EXECUTED、Problem 受影响 Case 与 Contract Fingerprint 变化的 Case，
不再在无目标时回退执行全量。报告显示 NEW、FIXED、STILL FAIL、REGRESSION、
NEWLY BLOCKED、UNCHANGED。

问题 ID 跨运行保持稳定，生命周期为 `OPEN / REPRODUCED / FIXED / STILL_FAIL /
WONT_FIX / BLOCKED`。`--repro P001` 只选择该问题在 Baseline 中关联的原始 Case，输出
`REPRODUCED / NOT_REPRODUCED / BLOCKED`；不会执行其他 Case。

相同 Requirement 的 Feature Model、Contract/Scenario 指纹和选择结果缓存在输出目录的
`.devtest-cache` 中。Requirement、Contract 或 Git Code 指纹变化时自动失效。只有存在
Baseline 且全部 Git 变化都能可靠映射到已发现 API/UI 时，影响分析才缩小执行范围；否则
保持完整核心计划，避免为提速造成漏测。

报告首页只优先显示 Feature Result、Dev Confidence、Core AC Coverage、Executed、
Confirmed/Likely Bugs、Blocked/Unknown 和 Top 5 Problems；五维覆盖在第二层，Case、Evidence、
Contract、Technical Details 在第三层。覆盖率分开计算
Requirement Coverage、Executable Coverage、Evidence Coverage。每个未测项都给出原因、
影响与解除条件，因此“没测”不会显示成“通过”。覆盖账本固定区分 `GENERATED / EXECUTED /
VERIFIED / NOT_TESTED`；Fact 只有在每个关联义务都有 Fact-aware Assertion、真实执行和完整
Oracle Evidence 时才进入 VERIFIED。

执行计划把互不依赖的 GET/HEAD/OPTIONS Case 并发运行；共享用户、Tenant、Resource、状态机
或任何写操作自动串行。每个 Case Run 记录 Prepare → Execute → Observe → Cleanup 生命周期，
Cleanup 失败产生 `CLEANUP_FAILED`，不能静默通过。

## Feature Acceptance 与回归守卫

DevTest 会从 Operation、资源、输出、输入与状态依赖构建 Business Flow Graph。每一步复用
对应 Case 的真实 Request/Response Evidence；上一步输出没有进入下一步输入、状态迁移错误，
或 Response 与 Database/Task/Billing/Audit/Resource Observer 不一致时，即使单接口全部 PASS，
Feature 仍会产生 `FEATURE_BUG` 或 `DATA_CONSISTENCY_BUG` 并判为 `NOT_READY`。

Invariant 在所有关联入口聚合判定，任何一个入口违反都会生成 `BUSINESS_RULE_BUG`。修复问题后
`--rerun P001` 不只运行原失败 Case，还会扩展到同 Contract、Invariant 与 Business Flow 的
相关 Case；相关路径出现新失败时生成 `REGRESSION_BUG`，Regression Guard 不通过。

最终门禁要求核心 Requirement、核心 Flow、Invariant、State Consistency、Regression Guard 与
Evidence 全部可信。预算或预计总时长超限会在业务请求前以 `BLOCKED` 结束；Confidence 不能覆盖
任何 fail-closed 门禁。

## 确定性 Oracle 与 Bug 去噪

最终 PASS/FAIL 只由 Requirement、Contract、Invariant、Observed State、Historical Baseline 与
canonical Assertion 组成的确定性 Oracle 决定。解释模型可以说明原因，但不参与 verdict。
只有真实执行、明确 Expected、可比较 Actual 和完整 Evidence 才能确认产品问题。HTTP 5xx、
Timeout、空响应、Browser Error 会先归因 Environment、Contract、Auth、Test Data 或 Processor，
证据不足时保持 UNKNOWN/LIKELY，不能直接生成 Confirmed Bug。

失败响应还会通过 Case Snapshot Observer 比较 DB、Task、Billing、Audit、Queue、Provider 与
Resource。失败请求产生隐藏扣费或任务时生成 CRITICAL `DATA_CONSISTENCY_BUG`；Case Cleanup 后
仍有状态残留则生成 `TEST_POLLUTION`，不会误报产品缺陷。

## 自适应选择与可靠性

Adaptive Test Score 合并 Test Value、历史失败、Bug 密度、代码变化、Contract Drift、近期回归
和执行成本。默认运行 Tier 0（Smoke/Core）与 Tier 1（High Risk）；Tier 2 边界矩阵仅在 `--deep`
时执行。重复提交、Replay、并发写仅在需求风险相关时纳入，缺少 Sandbox/Cleanup 或实体与副作用
Observer 时保持 BLOCKED。

Baseline 最多保存每个 Case 最近 20 次状态和耗时，并计算 passRate、failureRate、flakeRate、
avgDuration 与 STABLE/FLAKY/UNSTABLE。Baseline 只持久化 Oracle 完整的权威 PASS/FAIL；旧的原始
PASS 或 Evidence 不完整 PASS 不能触发 FIXED、REGRESSION、REOPENED。Flaky Case 进入 Test
Reliability，不归因产品 Bug，也不能把当前失败提升为 READY；已复现问题的定向修复 Case 在完整
Oracle PASS 后进入新的修复验证 epoch。Requirement Quality 与 Testability 独立评分；低于
60 会提示澄清，但不会阻断其他已有确定性 Oracle 的 Case。

Problem 使用稳定 Root Cause 身份关联 Contract、Scenario、Business Flow 和 Case。已 FIXED 的同一
根因再次出现时复用原 Problem ID 并标记 REOPENED。首页按 Severity × Confidence × Business
Impact × Reproducibility 的收益分数只突出 Top 5。

## 常见 BLOCKED

| 原因 | 解除方式 |
| --- | --- |
| `UNKNOWN_CONTRACT` | 发布带版本、Fingerprint 和来源的权威 Contract |
| `CONTRACT_DRIFT` | 审核漂移并重新生成 Execution Plan |
| `PROCESSOR_MISSING` | 注册支持 canonical operation/scene 的 Processor |
| `EVIDENCE_MISSING` | 接入 State/Database/Task/Billing/Browser Observer |
| `SAFE_MODE_MUTATION_HOLD` | 使用 Sandbox/Fixture，并配置 Cleanup/Rollback |
| `LIVE_APPROVAL_REQUIRED` | 提供 Approval、预算和回滚方案 |

DevTest 的业务结论不要求一定 READY。缺少可靠 Contract 或 Observer 时，正确结果
就是 BLOCKED，而不是猜测或假通过。
