# 自动回滚（Automatic Rollback）

> Phase 46（43.12 / 43.19 / 43.24）：Candidate 已上线后若发生质量回归，自动
> `DEACTIVATE → ROLLBACK → RESTORE BASELINE`，并记录 RollbackReason / Evidence / Metrics。

## 触发条件

上线后（Canary 放量 / 已激活）发现任一回归：

- Accuracy ↓
- False Pass ↑
- Unsafe Healing ↑
- Critical RCA Miss ↑

## 流程

```
Detect Regression
  → ROLLBACK（恢复基线版本）
  → 记录 RollbackReason / Evidence / Metrics
  → 写审计链路（43.19）
```

```ts
const rec = svc.experiments.rollback(exp.id, {
  reason: '生产 Accuracy 下降 24%',
  metrics: { accuracy: 0.7 },
});
// rec.toRef === 'baseline'：恢复到基线
```

## 回滚记录

```ts
interface RollbackRecord {
  id: string;
  proposalId?: string;
  kind: 'PROMPT' | 'MODEL' | 'RULE' | 'KNOWLEDGE';
  fromRef: string;   // 回滚自
  toRef: string;     // 回滚至（基线）
  reason: string;
  evidence: unknown[];
  metrics: Record<string, number>;
  actor: string;
  createdAt: string;
}
```

## 审计链路（43.19）

每个优化动作（含回滚）记录：`proposalId / actor / baseline / candidate / benchmark / approvalId /
metrics / decision / timestamp`，形成完整链路：

```
Problem → Proposal → Evaluation → Approval → Activation → Observation → Rollback / Success
```

`svc.rollbackExperiment()` 统一走此入口，保证回滚必留审计。

## AI Release Gate（43.24）

AI 自身变更纳入 Release Gate：

```
Prompt Change → Evaluation → Quality PASS → Safety PASS → Cost PASS → Approval → Release
```

## CLI

- `agent canary rollback <id> --reason <...>`
