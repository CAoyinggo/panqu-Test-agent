# Panqu 积分扣费 / 失败退费 / 账单 / 成本 — 真实代码流程 (billing-flow)

> **取证来源**：扫描 `/Users/mac/agents/panqu-ai/aibaseos`（PHP + Go）于 2026-09-24；关键 `文件:行号` 已抽样核对属实。行号会漂移，用「方法名 + 条件」定位。表名省 `pq_` 前缀。
> `pq_score_log.type`：**1=加/退，2=扣，3=充值，4=管理员扣减（正数存）**。

## 两个必须先知道的事实

**A. 「10 积分 = 1 元」到底在哪 —— 有两套营收口径：**
- **固定 10:1（旧/简单账单营收）**：`application/common/traits/BillingCalculatorTrait.php:60-63` `getPointsToCnyRate()` 硬返回 `0.1`（注释 `:56` "固定汇率：10积分=1元"）；另有多处字面量 `/ 10`（`BillingStat.php:1315`、`BillingDashboardActions.php:1512/1563/1831`）。
- **动态每企业单价（新财务引擎）**：`command/panquai/RevenueCostCalcStat.php:957` `realized_revenue += score * $currentP`，`$currentP` 是按各企业真实充值比例算的移动加权均价（如 1:30→0.0333），**不是 10:1**。
- ⚠️ `BillingStat.php:1194` 注释写「默认100积分=1元 从系统配置获取」是**过时错误**——实际调 `getPointsToCnyRate()` 返回固定 0.1，且不读配置。

**B. Go 消费者 vs PHP 边界：**
- **扣费 = 仅 PHP**（Go `internal/score/service.go:69 DeductScore` 无生产调用者，是死代码）。
- **退费 = 双实现**：新规范路径是 **Go 队列**（`pq_score_refund_request` + RabbitMQ），旧 **PHP 幂等**路径并行仍在（迁移说明见 `sql/20260919-队列退款/update.sql`）。
- **成本/营收对账 = PHP**（`RevenueCostCalcStat.php`，每小时 cron，独立于扣费重算供应商成本）。

---

## 端到端流程

### 1. 计算积分 — `PointsService::calculatePoints()` `PointsService.php:503`
单价来源 = **`pq_absetting`**（非 model_config、非刊例文档），经 `getPointsFromAbSetting():77`：
- 查 `Absetting WHERE status=1, model_config_id=selmodelsId, task_type=<映射>`，分辨率映射 480P..4K→1..6 `:271`，`hasvideo/quality/sound_type/billing_key` 走 extend_field LIKE，`order weigh desc,id desc` `:324`，返回 `list_price_points` `:344`。
- **按张/按尺寸/单次**：默认 `ceil($basePoints)` `:942`（每分辨率一行 absetting → 按尺寸计价）；Image2.5 专用 `getImage25Points:248`。
- **按秒（视频）**：`billing_type==2` → `points = duration*output_price_per_second (+ ceil(refDuration)*reference_price_per_second)` `:794-805`；否则 `list_price_points*duration` `:808`。
- 其它：文本按万字分档 `:855`、剧本分档 `:892`、TTS 双人计数 `:990`、一次性审阅 15s 档 `:1037`。

### 2. 扣费（PHP，原子）— `processAiTaskPoints()` `PointsService.php:1543`
计算 → `checkPoints` → `deductPoints():1054`：
- **原子防透支**：`Admin::where('id',uid)->where('score','>=',points)->dec('score',points)` `:1067-1070`；0 行则抛「积分不足」。
- `recordPointsLog(...,type=2,...)` `:1076` → INSERT `pq_score_log`（`userid,task_id,task_type,source_id,model_id,score,type,line,createtime`）`:1435`；`line` 取 `taskInfo['line']` 默认 1 `:1265`。
- `updateSourceTableExtra():1079` 把 **`deduct_points` 快照**写进源行 extra（如 `pq_aivideo_new`）——退费路径后续读这个快照。

