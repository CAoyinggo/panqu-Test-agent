# 开发验收测试执行流程 SOP

> 版本：v3.0 | 更新：2026-08-23 | 维护：AI 测试智能体
> **适用范围：需求驱动的开发验收测试**，不绑定特定产品、模型或业务。
> 规范资产：[通用 Scenario 模板](../tests/acceptance/templates/scenario.md) + [Pattern Library](../tests/acceptance/patterns/) + [TestCase V2 字段规范](testing/testcase-v2-schema.md)。
> 历史 `tasks/*.json`、旧 `run-test` 场景处理器和 TypeScript 内嵌 Markdown 仅为 **LEGACY** 兼容资产；保留它们不代表已经迁移到 canonical Scenario 主链。

开发者进行需求级初步自测时，统一入口为：

```bash
npm run devtest -- requirements/new-feature.md
```

该命令仍执行本文的 Requirement、Contract、Scenario、Policy、Assertion 和 Evidence
门禁，只增加五维选择、SAFE 默认策略、根因问题聚合和固定报告适配。详细说明见
[DevTest Mode](devtest.md)。

---

## ⚠ 强制要求

1. **设计完成不等于执行完成**。测试设计、质量评分、生成报告均不能证明被测操作已经执行。
2. 流程顺序不可跳过：`启动清单 → 需求/冲突解析 → Pattern 与 Scenario 设计 → Scenario Gate → Policy Gate → Prepare → Execution → Assertion/Evidence → Outcome → Cleanup/Report`。
3. 新场景以 canonical Scenario 为唯一设计和执行契约；`tasks/<任务名>.json` 只允许走显式标记的 LEGACY 兼容入口，不能被宣称为已迁移。
4. **Scenario Gate 与 Policy Gate 必须在 Prepare 和任何真实副作用之前**。Gate 未通过时不得创建数据、调用业务 Processor、调用外部 Provider 或扣费。
5. 设计阶段只允许 `EXECUTABLE`、`DESIGNED_ONLY`、`BLOCKED`；运行结果只允许 `PASS`、`FAIL`、`BLOCKED`、`NOT_EXECUTED`、`TIMEOUT`、`CANCELLED`。
6. `PASS` 的必要且充分执行条件为：`executed=true`、`processorInvoked=true`、至少一个有效断言且全部通过、所有 required evidence 完整并验证成功。无 Processor、Processor 未调用、零断言或缺证据一律不得 `PASS`。
7. 启动清单未经确认，不进入真实执行阶段；歧义、未知策略或依赖缺失一律 fail-close。
8. **素材来源**：上传文件优先从受控测试素材库 `/Users/mac/agents/Test-panqu/` 取用；Scenario 只保存数据引用，并记录 owner、tenant、project、敏感性和 cleanup hook。
9. **输出位置（强制）**：常规验收交付物按 `output/<YYYY-MM-DD>/<功能名>/` 存放；DevTest 固定写入 `devtest-results/<runId>/` 或 `--output` 指定目录。输出目录或 HTML 生成成功不等于测试 `PASS`。

---

## 0. 流程总览

```
[0 启动清单] → [1 需求/冲突解析] → [2 Pattern + Scenario 设计]
→ [3 Scenario Gate] → [4 Policy Gate] → [5 Prepare]
→ [6 Processor/Tool 执行] → [7 Assertion + Evidence]
→ [8 确定性 Outcome] → [9 Cleanup + Report]
```

