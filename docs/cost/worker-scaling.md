# Worker Scaling

Adaptive Scaling 输入 Queue Length、Oldest Queue Age、Worker Utilization、Run Priority 和 Estimated Cost，输出 desired worker count、UP/DOWN/HOLD、原因与 trace。

硬边界为 minWorkers/maxWorkers；jobsPerWorker 决定基础容量，队列老化、高优先级、高利用率分别提供可解释 boost。队列为空缩至 minWorkers，预计成本超过策略上限时不扩容。cooldown 期间保持当前数量，防止 Up/Down 震荡。

Worker assignment 还必须同时满足 maxConcurrentJobs、cpuLimit 和 memoryLimitMb，任一超限就拒绝分配。生产伸缩需要人工权限并写审计。
