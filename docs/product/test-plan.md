# Test Plan（测试计划）

> 版本：v4.14.0（Phase 39.2）｜ 模块：`src/platform/workflow/test-plan.ts`

## 定位

Test Plan 是 QA **可运行的工作单元**：把多个 Suite 绑定到某个环境与运行模式，即可一键启动 Run。层级为 `Test Plan → Suite → TestCase`。

```ts
interface TestPlan {
  id: string;
  projectId: string;
  name: string;
  suiteIds: string[];                 // 引用 Suite（Suite 再引用 Case）
  environment: string;                // test / staging / preprod / production
  mode: 'MANUAL' | 'REGRESSION' | 'AUTONOMOUS';
  priorityPolicy?: unknown;           // 预留：优先级策略
  budget?: number;                    // 预留：执行预算
  releaseGate?: boolean;              // 预留：Release 门禁
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

## 能力

| 操作 | Service 方法 | HTTP |
| --- | --- | --- |
| 创建 | `createPlan(input, role)` | `POST /test-plans` |
| 列表 | `listPlans(filter?, scopes?)` | `GET /test-plans` |
| 详情 | `getPlan(id)` | `GET /test-plans/:id` |
| 修改 | `updatePlan(id, patch, role)` | `PATCH /test-plans/:id` |
| 运行 | `runPlan(id, actor, role, scopes?)` | `POST /test-plans/:id/run` |
| 解析用例 | `planCases(id)` | `GET /test-plans/:id/cases` |

## 运行语义

`runPlan` 把 Plan 展开为一次 Run：

1. 解析 `suiteIds → caseIds`（经 Suite 引用，自动去重）。
2. 创建 Run 并固定 `planId` / `suiteIds` / `environment` / `mode`。
3. Run 生成时写入 `assetVersion`（各 Case 当前版本快照，见 asset-versioning）。
4. 入队执行（复用既有 Scheduler / Worker / Checkpoint / Gate）。

## 权限

创建/修改需 `ASSET_WRITE`；运行需 `TEST_RUN`；`runPlan` 支持传入 `scopes` 做项目隔离。

## CLI

```bash
agent plan list
agent plan create --name "WAN3 回归计划" --project wan3 --environment staging --mode AUTONOMOUS --suites <suiteId> --budget 10
agent plan run <planId>        # 展开并执行
agent plan cases <planId>      # 查看解析出的用例
```