### 3a. 成功
无台账变动；源行 `deduct_points` 快照保留。

### 3b. 失败 → 退费

**路径 A —— Go 队列（规范/新）**：Go 调度器检测终态失败 → `RefundScoreWithIdempotency`：
- 入队 `dal/refund_request.go:9` `CreateRefundRequest`（`INSERT ... ON DUPLICATE KEY UPDATE` on UNIQUE `uk_task_refund(task_id,task_type,source_id)`）→ 发 RabbitMQ `RefundQueue`；**恒返回 false（入队≠退款完成）**。
- 真正动账 `consumer/refund_processor.go:47` → `dal/refund_process.go:32`：锁请求 `FOR UPDATE` `:38`；**从台账反推退款额** `SELECT SUM(score) ... WHERE type=2 GROUP BY userid,line` `:65`，非单组则拒 `:69`；已存在 type=1 须匹配否则「存在重复退款」`:97`；INSERT `pq_score_log type=1` `:103` + `UPDATE pq_admin SET score=score+amount`（校验影响 1 行）`:112`；标记请求 `status=3`。全程 DECIMAL(18,2)。

**路径 B —— PHP 幂等（并行/旧）**：`refundAiTaskPointsWithIdempotency():1629`：
- 锁 `pq_volcengine_ai_task FOR UPDATE` `:1647`；幂等键 `score_log(userid+task_id+source_id+type=1)` 存在→返回 false `:1652`；`setInc('score'):1669`；INSERT `type=1` `:1672`。
- 调用方：`NewerrlogService.php:329`、`AiworkflowNodeService.php:4626`、`SmartEditTaskService.php:592`、`PlotService.php:5812`、`Imageedit.php:1318`、`FilmReview.php:620` 等；TTS 用独立 `refundTtsTaskPointsWithIdempotency:1715`。
- ⚠️ PHP 用调用方传入的 `$points`（`deduct_points` 快照）；Go 从台账反推——**Go 更安全**。

### 4. 账单大盘 / 台账
控制器 `application/admin/controller/aivideo/v2/Billing.php`（薄：`index:233, dashboard:566, personal:642, detail:819`），组合 `application/admin/traits/billingActions/` 下 9 个 trait，全部读 **`pq_score_log`**（`app\admin\model\ScoreLog` 默认表 = `pq_score_log`）：
- **大盘** `BillingDashboardActions.php`：`apiDashboardSummary:88`、`apiDashboardTrend:1007`、`apiDashboardModels:1111`、`apiDashboardOrgRanking:2026`……按 `userid,line,model_id,task_type,source_id` 聚合，净额 = type2−type1，营收 `/10`，成本/利润走 `calcRevCost`。新旧口径在分界日拼接（`:1327`）。
- **企业** `BillingEnterpriseActions.php`（`apiSummary:23` 等）；**个人消费** `BillingPersonalActions.php`（`apiPersonalRecords:252`、`apiPersonalRechargeRecords:294` 等）；**积分/充值记录** `BillingRecordActions.php`；**全站积分变动** `controller/auth/Adminscore.php`。
- 日汇总 cron `BillingStat.php:computeOrgStats:1150`：读 `pq_stat_daily_admin` + `pq_score_log`（type3 充值 `:1177`、type4 管理员扣 `:1186`），写 `pq_stat_daily_org`。

