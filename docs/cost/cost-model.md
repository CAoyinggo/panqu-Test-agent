# Cost Model

Phase 52 使用 `CostAttribution` 作为统一成本事实。每条记录必须有 `projectId`，并可进一步绑定 Run、Evaluation、Benchmark、Release、Version、Provider 和 Model。

类别为 `LLM / COMPUTE / STORAGE / NETWORK / WORKER / OTHER`；金额严格按 `quantity × unitCost` 计算，默认沿用平台成本账本币种 CNY。一个账本只接受单一币种，跨币种必须先在采集层换算，禁止直接相加。重复 `id` 幂等，冲突 payload 会拒绝而非静默覆盖。

`CostAttributionLedger.summarize()` 可回答 Cost/Run、Cost/Project、Cost/Evaluation、Cost/Benchmark、Cost/Model，并支持 today、7d、30d、release、version 窗口。`trend()` 提供 daily、weekly、monthly 确定性序列。

平台 `TelemetryService.recordLLM` 产生的真实 token/cost 会由 Cost API 幂等桥接为 `LLM` attribution；缺失 projectId 的旧记录不会被猜测归属。

隔离规则：所有非全局查询必须带 Project Scope；QA/Viewer 只能读授权项目，ADMIN 与映射为 FINANCE/PROJECT_OWNER 的 RELEASE_MANAGER 才能读全局成本。任何项目缺失都不会回退到其它项目。
