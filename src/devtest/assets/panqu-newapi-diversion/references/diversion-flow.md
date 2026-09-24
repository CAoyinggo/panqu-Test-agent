# NewAPI 两级分流 — 真实代码端到端流程 (diversion-flow)

> **取证来源**：扫描真实被测库 `/Users/mac/agents/panqu-ai/aibaseos`（ThinkPHP 5，PHP）于 2026-09-24；下列 `文件:行号` 关键锚点已抽样核对属实。代码演进后行号会漂移——用「方法名 + 条件」定位，行号仅作起点。
> **边界**：真正的「渠道权重/概率挑选」与「NewAPI→火山自动兜底」运行在读取队列 `ai_newapi_video_submit_queue` 的 **Go 消费者**里，**不在本仓库**。以下是 PHP 侧「决策 / 落库 / 回读」的完整链路。
> 所有表名省略 `pq_` 前缀（`Db::name('x')` → `pq_x`）。`LINE = 10` 即 NewAPI 分流（`NewapiDiversionRuleService.php:17`）。

---

## 视频分流端到端（VIDEO）

### 1. 入口 — `Videonew::add()`
- `application/admin/controller/aivideo/Videonew.php:403` `public function add`，POST 门禁 `:414`，入参 `:415` `$params = $this->request->post("row/a")`。
- **分流决策调用点 `:1012`**：`$extra['diversion'] = $this->check_diversion($extra, (int)$saveData['type']);`
- 决策结果落库到 `pq_aivideo_new.extra` `:1013`，保存 `:1017`，异步派发 `:1040` `$this->asyncGenerateVideo($saveData, $extra)`。
- （另一入口 `:2028` 同样调用 `check_diversion`，`:2121` 派发。）

### 2. 模式开关 — `check_diversion()`
- `Videonew.php:1321` `public function check_diversion(&$extra, int $videoType): int`。读模式 `:1324` `(new NewapiDiversionRuleService())->getRouteMode()`。
- `getRouteMode()` `NewapiDiversionRuleService.php:62`：读 `pq_aivideo_diversion_config` WHERE `line=10 AND name='newapi_route_mode'`；缺失/非法 → 默认 `'newapi'`。
- 三态（常量 `NewapiDiversionRuleService.php:35-41`）：
  - **OFF** → `Videonew.php:1325-1327` `return 0`（直连，LINE 0）。
  - **LEGACY** → `:1328-1330` `LegacyDiversionService->check(...)`（旧概率分流，返回 2/5/6/7 或 0；显式跳过 LINE 10）。
  - **NEWAPI（默认）** → 继续，最终 `:1408` 返回 `LINE`(10)。

### 3. 全量开放 `is_newapi_global` — 绕过组织路由，走全局 Key
- `Videonew.php:1341` `if ($ruleService->isGlobalModel($modelId))`。
- `isGlobalModel` `NewapiDiversionRuleService.php:126` → `getGlobalModelIds()` `:116` 读 `pq_model_config WHERE is_newapi_global=1`。
- 命中全量 `:1342-1351`：解析别名 `Ai::getNewAPIModelAlias`（空则异常）；要全局 Key `getGlobalApiKey()`（配置 `newapi_global_api_key`，空则异常 `:1347`）；随后 **`newapiOrgId=0, newapiRouteGroupId=0, newapiGroup=''`** `:1349-1351` —— **跳过能力并集与组织路由组解析**。Go 侧见 `route_group_id<=0` 即用全局 Key（org_id=0）。（图片镜像：`NewapiImageDiversionService.php:70-81`。）

### 4. 组织路由（非全量的 `else` 分支 `Videonew.php:1352-1391`）
1. 能力并集预筛 `:1355` `if (!$ruleService->isModelRoutable($extra)) return 0;`（不在全局能力并集 → 直连）。
2. 组织解析 `:1362-1363` `(new NewapiRouteService())->resolveByGroupIds($this->auth->getGroupIds())`。
   - `resolveByGroupIds` `NewapiRouteService.php:26`：按用户 auth-group 顺序，取**第一个**在 `pq_newapi_route_group_org` 有绑定的组（`:33`），加载 `pq_newapi_route_group`（`:37`）。
