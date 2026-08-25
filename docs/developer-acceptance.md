# 开发验收测试使用指南

## 1. 功能介绍

开发验收入口把 Markdown 或纯文本需求转换为 Requirement Fact Ledger，经 Canonical Fact Normalization 和集中 Test Strategy Policy 生成 Objective、Scenario 与 Test Case。Case 通过质量门后，只有具备明确来源、预期和执行契约的 HTTP Case 才会真实执行；UI、数据状态和外部副作用等当前不可观测能力会保留为 `DESIGNED_ONLY` / Observation Gap。最终输出可追溯的 JSON、Markdown 和 HTML 报告，开发人员不需要编辑 Test DSL。

推荐入口是 `npm run acceptance`。`runAcceptancePipeline()` 是供平台或 Agent 集成的兼容入口；其 execute 模式必须显式传入 `safetyPolicy`，并会在 Data Prepare/HTTP 前重新校验 Environment、Origin、Operation effect 与 Cleanup。`ApiProcessor` 属于内部执行边界，已从公共 barrel 移除，业务开发不得直接调用。目前没有单独暴露 Acceptance HTTP API，也没有废弃入口。

## 2. 输入需求格式

支持 Markdown、纯文本、标题、列表、Markdown 表格、中英文混合内容和代码块中的 HTTP 接口描述。建议至少提供：

- 功能标题和页面入口。
- HTTP Method 与 Path。
- Header、Path、Query、Body 参数及约束。
- 角色、测试身份和 Tenant。
- 权限及数据隔离规则。
- 状态码和响应约定。
- 带唯一 ID 的 Acceptance Criteria。

解析器会把已识别但无法结构化的参数、认证、响应字段、权限或隔离约束标成阻断型 `warnings`，并在 Data Prepare 前停止执行。报告会按已识别的规范性 Fact 计算 Fact / Objective / Case / Execution / Evidence Coverage，但这些指标不等于任意自然语言文档的全局识别准确率；没有独立 Ground Truth 时，Fact Recall、Silent Omission 和 False Interpretation 必须标为 `NOT_AVAILABLE`。试点输入仍应遵循本节的受限格式。

显式冲突不会由系统“选择一个”：相同 AC ID 的不同定义、同一参数的冲突契约、同时声明需要/无需认证，以及同一角色对同一目标同时 ALLOW/DENY，都会以 `REQUIREMENT_CONFLICT` 阻断。已识别但当前无法验收的状态迁移、短信/邮件、计费/积分、外部调用和审计保留语义会以 `UNVERIFIED_REQUIREMENT_FACT` 阻断，而不是只执行 HTTP 状态断言。

当一个需求包含多个 API 时，每条 Acceptance Criterion 必须显式写出准确的 `Method + Path`，例如 `AC-2 GET /users/{id} 返回 200`。系统只接受与原始 API 定义完全一致的绑定；歧义、不存在的操作或无法归属某个 API 的参数都会形成结构化 Binding/Parser 问题，不会自动选择第一个 API。

当前 Operation Identity Policy 为 `HTTP_METHOD_EXACT_PATH_V1`：稳定 ID 由精确 `Method + Path Template` 生成，不受声明顺序或描述文本影响；它不会合并 `{id}`、`:id`、`{userId}`，也不能表达不同 Server、Version、Content-Type 或 Auth Scheme 下的同路径操作。重复 Operation 会产生警告。需要这些维度时应拆分需求或等待 Canonical OpenAPI IR，不能依赖自动猜测。

每个 API 还应显式声明认证语义：认证 Header + Actor 表示 `AUTH_REQUIRED`；`无需认证` / `public endpoint` 表示 `AUTH_NOT_REQUIRED`；两者都没有时为 `AUTH_UNKNOWN` 并进入风险报告。受保护接口没有可执行 Actor 时在准备数据前阻断。

