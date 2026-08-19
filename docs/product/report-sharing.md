# Report Sharing（报告分享）

> 版本：v4.14.0（Phase 39.6）｜ 模块：`src/platform/workflow/run-report.ts`

## 定位

每个 Run 一份报告，可 **Preview / Share / Export JSON / Export HTML**。报告首页突出**关键结论**，不是简单堆数据。

## 报告摘要字段（RunReportSummary）

| 字段 | 说明 |
| --- | --- |
| `releaseDecision` | PASS / REVIEW / BLOCK + result + reason |
| `risk` | LOW / MEDIUM / HIGH / UNKNOWN（按状态与决策推导） |
| `coverage` | total / completed / failed / remaining |
| `failures` | 失败明细 |
| `rca` | 各 Case 的 RCA 分类 + 是否已验证 |
| `cost` | `{ value, tracked, unit }`——**tracked 仅在存在真实 CostLedgerEntry 时为 true**，无数据返回 false，不虚构 KPI |
| `durationMs` | 真实耗时（startedAt→finishedAt） |
| `approvals` | 本 Run 关联审批 |
| `decisionTrace` | Phase 23 DecisionTrace 原样透出，解释「为什么选/跳/败/重规划/停/REVIEW/BLOCK」 |

## 分享与权限

| 操作 | HTTP |
| --- | --- |
| 报告摘要 | `GET /runs/:id/report` |
| 分享 | `POST /runs/:id/share` → 返回 `{ token, url: /runs/:id/report }` |
| 分享信息 | `GET /runs/:id/share` |
| 导出 JSON | `GET /runs/:id/report/export?format=json` |
| 导出 HTML | `GET /runs/:id/report/export?format=html`（自包含单页） |

### 权限校验（双保险）

1. **Project Scope**：所有报告端点经 `withRunScope` → `assertRunAccess`，JWT 用户只能访问其作用域内项目的报告。
2. **RBAC**：读报告需合法身份（401 无 Token / 403 越权）。

**不能通过 URL 猜到其它项目的报告**：即使知道其它项目的 `runId`，不在作用域内一律 403（E2E S7 验证）。

## 为什么这样设计

- 复用 Phase 23 `DecisionTrace` 回答"为什么"。
- 成本 `tracked` 真实性（Phase 39 产品体验指标原则：真实采集，无数据即 `tracked=false`）。
- 分享链接仅暴露当前 Run 摘要，不泄露运维/审计数据。
