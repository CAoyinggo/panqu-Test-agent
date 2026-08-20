# Shadow 与 Canary（安全上线）

> Phase 46（43.9 / 43.10 / 43.13 / 43.14）：新 Prompt / Model 第一次上线先 Shadow，再 Canary
> 分级放量，异常自动停止扩展 / 自动回滚。

## A/B 评测（43.9）

Baseline vs Candidate，至少比较五个维度：

| 维度 | 说明 |
| --- | --- |
| Accuracy | 准确率 |
| Latency | 延迟（ms） |
| Cost | 成本 |
| Failure Rate | 失败率 |
| Safety | 安全（0 = 无安全事件） |

**不要只看 Accuracy。**

```ts
// 示例：Prompt A vs Prompt B
// Prompt A：Accuracy 91% / Cost 1 / Latency 500ms
// Prompt B：Accuracy 94% / Cost 1.5 / Latency 620ms
```

## 多目标评分（43.10）

`QualityScore` 由 Quality / Safety / Latency / Cost 加权合成，但**保留原始指标**（不输出黑盒分数）。

默认权重：`quality 0.5 / safety 0.3 / latency 0.1 / cost 0.1`（`DEFAULT_OBJECTIVE_WEIGHTS`）。

## Shadow Mode（43.13）

新 Prompt / Model 第一次上线先进入 Shadow：

- 真实 Run 时：Baseline 执行 + Candidate Shadow 并行
- Candidate **不影响 Release / 不修改 Defect / 不执行 Healing / 不改变生产状态**
- 只记录 Prediction / Score / Latency / Cost

```ts
svc.experiments.createShadow({ proposalId, candidateRef });
svc.experiments.recordShadowObservation(exp.id, { baseline, candidate }); // 只读比较
```

## Canary（43.14）

Shadow 通过后按阶段放量：

```
5% → 20% → 50% → 100%
```

每个阶段检查 Accuracy / Safety / Cost / Latency / Error Rate：

- 异常 → **自动停止扩展**
- 严重异常 → **自动回滚**

```ts
svc.experiments.createCanary({ proposalId, candidateRef }); // canaryStage = '5%'
svc.experiments.canaryPromote(exp.id, { metrics });         // '20%' → '50%' → '100%' → PROMOTED
```

## API / CLI

- `GET /api/experiments`；`POST /api/experiments`（RELEASE_APPROVE）
- `agent canary status` / `promote` / `rollback`
