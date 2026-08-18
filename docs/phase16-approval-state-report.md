# Phase 16 变更报告：Approval / Human-in-the-loop + 状态机

> 阶段目标（任务书第十节 / 十六节 / 十七节）：风险操作分级审批（AUTO/REVIEW/MANUAL/DENY）
> + 审批审计日志 + Agent 状态机（checkpoint / resume / pause / cancel / retry / 失败可恢复）。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `src/agents/approval/approval-schema.ts` | `ApprovalRequest` / `ApprovalResult` / `RiskOperation` 数据模型 + 归一化 |
| `src/agents/approval/approval-policy.ts` | 确定性分级策略：环境 × 严重度 × 操作类型 → AUTO/REVIEW/MANUAL/DENY |
| `src/agents/approval/approval-audit.ts` | `ApprovalAuditLog` 审计日志（内存 + 可选持久化回调，不可被 Agent 篡改） |
| `src/agents/core/agent-state-machine.ts` | 完整状态机：13 个主状态 + 4 个异常态 + checkpoint/resume/pause/cancel/retry/序列化 |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `src/agents/index.ts` | 新增 approval 模块 + state-machine 导出 |
| `package.json` | `agent:test` 追加 `approval.test.ts`、`state-machine.test.ts` |

## 三、新增测试

| 测试文件 | 数量 | 覆盖点 |
|---|---|---|
| `tests/unit/approval.test.ts` | 11 | 分级策略（AUTO/REVIEW/MANUAL/DENY 全路径）/ 审计日志（system/user/持久化回调）/ 归一化 |
| `tests/unit/state-machine.test.ts` | 14 | 顺序转移 / 跳步回退拒绝 / 终态锁定 / pause-resume / fail-retry / waitForApproval / cancel / checkpoint / toJSON-fromJSON 续跑 |

## 四、关键设计决策

1. **审批分级确定性规则**（任务书示例逐条实现）：P0+Production→MANUAL、P1+Test→REVIEW、P2/P3+Test→AUTO；生产 + 真实扣费/删数据/改库→DENY；测试环境创建缺陷/应用自愈→REVIEW（不自动改码/不自动提缺陷）。
2. **审计不可篡改**：`ApprovalAuditLog.record` 只增不改，记录决策/结论/操作者/时间，支持持久化回调；持久化失败不阻断审批（内存保留）。
3. **状态机严格顺序**：`transition` 只允许顺序前进；跳转到后续阶段（如 Execution 失败后从 Analysis 恢复）由 `resume(from)` 完成，契合「失败必须可恢复」。
4. **序列化续跑**：`toJSON/fromJSON` 支持 checkpoint 持久化，重启后恢复到失败前状态继续执行（任务书第十七节）。

## 五、验证结果

- `npm run build` ✅
- 新增单测：25/25 通过
- `npm test`（全量回归）：31 文件 / 539 测试通过（较 Phase 15 的 514 增加 25）
- 未破坏既有能力

## 六、进入 Phase 17 的前置说明

Phase 17 Observability 将记录每个 Agent 的 Token/Latency/Cost/Tool 调用/回退次数，生成 Agent Trace；
Budget 用于限制 Token/调用次数/执行时间，防止无限循环；Model Router 按任务分配合适模型。