| 步骤 | 动作 | 负责人 | 产出物 | 检查点 |
|---|---|---|---|---|
| 0 | 新任务启动 | 测试负责人+需求方 | 启动清单 | 环境、风险、数据与执行意图明确 |
| 1 | 需求/冲突解析 | Parser+评审人 | Requirement IR / Fact Ledger | AC 可判定；互斥事实先消歧 |
| 2 | Pattern 与 Scenario 设计 | Test Design | canonical Scenario | AC、Operation、Assertion、Evidence 可追溯 |
| 3 | Scenario Gate | Gate | 可执行性决定 + typed Blocked Reason | Processor、绑定、断言、证据、hook 完整 |
| 4 | Policy Gate | Policy+审批人 | 允许/拒绝决定 | 环境、权限、真实副作用、计费与审批合规 |
| 5 | Prepare | allowlist hook | 隔离测试数据 + before-state | 使用同一 execution context，且可清理 |
| 6 | 实际执行 | Runner+Processor/Tool | OperationResult | 每个 Step 实际调用、可取消、可追踪 |
| 7 | 断言与证据 | Assertion/Evidence Provider | 断言计数 + Evidence Envelope | 响应、状态、副作用分别有 oracle |
| 8 | 确定性结果 | Outcome | 六态 ScenarioResult | 未执行或证据不足不能 `PASS` |
| 9 | Cleanup 与报告 | Runner+Reporter | 清理结果 + 报告 | Cleanup 用 finally；报告忠实呈现执行事实 |

---

## 1. 新任务启动（所有任务强制门槛）

每个新任务开始前，必须先完成启动检查。表单见[新任务启动检查清单模板](04-新任务启动检查清单模板.md)，Scenario 字段见[通用 Scenario 模板](../tests/acceptance/templates/scenario.md)。

我按模板输出启动清单，包含：

| 清单项 | 说明 |
|---|---|
| 任务名 | 本次任务标识 |
| 场景类型 | 业务域、业务意图、Channel（API/UI/DATA/QUEUE/PROVIDER） |
| Actor/Scope | 角色、用户、tenant、project、目标资源及 owner |
| 所需数据 | 凭据引用、fixture/素材引用、before-state、可清理性 |
| 测试参数 | API 契约、业务参数、边界、状态与计费规则 |
| 关注点 | 本次重点验证的内容 |
| 风险与策略 | 环境、副作用、Provider、扣费、权限与审批要求 |
| 执行能力 | 可用 Processor、Evidence Provider、Prepare/Cleanup hook；缺失项标记 `DESIGNED_ONLY/BLOCKED` |

**规则**：启动清单逐项确认后才进入需求解析；是否允许真实执行仍须由后续 Scenario Gate 和 Policy Gate 独立决定。

---

## 2. 需求输入

你按固定格式提供本次测试需求，含以下字段（缺省项标注"无"）：

```
任务名/来源：
业务意图：
Acceptance Criteria：
Actor / Role：
Tenant / Project / Resource Owner：
API 或其他 Operation 契约：
前置状态与测试数据：
预期响应 / 状态 / 副作用：
权限、隔离、计费、Provider 等风险约束：
执行环境与是否允许真实副作用：
```

**约定**：输入先进入 Requirement Parser / Fact Ledger。缺失字段可形成 warning；互斥 Method/Path、权限、状态、计费或副作用事实必须标记冲突并阻断，不能由 LLM 猜测一个版本继续执行。

---

## 3. Pattern 驱动的 Scenario 设计

### 3.1 Pattern 不是固定四分类

测试资源按需求结构化事实和风险选择，而不是平均分给“功能/接口/计费/隔离”四类。当前可直接复用的 Pattern Library 包含：

`PERSISTENCE`、`NON_MUTATION`、`IDEMPOTENCY`、`AUTHORIZATION`、`TENANT_ISOLATION`、`ATOMICITY`、`STATE_MACHINE`、`BILLING`、`PROVIDER_FAILURE`、`CALLBACK`、`BOUNDARY`、`AUDIT`。

`FUNCTIONAL`、`API`、`UI`、`PARAMETER`、`PROJECT_ISOLATION`、`ASYNC`、`SECURITY` 等仍可由 Test Type/Aspect 动态选择，但在对应 Pattern 资产实际存在前，不得声称已通过 Pattern proof obligation。Pattern 的来源和 required proof obligation 以 [Pattern Library](../tests/acceptance/patterns/) 与 Registry 实际内容为准。选择 Pattern 后，必须补齐对应的 Actor/Scope、前后状态、响应、副作用、断言和证据；只填写 Pattern 名称不算覆盖。

### 3.2 canonical Scenario 规范

复制 [`tests/acceptance/templates/scenario.md`](../tests/acceptance/templates/scenario.md) 到：

```text
tests/acceptance/scenarios/<domain>/<scenario-id>/requirement.md
```

