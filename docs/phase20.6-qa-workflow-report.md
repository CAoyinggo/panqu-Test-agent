# Phase 20.6 变更报告：真正的 QA 工作流（4 种模式）

> 阶段目标：把 CLI 变成 QA 的日常工具，提供 4 种模式
> （A 从需求开始、B 只生成测试、C 只分析失败、D 修复后回归）。

## 一、本阶段变更

### 1. 新增 QA 工作流模块（`src/qa/workflows.ts`）

| 能力 | 说明 |
|---|---|
| `normalizeExecutionOutcome(input)` | 归一化执行结果输入：`ExecutionOutcome` / `CaseExecutionResult[]` / `agent-summary.json`（含 `outcome` / `execution.outcome` 嵌套） |
| `analyzeFailures(outcome, ctx, opts)` | 模式 C 核心：RCA → Defect（仅 DRAFT）→ Healing（仅 SUGGESTED）→ Approval（分级审批 + 审计） |
| `TaskRecord` / `saveTaskRecord` / `loadTaskRecord` | 任务记录持久化于 `output/tasks/<taskId>.json`，供模式 D 恢复 |
| `resumeTask(record, ctx, runner?, opts)` | 模式 D 核心：RCA → Defect → Healing → Approval → 应用获批补丁 → 回归执行 |

### 2. CLI 新增 4 种模式（`bin/run-agent.ts`）

| 模式 | 命令 | 行为 |
|---|---|---|
| A | `node dist/bin/run-agent.js --requirement=<file>` | 从需求文件开始全流程（需求 → 用例 → 风险 → 执行 → 分析 → 报告），并保存任务记录 |
| B | `node dist/bin/run-agent.js --requirement=<file> --plan-only` | 只生成 Requirement / TestDesign / Risk / Coverage，不注册执行 Tool，不执行 |
| C | `node dist/bin/run-agent.js --analyze=<result.json> --rca` | 只分析失败：读取结果文件 → RCA → Defect Draft → Healing 建议 → 分级审批 |
| D | `node dist/bin/run-agent.js --resume=<task-id>` | 恢复任务：RCA → Healing → Approval → 应用获批补丁 → 回归执行（注册执行引擎） |

CLI 其他新增参数：`--requirement`、`--plan-only`、`--analyze`、`--rca`、`--resume`、`--task-dir`。
模式 D 退出码：仍有失败返回 1，否则 0。帮助文本补充 4 模式用法与示例。

### 3. 复用既有能力

- `agent-pipeline.ts`：导出 `buildApprovalRequests`（缺陷 + 自愈分级审批），供工作流复用
- 模式 A/B 沿用 `runAgentPipeline`（未改动 Core / Pipeline / Assertion）

## 二、测试结果

### 新增单元测试 `tests/unit/qa-workflows.test.ts`（10 条）

- `normalizeExecutionOutcome`：ExecutionOutcome / 数组 / 嵌套 JSON / 非法输入
- `analyzeFailures`：产出 RCA + 缺陷草稿（恒 DRAFT）+ 自愈建议（error-code/high）+ 审批；无失败不产出
- `TaskRecord` 持久化往返 + 不存在返回 null
- `resumeTask`：未获批不应用、获批应用补丁到 Test DSL 并回归恢复；无失败不执行

### CLI 冒烟（真实命令）

- 模式 A：`--requirement=requirement.md --skip-execution` → 读取需求文件，10 条用例，覆盖率分析，保存任务记录
- 模式 C：`--analyze=result.json --rca` → RCA 1 条 / 缺陷草稿 1 / 自愈建议 1（error-code/high）/ 审批 2（pending）
- 模式 D：`--resume=task-resume-demo --auto-approve` → 获批并应用 `assertion.expected: '4001' → '4003'`

### 全量回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm test` | 43 文件 / 671 用例 PASS + 10 skipped |
| `npm run agent:test` | 31 文件 / 416 用例 PASS |

## 三、与 Phase 20 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 模式 A：`--requirement requirement.md` 全流程 | ✅ |
| 模式 B：`--plan-only` 只生成（Requirement/TestDesign/Risk/Coverage），不执行 | ✅ |
| 模式 C：`--analyze result.json --rca` 只分析失败 | ✅ |
| 模式 D：`--resume task-id` 继续 RCA→Healing→Approval→Execution | ✅ |
| 向后兼容（位置参数文本仍可用） | ✅ |

## 四、约束符合性与风险

- 未重构 Core / Pipeline / Assertion；未删除 Mock Benchmark 与现有 E2E
- 模式 B / 模式 D 均不自动创建正式缺陷、不自动应用未审批补丁
- 模式 D 的回归执行依赖项目配置（`execution.run` Tool）；未配置时输出「未注册 execution.run Tool，仅产出执行计划」并跳过
- 风险：`--resume` 需要任务记录存在于 `output/tasks`（或 `--task-dir`），记录缺失时报错退出

## 五、下一步

进入 **Phase 20.7 CI/CD 集成**：新增 `.github/workflows/agent-test.yml`（PR 触发，只执行 P0/P1；
P2/P3 nightly），建立六态结果（PASS/FAIL/WARNING/BLOCKED/KNOWN_ISSUE/FLAKY）与 P0 阻断规则。