当前只支持确定性准备的 anonymous/缺少凭据负向场景。expired、invalid、revoked、near-expiry、Scope、Audience 等场景如果没有专门 Actor Runtime，会保留为 `DESCRIPTIVE_ONLY`；系统禁止把“过期 Token 返回 401”改写成“无 Token 返回 401”。Cookie/Session、多认证方案仍不属于当前 Pilot Contract。

## 3. 最小需求示例

```markdown
# 用户资料修改

PUT /api/users/{id}

nickname: string required 2~20

## Acceptance Criteria

- AC-1 用户修改自己的昵称后返回 200。
- AC-2 昵称长度非法时返回 400。
```

完整的 canonical Scenario Schema 见 `tests/acceptance/templates/scenario.md`，高价值实例见 `tests/acceptance/scenarios/`，风险驱动证明义务见 `tests/acceptance/patterns/`。`tests/acceptance/fixtures/user-profile.md` 保留为旧 Acceptance Requirement 入口的兼容 fixture，不是 canonical Scenario Pack。

## 4. 执行命令

复制并填写一次项目配置：

```bash
cp config/acceptance.example.json acceptance.config.json
export ACCEPTANCE_USER_A_TOKEN='...'
export ACCEPTANCE_USER_B_TOKEN='...'
export ACCEPTANCE_ADMIN_TOKEN='...'
export ACCEPTANCE_TENANT_B_TOKEN='...'
```

配置完成后，一键执行：

```bash
npm run acceptance -- \
  --requirement ./tests/acceptance/fixtures/user-profile.md
```

也支持纯文本、stdin 和范围执行：

```bash
npm run acceptance -- --text '# Ping
GET /api/ping
该接口无需认证
AC-1 GET /api/ping 请求成功返回 200' --mode dry-run \
  --project demo --environment local --output ./reports

cat requirement.md | npm run acceptance -- --requirement -

npm run acceptance -- --requirement requirement.md --scope AC-1,PERMISSION
```

显式参数 `--project`、`--environment`、`--mode`、`--output`、`--base-url` 会覆盖配置文件。未知、重复、缺值参数会直接报错。

## 5. 环境配置

配置优先级为：CLI > 环境变量 > `acceptance.config.json`。默认自动查找项目根目录的 `acceptance.config.json`，也可通过 `--config` 指定。

| 配置 | 环境变量 | 说明 |
| --- | --- | --- |
| `project` | `ACCEPTANCE_PROJECT` | 项目标识，必填 |
| `environment` | `ACCEPTANCE_ENVIRONMENT` | 必填；当前 execute Allowlist 仅为 local/test/integration |
| `mode` | `ACCEPTANCE_MODE` | `execute` 或 `dry-run`，必填 |
| `output` | `ACCEPTANCE_OUTPUT` | 报告根目录，必填 |
| `baseUrl` | `ACCEPTANCE_BASE_URL` | execute 模式必填 |
| `actorHeaders` | `ACCEPTANCE_ACTOR_HEADERS_JSON` | Actor 凭据映射 |
| `maxCases` | - | 最大 Case 数；默认 500，超限时请求前整体阻断 |
| `deadlineMs` | - | HTTP Execution 阶段时限；默认 15 分钟，到期取消请求并阻断剩余 Case；不覆盖自定义 Prepare/Cleanup/Artifact 写入 |
| `environmentPolicy.allowedOrigins` | - | test/integration 的 API Origin Allowlist；必须与 baseUrl 精确匹配 |
| `operationPolicies` | - | 按稳定 Operation Key 声明 READ/WRITE/DELETE/EXTERNAL_SIDE_EFFECT/BILLABLE |

`local` 只允许 `localhost`、`127.0.0.0/8` 或 `::1`；把生产 URL 标成 local 会以 `ENVIRONMENT_TARGET_MISMATCH` 拒绝。test/integration 必须显式配置 `environmentPolicy.allowedOrigins`。HTTP 和 Lifecycle 请求使用 manual redirect，禁止由 30x 自动跳到未审核 Origin。这些规则防止配置误用，但不等价于 DNS/CIDR/Proxy 级网络策略。

