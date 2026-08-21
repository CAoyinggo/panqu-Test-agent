# Capacity Planning

第一版容量规划完全确定性，支持 1h、6h、24h、7d、30d。算法同时使用历史平均、线性趋势和历史峰值，输出 Expected Runs、Expected Cost、Expected Queue、Expected Worker Count。

Expected Runs/Cost 使用平均值加有界趋势；Expected Queue 不低于历史峰值；Expected Worker Count 由 queue/jobsPerWorker 向上取整且至少为 1。无历史样本时返回零需求与一个安全 worker，不虚构观测数据。

Web 展示当前成本、30 天预测和预算；API/CLI 同时返回五种周期及计算 trace。