每条 Scenario 至少包含：

- 唯一 Scenario ID、需求来源、明确 AC 和优先级；
- Patterns，以及每个 Pattern 对应的 proof obligation；
- Actor、Role、Authentication Reference、Tenant、Project、Resource Owner；
- Preconditions、Test Data、Risk、Dependencies；
- 一个或多个原子 Operation，每个都有 Step ID、Channel、Processor、AC 和 Evidence 引用；
- 结构化 Assertion：`channel + target + operator + expected/expectedFrom`；
- required Evidence、Prepare/Cleanup hook、Execution Mode、typed Blocked Reason。

API Operation 必须精确绑定 `Method + Path`。多 API 场景通过 `Capture` 将前一步输出显式传给后一步；不得依赖接口顺序、相似描述或隐式全局变量完成绑定。

### 3.3 设计态限制

Scenario 作者只能声明：

| 设计态 | 用法 |
| --- | --- |
| `EXECUTABLE` | 设计契约完整，仍需在本次运行通过 Gate/Policy |
| `DESIGNED_ONLY` | 设计完成，但 Processor、环境或 evidence capability 尚未具备 |
| `BLOCKED` | 已知冲突、策略或依赖明确阻断，并附 typed Blocked Reason |

不得在 Markdown 中预填 `PASS` / `FAIL`，也不得把“可生成报告”“可人工操作”或“质量评分达标”写成执行结论。更完整的状态、断言和证据规范见[TestCase V2 字段规范](testing/testcase-v2-schema.md)。

---

## 4. 代码核对

功能提测后，我可以直接查看代码确认实现：

1. **接口路径核对**：从后端 Controller 确认本次涉及的接口与参数结构（示例：视频类 `Videonew.php` 的 `add` 方法、`PointsService.php` 的计费逻辑；**此处需根据实际业务调整**）。
2. **参数结构核对**：确认提交参数命名（示例：`row[extra][cueword]`）、任务类型常量（示例：`Ai.php` 中 `WANXIANG3_TYPE_UNIVERSAL=105`；**此处需根据实际业务调整**）。
3. **计费规则核对**：从计费配置确认单价、分辨率档位、比例档位。
4. **状态流转核对**：从消费端代码确认任务状态机与错误处理。
5. **Processor 核对**：确认每个 Operation 的 Channel、Method/Path 或 Tool binding 被对应 Processor 显式支持；注册表中有同名 Processor 不等于已执行。
6. **观察能力核对**：确认响应、after-state、Non-Mutation、账单、事件或审计证据有独立 Evidence Provider。
7. **用例更新**：若代码实现与需求预期不一致，记录差异并回到 Requirement/AC 消歧；不得静默修改 oracle 去适配实现。

---

## 5. 数据隔离分析

### 5.1 分析维度

对本次功能做**表/模块级影响分析**，输出影响清单：

| 维度 | 说明 | 示例（{业务模块}，wan3 仅作演示） |
|---|---|---|
| 涉及数据表 | 本次操作会写入/读取哪些表 | 示例（wan3 视频生成，仅演示）：`pq_videonew`（任务）、`pq_aivideo_task_log`（日志）、`pq_aivideo_task_status`（状态）、账单流水表；**其他业务需根据实际库表调整** |
| 涉及功能模块 | 会影响哪些页面/功能 | 视频制作页、任务列表、个人账单、模型列表 |
| 数据写入 | 新增/修改哪些数据 | 新增任务记录、写入输入内容与参数、积分扣减流水 |
| 数据读取 | 会读取哪些数据 | 模型配置、用户积分余额、任务状态 |
| 对其他账号影响 | 是否会串账号/串项目 | 需确认 project_id 隔离、用户级积分隔离 |
| 对其他环境影响 | 是否影响 test/preonline 其他环境 | 环境配置隔离 |

### 5.2 影响核验清单

以下项目只有在对应 Operation、Processor、Assertion 和 Evidence Provider 已接通时才能标记“自动核验”；否则应在 Scenario Gate 阶段标记 `DESIGNED_ONLY/BLOCKED`，运行时标记 `NOT_EXECUTED`，不能仅凭报告骨架判定：