`production` 和所有未进入 Allowlist 的环境默认禁止执行；Shared/Dedicated Staging 也尚未开放。凭据应通过 `${ENV_NAME}` 引用环境变量，禁止提交真实 Token。所有选中 Operation 都必须在 `operationPolicies` 中显式分类；`EXTERNAL_SIDE_EFFECT`、`BILLABLE` 和 `UNKNOWN` 在当前 Pilot 一律拒绝。GET/HEAD 只能标为 READ，DELETE 必须标为 DELETE；WRITE/DELETE 还必须配置 `dataLifecycle.cleanup`。`allowNoCleanup=true` 只允许 local loopback 且必须是真正的 boolean，不替代测试租户、回滚和人工审批。

CLI 与公共 Pipeline 共用同一 Safety Policy evaluator；即使集成方绕过 CLI，缺少或不一致的 safety policy 也会把整个选中 Case 集归一为 `BLOCKED / EXECUTION_BLOCKED`，且不会进入 Prepare、Processor 或 HTTP。该应用层 Gate 仍不替代 DNS/CIDR、Proxy 与网络出口控制。

`dry-run` 只生成资产，所有 Case 为 `NOT_EXECUTED`，绝不会伪造 PASS。

## 6. 输出目录

每次运行生成唯一 Run ID 和独立目录，不覆盖历史报告：

```text
reports/
  YYYY-MM-DD/
    RUN-<ULID>/
      run-manifest.json
      requirement.md
      requirement.json
      test-points.json
      test-cases.json
      execution.json
      defects.json
      report.json
      report.md
      report.html
```

CLI 完成后会打印 Run ID、结论、统计、Markdown/HTML 路径和重跑命令。
默认的 `/reports/` 与根目录 `acceptance.config.json` 已加入 `.gitignore`；报告仍应放入受控存储并按团队的数据保留策略清理，不能把 Git Ignore 当作访问控制。

## 7. 报告说明

报告固定为 11 节开发视角结构：测试结论、测试摘要、需求理解、测试范围、测试统计、核心问题、缺陷详情、未验证项、测试覆盖、建议修复顺序和回归建议。`Requirement → Fact → Strategy → Objective → Scenario → Case → Quality Gate → Binding Gate → Request → Response → Assertion → Result` 可通过 ID 反向追溯。

所有格式都会在顶部和结论处明确显示：`resultScope=OPERATION_CONTRACT`、`requirementVerification=NOT_VERIFIED`、`businessSemantics=UNVERIFIED` 与 Evidence Quality。`Case PASS` 只能解释为“该 Case 已声明的 HTTP Operation Contract 断言通过”，不能解释为完整需求通过。

覆盖率按真实性分层，不能互相替代：

- `factCoverage`：已识别规范性 Fact 是否进入 Requirement-derived Test Objective；`DESIGNED_ONLY` 仍属于已设计。
- `factVerificationCoverage`：规范性 Fact 是否进一步闭合到可判定 Case 与 Fact-aware Assertion；不把设计态当成已验证。
- `objectiveCoverage`：Objective 是否有可追溯 Case；不代表已执行。
- `caseCoverage`：Case 是否能反向追溯到有效 Fact 与 Objective。
- `executionCoverage`：Case 确实进入底层 HTTP 执行。
- `evidenceCoverage`：执行包含请求、响应和有效断言证据。
- `operationContractEvidenceCoverage`：证据同时通过原始 ApiSpec Binding Gate；只证明 Operation/Contract，不宣称业务语义完整。

报告还会显式列出 Case Quality 的 Generated / Retained / Deduplicated / Ready / Designed Only / Blocked，以及当前 Executor 无法观察的 UI、数据库、消息、库存、扣费或其他业务后置状态。Observation Gap 只能得到 `PARTIALLY_VERIFIED` 或 `UNVERIFIED`，不会被 HTTP 200/201 覆盖成 PASS。

