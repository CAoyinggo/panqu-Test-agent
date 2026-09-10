# Panqu NewAPI 与分流代码入口映射

## 主站分流决策代码（aibaseos - ThinkPHP 5）

1. **模型配置与全量开关**：
   - 数据表：`pq_model_config`，关键字段 `is_newapi_global`（1:全量走NewAPI，0:走旧线路）；
   - 控制器：`application/admin/controller/aivideo/v2/ModelConfig.php`。
2. **渠道管理与参数配置**：
   - 控制器：`application/admin/controller/aivideo/v2/Channel.php`；
   - 参数字段：`ability` (全能参考/首尾帧)、`resolutions`、`ratios`、`environment` (正式/测试)。
3. **分流路由与重试逻辑**：
   - 线路配置表：`pq_aivideo_diversion_config`；
   - 调度方法：`application/admin/controller/aivideo/v2/Diversion.php`。

## NewAPI 网关配置

- 网关地址：`https://aiapis.panqu.com`；
- 分组管理：`panqu_test`（测试分组）、`panqu_tao`（正式业务分组）；
- 渠道管理：wan3.0 (#36), prime, TD (#41), RunningHub (#39, #40)。