- **积分扣费/回退**：提交扣费、失败回退，净消耗是否正确
- **账单统计**：`summary` / `modelTrend` / `modelTop` / `records` 是否正确反映本次消耗
- **任务状态**：状态流转是否符合预期（待处理→处理中→完成/失败）
- **数据正确性**：落库字段（model_id、任务类型、参数）是否正确
- **拒绝路径无变更**：保存 before-state，并证明 after-state、实体数、账单和外部调用均未发生禁止变化
- **跨范围无污染**：分别核对 Actor、Resource Owner、Tenant 与 Project，不只验证响应错误码

---

## 6. 数据需求清单

执行前生成**数据需求清单**，标记每项数据来源：

| 数据项 | 来源 | 说明 |
|---|---|---|
| Actor / Authentication | 运行时 credential reference | Scenario 不保存 Cookie、Token 或密码明文 |
| Tenant / Project / Resource Owner | 需求与受控配置 | 权限/隔离场景必须明确，不得从登录态隐式猜测 |
| API / Tool 输入 | Requirement / fixture / prepare output | 明确类型、边界、敏感性和 AC 来源 |
| 素材或长文本 | 受控 fixture/素材库引用 | Processor 确认支持后才加载，不在 Markdown 嵌入 Secret |
| Before-state | 独立状态探针 | Persistence、Non-Mutation、Atomicity、Billing 等 Pattern 使用 |
| 动态资源 ID | Prepare 或前序 Operation Capture | 通过同一 execution context 传递 |
| Cleanup 信息 | allowlist cleanup hook | 标记 owner、run ID、删除/恢复验证方式 |
| Evidence access | DB/API/Queue/Provider/Audit Probe | 权限最小化，只开放 Pattern 所需观察范围 |

除上表外，Scenario Test Data 必须记录：Actor、Tenant、Project、Resource Owner、数据来源、是否可变、是否敏感和 cleanup hook。认证信息只保留 credential reference，真实 Secret 由运行时安全配置解析。

Prepare 创建的数据、Operation 使用的数据与 Cleanup 删除的数据必须来自同一个 execution context，并以 run ID 关联。Prepare/Cleanup 只允许引用 allowlist handler；禁止从 Markdown 执行任意脚本。Cleanup 必须采用 `finally` 语义，失败时单独报告，不能覆盖原始执行结果。

**约定**：可复用数据仍须通过本次 Gate；缺少 owner、scope、Processor 支持或 cleanup 能力时不得自动加载。素材库只是数据来源，不构成真实执行许可。

---

## 7. 脚本执行

### 7.1 当前 Requirement 驱动入口

```bash
cd /Users/mac/agents/test-flow
npm run acceptance -- --requirement <需求.md> --config acceptance.config.json
```

该入口完成 Requirement 解析、测试设计、用例选择、安全检查、执行和归档。`--mode=dry-run` 只形成设计结果，不得报告实际执行 `PASS`；`--mode=execute` 还必须显式配置 project、environment、output、base URL、Actor credential mapping、Operation Policy 和 Data Lifecycle。production 默认禁止执行。

canonical Scenario 资产由 `scenario-asset-loader` 加载，并进入 `Requirement → Pattern Selection → Scenario Gate → Runner → Evidence Report` 链。现阶段不要假设所有历史 CLI/任务文件已经改走该链；入口是否接通本身也是验收项。

### 7.2 执行前 Gate（必须早于 Prepare）

Runner 的固定顺序是：

```text
Parse / Conflict Check
→ Pattern Proof Validation
→ Scenario Gate
→ Policy Gate / Approval
→ Prepare
→ Operations
→ Assertions / Evidence
→ Outcome
→ Cleanup (finally)
→ Report
```

Scenario Gate 至少验证：

- 至少一个 AC、Operation 和有效 Assertion，且 AC 可追溯到 Operation + Assertion；
- 每个 Operation 有唯一 Step ID、明确 Channel、可用 Processor、AC 与 Evidence 引用；
- API Operation 有唯一 `Method + Path`，多 API 绑定不存在歧义；
- required evidence 有来源，Pattern 要求的 state/non-mutation/side-effect 观察能力完整；
- Actor、Authentication、Tenant、Project、Resource Owner 满足权限/隔离场景要求；
- required Prepare/Cleanup hook 在 allowlist 中，依赖和环境可用。