AC、Test Point 和 Requirement 的有效覆盖只统计 Method、Path 与 `source.apiSpecId` 均匹配原始 ApiSpec 的 Case。生成了 Case 但 Binding 错误，不计为有效覆盖。

请求 Header、Token、Cookie、邮箱、手机号、常见支付卡号、用户 ID、Tenant ID 和内部 URL 会在 JSON/Markdown/HTML、执行证据及缺陷交付产物中统一脱敏。报告中的 `[CONFIGURED_BASE_URL]` 表示从当前环境配置读取的服务地址。自由文本 PII 的识别不是 DLP 产品；进入真实环境前仍需数据分类和 Artifact 访问控制。

## 8. 结果状态定义

### 8.1 Canonical Scenario 运行结果

canonical Scenario 主链只使用以下六态，报告层会对任何伪造或字段矛盾的 `PASS` 二次 fail-close：

| 状态 | 严格语义 |
| --- | --- |
| `PASS` | 所有 Operation 真实完成且 `executed=true` / `processorInvoked=true`，至少一个有效业务断言全部通过，所有 required evidence 均按 Scenario/Operation/AC/Requirement identity 匹配且 `verified=true` |
| `FAIL` | 真实执行已完成，且至少一个确定性业务断言未通过 |
| `BLOCKED` | Scenario Gate、Policy Gate、绑定、依赖、Processor、断言或证据能力不完整；受控操作不得开始 |
| `NOT_EXECUTED` | 设计态场景或运行时未完成实际被测操作；不得转成 `PASS` |
| `TIMEOUT` | 已启动的 Operation 超时并发出 Abort；返回前不再调度后续 Operation，外部系统是否已提交副作用需另行对账 |
| `CANCELLED` | 用户、系统或上游显式取消；保留取消与 Cleanup 证据 |

Scenario 设计文件只允许声明 `EXECUTABLE / DESIGNED_ONLY / BLOCKED`。`PASS / FAIL` 只能由真实运行产生，质量评分和报告生成成功都不是执行证据。

### 8.2 Legacy Acceptance 兼容报告

下表仅描述旧 Acceptance Pipeline 的兼容聚合语义；`PASS_WITH_RISK` 不是 canonical Scenario Result，也不得被换算为完整 Requirement 通过。

| 状态 | 语义 | 是否生成产品缺陷 |
| --- | --- | --- |
| `PASS` | Case 真实执行、有有效断言且全部符合预期；范围仅为 OPERATION_CONTRACT | 否 |
| `PASS_WITH_RISK` | 所有已执行 Case 的 Operation Contract 通过，但仍有非阻断解析警告、归因不确定或其他已披露风险；绝不表示完整 Requirement 已验证 | 否 |
| `FAIL` | 真实执行完成，但业务断言不符合预期 | 仅 `PRODUCT_FAILURE` 且有确定性证据时 |
| `BLOCKED` | 环境、凭据、数据准备或系统条件阻止执行 | 否 |
| `NOT_EXECUTED` | dry-run、无 Processor、不可执行 Case 或未进入 Runner | 否 |
| `TIMEOUT/CANCELLED` | 执行基础设施状态，报告归入风险 | 否 |

Binding Gate 在任何网络请求之前检查稳定 Operation Key、ApiSpec ID、Method、Path、必填 Path/Query/Header/Body，以及 GET/HEAD 无 Body 规则。Gate 不会自动修正 Case。校验失败统一为 `BLOCKED` 或 `NOT_EXECUTED`，且 `executed=false`、`processorInvoked=false`。明确声明 `negativeContractIntent` 的缺失/错误类型等负向向量可以穿过 Gate，真实到达服务端验证 4xx。

对 canonical 拒绝类 Scenario，“预期 403 且实际 403”只能证明响应断言；还必须按 `NON_MUTATION` / 隔离 / 安全 Pattern 收集 before/after state、无泄露与副作用证据，才可对整个 Scenario 判定 `PASS`。旧 Operation Contract Case 若只断言 403，其结论不得扩大为“数据未修改”。

