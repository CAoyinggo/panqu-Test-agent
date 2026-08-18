# Phase 20.4 变更报告：真实缺陷系统集成（IssueTracker）

> 阶段目标：将 `Defect Draft` 与外部缺陷系统解耦，抽象统一 `IssueTracker` 接口，
> 设计 Jira / 飞书项目 / GitLab Issue / GitHub Issue / 本地 五类适配器，
> 第一阶段只允许生成 Draft，创建正式 Bug 必须 Approval + 开关 + 环境策略三重门禁。

## 一、本阶段变更

### 1. 新增 `src/agents/issues/`（7 个文件）

| 文件 | 说明 |
|---|---|
| `issue-types.ts` | 接口与类型：`IssueDraft` / `ApprovedDefect` / `Issue` / `IssueTrackerConfig` / `IssueTracker`；门禁函数 `requireApproved` / `isApprovedForCreate`；工具函数 `requireTrackerConfig` / `buildIssueBody`（标准 markdown 正文：严重程度 / 复现步骤 / 证据 / RCA） |
| `mock-issue-tracker.ts` | `LocalIssueTracker`：内存版草稿 / Issue 存储，`listIssues()` 便于校验 |
| `github-adapter.ts` | `GitHubIssueAdapter`：Bearer token，`POST /repos/{repo}/issues`，labels=severity，`/search/issues?q=` |
| `gitlab-adapter.ts` | `GitLabIssueAdapter`：PRIVATE-TOKEN，`POST /projects/{id}/issues`，labels=severity |
| `jira-adapter.ts` | `JiraIssueAdapter`：Basic auth，`POST /rest/api/2/issue`，issuetype=Bug，P0→Highest/P1→High/P2→Medium/P3→Low |
| `feishu-adapter.ts` | `FeishuIssueAdapter`：Bearer，`POST /open-apis/task/v2/tasks`，校验 `code!=0` |
| `issue-tracker.ts` | 工厂 `createIssueTracker` / `createIssueTrackerFromEnv`；环境配置加载 `loadIssueTrackerConfigFromEnv`（默认 local）；`IssueTrackerService` 门禁服务 |

### 2. 统一接口

```ts
interface IssueTracker {
  name: string;
  createDraft(input: DefectDraft): Promise<IssueDraft>;   // 第一阶段唯一默认动作
  createIssue(draft: ApprovedDefect): Promise<Issue>;     // 需三重门禁
  searchIssues(query: string): Promise<Issue[]>;          // 只读
}
```

### 3. 三重门禁（`IssueTrackerService.createIssue`）

1. `requireApproved(approved)`：审批结论必须为 `approved`，否则抛「禁止创建正式 Issue」
2. `environmentAllowsCreate(environment)`：`production` / `prod` 一律拒绝（环境默认 read-only）
3. `issueCreateEnabled()`：`ISSUE_CREATE_ENABLED=true` 才允许（默认关闭）

缺任一条件即拒绝；`createDraft` 无任何外部副作用。

### 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ISSUE_TRACKER` | `local` | `github` / `gitlab` / `jira` / `feishu` / `local` |
| `ISSUE_BASE_URL` | - | 适配器地址 |
| `ISSUE_TOKEN` | - | 认证 token |
| `ISSUE_PROJECT_KEY` | - | Jira / 飞书项目 |
| `ISSUE_REPO` | - | GitHub / GitLab 仓库 |
| `ISSUE_USERNAME` | - | Jira Basic auth 用户名 |
| `ISSUE_CREATE_ENABLED` | `false` | 创建正式 Issue 总开关 |

### 5. 其他修改

- `src/agents/index.ts`：新增 issues 模块 7 行导出
- `package.json`：`agent:test` 纳入 `tests/unit/issue-tracker.test.ts`
- `tests/unit/issue-tracker.test.ts`（新增 13 条，见下）
- `tests/unit/agent-pipeline.test.ts`：修复 Trace 耗时断言时序抖动（Mock LLM 同步执行耗时可为 0ms，改为验证耗时已记录且进入汇总）

## 二、测试结果

### 新增单元测试 `tests/unit/issue-tracker.test.ts`（13 条）

- 草稿生成无外部副作用（local 适配器）
- `buildIssueBody` 包含严重程度 / 复现步骤 / 证据 / RCA 引用
- `rejected` / `pending` 审批被拒绝创建
- `requireApproved` 非 approved 抛错
- approved + 开关开启 → 创建成功
- 开关默认关闭 → 拒绝创建
- 生产环境（production / prod）→ read-only 拒绝
- 工厂创建 5 类适配器（github / gitlab / jira / feishu / local）
- 环境变量配置加载（含非法值回落 local）
- `ISSUE_CREATE_ENABLED=true` 生效
- `createIssueTrackerFromEnv` 门禁服务创建
- 环境策略 `environmentAllowsCreate` 判定
- GitHub 适配器缺 token 时 `createIssue` 报「配置缺失」

### 全量回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm test` | 40 文件 / 645 用例 PASS + 10 skipped（真实 E2E 默认关闭） |
| `npm run agent:test` | 29 文件 / 394 用例 PASS |

## 三、与 Phase 20 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 抽象 `IssueTracker` 统一接口（createDraft / createIssue / searchIssues） | ✅ 完成 |
| 至少设计 Jira / 飞书项目 / GitLab Issue / GitHub Issue 适配器 | ✅ 完成（另含 local） |
| 第一阶段只允许生成 Draft | ✅ 完成（createDraft 默认可用） |
| 创建正式 Bug 必须 Approval approved | ✅ `requireApproved` 门禁 |
| 禁止 API Key 写代码 | ✅ token 全部来自环境变量 |
| 向后兼容 | ✅ 既有 DefectAgent / Approval 未改动 |
| 危险动作可审批 | ✅ 创建正式 Issue 三重门禁 |

## 四、约束符合性与风险

- 未重构 Core / Pipeline / Assertion；未删除 Mock Benchmark 与现有 E2E
- `ISSUE_CREATE_ENABLED` 默认 `false`，生产环境默认 read-only，不会误触发外部缺陷系统写入
- 适配器网络调用仅在显式配置并开启时发生；`createDraft` 全程无副作用
- 风险：Jira / 飞书 / GitHub / GitLab 真实 API 需在 `agent:preflight`（20.8）中做连通性探测，本阶段仅提供适配器与门禁，未做真实外部调用

## 五、下一步

进入 **Phase 20.5 Self-Healing Validation**：建立 3 个真实变更场景
（`data.result.url`→`data.output.url`、`status`→`taskStatus`、错误码 `4001`→`4003`），
验证 Patch → 重新执行 → 测试恢复的完整闭环。