3. 无绑定 → `Videonew.php:1364-1366` `return 0`（回退直连）。
4. 组不可用 → **抛异常（非静默）** `:1369-1371`。`isRouteGroupUsable` `NewapiRouteService.php:53`：`status===1 && !empty(newapi_api_key)`。
5. 组级能力校验 `:1384` `if (!$ruleService->isModelRoutableForGroup($extra, $newapiGroup)) return 0;`。
6. 快照冻结进 `extra` `:1394-1397`（`newapi_org_id / newapi_route_group_id / newapi_group / newapi_model`）。

### 5. 资格门禁 → 强制回退直连（return 0）
`isRequestEligible()` `NewapiDiversionRuleService.php:155`：
- `:159-161` 非 Wan3(videoType≠10) 且 videoType≠6 → 否。
- `:164` `selmodelsId ∈ [16,58]`（seedance-2.0-mini/fast）→ 否。
- `:167-173` `task_type` 不在 `[SEEDANCE_UNIVERSAL(28), FIRST_LAST_FRAME(29), LITE_FIRST_LAST_FRAME(51)]` → 否。
- `:176` 真人人像 `hasRealHumanPortrait`（`:440`，`media_source==='real_human'` 或名字含「真人人像」）→ 否。
- `:179` **提示词 `cueword` > 5000 字 → 否**（计算 `:414-432`；UI 镜像 `v2/VideoHub.php:786`）。
- `:182` **`output_format === 'mov'` → 否**。

能力并集门禁（分辨率/宽高比是否在渠道能力并集）：
- `isModelRoutable()` `:198-232`：全局配置 `newapi_route_rules`；分辨率不在列表 `:224`→否，宽高比不在 `:227`→否。
- `isModelRoutableForGroup()` `:246-312`：按路由组 `newapi_route_group_rules`；空组放行 `:249`；分辨率/宽高比未命中 `:304/:307`→否（`adaptive`↔`auto` 归一 `:486-491`）。
- 图片资格：`NewapiImageDiversionService::check()` `:37-103`（模型 57 低价 / 空别名 / serviceline≠'r' / `size_type==='pixels'` / 参考图 >10 → 不分流）。

### 6. 渠道选择
真正的候选渠道 + 权重/概率挑选在**外部 NewAPI 网关**内（见步骤 7），PHP 只收窄搜索空间：
- 路由组 → `newapi_group`(Token 分组) + `newapi_api_key`；网关在该组内选渠道。
- 能力预筛用配置 `newapi_route_rules` / `newapi_route_group_rules`（`NewapiDiversionRuleService.php:198-312`）。
- 渠道元数据（能力/分辨率/宽高比）由 `NewapiOrgChannelService::listChannelsForFiltering()`（`:221-237`）与 `LineRegistryService::pullChannelMetadata()`（`:610-638`）从 NewAPI 同步。
- 日限额输入：任务积分写入 `extra['points']` `Videonew.php:1401-1406`，供网关按渠道 `daily_quota_limit` 限流。

### 7. 提交 — `asyncGenerateVideo()` + 队列
- `Videonew.php:1072`。线路解析 `:1101-1106`：`diversion===LINE(10)` → `$line=10`，`$line_type = getLineType(selmodelsId)`（映射 `NewapiDiversionRuleService.php:392-403`：15→5,16→6,58→8,78→7,Wan3(84)→9,Wan3Prime(88)→10）。旧线路 2/5/6/7 走 `:1107-1152`。
- 落库：
  - `pq_volcengine_ai_task` 创建 `:1178`（带 `line`,`line_type`）。
  - **仅 NewAPI 线**（`:1182` `if ($line == LINE)`）：建 `pq_newapi_task_log`（`NewapiTaskLog::create` `:1183-1190`，`task_type='video'`,`org_id`,`route_group_id`,`newapi_group`,`status=INIT`），回写 `:1192-1194` `extra={"newapi_log_id":N}`。
  - `pq_aivideo_new.extra.diversion=10` 已在步骤 1 写入。
