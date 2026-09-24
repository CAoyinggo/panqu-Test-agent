# Panqu NewAPI 新模型接入与分流代码入口映射

本文档详细梳理 NewAPI 对接、新模型接入与两级分流决策在主站系统中的代码实现路径与数据表结构。

---

## 一、主站核心决策与服务代码（ThinkPHP 5 `aibaseos`）

| 模块 | 文件相对路径 | 核心类/方法/职责 |
| :--- | :--- | :--- |
| **分流总规则服务** | `application/admin/service/NewapiDiversionRuleService.php` | `class NewapiDiversionRuleService`<br>- `LINE = 10`：主站分流专属线路常量<br>- `getRouteMode()` / `saveRouteMode()`：读取/保存分流模式（`newapi` / `legacy` / `off`）<br>- `isRequestEligible($extra, $videoType)`：硬性任务资格判断（5000字、mov格式、真人人像、Seedance全能参考）<br>- `isGlobalModel($modelId)`：全量模型判断（查询 `pq_model_config.is_newapi_global`）<br>- `isModelRoutable($extra)`：全局能力并集判断（`newapi_route_rules`）<br>- `isModelRoutableForGroup($extra, $group)`：分组能力精确判断（`newapi_route_group_rules`） |
| **组织路由服务** | `application/admin/service/NewapiRouteService.php` | `class NewapiRouteService`<br>- `resolveByGroupIds($groupIds)`：通过当前用户所属组织的角色组 ID 列表查询 `pq_newapi_route_group_org`，解析对应的 NewAPI 路由组<br>- `isRouteGroupUsable($routeGroup)`：校验路由组是否启用 (`status===1`) 且 NewAPI API Key 非空 |
| **视频生成控制器** | `application/admin/controller/aivideo/Videonew.php` | `class Videonew`<br>- `check_diversion(&$extra, $videoType)`：分流决策总入口，执行两级判断并在命中时将 `newapi_org_id`、`newapi_route_group_id`、`newapi_group`、`newapi_model`、`points` 写入 `extra` 快照，返回 `LINE = 10` |
| **模型管理控制器** | `application/admin/controller/aivideo/Diversion.php` | `class Diversion`<br>- `modellist()` / `listModelsForTable()`：模型管理列表数据源<br>- `saveModelFlag()` / `batchSaveModelFlag()`：单个与批量保存 `is_newapi_global` 开关 |
| **渠道管理控制器** | `application/admin/controller/aivideo/Channel.php` | `class Channel`<br>- 编辑渠道参数：分类（视频/图片）、模型能力（全能参考/首尾帧）、分辨率（含 768P）、宽高比<br>- 调用 `NewapiOrgChannelService::updateChannel` 更新中台配置，调用 `NewapiProviderService::upsertChannelMapping` 保存本地参数 |
| **组织管理控制器** | `application/admin/controller/auth/Newapiorganization.php` | `class Newapiorganization`<br>- NewAPI 组织列表与路由组密钥维护，企业精准搜索与移交 |
| **模型别名映射** | `application/common/constant/Ai.php` | `getNewAPIModelAlias($modelId)`：将主站模型 ID（如 84, 88）转换为 NewAPI 请求模型标识（如 `wan3.0-video`, `wan3.0-video-prime`） |
| **计费与预估** | `application/common/traits/BillingCalculatorTrait.php` | 积分计算逻辑：固定汇率 10 积分 = 1 元，按秒计费 = 生成秒数 × 单价 + 参考视频秒数 × 参考单价 |
| **账单大盘** | `Billing.php` & `BillingDashboardActions.php` | `/billing/dashboard`：按动态线路供应商统计消费用量与模型报表 |

---

## 二、关键数据表与字段

| 表名 | 关键字段 | 说明 |
| :--- | :--- | :--- |
| `pq_model_config` | `id`, `show_name`, `newapi_model_alias`, `is_newapi_global` | 模型配置表。`is_newapi_global` 为 1 表示全量开放，0 表示分组开放 |
| `pq_aivideo_diversion_config` | `line`, `name`, `value`, `title` | 分流全局配置表。包含 `newapi_route_mode`、`newapi_global_api_key`、`newapi_route_rules`、`newapi_route_group_rules` |
| `pq_newapi_route_group` | `id`, `name`, `newapi_group`, `newapi_api_key`, `status` | NewAPI 路由组配置表 |
| `pq_newapi_route_group_org` | `id`, `org_id`, `route_group_id` | 角色组（组织）与 NewAPI 路由组的绑定映射表 |
| `pq_aivideo_new` | `id`, `type`, `extra`, `is_need_fallback`, `status` | 视频任务表。`extra` 中保存分流路由快照；`is_need_fallback` 控制 SD 系列重试兜底 |

---

## 三、NewAPI 网关环境

- **API Base URL**：`https://aiapis.panqu.com`
- **只读管理页面**：`https://aiapis.panqu.com/keys`
- **核心分组**：`panqu_test`（测试分组）、`panqu_tao`（生产业务分组）
- **安全约束**：测试人员与智能体对 NewAPI 实例**严禁执行任何写操作**（零创建、零修改、零删除）。
