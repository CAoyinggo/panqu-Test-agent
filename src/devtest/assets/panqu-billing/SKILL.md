---
name: panqu-billing
description: 处理 Panqu/盼趣的计费、积分预估、消费明细、账单大盘、扣费与退费对账的自测与审查。当涉及新增模型定价、刊例价、钱包扣费、充值记录、大盘趋势统计或数据库积分日志核验时使用。
---

# Panqu 计费、积分与对账专项

在 Panqu/盼趣项目中，所有涉及模型生成扣费、积分结算、刊例价变动、消费明细及管理后台账单统计的需求，必须读取本 Skill 并执行端到端闭环验证。

## 一、主战场与架构分层

- **核心主战场**：`aibaseos`（PHP ThinkPHP 5），核心文件为 `application/admin/controller/aivideo/v2/Billing.php`（478KB）与 `aivideo/v2/Task.php`。
  - 前端路由多通过 `billing/personal` 与 `billing/dashboard` 配合 `section` 参数进行请求分发。
- **中台预估计费**：`aipanqucenter`（NestJS），负责 `/integration-platform/models/estimatedBilling` 与 `/expense/user/getMany`。
- **底层数据表**：
  - `pq_absetting`：积分单价配置表（含 `list_price_points`）；
  - `pq_model_config`：模型配置与定价表；
  - `pq_score_log` 及 `pq_score_log_archive_*`：用户积分流水表（按月归档，跨月核查需注意合并归档表）。

## 二、19 个核心账单端点清单

在生成测试用例与验证契约时，针对以下已验证的 19 个核心端点进行断言覆盖：

| 端点路径 | 方法 | 说明 | 核心断言与校验点 |
|---|---|---|---|
| `POST aivideo/points/preview` | POST | 积分预估接口 | 入参为 resource/extra，响应 `required_points` 必须与刊例价严格一致 |
| `GET billing/apiSummary` | GET | 企业汇总看板 | 校验可用积分、区间消耗、累计充值三项汇总计算无误 |
| `GET billing/dashboard?section=summary` | GET | 账单大盘累计消耗 | 支持筛选模型，返回指标必须包含新模型用量 |
| `GET billing/dashboard?section=modelDist` | GET | 模型调用分布饼图 | 新模型名称正确归类，禁止显示为“未知模型” |
| `GET billing/dashboard?section=models` | GET | 模型筛选下拉列表 | 包含本次新上线模型，禁止遗漏 |
| `GET billing/apiDashboardTrend` | GET | 消费趋势曲线 | 验证时间切换（今天/近7天/本月/自定义）数据聚合正确 |
| `GET billing/apiDetailRecords` | GET | 消费明细记录 | 分页列表，每条记录的 `points` 扣除与模型配置一致 |
| `GET billing/personal` | GET | 个人维度消费明细 | 支持 records/summary/projectTop，验证个人扣费账单 |
| `GET aivideoab/absetting/index` | GET | 积分单价配置列表 | 验证新模型 `list_price_points` 基础配置 |
| `GET aivideo/v2/character/getModelConfigs` | GET | 模型配置元数据 | 检查模型子分类、任务类型与计费规则配套 |
| `POST /integration-platform/models/estimatedBilling` | POST | NestJS 刊例价预估 | 验证前端画布节点连线预估费用链 |
| `POST /expense/user/getMany` | POST | NestJS 消费明细审计 | 校验 `billing_calculation_chain` 计费计算链完整性 |

## 三、12 条核心验收规则与测试断言

1. **账单-汇总维度**：企业主账号「累计消耗」「近7天消耗积分」「近7天任务总数」必须准确纳入新模型消耗。
2. **趋势与排行维度**：消耗趋势图与 TOP5 模型消耗排名必须包含新模型，且排序权重符合实际消费大小。
3. **消费明细规范**：模型功能必须适配，**绝对不能出现“未知模型”**（重点防范 `Billing.php` 中 `resolvePersonalRecordModelName` 兜底失效）。
4. **刊例价与实扣匹配**：实测任务提交后，实际扣除积分必须精确等于刊例价（例如 wan3 实扣 28 积分、prime 实扣 44 积分、td 实扣 60 积分）。
5. **任务失败不扣费/退费**：生成失败或超时取消的任务，冻结积分必须原路解冻或补偿退回，积分流水记录状态为退款。
6. **模型中转名称对齐**：非公认爆火模型统一用功能/需求写入名称进行中转名称展示，覆盖任务标签与后台统计。
7. **月度归档跨表查询**：核对历史积分变动时，必须验证 `pq_score_log_archive_YYYYMM` 归档表的连贯性。
8. **免费重试幂等性**：因上游供应商错误发起的任务重试，不得二次重复扣除用户积分。
9. **并发请求防重扣**：高并发提交相同 `idempotency_key` 任务时，必须幂等，只能扣减一次积分。
10. **零余额与余额不足拦截**：用户钱包可用积分小于 `required_points` 时，接口必须直接返回 402/错误码，禁止透支生成。
11. **多租户/分组隔离**：不同企业组织下的积分配置与消费明细必须严格数据隔离，禁止越权查询。
12. **账单大盘与明细总和一致性**：在指定时间窗口内，大盘汇总的消费积分总值必须等于明细列表中单笔积分扣减之和。
