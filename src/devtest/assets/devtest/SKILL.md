---
name: devtest
description: 根据当前仓库的需求文档规划和执行开发自测，集中澄清需求，确认计划后立即调用 DevTest MCP，按真实证据解释结果。用于功能自测、测试计划、测试结果和失败排查；不用于擅自修改业务代码或发布。
---

# DevTest：澄清 → 一次确认 → 直接执行

你负责读需求、问清歧义、请求确认和解释证据。`devtest` MCP 内核负责生成 TEST_CASE_V2、校验、执行和判定。不要自己编写替代内核用例、HTTP 脚本或伪造测试结论。已授权的本地离线测试可以作为独立补充证据，按下文执行，不能冒充 MCP 结果。

## Panqu 功能专项路由

在 Panqu/盼趣项目中，生成计划前按需求语义和实际改动入口读取所有相关专项 Skill，不依赖固定模型名称：

| 涉及范围 | 同目录下应读取的 Skill |
| --- | --- |
| 画布组件、节点、连线、保存、协作与执行 | `../panqu-canvas/SKILL.md` |
| 视频模型、视频生成/编辑、参数能力与任务结果 | `../panqu-video-models/SKILL.md` |
| 图片模型、图片生成/编辑、参数能力与任务结果 | `../panqu-image-models/SKILL.md` |

例如“画布新增视频模型”同时读取画布和视频；“新增图片模型”不论新模型叫什么都读取图片；普通登录页背景图不触发图片模型专项。读取对应 Skill 时简短告知用户。专项 Skill 用于找代码、澄清业务和分析覆盖，不替代下面的内核流程，不把候选检查当成已确认需求。文件缺失时明确提示更新/安装 Skill，不能声称已完成专项检查。

涉及上传、提示词、默认参数或节点输入时，必须在计划前读取对应专项的 `references/input-constraints.md` 并形成逐项约束表。至少区分格式、单文件/整批大小、单次/累计数量、提示词条数/长度、类型与必填、默认值与生效时机、参数联动、违规处理与副作用；只检查本轮适用维度。不允许用“参数校验正常”跳过需求里的具体数字、单位、条件、表格或注释。

已明确规则直接提取并保留来源；缺失、歧义、冲突集中澄清，不能拿代码、常识或上一模型补成确认答案。已确认边界检查必须关联内核实际生成的用例；没生成/未执行的逐条列为缺口，不能编造用例 ID 或修改需求以匹配内核能力。这是入口 Skill 要求，不代表内核自动新增了上传/生成测试能力。

## 当前状态决定下一步

Panqu 图片、视频、画布任务先完整读取 [代码、校验与页面联合验证](references/combined-validation.md)，形成逐条规则的代码/边界/API/页面/业务证据映射；不能仅选页面 happy path。所有开发自测 Markdown 交付读取并遵守 [固定报告格式](references/markdown-handoff.md)。本地已有测试的安全执行不受“不能替代 MCP 用例”误限；本地证据不足或未执行必须留缺口，不能自行提升内核结论。

1. **定位需求**：优先使用用户指定的仓库内文档。未指定时查找现有需求；有多个合理候选才问用户选哪份。首次接入调用 `{"action":"doctor"}`；缺少工具或配置时说明具体缺项并停在接入问题，不能假装执行。已有可用配置不必每轮重复检查。
2. **生成计划**：调用 `{"action":"plan","requirement":"实际的仓库相对路径"}`。只复制实际路径，不能把示例占位符作为输入。规划不发业务请求，无需先征求“是否生成计划”。
3. **按工具的 `next_action` 行动**：

| `next_action.kind` | 你必须做什么 |
| --- | --- |
| `CLARIFY_REQUIREMENTS` | 按 `questions` 集中询问业务问题，保留原文和位置；没有答案的条目继续待确认，不能执行含糊规则 |
| `RESOLVE_BLOCKER` | 说明具体阻断和需要谁补充什么；不循环重试或自造预期 |
| `CONFIRM_EXECUTION` | 展示下面的确认摘要，保留工具返回的 `execute_arguments`，等待用户确认一次 |
| `WAIT_FOR_RESULT` | 使用 `status_arguments` 查询；同一回复内最多查询三次，仍在运行就如实说明；用户要求查看进度时继续查询，不擅自创建定时任务 |
| `REVIEW_RESULT` | 依据实际结果交付，不重新执行，也不继续询问是否执行 |

