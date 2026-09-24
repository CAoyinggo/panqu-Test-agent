# Panqu 视频创建 — 真实代码端到端流程 (video-creation-flow)

> **取证来源**：扫描 `/Users/mac/agents/panqu-ai/aibaseos`（ThinkPHP 5 + Go worker）于 2026-09-24；关键 `文件:行号` 已抽样核对属实。代码演进后行号会漂移——用「方法名 + 条件」定位。
> **一句话架构**：**PHP 只负责提交**（校验 → 落库 → 预扣积分 → 发 RabbitMQ），**Go worker**（`panqu/internal/…`）消费队列、调用供应商、轮询至终态、把结果与终态**回写** `pq_aivideo_new`；PHP 只读状态、失败时退款。
> 分流分支详见 [`../../panqu-newapi-diversion/references/diversion-flow.md`](../../panqu-newapi-diversion/references/diversion-flow.md)；账务细节详见 [`../../panqu-billing/references/billing-flow.md`](../../panqu-billing/references/billing-flow.md)。表名省 `pq_` 前缀。

---

## 端到端流程

### 1. 入口
- **主入口**：`application/admin/controller/aivideo/Videonew.php:403` `add()` — POST 门禁 `:414`，入参 `:415` `post("row/a")`，事务 `:423` `Db::startTrans()`。
- **编辑重生成**：`Videonew.php:1414` `edit()` → 复跑分流 `:2028` → 复派发 `:2121`（会**再次扣费**）。
- **v2 UI 入口**：`aivideo/v2/VideoHub.php:324` `submit()` → 复用旧控制器 `:448` `asyncGenerateVideo(...)`。

### 2. 输入 / 素材校验（注意：服务端校验很薄）
- **校验器只查任务名**：`application/admin/validate/Video.php` 规则仅 `'name' => 'length:0,100'`。
- **提示词 cueword**：仅按任务类型做「存在性」校验（如 `:450/:589/:643`），**无最大长度限制**。
- **参考图/视频/音频（type 6 全能参考）**：`:967` `if (!$hasInput) exception(...)` 仅存在性；前端预传 OSS URL 存 `size=0`，**无服务端数量/大小/格式校验**。
- **直传文件**（首尾帧 `processImageFile()` `:3059`）：仅此路径强制**格式**（jpeg/jpg/png/webp/bmp/gif/tiff）`:3066` + **≤30MB** `:3072`。
- **首尾帧 ≥1 帧**：`:779`；**时长**默认 15s，硬校验仅 `model_id==7` 须 ≥4s `:1003`；**分辨率/宽高比**只有默认无白名单（`:975/:978`）；`output_format` 非 Seedance2.5(78) 被剥离 `:1007`。

### 3. 任务类型解析（两层）
- **前端 type(1-8) switch** `add():447`：1 火山图生 / 2 火山首尾帧 / 3 火山文生 / 4 sora文生 / 5 sora图生 / **6 PanquAI(Seedance/Wan)** / 7 HappyHorse / 8 腾讯 Kling。
- **Seedance task_type**（case 6 `:718`）：默认 `Ai::SEEDANCE_TYPE_UNIVERSAL`(28)；`:724` 若 `FIRST_LAST_FRAME(29)/LITE_FIRST_LAST_FRAME(51)` 走首尾帧分支，否则全能参考分支。
- **映射到常量+队列**：`getVideoTaskTypeAndQueue():3136`（type1→图生 / type3→文生 / type6→Seedance 28/29、Lite 50/51 `:3197` / else→`VideoTaskRouteResolver` 处理 wan3 等）。常量见 `application/common/constant/Ai.php`（`SEEDANCE_TYPE_*`、`CHARACTER_TYPE_*`、`SEEDANCE25_MODEL_ID=78`）。

### 4. 派发 — `asyncGenerateVideo($params,$extra,$deductPoints=true)` `:1072`
（由 `add():1040` 在 `Db::commit():1038` 后调用。）
- **AI 开关**：`:1075` `if (!$this->aiOnOff) return;`。
- **解析类型+队列**：`:1086` `getVideoTaskTypeAndQueue(...)` → `:1090` `if ($taskType<1) exception("视频生成类型选择错误")`。
- **队列选择**（type 6，`:3183-3191`）：NewAPI 分流→`ai_newapi_video_submit_queue`；`diversion>0`→`ai_video_panqu2_rh_queue`；否则 `ai_video_panqu2_queue`；**多数 panqu2 任务再改道白名单队列 `ai_video_whitelist_queue`** `:3214-3216`（RH/NewAPI 队列除外）。队列/交换机默认见 `application/config.php:309-340`。
- **线路解析** `:1099-1152`：`$diversionLine=(int)$extra['diversion']` `:1101`；`===LINE(10)`→`line=10, line_type=getLineType(selmodelsId)` `:1104`；否则 legacy line 按 `Ai::diversion()` 重映射（line 2 / 5 / 6 / 7）。
- **建任务行 `pq_volcengine_ai_task`** `:1178`（`user_id,source_id=addId,type,line,line_type,model_id`）；NewAPI 线再建 `pq_newapi_task_log` `:1183` 并回写 `extra.newapi_log_id` `:1192`。
- **更新源表 `pq_aivideo_new`** `:1235`（`task_status=1, progress=rand(1,4), taskid(csv)`）；提交计数 `pq_admin.ai_video_addnum++` `:1243`；写 `pq_aivideo_task_log`(`logVideo` `:1256`) 与 `pq_aivideo_taskstatus` `:1258`。
- **MQ 发布** `:1271-1281`：`{type,id:addId,taskid:now_task_id}`（NewAPI 加 `newapi_log_id`）—— **消息只带 ID，不含 token/prompt**。
- **直连 vs 分流** 完全由 `extra.diversion` 决定（`add():1012` `check_diversion():1321`：0=直连 / legacy line / `LINE=10` NewAPI）。