Policy Gate 再检查环境、真实执行许可、真实扣费、高风险操作、数据隔离、人工审批、`recommendedSkip` 和项目策略。任何 Gate 拒绝都必须在 Prepare 前返回 `BLOCKED` 和 typed Blocked Reason。

### 7.3 Operation / Processor 执行语义

多 Operation 场景按显式依赖顺序执行。每个 Operation 必须产生独立 OperationResult，至少记录：`executed`、`processorInvoked`、Processor 名称、开始/结束时间、证据和阻断原因。前一步 `Capture` 的输出通过本次 execution context 传给后一步。

Processor 必须显式声明支持对应 Channel/Operation。以下情况 fail-close：

| 情况 | 结果 |
| --- | --- |
| 设计时找不到 Processor / binding / evidence capability | `BLOCKED` 或 `DESIGNED_ONLY`，且不得 Prepare |
| Gate 发现本次运行没有匹配 Processor | `BLOCKED`，且不得 Prepare |
| Processor 存在但未实际调用、被旁路或未完成被测动作 | `NOT_EXECUTED` |
| 已执行且断言失败 | `FAIL` |
| 执行超时并取消底层任务 | `TIMEOUT` |
| 用户或系统显式取消 | `CANCELLED` |

禁止“半自动通用骨架仍出成功结果”。通用登录、素材扫描、影响分析或 HTML 报告成功都不能把未执行 Operation 提升为 `PASS`。

### 7.4 Assertion、Evidence 与确定性结果

Runner 在所有必需 Operation 完成后，对响应、状态和副作用执行结构化断言，并收集与 run/operation/assertion/AC 关联的 Evidence Envelope。

只有同时满足下式才能返回 `PASS`：

```text
executed=true
AND processorInvoked=true
AND assertions>=1
AND passedAssertions=assertions
AND failedAssertions=0
AND 所有 required evidence 存在且 verified=true
```

仅有 HTTP 2xx、自然语言预期、截图、日志、空断言、空失败列表或 `total=0` 均不能证明 `PASS`。写场景必须有独立 after-state；拒绝/失败场景必须通过 before/after 与副作用计数证明 Non-Mutation。

### 7.5 Prepare / Cleanup

Prepare 只能在两个 Gate 均允许后执行。它创建的资源必须属于 Scenario 声明的 Actor/Tenant/Project，并将资源 ID 写入同一 execution context。Cleanup 逆序执行且置于 `finally`；即使 Operation 失败、超时或取消，也应尽力清理。Cleanup 失败单独记录为运维/环境风险，不能覆盖已经确定的业务断言结果，更不能把结果改为 `PASS`。

### 7.6 UI 与人工场景

没有真实 UI Processor 与可验证证据时，浏览器步骤只能处于 `DESIGNED_ONLY`；运行实例若没有执行则为 `NOT_EXECUTED`。人工操作记录只有在明确绑定本次 run、完成全部断言并提交 required evidence 后，才可由受控入口形成运行结果。“待人工”不是第七种状态。

### 7.7 LEGACY 入口

以下命令仅用于尚未迁移的历史资产：

```bash
node dist/bin/run-test.js --task tasks/<任务名>.json --env=<环境>
```

该入口必须在报告和日志中标明 `LEGACY`。历史 `scene` 分发、`tasks/*.json` 或内嵌 Markdown 不得被当作 canonical Scenario 迁移完成的证据，也不得绕过上述 `PASS` 谓词。

### 7.8 受控执行内容

在能力存在且 Gate 允许的前提下，Runner 可以执行登录/认证解析、隔离数据准备、业务 Operation、状态查询、计费/隔离核验、证据采集和报告输出。每一项是否自动完成取决于已注册的 Processor、hook 和 Evidence Provider，文档不得用“脚本自动完成”掩盖能力缺口。

---

## 8. 输出报告