若旧内核没有 `next_action`，按同样顺序处理 `requirement_assurance`、计划和状态，不猜工具参数；缺少 `requirement_assurance` 则要求更新内核，不能声称整体验收通过。

## 问题必须具体，不能让用户替你设计测试

先读需求涉及的角色、资源、归属/租户、状态、业务动作、结果和副作用。信息已经明确的不要重问，缺失的标 UNKNOWN。

每个问题只包含“原文及位置 → 不确定之处 → 需要确认的业务结果”。同一原文的相同问题合并展示，保留关联 ID。允许给出少量备选，但必须标明只是待选方案；用户不选不代表默认同意。不能把接口地址、已有代码行为、通用惯例或模型猜测当成缺失的业务规则。

可以只读相关代码定位实现、参数和冲突，但须标为“代码现状”，不能因此修改需求预期。禁止为了过门禁删除原文、把要求改成背景说明、移出测试范围或写成已确认。

用户确实给出/确认答案后，将原文及答复保留在需求中，明确修订对应条目的待确认状态；不要只在末尾追加互相矛盾的说明。只修改已获授权的需求文档，不修改业务代码。文件不可编辑或权限不足就说明缺少的访问，不能复制受限内容绕过权限。更新需求后重新 `plan`。

## 一次确认的摘要

使用工具返回的事实，简短展示：

- 需求文件与本轮业务目标；若你对原文理解有歧义，先澄清。
- 本轮所选范围、可执行数量、SAFE 只读边界，以及请求/时间预算。
- `runtime_preflight_after_confirmation=true` 时，说明环境连通性将在授权后检查；零网络规划不是环境已验证。
- 未覆盖、被阻断、未选中的要求及其影响；不能把部分测试称为完整验收。
- `plan_id`、`plan_hash`，并询问：“确认按这份计划执行吗？”

**用户对这份未变化的计划回复“确认”“开始”“直接执行”等明确授权后，下一步立即调用 `devtest` 的 `execute`。** 原样使用 `next_action.execute_arguments`；旧内核则使用原 `plan_id`、`expected_plan_hash`，为该计划固定一个合法 `idempotency_key`。不能再次问“是否开始”，不能只回复“马上执行”就结束，也不能无理由重新 `plan`。

如果用户只确认了业务答案，而尚未看到最终计划，先更新需求并展示新计划，不把业务确认当成执行授权。泛泛的“以后都直接跑”不能代替未知范围的授权。需求、代码、环境或范围变化导致 `STALE_PLAN` 时，重新计划、说明变化并确认；不自行改 hash 绕过校验。

## 执行后和异常时

调用结果不明确、连接中断或 `RUN_IN_PROGRESS` 时，先用原 `plan_id` 调 `status`。不要换幂等键，不要重新计划后偷跑一遍，不要删除锁。仍无法判断是否执行就保留未知状态并请求操作员核查。已完成计划的同键重放只用于恢复结果，不是新的测试。

## 开发者即时高阶自测工具 (Trae 场景化直接调用)

为了满足日常开发中“即改即测”、“快速排障”的敏捷工作流，DevTest MCP 提供了 4 项高阶场景化操作，支持在 Trae 对话框中直接调用：

1. **`quick_verify`：模型一键闭环自测体检**
   - **适用场景**：刚写完一个新模型的接入代码，或刚刚调整了某个模型的生成参数/分流配置，想要立刻验证全链路。
   - **调用示例**：`{"action": "quick_verify", "model_id": 84, "media_type": "video", "mode": "mock", "resolution": "720p", "duration": 4}`
   - **核心产出**：即时输出正向闭环状态、两级分流命中指标、产物物理元数据（MP4 Box 容器/PNG IHDR 结构）、刊例计费扣款/退款核销、供应商成本毛利。

