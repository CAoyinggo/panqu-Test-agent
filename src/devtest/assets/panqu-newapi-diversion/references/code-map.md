# Panqu NewAPI 分流 — 代码入口映射 (code-map)

> 完整端到端流程见 [`diversion-flow.md`](./diversion-flow.md)（含 `文件:行号` 取证）。本页只做「去哪找」的速查。
> 路径均在 `/Users/mac/agents/panqu-ai/aibaseos/`（ThinkPHP 5）。表名省 `pq_` 前缀。

## 决策与服务（核心）
- **分流决策服务**：`application/admin/service/NewapiDiversionRuleService.php` — `LINE=10`、`getRouteMode()`、`isGlobalModel()`、`isRequestEligible()`、`isModelRoutable[ForGroup]()`、`getLineType()`。
- **图片分流服务**：`application/admin/service/NewapiImageDiversionService.php` — `check()` / `applySnapshot()`（置 `extra.newapi_image=1`）。
- **组织路由解析**：`application/admin/service/NewapiRouteService.php` — `resolveByGroupIds()`、`isRouteGroupUsable()`。
- **线路/渠道注册**：`application/admin/service/LineRegistryService.php`；计费线解析 `application/admin/service/NewapiProviderService.php`。
- **旧概率分流**：`application/admin/service/LegacyDiversionService.php`（mode=legacy 时用，线 2/5/6/7）。

## 控制器（入口 / 后台）
- **视频入口 + 决策**：`application/admin/controller/aivideo/Videonew.php` — `add():403`、`check_diversion():1321`、`asyncGenerateVideo():1072`、队列 `getVideoTaskTypeAndQueue():3136`。
- **分流后台/重试日志/兜底比例**：`application/admin/controller/aivideo/Diversion.php`。
- **渠道管理**：`application/admin/controller/aivideo/Channel.php`；`v2/VideoHub.php`（UI 侧提示词长度镜像 `:786`）。
- **图片入口**：`Goods.php` / `Character.php` / `Scene.php` / `Fusion.php`（`applySnapshot` + `createTaskLog`）。
- **兜底 provider 归一/计费线**：`application/admin/controller/aivideo/VolcengineSearch.php`。

## 模型 / 表
- 模型：`application/admin/model/{NewapiRouteGroup,NewapiRouteGroupOrg,NewapiTaskLog,ModelConfig}.php`。
- 核心表：`aivideo_new`、`aivideo_diversion_config`(line=10 配置)、`aivideo_diversion_setting`、`aivideo_diversion_retrylog`、`model_config`(`is_newapi_global`/`newapi_model_alias`/`is_need_fallback`)、`newapi_route_group[_org]`、`newapi_task_log`、`volcengine_ai_task`、`score_log`、`admin`。

## 配置 / 网关 / 队列
- `application/config.php:298-304` — `newapi.base_url` / `newapi.org_api_token` / `newapi.channel_sync_token`。
- `application/config.php:340-341` — 队列 `ai_newapi_video_submit_queue` / `ai_newapi_image_submit_queue`。
- 常量：`application/common/constant/Ai.php`（`VIDEO_TYPE_WANXIANG3=10`、`WANXIANG3_MODEL_ID=84`、`SEEDANCE_TYPE_*`、`diversion()` 映射 `:1159-1168`）。
- 统计命令：`application/admin/command/panquai/DiversionStat.php`。

## ⚠️ 不在本仓库
渠道权重挑选 + NewAPI→火山自动兜底 = 读队列 `ai_newapi_video_submit_queue` 的 **Go 消费者**，不在 `panqu-ai`。以上均为 PHP 侧的决策/落库/回读。

## 旧版订正（原 code-map 有误）
- `aivideo/v2/ModelConfig.php` **不存在**——模型配置在表 `pq_model_config` + `common/constant/Ai.php`。
- `Diversion.php` 在 `controller/aivideo/`（非 `v2/`）。
- 分流调度核心是 `service/NewapiDiversionRuleService.php`（非某个 `v2/Diversion.php` 方法）。
