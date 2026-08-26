# Phase 24 平台化现状分析与最小改造路径（24.0）

- 阶段：24.0 Platform Analysis（扫描 → 分析 → 规划）
- 目标：为 24.1–24.8 提供现状依据与最小改造路径
- 原则：复用 Phase 1-23，保持向后兼容，不重写 Core / Assertion / Autonomous Engine

## 一、现状盘点（11 项）

### 1. 当前 Project / Environment 能力
- **无 Project 实体**：全库无 Project 模型/仓库；仅业务侧 `project_id`（`src/core/types.ts` `EnvironmentConfig.project_id`）。
- **Environment 有两层**：平台配置层（`src/config/environments.json`：test / preonline）+ 安全策略层（`src/config/environment-policy.ts`：`EnvironmentTier`、`PRODUCTION_FORBIDDEN_ACTIONS`、`guardProductionAction`）。
- **安全判定散落 3 处**：`environment-policy.ts` / `approval-policy.ts` / `tool-registry.ts` 各自维护 prod/preonline 判定，`environments.json` 无 `safetyPolicy` 字段。

### 2. 当前 Storage 接口
- 全部 JSON 文件持久化（`writeFileSync` + `readJson/writeJson`，`src/utils/fs-utils.ts`）。
- 各存储类为「内存 Map/数组 + save/load + JSON.stringify」：`RegressionHistory`、`TestAssetStore`、`CostLedger`、`JsonMemoryStore`、`TaskRecord`。
- 唯一可替换接口：`TestMemory`（`src/agents/memory/memory-store.ts`）。无统一 `Repository<T>`。

### 3. 当前 Run 状态
- `RegressionRunStatus` 仅结果态：`PASS | FAIL | PARTIAL | BLOCKED`，无 `QUEUED/RUNNING/PAUSED` 过程态。
- 存在两套 runId：`regression.generateRunId()` vs `autonomous-${nowMs}`（口径不一致）。
- 运行级状态机缺失（`AgentStateMachine` 是 Agent 流程级，非 Run 级）。

### 4. 当前 Scheduler / Worker 能力
- `RegressionScheduler` 为同步纯函数编排（变更→影响→计划→记录），无定时器/队列/Worker 池/任务持久化。
- `RegressionTriggerType` 已含 `schedule` 但无实现。全库无真实 Job Queue / Worker。

### 5. 当前 Permission / Approval
- **Approval 较完整**：`src/agents/approval/`（`evaluateApproval` 确定性分级、`ApprovalAuditLog`、`ApprovalRequest`）。
- **Tool Permission**：`src/agents/tools/tool-registry.ts` `enforcePermission`（strict/permissive + onApproval 回调）。
- **Exploration 内置三进门禁**：Risk / Budget / Permission。
- **缺失**：RBAC（无用户/角色/权限点）、approval-center（无持久化审批中心）。

### 6. 当前 Dashboard
- Agent KPI：`src/qa/dashboard.ts`（`output/<date>/agent-summary.json`）。
- Operations 视图：`src/operations/operations-aggregator.ts`（`OperationsView` + HTML，含 autonomous 区块）。

### 7. 当前 CI/CD
- 5 个工作流：`agent-release-gate.yml`（PR/push 触发，REVIEW 挂 `environment: release-approval` 人工审批）、`agent-test.yml`（p0-p1 + p2-p3-nightly）、`release.yml`、`security.yml`、`test.yml`；另有 `.gitlab-ci.yml`。

