# Developer Self-Test

Developer Self-Test 将代码变更转换为可追溯的最小自测闭环：

```text
Change / Requirement
  → Discovery Candidate
  → Contract Resolver
  → Operation Graph / Risk
  → 3~8 个 P0 Scenario
  → Execution Guard
  → Processor + Observer
  → Assertion + Evidence
  → READY / PARTIAL / BLOCKED / FAILED
```

## 使用方式

```bash
npm run self-test -- \
  --requirement requirements/new-feature.md \
  --changed HEAD~1..HEAD \
  --env test
```

也可以显式指定变更文件和只读入口：

```bash
npm run self-test -- \
  --changed-files src/routes/user.ts,web/src/UserPanel.tsx \
  --entrypoint http://127.0.0.1:3000/api/users/1 \
  --base-url http://127.0.0.1:3000 \
  --env test \
  --mode safe
```

默认模式为 `SAFE`。`LIVE` 必须同时提供 `--approval`、`--budget`，且有副作用的 Scenario 还必须声明可用的 Cleanup/Rollback 和完整 Observer。

## 三种模式

- `DRY_RUN`：只做文件/API Discovery、Contract Resolution、风险与 Pack 生成；Processor 调用数为零。
- `SAFE`：允许 GET/HEAD/OPTIONS，以及显式声明 `sideEffectFree=true`、预期为拒绝结果的非法参数探针。其他写操作和真实扣费在调用前阻断。
- `LIVE`：允许真实业务动作，但必须通过审批、预算、项目 Policy、Cleanup/Rollback 与 Evidence Gate。

## Discovery 与 Contract 边界

Route、Controller、OpenAPI、Frontend Network 和 Runtime Observation 只产生 Candidate。Candidate 注册后仍须由 Phase 1 `ContractResolver` 得到 `RESOLVED`；`UNKNOWN / CONFLICT / STALE / DRIFT` 均不能执行。

Runtime Discovery 不会自动调用正常的 POST/PUT/PATCH/DELETE。Mutation 探针必须显式提供非法输入、允许的拒绝状态以及 `sideEffectFree: true`。

## Observer 与 Evidence

HTTP Processor 只天然证明 REQUEST/RESPONSE。只有独立 GET/HEAD/OPTIONS 观察 Operation 才能把响应作为 API State Observer；Mutation Response 不能冒充持久化证据。

通用 Observer 包括：

- `StateObserver`
- `DatabaseObserver`
- `TaskObserver`
- `BillingObserver`
- `AuditObserver`
- `BrowserObserver`

这些 Observer 必须绑定真实 Probe。未配置 Probe 时 `available=false`；所需 Evidence 缺失时 Scenario 为 `BLOCKED`，不能生成 PASS。

## Feature 结论

- `READY`：所有 P0 都真实执行、断言通过且 Required Evidence 完整。
- `PARTIAL`：部分 P0 有完整 PASS，但仍有 BLOCKED/NOT_EXECUTED。
- `BLOCKED`：没有 P0 获得完整执行证据，或 Contract/环境/Processor/Observer 不足。
- `FAILED`：至少一个真实执行的 P0 确定性断言失败。

报告同时列出 Unknowns，不会把未知状态折算为通过。