- 队列 `getVideoTaskTypeAndQueue()` `:3136`：NewAPI → `config('mq_queue.video_newapi')` = `ai_newapi_video_submit_queue`（`:3182-3186` / `:3229-3231`）。
- MQ 发布 `:1271-1281` —— **消息里绝不带 Token**：`{type,id,taskid}`，NewAPI 线再加 `newapi_log_id`。真正 HTTP 提交到网关（`config.php:298-304` `newapi.base_url`）由读队列的 **Go 消费者**按 `newapi_log_id` 查路由组 Key 完成，**不在本仓库**。
- 图片提交：`NewapiImageDiversionService::applySnapshot()` `:118-150` 置 `extra['newapi_image']=1`（`:144`），派发 `ai_newapi_image_submit_queue`（如 `Goods.php:926`）。

### 8. 重试 / 兜底（Seedance 分流失败 → 火山）
NewAPI→火山兜底在 Go 消费者执行；PHP 记录/回读结果：
- `extra.retry_provider` = `'volc_new'` | `'volc_legacy'`（`VolcengineSearch.php:115`，归一 `:288`）。兜底计费线 `:168`：`volc_new`→15，否则 1（火山）。
- 兜底重试日志表 `pq_aivideo_diversion_retrylog`（`Diversion.php:45/:56`），`retry_status=3` = **兜底成功**（`:836`，`excludeFallbackSuccessScoreLogs` `:828-840` 排除首试积分行防重复计。）
- volc-new vs volc-legacy 分流比：配置 `seedance_volcnew_percent`（`Diversion.php:35`，写 `saveVolcNewRoute()` `:618-636`）。
- 逐模型兜底开关：`pq_model_config.is_need_fallback`（`Diversion.php:284/:326`）。
- 其它（非兜底）重试命令：`AutoRequeueFailedTasks.php`（状态 FAILED=4/QUEUED=1/RETRY_QUEUED=7）、`SeedanceEnhancementRetryAuto.php`、`Sensitivetaskretry.php`。**模型 16/58 硬排除，永不进 NewAPI**（步骤 5）。

### 9. 计费（预扣 / 结算 / 失败退款净扣归零）
- **预扣**（提交时）`Videonew.php:1199-1221` → `PointsService::processAiTaskPoints()` `:1543-1557` → `deductPoints()` `:1054-1090`：原子 `->where('score','>=',$points)->dec('score',$points)` `:1067`；写 `pq_score_log` `type=2`(扣) `:1076`；`extra.deduct_points` `:1079`。（`type`：1=加/退款，2=扣，`:1096`。）
- **积分计算**（按秒）`calculatePoints()` `:503`：按秒分支 `:797-800` `points = duration*output_price_per_second (+ ceil(refVideoDuration)*reference_price_per_second)`。
- **失败退款**（幂等，净扣归零）`refundAiTaskPointsWithIdempotency()` `:1629-1697`：锁任务 `:1647`；幂等键 `score_log(userid+task_id+source_id+type=1)` `:1652-1661`；`setInc('score')` `:1668`；写 `pq_score_log` `type=1` `:1672-1685`；`extra.refund_points` `:1687`。失败净效果 = 扣(2)+退(1)=0。
- 台账表 `pq_score_log`（`pq_user_score_log` **不在本链路**）。「10 分=1 元」是业务约定，**未**编码为本链路常量（CNY 换算在 RevenueCost/BillingStat 命令里，属另一路径）。