2. **`audit_billing`：账单流水对账核销与防资损审计**
   - **适用场景**：调试计费、预扣、结算、失败退款逻辑后，输入一组真实或模拟的账单流水记录，核验是否存在资损漏洞。
   - **调用示例**：`{"action": "audit_billing", "task_id": 12345, "model_id": 84, "media_type": "video", "terminal_status": "SUCCESS", "score_logs": [{"task_id": 12345, "type": 2, "score": -56}]}`
   - **核心产出**：严格断言三大账务不变量（防重复扣费 ANTI_DOUBLE_BILLING、失败净扣归零 NET_CHARGE_ZERO、退款幂等 REFUND_IDEMPOTENCY），精确指出少扣、多扣、重复扣、漏退款等异常。

3. **`diagnose_diversion`：分流规则快照诊断与加权渠道推导**
   - **适用场景**：在主站配置完模型分流规则、组织路由组或网关渠道权重后，零网络消耗即刻推导分流决策。
   - **调用示例**：`{"action": "diagnose_diversion", "model_id": 84, "media_type": "video", "resolution": "720p", "aspect_ratio": "16:9", "user_group_ids": [10]}`
   - **核心产出**：主站决策（DIVERTED / DIRECT）、切流线路（如 line 10）、网关可用渠道列表、加权推导概率分布、未入选渠道拒绝原因。

4. **`self_test_plan`：需求驱动测试策略规划**
   - **适用场景**：拿到 PRD、需求描述或技术文档时，一键规划区分“新模型直接接入（DIRECT）”与“已有模型分流（DIVERSION）”的测试方案。
   - **调用示例**：`{"action": "self_test_plan", "requirement": "接入新视频模型 Wan 3.0 Prime，代码写死直连 NewAPI", "flow_type": "direct", "model_id": 88}`
   - **核心产出**：自动化生成的测试场景列表、每个场景的断言依据以及 5-7 阶段的可执行步骤 DAG。

5. **`probe_environment`：真实测试环境一键探针与连通性巡检**
   - **适用场景**：联调测试前，只读探活当前 test/preonline 主站服务、会话 Cookie 有效性、关键端点健康度与模型分流就绪状态。
   - **调用示例**：`{"action": "probe_environment", "env": "test", "model_id": 84}`
   - **核心产出**：输出环境整体状态（HEALTHY/DEGRADED/BLOCKED）、端点响应耗时、会话状态、分流渠道候选数与排障诊断建议。

6. **`export_repro`：缺陷一键复现包导出**
   - **适用场景**：当开发自测或流水线发现计费少扣/漏退/重复扣、分流未切流、产物介质损坏时，一键生成标准复现包。
   - **调用示例**：`{"action": "export_repro", "model_id": 84, "failure_category": "BILLING_ANOMALY", "violated_invariants": ["ANTI_DOUBLE_BILLING"]}`
   - **核心产出**：生成开箱即用的 cURL 调试命令、Playwright 最小脱敏复现脚本与 Markdown 提单模版（可直接贴入飞书/Jira）。

7. **`extract_model_matrix`：业务模型规格矩阵逆向提取**
   - **适用场景**：接入新模型或验证已有模型时，只读逆向提取 panqu-ai 业务源文件中定义的分辨率、画幅、时长等真实规格字典。
   - **调用示例**：`{"action": "extract_model_matrix", "model_id": 901}`
   - **核心产出**：输出模型官方支持规格字典，并自动生成前 3-10 个最具代表性的正交自测场景参数组合。

8. **`analyze_git_impact`：Git 改动增量模型影响分析**
   - **适用场景**：提交代码或发布前，只读扫描当前分支改动（`git diff`），自动逆向推导受波及的具体模型，生成最小回归测试集。
   - **调用示例**：`{"action": "analyze_git_impact"}`
   - **核心产出**：输出受影响模型列表（如改动 Image25 影响 901/902，改动分流表影响 84 等）、影响等级与推荐执行的精准自测命令。

