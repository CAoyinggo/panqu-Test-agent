# Phase 24.5：RBAC + Approval 报告

## 1. 目标

建立统一权限模型与审批中心，落实最终链路：

```text
User → RBAC → Tool Permission → Environment Policy → Approval → Execute
```

核心约束：任何角色（含 ADMIN）都不能绕过 RBAC 或生产安全。

## 2. 新增模块

| 文件 | 职责 |
| --- | --- |
| `src/platform/rbac/rbac.ts` | 角色（6 种）/ 权限（11 项）/ `ROLE_PERMISSIONS` 矩阵 / `hasPermission` / `approvalPermissionFor` |
| `src/platform/rbac/access-chain.ts` | `evaluateAccessChain`：RBAC → 环境策略两阶段判定（ALLOWED / APPROVAL_REQUIRED / DENIED） |
| `src/platform/rbac/platform-gate.ts` | `PlatformGate`：组合 RBAC + 环境策略 + Approval Center 的完整门禁（自动发起审批、审批权限校验） |
| `src/platform/approval-center/approval-schema.ts` | `ApprovalRequest` 实体（approvalId / runId / action / riskLevel / environment / requester / reason / evidence / status） |
| `src/platform/approval-center/approval-center.ts` | `ApprovalCenter`：request（幂等）/ approve / reject（仅 PENDING，已决幂等）/ list / pendingCount |
| `src/platform/rbac/index.ts` / `approval-center/index.ts` | 导出 |

## 3. 关键设计

- **角色矩阵**：ADMIN 持全部 11 项权限；QA 可跑/取消/重试测试但不能审批；RELEASE_MANAGER 额外持有 HEALING_APPROVE / RELEASE_APPROVE / PRODUCTION_ACCESS；VIEWER 只读；SERVICE_ACCOUNT 供 CI 使用。
- **访问链路两阶段**：
  1. RBAC：角色必须持有该动作的基础权限（如 production 操作需 `PRODUCTION_ACCESS`）。
  2. 环境策略：复用 24.1 `resolveEnvironmentDecision`（dev/test: risky=allow、dangerous=approval；staging/preprod/production: risky=approval、dangerous=deny）。
  - 环境策略 `deny` → 无条件 DENIED（ADMIN 亦不可绕过）。
  - 环境策略 `approval` → `PlatformGate` 自动向 Approval Center 发起审批，审批通过后才执行。
- **审批权限**：`approvalPermissionFor(action)` 决定审批所需权限（healing → HEALING_APPROVE；release/production → RELEASE_APPROVE）；审批人无权限时 `PlatformGate.approve/reject` 抛错。
- **幂等**：同一 Run 的审批请求使用 `gate:{runId}:{action}:{env}` 幂等键，重复 execute 只创建一份；已决审批不可二次变更。

## 4. 验收结果

| 检查项 | 结果 |
| --- | --- |
| Build（`tsc --noEmit`） | ✅ 通过 |
| 单元测试 `tests/unit/rbac.test.ts` | ✅ 16 / 16 PASS |
| 单元测试 `tests/unit/approval-center.test.ts` | ✅ 7 / 7 PASS |
| `npm test` | ✅ 82 文件 / 1142 用例 PASS（含旧用例，无回归） |
| `npm run agent:test` | ✅ 450 / 450 PASS（Phase 1-23 行为保持） |

关键场景验证：

| 场景 | 结果 |
| --- | --- |
| QA + production + dangerous → RBAC 拒绝 | ✅ DENIED（无 PRODUCTION_ACCESS） |
| RELEASE_MANAGER + production + dangerous → 环境策略拒绝（Scenario 5） | ✅ DENIED（生产安全） |
| ADMIN + production + dangerous | ✅ DENIED（Admin 不可绕过生产安全） |
| production + risky → 自动审批 → 通过后执行（Scenario 6） | ✅ APPROVAL_REQUIRED → APPROVED |
| 审批驳回 | ✅ REJECTED，执行被拒绝 |
| 无审批权限角色审批 | ✅ 抛错 |
| 审批请求幂等 | ✅ 同一 Run 只创建一份 |

## 5. 与任务书对应

- 任务书 9（RBAC + Approval）：✅ 角色 / 权限 / 完整链路 / Approval Center / Admin 不可绕过。
- 任务书 21 Scenario 5 / 6：✅ 单元级验证（集成场景在 24.7 API 与 integration 测试覆盖）。

## 6. 后续

- 审批与 Run / Release 决策联动、审计记录（actor / role / approvalId）在 24.7 Service Layer 与 24.8 审计模块接入。
- Approval Center 已基于 Repository 抽象，可平滑切换 JSON / SQLite 持久化。

下一阶段：24.6 Notification + Event Bus。