### 10. `line=10` 语义澄清
`LineRegistryService` 把 `line=10` 当作**调度 Agent / 执行路由，不是计费供应商**（`:36-37`，硬拒 `:202-207`）。真实计费线由实际上游渠道经 `NewapiProviderService` 解析（`NEWAPI_LINE=10 :15`、`VOLC_NEW_LINE=15 :18`、`AL_QD_LINE=11 :20`、`resolveBillingLineFromTask` `:97-126`）。

---

## 表与关键字段（附录）

| 表（省 `pq_`） | 作用 | 关键字段 |
|---|---|---|
| `aivideo_new` | 视频源任务行（入口） | `type`,`extra.diversion`(0/2/5/6/7/10),`extra.newapi_*` 快照,`taskid`,`task_status`,`progress` |
| `aivideo_diversion_config` | NewAPI 配置（line=10） | `line`,`name`,`value`（`newapi_route_mode`,`newapi_global_api_key`,`newapi_route_rules`,`newapi_route_group_rules`,`newapi_channel_line_map`） |
| `aivideo_diversion_setting` | 分流后台开关 | `name`(`seedance_volcnew_percent`),`value` |
| `aivideo_diversion_retrylog` | 兜底重试日志 | `task_id`,`source_id`,`err`,`retry_status`(3=兜底成功),`score` |
| `model_config` | 模型注册 | `id`,`newapi_model_alias`(''=不分流),`is_newapi_global`(1=全量),`is_need_fallback` |
| `newapi_route_group` | 路由组 | `id`,`status`(1=启用),`newapi_api_key`,`newapi_group` |
| `newapi_route_group_org` | 组织↔组绑定 | `org_id`(=auth group id),`route_group_id` |
| `newapi_task_log` | NewAPI 调用日志 | `ai_task_id`,`task_type`,`org_id`,`route_group_id`,`newapi_group`,`newapi_task_id`,`upstream_task_id`,`channel_id`,`status`,`fail_reason` |
| `volcengine_ai_task` | 统一 AI 任务 | `line`(10=NewAPI),`line_type`,`status`(1排队/4失败/7重排),`task_id`,`extra`(`newapi_log_id`,`retry_provider`),`output_result` |
| `score_log` | 积分台账 | `userid`,`task_id`,`source_id`,`score`,`type`(1加/退,2扣),`line`,`model_id`,`createtime` |
| `admin` | 用户余额 | `score` |

**配置/环境**：`config.php:298-304` `newapi.base_url` / `newapi.org_api_token`；`:340-341` 队列 `ai_newapi_video_submit_queue` / `ai_newapi_image_submit_queue`。
**关键常量**（`application/common/constant/Ai.php`）：`VIDEO_TYPE_WANXIANG3=10`、`WANXIANG3_MODEL_ID=84`、`WANXIANG3_PRIME_MODEL_ID=88`、`SEEDANCE_TYPE_UNIVERSAL=28`；`diversion()` 映射 `:1159-1168`（2 RH,5 数据宝,6 星辰,7 赞奇,10 NewAPI）；`getNewAPIModelAlias()` `:1148-1152`（读 `model_config.newapi_model_alias`）。

---

## 边界与限制（测试时必读）
- **渠道权重/概率挑选** 与 **NewAPI→火山自动兜底** 都在读 `ai_newapi_video_submit_queue` 的 **Go 消费者**里，**不在 `/Users/mac/agents/panqu-ai`**（`gocron` 无 newapi 代码）。以上仅为 PHP 侧决策/落库/回读。
- 已发现的路径订正：`aivideo/v2/ModelConfig.php` **不存在**（模型配置在表 `pq_model_config` + `common/constant/Ai.php`）；分流核心是 `service/NewapiDiversionRuleService.php`（图片另有 `NewapiImageDiversionService.php`）；`Diversion.php` 在 `controller/aivideo/`（非 `v2/`）。
- `test-diversion.sh`（panqu-ai 根）只是 DevTest CLI 跑批器（编译 test-flow 后跑 `plan|execute`），不含 PHP 流程。
- `LegacyDiversionService::check()` 内部（2/5/6/7 概率分配）仅按签名+grep 确认，未逐行读。