9. **`watch_task`：长任务流式进度监视与断点对账**
   - **适用场景**：针对耗时 30s~180s 的视频生成或异步大图生成长任务，提供流式状态轮询，并在成片时自动触发介质检查与扣费核销。
   - **调用示例**：`{"action": "watch_task", "task_id": 20001, "model_id": 84, "media_type": "video"}`
   - **核心产出**：输出任务状态变迁序列（SUBMITTED -> QUEUED -> PROCESSING -> COMPLETED/FAILED）、MP4 Box 容器校验结果以及三大账务不变量核销报告。

10. **`simulate_chaos`：NewAPI 网关多渠道故障与降级容灾演练**
    - **适用场景**：验证网关在上游供应商 429 限流、504 超时或服务全挂时的容灾韧性，确保平滑故障转移或直连降级。
    - **调用示例**：`{"action": "simulate_chaos", "chaos_type": "UPSTREAM_429_RATE_LIMIT", "model_id": 84}`
    - **核心产出**：输出故障转移目标渠道、是否降级回退主站直连、防重复扣费与净扣归零不变量判定。

11. **`audit_config_drift`：多环境配置与刊例价差异动审计**
    - **适用场景**：对比测试环境与现网配置差异，检查是否存在“代码上线但未配刊例价导致白嫖”或分流开关不一致等资损隐患。
    - **调用示例**：`{"action": "audit_config_drift", "env": "test", "compare_env": "online"}`
    - **核心产出**：输出配置一致性状态（CONSISTENT/DRIFT_DETECTED/CRITICAL_DRIFT）、未定价模型告警及修复建议。

12. **`audit_margin`：供应商成本与平台毛利率智能核算门禁**
    - **适用场景**：新模型上线定价或配置 NewAPI 分流前，自动遍历 480p/720p/1080p 测算用户收入、供应商成本与毛利率，拦截价格倒挂（负毛利净亏损）与降级成本失控风险。
    - **调用示例**：`{"action": "audit_margin", "model_id": 84, "target_margin_percent": 30}`
13. **`review_pr`：Trae 双 MCP 协同 PR 审查与代码行级评审 (GitHub MCP 深度适配)**
    - **适用场景**：在 Trae 中配合 GitHub MCP 使用。当 Trae 读取到 PR 变更或 patches 后，输入本工具进行模型波及分析、毛利率核算与资损审查。
    - **调用示例**：`{"action": "review_pr", "pull_number": 42, "changed_files": ["app/admin/controller/aivideo/PlotService.php"], "target_margin_percent": 30}`
    - **核心产出**：不仅输出 Markdown 审查总览，而且直接生成标准格式的 `github_mcp_payload` 与 `trae_next_action`（包含 `event: 'APPROVE' | 'REQUEST_CHANGES'`, 逐行行间评论 `line_comments: [{path, line, side, body}]`），Trae 可直接执行 GitHub MCP 的 `create_pull_request_review` 工具将结论与行间批注一键发布到 GitHub PR。

14. **`export_ci_workflow`：一键导出 GitHub Actions CI 门禁流水线配置**
    - **适用场景**：快速为 GitHub 仓库生成开箱即用的 `.github/workflows/test-flow-ci.yml` 自动化门禁工作流。
    - **调用示例**：`{"action": "export_ci_workflow"}`
    - **核心产出**：生成包含代码检出、依赖安装、构建、门禁核算与 PR 评论自动回写的 GitHub Actions 配置。

15. **`propose_fix_pr`：资损与毛利优化一键提 PR 闭环 (Auto-Fix PR via GitHub MCP)**
    - **适用场景**：在审查或门禁发现价格倒挂（`NEGATIVE_MARGIN_LOSS`）或未配置刊例价（`UNPRICED_MODEL`）阻断后，一键生成精确修复包，包含修改前后的财务损益对照表、FastAdmin 数据库更新 SQL、配置补丁 JSON，并直接装配 GitHub MCP 的 `create_or_update_file_contents` 与 `create_pull_request` 标准调用参数。
    - **调用示例**：`{"action": "propose_fix_pr", "model_id": 84, "target_margin_percent": 30}`
    - **核心产出**：输出规范分支名（`fix/pricing-margin-model-84`）、迁移脚本、带前后对比表格的 PR 描述，以及供 Trae 零思考调用 GitHub MCP 的 `github_mcp_actions` 序列。

