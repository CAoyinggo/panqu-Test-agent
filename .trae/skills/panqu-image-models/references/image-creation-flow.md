# Panqu 图片创建 — 真实代码端到端流程 (image-creation-flow)

> **取证来源**：扫描 `/Users/mac/agents/panqu-ai/aibaseos`（ThinkPHP 5 + Go worker）于 2026-09-24，关键 `文件:行号` 已抽样核对（Goods 链路逐行确认；Character/Scene/Fusion 为同构，按各自 `model()` 与 `$imgTableName` 固化）。行号会漂移——用「方法名 + 条件」定位。
> **一句话架构**：与视频同构——**PHP 只负责提交**（校验 → 落库 → 分流快照 → 预扣积分 → 发 RabbitMQ），**Go worker**（`panqu/internal/…`）消费队列、调供应商、回写产物 URL 与终态；PHP 只读状态、失败退款。
> 分流资格（模型×分辨率×画面比例×启用）见 [`../../panqu-newapi-diversion/references/newapi-eligibility-gate.md`](../../panqu-newapi-diversion/references/newapi-eligibility-gate.md)；账务细节见 [`../../panqu-billing/references/billing-flow.md`](../../panqu-billing/references/billing-flow.md)。表名省 `pq_` 前缀。

---

## 端到端流程（以 `Goods.php` 商品图为代表）

### 1. 入口 / 落库
- **主入口**：`application/admin/controller/aivideo/Goods.php:452` `add()`——事务 `Db::startTrans()` `:474`；组装 `extra`（含 `selmodelsId/resolution/aspectRatio/size_type/serviceline/imageList`）；插入源表（`$this->model = model('Goods')` `:60` → 表 `pq_aivideo_goods`）；`Db::commit()` `:804` 后 `addId = $this->model->id` `:806`。
- **四类图片模式各写各自源表**（同构控制器）：`Goods`→`pq_aivideo_goods`（已确认）、`Character`→model('Character')`:66`、`Scene`→model('Scene')`:60`、`Fusion`→model('Fusion')`:60`（另有 `pq_aivideo_fusion_folder`）。四者都可引用 `pq_aivideo_onedraw`（单图/历史，`Goods.php:190/:212`）。
- **HomepageService** 仅对 `NANO_BANANA_PRO(12)` 触发分流（见资格文档 Q1）；**`Imageedit.php`（局部重绘/消除/扩展）不走分流**，直连 `VolcengineAIEdit`；`v2/*` 多经 `__call` 委派回 v1（Character v2 的 `__call` 被注释、无独立提交）。

### 2. 分流资格快照（创建前置拦截）
- `add()` 与 `asyncGenerateImage()` 均调 `(new NewapiImageDiversionService())->applySnapshot($extra, selmodelsId, serviceline, groupIds)`：`Goods.php:534`（add 路径）、`:847`（normal, 'r'）、`:863`（`Ai::MODEL_ID_MJ_V82`）。命中则写 `extra.newapi_image=1` + 路由快照并回写源表 `extra`（`:849/:864`）。
- 资格门槛（`NewapiImageDiversionService::check`/`applySnapshot`，逐行见资格文档）：别名非空 → serviceline='r' → `size_type≠pixels` → 参考图≤10 → `isImageModelRoutable`（**同一启用渠道同时支持 `resolution`+`aspectRatio`**）→ 全量用全局Key / 分组解析路由组。**Image2.5 无渠道抛用户错误；MJ v8.2 无条件分流；其余未命中静默回退原渠道**。

### 3. 派发 — `asyncGenerateImage($params,$extra)` `Goods.php:843`
每个模型分支结构一致：
- 建任务镜像行 `pq_volcengine_ai_task`（`source_id=addId` `:873`）；写任务日志 `logGoods()` `:882`；
- `$imgTableName="pq_aivideo_goods"`（`:900` 等），更新源行 `task_status=1` `:912/:928`；
- **预扣积分** `PointsService::processAiTaskPoints($userid,$taskType,$extra,$taskInfo)`（`:890/:980/:1049/:1124/:1184/:1254/:1314`，详见 §4）；
- **MQ 发布** `{type,id:addId,taskid}` 到分模型队列（`config('mq_queue')`）。

### 3.1 队列选择（按模型；分流会改写）
| 模型/渠道 | 队列（默认名） | 行 |
|---|---|---|
| 腾讯 MJ | `ai_image_tengxun_queue` | `:897` |
| Goods/AgentEarth | `ai_queue` / `ai_image_agentearth_queue` | `:988-989` |
| RunningHub | `ai_image_runninghub_queue` | `:1056` |
| Gemini | `ai_gemini_image_queue` | `:1131` |
| nano2 | `ai_image_nano2_queue` | `:1190` |
| image2 | `ai_image_image2_queue` | `:1260` |
| AgentEarth | `ai_image_agentearth_queue` | `:1320` |

