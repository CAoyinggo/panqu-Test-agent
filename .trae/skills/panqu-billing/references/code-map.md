# Panqu 计费与对账代码入口映射

## 后端核心代码（aibaseos - ThinkPHP 5）

1. **计费总入口与报表**：
   - 路径：`application/admin/controller/aivideo/v2/Billing.php`
   - 关键方法：
     - `ApiSummary()`：企业可用积分与消耗汇总；
     - `Dashboard()`：大盘累计消耗、模型调用分布（section=modelDist）、模型下拉（section=models）；
     - `Personal()`：个人消费记录与排行榜；
     - `ApiDetailRecords()`：消费明细分页列表；
     - `CostInspectorData()`：成本核查单价。
2. **积分预估与任务发起**：
   - 路径：`application/admin/controller/aivideo/v2/Points.php` / `Task.php`
   - 关键方法：
     - `Preview()`：计费预估，返回 required_points；
     - `Videonew/add()`：视频任务创建与积分冻结。
3. **数据库表与模型**：
   - 积分配置表：`pq_absetting`（单价）、`pq_model_config`（模型元数据）；
   - 积分日志流水：`pq_score_log`（当月最新）及 `pq_score_log_archive_YYYYMM`（历史归档）。

## 中台代码（aipanqucenter - NestJS）

1. **刊例价计算与模型目录**：
   - `src/modules/integration-platform/`：`/integration-platform/models/estimatedBilling`；
   - `src/modules/expense/`：`/expense/user/getMany` 与 `/expense/admin/getMany`。