脚本生成 **HTML 可视化报告**，包含：
- 任务信息与环境
- Scenario 设计态和运行六态（`PASS / FAIL / BLOCKED / NOT_EXECUTED / TIMEOUT / CANCELLED`）
- `executed`、`processorInvoked`、Processor 与 OperationResult 明细
- 断言总数/通过数/失败数，以及每条断言对应的 AC
- required evidence 完整性、验证状态和证据来源
- typed Blocked Reason（code/stage/message/details/recoverable）
- 接口响应、before/after state 与副作用摘要
- 数据影响清单（表/模块）
- 计费核验结果
- Cleanup 结果和残留风险
- 需要补能力或人工审批的卡点

报告根目录由 Acceptance 配置或 `--output` 显式指定；推荐按 `/Users/mac/agents/output/<YYYY-MM-DD>/<功能名>/` 归档。LEGACY `--func` 命名约定不得被当作 canonical CLI 能力。

Reporter 只能忠实呈现 Result，不能把空结果、部分结果、质量分数或“报告已生成”转换成业务成功。Scenario 的质量评分用于发现设计缺口，不能参与将未执行场景提升为 `PASS`。

---

## 9. 问题卡点处理

执行中发现的问题分层记录，不能全部归为产品失败：

| 类型 | 说明 | 处理 |
|---|---|---|
| `BLOCKED` | Gate/Policy/审批/依赖在执行前拒绝 | 修复可恢复条件后重新评估，不创建产品失败结论 |
| `NOT_EXECUTED` | Processor 未匹配、未调用或执行入口旁路 | 修复 binding/Processor/Runner，禁止 `PASS` |
| `TIMEOUT` | 底层操作被 deadline 取消 | 验证真实 Abort、无后续写入/扣费后再重试 |
| `CANCELLED` | 用户或系统显式取消 | 保留取消来源与 Cleanup 证据 |
| `FAIL` | 已真实执行且确定性断言失败 | 结合证据判断产品、数据、环境或 Provider 原因 |
| 设计缺口 | Scenario 缺 AC、断言、证据或 scope | 回到需求/设计层补齐，不伪装成运行结果 |

---

## 10. 附：LEGACY 场景参考

> 以下是旧 `run-test` 链的历史/现状记录，仅用于维护兼容入口，**不代表 canonical Scenario 已迁移或通过验收**。要进入新链，仍须建立 Operation binding、Pattern proof obligations、Scenario Gate、Processor/Evidence 和确定性结果契约。

### 10.1 视频类（LEGACY Processor）

- **Wan 3.0**：model_id=84，任务类型 105=全能参考 / 106=首尾帧
- **提交接口**：`POST /aivideo/videonew/add`（form-data + CSRF，`row[type]=6`，`row[selmodelsId]=84`）
- **状态接口**：`POST /aivideo/v2/task_status/apiGetStatus`（type=video，ids=任务ID）
- **计费**：720P=60积分/秒（4秒=240积分）
- **账单接口**：`GET /billing/personal?section=summary|modelTrend|modelTop|records&range=7days`
- **已发现卡点**：test 环境 Wan3.0 接入点 `wan3.0-video` 在阿里云百炼未开通/无权限 → 任务失败并自动回退积分

### 10.2 LEGACY 待接入场景

- 剧本分镜（`episode/getModelConfigs` 已验证，生成链路待接入）
- 账单/计费调整（`billing/personal` 各 section 已验证）
- 其他 AI 能力（接入点未知，需提测时确认）

---

## 11. 新能力接入指引

> 新能力默认接入 canonical Scenario 链。只有维护既有 `tasks/*.json` 时才修改 LEGACY SceneHandler；不得以 LEGACY 可运行代替新链验收。

### 11.1 先盘点执行与观察能力

对每个 Operation 明确：

- Channel：`API / UI / DATA / QUEUE / PROVIDER`；
- 唯一 binding：Processor 名称，以及 API 的 `Method + Path`；
- Processor 是否显式 `supports(operation)` 且支持 Abort；
- 能产生哪些 Evidence Kind；
- 是否还需要 DB、资源、队列、账单、审计或 Provider Probe；
- Prepare/Cleanup hook 名称是否进入 allowlist；
- 环境、审批、扣费和数据隔离策略是否允许真实执行。

