# QA Workflow（QA 工作台）

> 版本：v4.14.0（Phase 39.5 / 39.7）｜ 模块：`src/platform/workflow/collaboration.ts` + `qa-home.ts`

## 一、协作（Collaboration）

失败 Case 上的人机协同：评论 / @提及 / 指派 / 关注。

```ts
interface CollaborationItem {
  id: string;                     // collab-<resourceType>-<resourceId>
  resourceType: 'run' | 'suite' | 'plan';
  resourceId: string;
  projectId: string;
  comments: CommentEntry[];       // { id, actor, text, mentions, createdAt }
  assignees: string[];
  watchers: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 能力与语义

| 操作 | HTTP | 说明 |
| --- | --- | --- |
| 评论 | `POST /runs/:id/comments` | 解析 `@user` → `mentions` |
| 评论列表 | `GET /runs/:id/comments` | — |
| 指派 | `POST /runs/:id/assign` | `{ assignee }` 写入 assignees |
| 关注 | 服务 `setWatcher` | 关注/取消关注 |

- **@ 提及触发通知**：评论含 `@zhangsan` 时发布 `CollaborationMention` 事件，经既有 Notification Channel 通知（复用 Phase 24.6 通知桥接，零新增通道）。
- **审计**：评论 / 指派分别记录 `collaboration.comment` / `collaboration.assign` 审计动作（复用既有 AuditLog）。
- **跨项目隔离**：评论写操作校验 Run 项目归属。

### 示例

```
Case: wan3-1080p-10s
RCA: MODEL_ERROR
@zhangsan 请确认模型服务是否刚发布。
```

## 二、QA Home（QA 工作台首页）

首页目标不是展示 Metrics，而是 **告诉 QA 现在应该做什么**。

```ts
interface QaHome {
  projects: Project[];
  todayRuns: number;
  runningRuns: TestRun[];
  failedRuns: TestRun[];
  pendingApprovals: ApprovalRequest[];
  recentFailures: TestRun[];
  recentDefects: Defect[];
  recentReleases: ReleaseRecord[];
  commonPlans: TestPlan[];
  commonTemplates: RunTemplate[];
  flakyCases: FlakyCase[];
  highRiskCases: RiskCase[];
  actionCenter: ActionItem[];    // 按严重度排序的待办
}
```

### Action Center

真实聚合六类待办（无数据即不出现，不虚构）：

- `RELEASE`：Release REVIEW 等待审批 → 直达审批页
- `APPROVAL`：待处理审批 → 直达审批页
- `FAILURE`：P0/P1 失败 Run → 直达 Run 详情
- `WORKER`：异常 Worker → 直达 Worker 页
- `FLAKY`：待确认 Flaky Case → 直达 Runs
- `RCA`：待人工确认 RCA → 直达 Run 详情

### 快速操作

`Create Test Plan` / `Run Regression` / `Run Autonomous` / `Create Suite` / `Create Run Template` / `Open Failed Runs` / `Open Pending Approvals` —— 一次点击直达，减少多层菜单。

### 接入点

- Service：`qaHome(scopes?, now?)`
- API：`GET /qa-home`（Web QAHome 页每 3 秒轮询）

## 三、历史 Run 快速复用（Run Detail）

| 操作 | HTTP | 复制 | 不复制 |
| --- | --- | --- | --- |
| Run Again | `POST /runs/:id/rerun` | project/environment/suite/plan/mode/budget | 旧状态/结果/RCA/门禁决策 |
| Clone Configuration | `POST /runs/:id/clone` | 同 Run Again + 可改 environment/budget/releaseGate | 旧状态/结果/追踪/决策 |
| Create Template | `POST /runs/:id/template` | 配置 → RunTemplate | 结果/RCA/决策 |
| Create Regression Plan | `POST /runs/:id/template` + plan 化 | 配置 | 结果/RCA/决策 |
