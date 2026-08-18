# Phase 21.3 变更报告：Continuous Regression 持续回归 + Change Impact Analysis

> 阶段目标：建立 Regression Scheduler / Planner / Trigger / History，支持 PR / 发布 / 模型发布 /
> 配置变化 / 价格变化 / 环境变化 / 人工 / 定时触发；落地变更影响分析（本阶段最重要的能力），
> 形成 Change → Impact Analysis → Test Selection → Regression 链路；引入统一 Test Run ID。

## 一、本阶段变更

### 新增 `src/regression/`（6 个文件，未修改任何既有 src 文件）

| 文件 | 说明 |
|---|---|
| `regression-schema.ts` | `ChangeEvent`（7 种变更类型：code / model / api / config / pricing / environment / requirement）+ `RegressionTriggerType`（8 种触发）+ `ImpactAnalysis` + `RegressionPlan` + `RegressionRun` + **`generateRunId()` 统一 Test Run ID** + `normalizeChangeEvent` 校验 |
| `impact-analyzer.ts` | **Change Impact Analysis**：变更 → 受影响业务 / 能力 / TestCase / 风险 + 命中原因。确定性实现：业务注册中心（能力映射）+ 资产库（标签/内容匹配）；全局型变更（code/config/environment）未定位业务时按全局处理 |
| `regression-planner.ts` | **Regression Planner**：仅选择受影响用例（不执行全量），P0/P1 全量 + P2 影响直选 + P3 默认排除（includeP3 可开）+ 预算超限从 P2 反向裁剪（保 P0/P1），每条选择/跳过带 reason；`assetPriority`（content > tags > 默认 P2）；`summarizePlan` |
| `regression-history.ts` | **Regression History**：runId 为主键记录运行，query（feature/trigger/status/limit）、failureChain（runId → 失败 → RCA/Defect）、trend（最近 N 次通过率与状态分布）、JSON 持久化（损坏降级空历史） |
| `regression-scheduler.ts` | **Regression Scheduler**：`trigger(change, triggerType, options)` 端到端（变更 → 影响 → 计划）；`completeRun(plan, feature, outcome)` 记录历史并 **runId 资产串联**（execution 资产 metadata.runId + case→exec→rca→defect 建链，幂等） |
| `index.ts` | 统一导出 |

### package.json

新增 `agent:impact:test` 与 `agent:regression:test`（任务书验收命令）。

### 统一 Test Run ID 贯穿

```text
runId（run-<日期>-<时间戳>-<序号>）
  ├─ RegressionPlan.runId / RegressionRun.runId（回归域）
  ├─ execution 资产 metadata.runId（资产域）
  ├─ case ──executes──▶ exec-<runId> ──failed-as──▶ rca ──caused──▶ defect（追踪链）
  └─ history.failureChain(runId)：任一失败可找回完整链路
```

## 二、测试结果

### 新增单元测试（20 条）

- `tests/unit/impact-analyzer.test.ts`（10 条）：ChangeEvent 校验、runId 唯一性（50 连发无碰撞）、
  模型变化定位业务/能力/用例、归档用例排除、显式 businessId、价格变化计费风险、全局变更、
  未知目标空影响、无注册中心关键词匹配
- `tests/unit/regression.test.ts`（10 条）：assetPriority 三级来源、**不执行全量**（未受影响 + P3 跳过）、
  includeP3、预算裁剪保 P0/P1、空影响全跳过、历史 record/query/trend/幂等、save/load、
  调度器端到端（runId 串联 + trace 验证 case→exec→rca→defect）、completeRun 幂等

### 回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:impact:test` | 10/10 PASS |
| `npm run agent:regression:test` | 10/10 PASS |
| `npm run agent:test` | 34 文件 / 450 用例 PASS（零变化） |
| `npm test` | 52 文件 / 780 用例 PASS + 18 skipped（760 → 780） |

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 新增 `src/regression/`（Scheduler / Planner / Trigger / History） | ✅ 四组件齐备 |
| 支持 PR / 代码发布 / 模型发布 / 配置变化 / 价格变化 / 环境变化 / 人工触发 / 定时任务 | ✅ 8 种 `RegressionTriggerType` |
| Change Impact Analysis（代码/模型/接口/配置/需求变化 → 受影响功能/场景/用例/风险/建议执行集合） | ✅ `analyzeChangeImpact` 输出业务/能力/用例/风险 + reasons |
| 代码变化 → 影响分析 → 测试选择 → P0/P1 回归，不每次执行全部 Case | ✅ Planner 跳过未受影响用例（测试验证 skipped 非空） |
| 统一 Test Run ID（runId/taskId/feature/caseId/executionId/defectId 串联） | ✅ runId 贯穿计划/运行/资产/历史，trace 可回完整链路 |
| 复用 Phase 1-20 | ✅ 复用 21.1 业务注册中心 + 21.2 资产库；选择策略与 TestSelectionAgent 对齐（其输入为 agent 层 Requirement+TestCase，与资产形态不匹配，故 Planner 按同策略实现，避免强制转换层） |
| 验收命令 `agent:impact:test` / `agent:regression:test` | ✅ 已添加并通过 |

## 四、约束符合性与风险

- 未重建 Test Engine / Memory / Pipeline；`src/regression/` 纯增量，未修改既有文件（package.json 仅加脚本）
- 影响分析为确定性匹配（业务注册中心 + 标签/内容关键词），不依赖 LLM、不引入向量库
- 风险：影响分析召回依赖用例资产的 tags/content 质量（覆盖点需写入资产），接入 pipeline 自动落资产后召回率会提升
- 风险：`generateRunId` 序号进程内递增，同毫秒跨进程理论上可碰撞（时间戳 36 进制已大幅降低概率）；
  生产接入时可用 UUID 替换，接口不变
- 遗留：定时触发的实际 cron 接线（schedule trigger 的类型与入口已就绪）依赖 CI Nightly，
  与 21.8 Production Operations 的运维编排一并落地

## 五、下一步

进入 **Phase 21.4 Defect Lifecycle**：缺陷状态机（DRAFT → REVIEW → CREATED → ASSIGNED →
FIXING → FIXED → REGRESSION → VERIFIED），支持 Known Issue / Duplicate / Won't Fix /
Fixed / Regression Failed；失败 → 搜索历史 Issue → 重复判定 → 关联已有 Bug，
避免同一问题每次回归创建新 Bug。