缺任一关键能力时，Scenario 标为 `DESIGNED_ONLY` 或 `BLOCKED`，不得先跑通用骨架再补判断。

### 11.2 建立 Scenario 资产

1. 复制[通用 Scenario 模板](../tests/acceptance/templates/scenario.md)到 `tests/acceptance/scenarios/<domain>/<scenario-id>/requirement.md`。
2. 从 Requirement Fact Ledger 选择 Pattern，并落实每个 required proof obligation。
3. 为多 API 流程逐项填写 Step ID、Processor、Method、Path、Request、Capture、AC 和 Evidence。
4. 分别定义 Expected Response、Expected State 与 Expected Side Effects；拒绝/失败场景加入 `NON_MUTATION`。
5. 声明 Actor/Scope、测试数据 owner、Prepare/Cleanup、风险、依赖和设计态。
6. 作为 Scenario Pack 交付时必须提供 `expected.json` 保存稳定预期；`server-scenario.ts` 不得由 Markdown Loader 动态执行，必须走显式 allowlist/构建流程。

### 11.3 实现并注册 canonical ScenarioProcessor

`ScenarioProcessor` 必须具备：

```ts
interface ScenarioProcessor {
  name: string;
  supportsAbort: true;
  supportedEvidenceKinds: readonly ScenarioEvidenceKind[];
  supports(operation: ScenarioOperation): boolean;
  execute(
    operation: ScenarioOperation,
    context: ScenarioProcessorContext,
  ): Promise<ScenarioProcessorExecution>;
}
```

实现要求：

- `supports()` 明确检查 Channel 和 Operation 契约，未知输入返回 false；
- `execute()` 使用传入的 `AbortSignal`，真实执行后才返回 `executed=true`；
- 返回证据必须绑定 scenarioId、operationId、AC、来源与时间，并经过脱敏；
- 响应成功不能代替状态/副作用证据，无法观察时返回阻断而不是空证据；
- 重试需幂等，超时/取消后不得继续写入、扣费或回写成功。

API 原子操作可复用 `createAcceptanceHttpScenarioProcessor()`；状态、账单、队列或审计证据仍应根据 Pattern 增加独立观察能力。

### 11.4 注册 Hook 与 Evidence Provider

Prepare/Cleanup 以 handler 名称注册到 Runner 的 allowlist Map，不接受 Markdown 内任意代码。Prepare 产物通过 `variables`/execution context 显式传递；Cleanup 逆序执行。Processor 的 `supportedEvidenceKinds` 与 `additionalEvidenceKinds` 必须真实反映能力，不能为通过 Gate 虚报。

### 11.5 接入验收

至少验证：

1. 正常多 Operation 场景真实调用每个 Processor，capture 传递正确，断言和 required evidence 完整后才 `PASS`。
2. Processor 不存在、不支持或未调用时为 `BLOCKED/NOT_EXECUTED`，且 Prepare 前阻断或完成 Cleanup。
3. 零断言、缺 required evidence、状态探针缺失、binding 歧义均不能 `PASS`。
4. 写入场景有持久化读回；拒绝场景有 before/after Non-Mutation；计费/回调/重试有精确副作用次数。
5. Timeout/Cancel 真正传播 Abort，无后续写入、扣费或成功回写。
6. production、未知环境、未知权限或缺审批默认拒绝，且阻断发生在 Prepare 前。

### 11.6 LEGACY SceneHandler 维护边界

如确需维护 `src/plugins/scenes/`，当前接口使用 canonical scene ID，并要求 `supportedScenes` 与 `supports(scene)` 双重声明。未匹配 Handler 或未完成实际提交必须保持 `executed=false` 并进入 `BLOCKED/NOT_EXECUTED`；禁止恢复“无处理器也出成功报告”的半自动语义。

历史 `tasks/*.json`、旧报告和内嵌 Markdown 只能作为迁移输入。迁移完成的判据是：资产已转换为 canonical Scenario、通过 Gate、接入 Processor/Evidence/Hook，并有跨模块契约测试证明结果语义，而不是文件仍能被旧 CLI 读取。