16. **`report_check_run`：GitHub Check Runs 原生门禁回写与代码注记闭环 (GitHub MCP 深度适配)**
    - **适用场景**：在企业级保护分支（Branch Protection）强卡点场景下，Trae 调用本工具生成符合 GitHub REST API 规范的 Checks 原生载荷。在 GitHub PR 页面挂载原生检查通过/阻断状态，并在 Files Changed 处自动显示代码行级 Annotations。
    - **调用示例**：`{"action": "report_check_run", "head_sha": "a1b2c3d4e5f6", "pull_number": 42, "target_margin_percent": 30}`
    - **核心产出**：输出结构化 `check_run_payload`（包含 `name`、`head_sha`、`conclusion: 'success' | 'failure' | 'neutral'`、`output.title`、`output.summary`、`output.annotations`），并直接组装针对 GitHub MCP 的首选操作 `create_check_run` 与降级备选 `create_commit_status`。
17. **PR 评论指令交互与自动化闭环 (`handle_pr_command`)**：
    - **适用场景**：在 Trae 协同场景下，当开发者或测试人员在 GitHub PR 评论区回复指令（如 `@panqu-bot /retest`、`/fix 84`、`/audit 84`、`/help`）时，Trae 读取评论并调用本工具进行指令识别、门禁触发或自动提修复 PR。
    - **调用示例**：`{"action": "handle_pr_command", "comment_body": "@panqu-bot /retest", "comment_author": "alice", "pull_number": 42}`
    - **核心产出**：输出结构化指令识别结果、通俗易懂的双视角回执 Markdown（`reply_markdown`）以及开箱即用的 GitHub MCP 动作序列（`create_issue_comment`、`create_check_run`、`create_pull_request`），使智能体自动在 PR 评论区回复执行结果。
18. **PR 合入后生产校验、工单关闭与版本发布 (`post_merge_release`)**：
    - **适用场景**：PR 正式合并（Merge）入主分支后，Trae 调用本工具完成线上配置零漂移核验（Zero Drift Verification）、自动关闭关联的资损 Issue（`update_issue`）、发布 Release Tag 并挂载通俗双视角 Release Notes（`create_release`）。
    - **调用示例**：`{"action": "post_merge_release", "pull_number": 42, "associated_issue_numbers": [38], "tag_name": "v1.2.0"}`
    - **核心产出**：输出 `drift_passed`、`margin_passed`、通俗易懂的双视角 Release Notes（包含产品业务收支看板与研发数据库迁移归档），并生成针对 GitHub MCP 的动作链（`update_issue(closed)` + `create_release` + 回复 PR/Issue 评论）。

## 不可越过的边界与限制守则 (Hard Boundaries & Quality Rules)

为了确保研发团队高效协同、杜绝线上资损与白嫖风险，本智能体及研发/测试人员必须严格恪守以下三大维度的限制守则：

### 🛑 一、研发人员硬性限制与修改守则 (开发看懂怎么改、哪里不能动)

1. **业务仓库绝对只读保护 (Safe Read-Only)**：
   - 测试智能体对当前工作区内的业务主仓库始终保持**严格只读**。
   - 严禁在被测业务代码库中直接写入临时文件、调试代码或测试脏数据；所有改动必须通过 GitHub PR 分支提交。
2. **调价与配置修改规范 (严禁代码硬编码)**：
   - 严禁在 PHP/Go 控制器或服务中私自硬编码模型刊例价格；
   - 必须通过 FastAdmin 数据库迁移 SQL（统一采用 `INSERT ... ON DUPLICATE KEY UPDATE` 保证幂等执行）与配置补丁（`application/extra/`）进行修改；
   - 调价 PR 必须明确附带修改前后的**财务损益对比表**，确保调价后的毛利率不低于保本基准（默认 30%）。