### 5. 成本 / 营收对账 — `command/panquai/RevenueCostCalcStat.php`（`panquai:compute-revenue`，每小时，2h 缓冲）
权威引擎，`processGroupHourlyLogs:916`：type3 充值重算 `currentP:949`；type2 `realized_revenue += score*currentP:957`、`platform_cost += calculateTaskCost():958`；type4 只减余额；type1 退款按**原扣费时价** `originalP` 冲销营收 `:968`（`getOriginalDeductPrice:1446`）；写 `pq_finance_hourly_report:1020` + `pq_finance_model_hourly_report`（连接 `database.billing`）。
- 成本引擎 `calculateTaskCost:1760` → `command/panquai/cost/CostEngine.php:76` 策略分派（General / MinimaxH3 / Seedance2Lite / Seedance2Token / FixedPrice / SteppedText，按 absetting `strategy` 列选）→ `LineCostCalculator.php:130` 套线路/供应商成本；成本字段来自 `pq_absetting.cost_price` / extend_field。
- 线路归属：`line=1` 火山、`line=2` RunningHub、`line=10` NewAPI（`NewapiDiversionRuleService::LINE=10`）；NewAPI/兜底特殊处理 `:1796`。
- 动态线路供应商统计：`command/panquai/DiversionStat.php`（每小时，源 `pq_volcengine_ai_task` + `pq_score_log` 按 line+HOUR，写 `pq_stat_hourly_diversion_*`，独立于 BillingStat）。

---

## 三大账务不变量（代码落点 + 强弱）

1. **防重复计费（charge-once）—— 最弱，无 DB 键**：`pq_score_log` type=2 **无幂等键**；`deductPoints` 只靠原子 `where('score','>=')->dec()`（`:1067`）防透支。「只扣一次」纯靠控制器在建任务流程里恰好调一次 `processAiTaskPoints`（如 `Video.php:2724`）+ `deduct_points` 快照。**没有唯一约束阻止重提交/重试导致重复扣**。
2. **净扣归零（退款=扣款）**：Go 强（`refund_process.go:65` 从台账反推 `SUM(type=2)`、拒歧义 `:69`、DECIMAL）；PHP 弱（退款额用调用方传入的 `deduct_points`，非台账反推）。
3. **退款幂等 —— 最强**：Go = UNIQUE `uk_task_refund` + `ON DUPLICATE KEY` + 状态守卫 + type=1 匹配校验；PHP = `score_log(userid+task_id+source_id+type=1)` 存在检查 + `FOR UPDATE`。监控 `command/panquai/ScoreRefundDailyMonitor.php:80` 按 `(userid,task_id,source_id)` 计 type=1，>1 则飞书告警。

## 表与关键字段（真实名）
| 表 | 库 | 关键字段 |
|---|---|---|
| `score_log` | 默认 | `userid,task_id,task_type,source_id,model_id,score,type(1退/2扣/3充/4管理员扣),line,createtime` |
| `admin` | 默认 | `score`（余额） |
| `absetting` | `database_ab` | `model_config_id,task_type,billing_type(1次/2秒),resolution,list_price_points,cost_price,extend_field(json),weigh,status,strategy` |
| `score_refund_request` | 默认 | UNIQUE `uk_task_refund(task_id,task_type,source_id)`,`status(0待投/1已投/2失败/3已退)`,`refund_amount/line/log_id` |
| `finance_hourly_report` / `finance_model_hourly_report` | `database.billing` | `group_id,stat_hour,consume_score,realized_revenue,platform_cost,gross_profit,end_unit_price` |
| `stat_daily_org` / `stat_hourly_diversion_*` | `database.billing` | 日/时聚合营收/成本/利润、动态线路任务与积分 |
| `volcengine_ai_task` | 默认 | `line,extra.refund_points`（退款回写） |

## 边界与订正
- **10:1 只是旧「消费营收」近似**；新小时财务引擎忽略它、用各企业真实移动加权均价 `currentP`。大盘在分界日拼接新旧（`BillingDashboardActions.php:1327`）。
- 扣费仅 PHP 且**无幂等键**；退费双实现（Go 队列 + PHP 内联）并存，待按 `sql/20260919-队列退款/update.sql` 切换。Go `DeductScore` 是死代码。
- 跨库：`absetting`@`database_ab`、财务/统计@`database.billing`、台账+admin@默认——台账与财务表间无外键。
- ⚠️ **本链路真实台账表是 `pq_score_log`（跨月看 `pq_score_log_archive_YYYYMM` 归档表）**；`pq_user_score_log` 是遗留 FastAdmin 表（仅见于 `application/common/model/ScoreLog.php:14` 等 legacy 处，与积分/账单无关），核验勿用。

