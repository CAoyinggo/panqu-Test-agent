# 错误分析（Error Analysis）

> Phase 46（43.3 / 43.4）：Evaluation 失败后不仅输出 `Score = 0`，还自动分析：
> 为什么失败？属于哪类错误？集中在哪个项目 / 模型 / Prompt / Tool / 环境？

## 错误分类（43.3 Error Taxonomy）

统一分类：

| 分类 | 含义 | 示例 |
| --- | --- | --- |
| `WRONG` | 输出与真值不符 | 预测类别 / 字段错误 |
| `MISSING` | 应当输出但缺失 | 断言 / 根因覆盖不全 |
| `OVER_PREDICTION` | 过度预测 | 风险虚高 / 过度 BLOCK |
| `UNDER_PREDICTION` | 低估 / 漏判 | Risk 判 P2、实际 P0 |
| `DUPLICATE` | 重复产出 | 重复创建缺陷 |
| `UNSAFE` | 不安全行为 | 掩盖真实 Bug 的自愈 |
| `INCONSISTENT` | 自相矛盾 | 部分命中但字段冲突 |
| `LOW_VALUE` | 低价值输出 | 产出但对决策贡献有限 |

分类为**确定性规则**推导（可复现、不消耗 token）。例如 `Risk=P2 → 真值 P0` 自动归类为
`UNDER_PREDICTION`。

## 错误聚类（43.4）

输入：反馈（`AIFeedback[]`）+ 评测失败（`evalFailures[]`）。
输出 `ErrorCluster[]`：

```ts
interface ErrorCluster {
  id: string;                 // 确定性 id：同一 domain+category 永远相同 → 提案幂等去重
  domain: AiDomain;
  category: ErrorTaxonomy;
  count: number;
  cases: string[];            // 关联用例（无 caseId 时用反馈 id）
  suspectedCause?: string;    // 规则启发（非虚构）
  evidence: unknown[];        // 原始快照
  createdAt: string;
  lastSeenAt: string;
}
```

聚类键 = `domain + category`，按 count 降序排列，便于定位「错误最集中」的领域与类型。

## 疑似根因启发

每条分类带确定性根因启发（`suspectedCause`），例如：

- `UNDER_PREDICTION` → 规则 / 模型对严重度、临界用例、关键风险的敏感度不足
- `UNSAFE` → 自愈 / 决策可能掩盖真实 Bug 或产生副作用

## 使用

```ts
svc.errorClusters();           // 从反馈自动聚类
analyzeErrors({ evalFailures }); // 从评测失败聚类（Phase 45 runner 输出）
```

## API

- `GET /api/ai-errors`

## CLI

- `agent eval errors`：查看当前错误聚类
