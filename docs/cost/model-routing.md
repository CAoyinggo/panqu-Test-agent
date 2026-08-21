# Model Routing

`ModelPolicy` 按 project/domain 定义 primary、fallback、maxCost、maxLatencyMs、SHADOW/PRODUCTION 与状态。候选模型按 Quality、Cost、Latency、Failure Rate 联合评分。

简单任务提高成本权重，优先低成本模型；复杂/关键任务提高质量权重，关键任务在满足上限时优先使用策略主模型。每次决策返回 complexity、selected model、score 以及质量、成本、延迟和权重 trace，可直接回答“为什么使用这个模型”。

新生产策略不能自动生效。建议必须经过人工批准，再通过 shadow 与 5% → 20% → 50% → 100% canary。无候选满足限制时使用显式 fallback，不会静默选择最贵模型。