### 5. 生成与状态（在 Go worker，非 PHP）
- **轮询器**：`panqu/internal/scheduler/query_panqu_task.go:90` `Execute()`（各供应商有同类 `query_*_task.go`）。终态分支 `:271` `succeeded`→`handleCompletedTask():309`（下载转存 OSS `:313`、写回 URL `:333`）；`:273` `failed/cancelled/expired`→失败路径。
- **两套状态码**（`panqu/internal/consumer/task_status_updater.go:33-56`）：源表 `pq_aivideo_new` `Completed=2/Failed=3`；AI 任务 `pq_volcengine_ai_task` `Completed=3/Failed=4`（**别混淆**）；progress `100=成/-1=败`。
- **失败/重试**：`HandleVideoTaskFailure`（`query_panqu_task.go:245/:424`）→ `UpdateAivideoNewFailed(status=3,progress=-1,err)`（`video_repository.go:69`）；敏感内容重试重置 `task_status=1` `:580`；PHP 侧 `NewerrlogService::markTaskFailed():360` 同步三表并触发退款。

### 6. 结果落库
- **Go 回写**：`panqu/internal/dal/video_repository.go:57` `UpdateAivideoNewSuccess(id,videoURL,lastFrameURL)` → `UPDATE pq_aivideo_new SET task_status=2,progress=100,video_url=?,last_frame_url=?`；任务日志 URL 经 `UpdateAiVideoTaskLogOutputResult:460`；状态镜像 `UpdateAivideoTaskStatus:549`。
- **前端读取**：`Videonew.php:2903` `get_info()`；`video_url` 为 CSV，`array_reverse` 取最新 `:2934`；`task_status==3` 解 `err` JSON 为 `task_err_text` `:2974`。

### 7. 计费（详见 billing-flow.md）
- **预检**（事务内、commit 前）：`add():1034` `checkCalculateTaskPoints()` `:3246`（`calculatePoints`+`checkPoints`，不扣）。
- **真正扣费**（派发时）：`asyncGenerateVideo():1212` `processAiTaskPoints()`（`PointsService.php:1543`）→ `deductPoints():1054`：**原子** `Admin->where('score','>=',$points)->dec('score',$points)` `:1067`（0 行则抛异常防透支）；写 `pq_score_log type=2`(扣) `:1435`；`extra.deduct_points` `:1079`。
- **积分计算**：`calculatePoints():503`；Seedance/Wan 按秒块 `:790-805`（读 `pq_absetting` 的 `billing_type/output_price_per_second`）。
- **失败退款**（幂等，净扣归零）：`refundAiTaskPointsWithIdempotency():1629`（锁 `pq_volcengine_ai_task:1647`；幂等键 `score_log userid+task_id+source_id+type=1` `:1652`；`setInc('score'):1669`；写 `pq_score_log type=1` `:1672`）。

---

## 表与关键字段（省 `pq_`）
| 表 | 写入方 | 关键字段 |
|---|---|---|
| `aivideo_new` | add 插入 `:1017` / async 更新 `:1235` / **Go** 成功失败回写 | `type(1-8)`,`model_id`,`cueword`,`extra(json)`,`taskid(csv)`,`task_status(0/1/2/3/5)`,`progress`,`video_url(csv)`,`err` |
| `volcengine_ai_task` | async `:1178` / Go 更新 | `source_id(=aivideo_new.id)`,`type`,`line`,`line_type`,`status(1/2/3/4)`,`task_id(供应商)`,`output_result` |
| `aivideo_task_log` / `aivideo_taskstatus` | `logVideo:1256` / `:1258` / Go | 日志与状态镜像（`selmodelsId`,`progress`,`task_status`） |
| `score_log` | `recordPointsLog:1435` / 退款 `:1672` | `userid`,`task_id`,`source_id`,`score`,`type(1退/2扣)`,`line`,`model_id` |
| `admin` | `dec('score'):1067` / `inc('ai_video_addnum'):1243` | `score`,`ai_video_addnum` |
| `absetting` | `calculatePoints` 读 | `model_config_id`,`task_type`,`resolution`,`billing_type(1次/2秒)`,`extend_field(json)` |
| `newapi_task_log` | `NewapiTaskLog::create:1183` | `ai_task_id`,`task_type='video'`,`org_id`,`route_group_id`,`newapi_group`,`status` |

## 边界与注意
1. **生成/轮询/回写在 Go worker（`panqu/internal/…`），不在 PHP**；无 PHP 回调端点写 `video_url`。
2. **两套状态码命名空间**：`aivideo_new` 用 2 成/3 败，`volcengine_ai_task` 用 3 成/4 败——别混淆。
3. **服务端素材校验薄**：仅任务名限长；cueword 无长度上限；前端预传 URL 存 `size=0` 绕过大小/格式；格式+30MB 仅约束直传首尾帧文件。
4. **积分在提交时预扣**（非完成时），失败幂等退款、行锁抗并发回调。
5. **白名单改道**：多数 type6 任务先进 `ai_video_whitelist_queue` `:3214`。
6. **`edit()` 与 `v2/VideoHub::submit()` 都会复派发**（`:2121`/`:448`）→ 重生成会**再次分流+建行+扣费**。
7. 渠道权重挑选 + NewAPI→火山自动兜底在网关侧 Go 消费者，不在本仓库。