非预期的 401/403/429/500/502/503/504 不会仅凭状态码归责给产品、认证、Gateway 或依赖，而是记录为 `UNCONFIRMED`，并输出 attribution 的 `confidence`、`reason` 和 `evidenceSources`。没有服务端 Trace/Log 时，`PRODUCT_FAILURE` 的归因置信度最高只为 `MEDIUM`。

## 9. 如何重新执行失败用例与 Fact 回归

从报告复制 Run ID 和 Case ID：

```bash
npm run acceptance -- \
  --run-id RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV \
  --case-id CASE-<semantic-sha256-id>
```

重跑会读取原 Run 归档的需求，重新生成同一 Case，并与归档的执行语义比较后创建新 Run；新 Manifest 中保存 `parentRunId`，原报告不会被覆盖。语义漂移会在 Data Prepare 前以 `ARCHIVE_REPLAY_MISMATCH` 拒绝。

开发修复产品缺陷后，可按原失败 Run 生成 Fact-based Regression：

```bash
npm run acceptance -- \
  --run-id RUN-01ARZ3NDEKTSV4RRFFQ69G5FAV \
  --regression
```

回归范围包含原失败 Case、同 Fact Case 和同 canonical 测试策略 Case。报告与 Manifest 会保留 Affected Facts / Objectives / Cases 及每个 Case 的选择原因。缺少可信失败证据、Fact trace、原 Execution Plan 授权或归档语义一致性时，回归会在 Data Prepare 前 fail-close；不会退化为静默全量执行或扩大真实副作用范围。

Artifact 只保存脱敏内容。如果需求中的邮箱、手机号、凭据等内容在归档时发生替换，Manifest 会标记 `replaySafety=BLOCKED_REDACTED_INPUT`，重跑统一以 `ARCHIVE_REPLAY_UNSAFE` 阻断，避免把 `***` 等掩码值重新发送到被测系统。旧 Artifact、缺少稳定 Operation Identity 或旧版 Manifest 同样必须从原始需求重新建立基线，不能不安全地兼容执行。环境凭据仍从当前安全配置读取。

## 10. 常见错误

- `缺少 output/project/environment/mode`：补全配置文件或对应环境变量。
- `API baseUrl 未配置`：execute 模式配置目标测试服务地址。
- `ENVIRONMENT_TARGET_MISMATCH`：local 使用了非 loopback，或 test/integration 的 Origin 未进入 Allowlist。
- `OPERATION_POLICY_REQUIRED / INVALID`：为每个选中 Operation 补充可审计分类，且 Method/Effect 必须一致。
- `MUTATION_POLICY_BLOCKED`：外部副作用、计费及未知操作当前禁止执行。
- `缺少 Actor 凭据映射`：为报告指出的 Token Ref 配置 Header。
- `未配置 dataLifecycle.cleanup`：提供测试数据清理接口，或确认幂等后显式允许。
- `Requirement Parse Warning`：检查缺失的 Response、AC 或 Actor 定义。
- `BLOCKED / ENVIRONMENT_FAILURE`：先修复环境或测试数据，不要创建产品 Bug。
- `Run 中不存在 Case`：从该 Run 的 `test-cases.json` 复制正确 Case ID。
- `BINDING_AMBIGUOUS / API_NOT_FOUND`：为对应 AC 补充准确的 `Method + Path`，不要依赖接口顺序。
- `BINDING_MISMATCH / *_PARAMETER_MISSING`：修复需求契约或生成链路；Gate 不会在执行前代为补齐或改写请求。
- `REQUIREMENT_CONFLICT`：需求内部存在互斥事实，必须由需求负责人消歧，系统不会代为选择。
- `UNVERIFIED_REQUIREMENT_FACT`：系统发现了状态、副作用、计费或审计语义，但当前没有确定性 Assertion。
