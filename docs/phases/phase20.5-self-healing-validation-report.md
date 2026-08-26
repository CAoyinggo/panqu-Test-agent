# Phase 20.5 变更报告：Self-Healing 真实验证

> 阶段目标：建立真实变更场景，验证完整闭环
> 「发现失效 → 分析新 Response → 生成 Patch → Diff → 人工审批 → 应用 Patch → 重新执行 → 测试恢复」。
> 不能只验证「Agent 找到了新字段」，必须验证 Patch → 重新执行 → 测试恢复。

## 一、本阶段变更

### 1. 扩展确定性检测（`src/agents/self-healing/healing-analyzer.ts`）

- 新增 `extractErrorCodeMismatch`：提取错误码不匹配（期望 vs 实际），支持中英两种表达
  - `expected 4001, got 4003` / `期望 4001，实际 4003` / `错误码 4003 与期望 4001 不一致`
  - 要求 3~5 位业务错误码，避免把 `expected SUCCESS, got 503` 等状态误判为错误码变更
- 新增 `classifyPathChange`：区分路径变更类型
  - 中间结构段变化（`data.result.url` → `data.output.url`）→ `json-path`
  - 仅叶子字段重命名（`data.task.status` → `data.task.taskStatus`）→ `api-field`
- `analyzeHealing` 增强：
  - 路径失效建议按 `classifyPathChange` 标注类型
  - 新增错误码变更检测：产出 `error-code` 类型建议，风险恒为 `high`，
    理由明确提示「请人工确认是预期业务调整还是回归缺陷」

### 2. 新增自愈闭环执行器（`src/agents/self-healing/healing-loop.ts`）

| 函数 | 说明 |
|---|---|
| `parseHealingPatch(patch)` | 解析补丁文本为结构化 `{ from, to }`（`- path: 'x'` / `+ path: 'y'`） |
| `applyHealingPatch(suggestion, testCase)` | 应用补丁到 Test DSL 副本（不修改原对象）：路径/字段改写断言 `path`；错误码改写断言 `expected` 并同步 `expected.fields` |
| `evaluateHealingApproval(...)` | 复用 Approval Policy：`apply-healing` 恒为变更类操作，DENY / REVIEW / MANUAL 未获人工批准不授予 |
| `runHealingLoop(input)` | 完整闭环：检测 → 审批 → 应用 Patch → 重新执行 → 验证恢复 |

闭环返回 `HealingLoopResult`：`detected` / `chosen` / `approval` / `applied.diff` / `reexecuted` / `recovered` / `summary`。

### 3. 导出与脚本

- `src/agents/index.ts`：新增 `healing-loop.js` 导出；`self-healing-agent.ts` 重导出新检测函数
- `package.json`：新增 `agent:e2e:healing` 脚本；`agent:test` 纳入 `tests/unit/healing-loop.test.ts`

## 二、真实变更场景验证（`tests/e2e/healing/real-healing-scenarios.test.ts`，4 条）

| 场景 | 变更 | 类型 | 验证闭环 |
|---|---|---|---|
| 场景 1 | `data.result.url` → `data.output.url` | `json-path`（结构变化） | 失败 → 检测 → Patch → 审批拒绝不应用 → 审批通过 → 应用 → 重新执行 → 恢复 |
| 场景 2 | `data.task.status` → `data.task.taskStatus` | `api-field`（字段重命名） | 检测 type=api-field → Patch → 应用 → 恢复 |
| 场景 3 | 错误码 `4001` → `4003` | `error-code`（风险 high） | 检测 type=error-code、risk=high、理由含人工确认 → Patch 改写期望码 → 未审批不应用 → 审批通过 → 恢复 |
| 对照 | 503 服务错误（非可自愈变更） | - | 不产出建议、不做修改 |

每个场景都证明：**Patch → 重新执行 → 测试恢复**，且「未获审批绝不应用补丁」。

## 三、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm test` | 42 文件 / 661 用例 PASS + 10 skipped（真实 E2E 默认关闭） |
| `npm run agent:test` | 30 文件 / 406 用例 PASS |
| `npm run agent:e2e:healing` | 1 文件 / 4 用例 PASS |
| 新增单元测试 `healing-loop.test.ts` | 12 条 PASS |

## 四、与 Phase 20 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 场景 1：`data.result.url` → `data.output.url` | ✅ 闭环恢复 |
| 场景 2：`status` → `taskStatus` | ✅ 闭环恢复（api-field） |
| 场景 3：错误码 `4001` → `4003` | ✅ 闭环恢复（error-code） |
| 发现 Path 失效 → 分析新 Response → 生成 Patch → Diff | ✅ 确定性检测 + Patch/Diff |
| 人工审批 | ✅ Approval Policy 门禁，未批准不应用 |
| 重新执行 → 测试恢复 | ✅ `runHealingLoop` 验证 `recovered` |
| 不自动修改核心代码 | ✅ 补丁只作用于 Test DSL 副本 |
| 危险动作可审批 | ✅ `apply-healing` 恒 REVIEW，错误码修复风险 high |

## 五、约束符合性与风险

- 未重构 Core / Pipeline / Assertion；未删除 Mock Benchmark 与现有 E2E
- 错误码类自愈风险为 `high`：自动改写期望错误码可能掩盖回归缺陷，
  因此闭环强制人工确认（理由中明示「预期变更还是缺陷」）
- 自愈只作用于测试用例（Test DSL），绝不触碰核心代码

## 六、下一步

进入 **Phase 20.6 QA Workflow**：提供 4 种模式 CLI
（A `--requirement` 全流程、B `--plan-only` 只生成、C `--analyze result.json --rca`、D `--resume task-id`）。
