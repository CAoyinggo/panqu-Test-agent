# Resource Optimization

优化建议包含当前策略、候选策略、预期成本变化和预期质量变化，初始状态固定为 `RECOMMENDED`，默认仅建议。

生产流程为：Recommendation → Human Approval → Shadow/Canary → Activate。Canary 只能按 5%、20%、50%、100% 前进。成本或延迟达到警戒线时 `STOPPED`；质量下降、失败率上升或成本严重回归时 `ROLLED_BACK` 并把流量恢复为 0%。

版本回归规则：成本上升至少 50% 且质量无提升为 `REVIEW`；成本/延迟翻倍或质量严重下降为 `BLOCK`。`paretoFrontier()` 排除质量更低且成本更高的被支配模型，保留最优成本、最优质量和均衡候选。

审批、激活、灰度、停止、回滚都记录 Actor、Timestamp、Project、Action 与 Trace。