### 8. 可复用的模块
| 模块 | 位置 | 复用方式 |
|---|---|---|
| 决策轨迹 | `src/decisions/decision-recorder.ts` | Trace 记录 |
| 统一观测 | `src/agents/observability/unified-trace.ts` | 四轨 trace |
| 发布门禁 | `src/operations/release-gate.ts` / `src/release-decision/` | Release Decision |
| 回归编排 | `src/regression/regression-scheduler.ts` | 作为 Worker 内执行体 |
| 自适应停止 / 探索 / 组合 | `src/stopping/` `src/exploration/` `src/portfolio/` | 自治引擎 |
| 审批策略 | `src/agents/approval/approval-policy.ts` | 确定性分级 |
| Tool 权限 | `src/agents/tools/tool-registry.ts` | 执行点 |
| 记忆接口 | `src/agents/memory/memory-store.ts` | 存储可替换样板 |
| 资产库 | `src/test-assets/asset-store.ts` | Asset 管理 |
| 成本 | `src/cost/cost-ledger.ts` | 成本台账 |
| 运维视图 | `src/operations/operations-aggregator.ts` | Dashboard |
| 通知 | `src/integrations/notifiers/feishu.ts` | Feishu 通道 |

### 9. 需要扩展的接口
- Run 状态模型扩展（过程态 + 状态机 + 持久化）；统一 runId。
- 真实 Scheduler / Queue / Worker（异步 Job、优先级、重试、超时、幂等消费、cron 触发）。
- 统一 `Repository<T>`（SQLite / JSON / Memory 可替换）。
- RBAC（用户/角色/权限点 + `permission-check`）。
- Approval Center（持久化审批中心 + 回执）。
- 环境安全策略单一策略源（`environments.json.safetyPolicy`）。
- Notification Center（多渠道 + 事件路由 + 重试）。
- SLO / EventBus / Audit / Idempotency。

### 10. Breaking Change 风险
- **低**：全部测试相对路径导入（NodeNext + `.js` 后缀），无 `paths` 别名；`src/platform` 全新目录无命名冲突；`npm test` 自动纳入新增测试。
- **需管控**：与 `src/agents/approval`、`src/config/environment-policy` 的功能边界（复用而非复制）；`operation` 枚举兼容性；不破坏 `src/agents/index.ts` 等现有 barrel。
- `agent:test` 是显式文件清单，新增测试需手动追加（platform:* 脚本单独管理）。

### 11. Phase 24 最小改造路径
```
24.1 projects/  Project + Environment + 单一环境安全策略（新增，不碰现有）
24.2 storage/   Repository<T> 接口 + Memory/JSON 实现（可替换 SQLite）
24.3 runs/ + scheduler/  TestRun 状态机 + Checkpoint + TestJob 队列（优先级/重试/超时/幂等）
24.4 workers/   Worker 注册/心跳/健康/调度（环境+能力+并发+健康）
24.5 rbac/ + approval-center/  权限链 + 持久化审批中心
24.6 events/ + notifications/  EventBus + 多渠道通知
24.7 service/ + api/ + bin/   统一 Service Layer + HTTP API + CLI 子命令
24.8 metrics/ + audit/ + idempotency/ + platform dashboard
```

## 二、平台分层（Modular Monolith）

```text
src/platform/
├── projects/        Project / Environment / 安全策略
├── storage/         Repository<T>（Memory / JSON / SQLite 可替换）
├── runs/            TestRun 状态机 / Checkpoint
├── scheduler/       TestJob / 队列 / 优先级 / 重试 / 超时
├── workers/         Worker 注册 / 心跳 / 调度
├── rbac/            User / Role / Permission
├── approval-center/ 审批中心（持久化）
├── events/          In-Process EventBus
├── notifications/   Feishu / DingTalk / Email / Webhook
├── service/         统一 Service Layer（API 与 CLI 共用）
├── api/             HTTP API（node:http，无外部依赖）
├── metrics/         平台指标 + SLO
├── audit/           审计日志
├── idempotency/     幂等键
└── index.ts
```

## 三、结论
现状：能力已覆盖「自治测试引擎」全链路，但缺少平台化骨架（Project / Run 状态机 / 队列 / Worker / RBAC / API / 审计 / 通知 / 指标）。Phase 24 在不重写引擎、不引入重基础设施（无 Kafka / Kubernetes）前提下，以 Modular Monolith 补齐平台层，全部新增，向后兼容。