3. **零资损上线红线 (价格倒挂与未定价绝对阻断)**：
   - **严禁负毛利倒挂上线**：凡是用户刊例收入低于供应商成本的规格（`NEGATIVE_MARGIN_LOSS`），门禁必须返回 Exit 1 阻断，严禁合并！
   - **严禁未定价模型上线**：新接入模型上线前，若 FastAdmin 积分表未配置刊例价（`UNPRICED_MODEL`），严禁放行，杜绝用户 0 积分白嫖生成。

---

### 🛑 二、产品与测试硬性限制与质量红线 (产品测试看出哪里有问题、何时不能放行)

1. **保护分支 (Branch Protection) 强卡点**：
   - GitHub PR Checks（`test-flow/quality-and-margin-gate`）与 PR Review 阻断项未清零前，**测试人员与产品经理严禁强制审批或放行合入**；
   - 必须在 GitHub Checks 看到绿标（`SUCCESS`）且行级 Annotations 阻断项全部解决后方可点通过。
2. **直接接入新模型 (DIRECT) 全矩阵覆盖要求**：
   - 新模型代码写死直连 NewAPI 时，必须覆盖其所支持的**全规格矩阵**（全部可用分辨率、画幅比例与视频时长）；
   - 严禁仅测试单一默认规格（如仅测 720p 却遗漏 1080p 倒挂规格）。
3. **已有模型分流 (DIVERSION) 降级兜底验证**：
   - 分流模型不仅要测试命中 NewAPI 渠道的成功闭环，**必须强制演练反向降级回退主站原链路**；
   - 必须验证 NewAPI 上游出现 429 限流、504 超时或供应商全挂时，系统能够平滑切回直连，不中断用户生成。
4. **四大核心账务不变量铁律 (资金安全底线)**：
   - **防二次扣款 (`ANTI_DOUBLE_BILLING`)**：相同 `client_token` 重试严禁扣费两次；
   - **失败净扣归零 (`NET_CHARGE_ZERO`)**：任何生成失败、超时或上游报错的任务，必须 100% 全额退款，用户钱包净扣必须严格为 0 pt；
   - **退款幂等性 (`REFUND_IDEMPOTENCY`)**：退款流水至多触发 1 次，严防重复退款资损；
   - **损益平衡保本 (`BREAK_EVEN`)**：平台扣除积分折算收入必须高于供应商履约成本。

---

### 🛑 三、Trae 智能体与执行器安全边界 (智能体运行限制)

1. **双重视角输出规范 (通俗易懂原则)**：
   - 每次生成的门禁审查报告、PR Review 批注、Check Runs 状态与 CLI 控制台输出，**必须严格拆分为两部分**：
     - 📋 **【产品与测试看板：业务影响与资损风险】**：用通俗易懂的语言讲清楚受影响模型、具体业务问题、每单亏多少钱、有无白嫖漏洞；
     - 🛠️ **【研发排查与修复指引：改动位置与修复方案】**：必须明确指出修改的具体文件路径、参考行号、推荐改动值、数据库迁移 SQL 及本地复测命令。
   - 严禁输出让团队成员看不懂的晦涩学术黑话。
2. **操作授权与 MCP 调度安全**：
   - 智能体在 Trae 中仅执行只读分析、测试规划与门禁核算；
   - 所有针对 GitHub 仓库的写操作（包括提交分支、更新文件、开启 PR、提交代码批注、回写 Check Run 状态），必须封装为结构化的 `github_mcp_actions`，交由 Trae 在获得开发者明确确认后依次调度 GitHub MCP 执行，严禁私自静默越权写库或写代码。
3. **确定性证据要求**：
   - 所有的 PASS / APPROVED 结论必须基于真实的 Git Diff、真实的模型白名单扫描、真实数据库刊例读取以及确定的 Oracle 机器核算，严禁凭空捏造虚假证据。