> **NewAPI 分流改写**：当 `extra.newapi_image` 命中，队列被改写为 `image_newapi` = **`ai_newapi_image_submit_queue`**（`:926/:1084/:1217/:1344`），覆盖上面的分模型队列。**消息只带 ID**，不含 token/prompt。

<!-- SEC2 -->

### 4. 计费（提交时预扣，详见 billing-flow.md）
- **预扣**（派发时，非完成时）：`processAiTaskPoints()` → `deductPoints()`：原子 `Admin->where('score','>=',points)->dec('score',points)` 防透支；写 `pq_score_log type=2`；`extra.deduct_points` 快照。
- **积分计算** `PointsService::calculatePoints()`：图片**按张**（默认 `ceil(basePoints)`）；Image2.5 专用 `getImage25Points`；单价源 `pq_absetting`。刊例价数值/映射见 [`billing-flow.md`](../../panqu-billing/references/billing-flow.md)，此处不重复。
- **失败退款**（幂等，净扣归零）：`refundAiTaskPointsWithIdempotency()`（幂等键 `score_log userid+task_id+source_id+type=1`）；图片编辑失败退款调用点如 `Imageedit.php:1318`。

### 5. 生成与回写（Go worker，非 PHP）
- **NewAPI 图片**：`panqu/internal/scheduler/query_newapi_image_task.go` 轮询终态；成功写 `image_url` `:480`、`image_urls` `:481`，调 `statusUpdater.UpdateImageTaskSuccess(ctx, tableName, sourceID, aiTaskID, …)` `:495` 回写**源表**（`tableName`=`pq_aivideo_goods` 等）与 `pq_volcengine_ai_task`。
- **普通渠道**：腾讯/RunningHub/Gemini/阿里 等各自 `panqu/internal/…` 处理器；失败/取消统一 `UPDATE <源表> SET task_status=?, progress=0 …`（`handler/statistics/task/handlers.go:151`、`runninghub/handlers.go:111-114`）。
- **两套状态码**（与视频同）：源表 `task_status` 2成/3败；`pq_volcengine_ai_task` 3成/4败——**别混淆**。

### 6. 读取
- `Goods.php:2274` `get_info()`（`checkGenerateStatus()` `:2214` 轮询）——读源行 `task_status`/`image_url`(Go 写入)/`err`；产物 URL 由 Go 回写后前端可见。**无 PHP 回调端点写 image_url**。

---

## 表与关键字段（省 `pq_`）
| 表 | 写入方 | 关键字段 |
|---|---|---|
| `aivideo_goods`/`aivideo_character`/`aivideo_scene`/`aivideo_fusion` | add 插入 / async 更新 / **Go** 回写 | `type`,`selmodelsId`,`extra(json: resolution/aspectRatio/newapi_image/deduct_points…)`,`task_status(1/2/3)`,`image_url`,`err` |
| `aivideo_onedraw` | 单图/历史引用 | 关联 `project_id` |
| `volcengine_ai_task` | async `:873` / Go 更新 | `source_id(=源表id)`,`type`,`status(1/2/3/4)`,`task_id(供应商)`,`output_result` |
| `score_log` | `processAiTaskPoints` / 退款 | `userid`,`task_id`,`source_id`,`score`,`type(1退/2扣)` |
| `newapi_task_log` | 分流命中建 | `task_type='image'`,`org_id`,`route_group_id`,`newapi_group`,`status` |

## 图片与视频创建的差异（务必分清）
1. **多源表**：图片按模式分 `aivideo_goods/character/scene/fusion`(+`onedraw`)，视频是单表 `aivideo_new`。
2. **多分模型队列**：图片队列按渠道细分（tengxun/rh/gemini/nano2/image2/agentearth…）；分流命中一律改写为 `ai_newapi_image_submit_queue`。
3. **分流入口**：图片走 `NewapiImageDiversionService::applySnapshot`（写 `newapi_image=1`），含 Image2.5 抛错 / MJ v8.2 无条件 / 其余静默回退三种特例。
4. **计费口径**：图片**按张**（`ceil(basePoints)`/`getImage25Points`），视频**按秒**。
5. **分流资格不对称**：**图片全量模型仍校验分辨率/画面比例**，视频全量模型跳过（见资格文档）。
6. **服务端校验薄**：与视频一致，前端预传 URL、`size_type`/`serviceline` 决定分流走向；真正的分辨率/画面比例资格由 NewAPI 网关渠道配置卡。

