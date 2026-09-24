# NewAPI 分流「运行时资格」门槛 — model × 分辨率 × 画面比例 × 渠道启用 (newapi-eligibility-gate)

> **取证来源**：逐行核对 `/Users/mac/agents/panqu-ai/aibaseos` 于 2026-09-24。用「方法名 + 条件」定位（行号会漂移）。
> **先记这条**：飞书《分流渠道表》是**业务刊例/成本**元数据（见 [`channel-cost-discount-catalog.md`](./channel-cost-discount-catalog.md)），**不是运行时资格真源**。运行时是否分流由 **NewAPI 网关渠道配置**（`apitest.panqu.com/channels`「模型与分组」：每模型→允许分辨率+允许画面比例）决定。

## 两套真源（务必分开）

| 真源 | 内容 | 决定什么 | 代理可读方式 |
|---|---|---|---|
| 飞书《分流渠道表》 | 刊例价(积分)、成本价¥、折扣 | **价格/成本对比**（刊例价不变量、选最低成本渠道） | 本地快照 `feishu-live-pricing-cache.json` |
| **NewAPI 网关渠道配置** | 每(渠道,模型)→{允许分辨率, 允许画面比例, 启用状态, 分组} | **运行时可分流资格** | 见下「数据可达性」 |

两者以 `pq_model_config.newapi_model_alias`（别名↔模型ID）关联。

## 资格配置存哪（网关 → 本地镜像）

- 网关是权威源；`Channel.php` 编辑/启用渠道时 **PUT 网关** 并 `syncChannelMappingsFromNewapi()` 同步进本地。
- 本地镜像表 `pq_aivideo_diversion_config`（`line=10`）：
  - `newapi_route_rules`（全局并集）：`{"video":{<模型ID>:{"resolutions":[],"aspect_ratios":[]}}, "image":{<模型ID>:{"channels":[{"resolutions":[],"aspect_ratios":[]}]}}}`
  - `newapi_route_group_rules`（按 `newapi_group` 分组）：同结构多一层分组键。
  - `newapi_route_mode`：`newapi`/`legacy`/`off`（分流总开关，默认 newapi）。
  - `newapi_global_api_key`：全量模型全局 Key。
- **「打开分流渠道」**（`aivideo/channel/index`）：`Channel::status()` → 网关 `PUT /api/organization/channel/{id}/status`（1启用/2停用）+ 同步。**只有 status=1 的渠道**会被折进 route_rules（`NewapiProviderService::syncRouteRules`）。

## 视频资格门槛（`Videonew::check_diversion`，返回 10=分流 / 0=直连）

顺序（全在 aibaseos PHP）：
1. `getRouteMode()`：`off`→0；`legacy`→旧概率分流线路(2/5/6/7)。
2. `isRequestEligible()`：wan3 或 type=6 Seedance；排除模型 16/58；task_type∈{28,29,51}；无真人人像；cueword≤5000；output≠mov。不过→0。
3. `isGlobalModel()`（`pq_model_config.is_newapi_global=1`）：**跳过分辨率/画面比例校验**，直接用全局 Key（缺别名/缺全局Key→**抛异常中断提交**）。
4. 非全量：`isModelRoutable()`——`video_resolution`∈允许分辨率 **且** `video_aspect_ratio`(归一化 adaptive→auto)∈允许画面比例（全局并集）；不过→**回退0**。
5. 解析企业路由组；组停用/缺Key/缺别名→**抛异常**；组未解析→回退0。
6. `isModelRoutableForGroup()`：按 `newapi_group`(+default) 精确校验分辨率+画面比例；不过→回退0。命中→写快照 + 返回 10。

**字段**：`video_resolution` / `video_aspect_ratio`。

## 图片资格门槛（`NewapiImageDiversionService::check` + `applySnapshot`）

- 特判先行：**Image2.5** 无渠道→抛用户错误「所选分辨率和画幅暂无可用图片渠道」（中断）；**MJ v8.2** 无条件分流（不校验画面比例）。
- 常规：模型57(Image2低价版)暂停→回退；别名空→回退；`serviceline≠'r'`→回退；`size_type='pixels'`→回退；参考图>10→回退。
- `isImageModelRoutable()`→`matchesImageCapability()`：**同一启用渠道**须**同时**支持 `resolution`(默认2k) 与 `aspectRatio`(默认1:1)。
- **关键差异 vs 视频**：图片**全量模型仍校验分辨率/画面比例**（`isImageModelRoutable` 在全量分支之前执行）；分组不可用是**静默回退**（非异常）。
- **字段**：`resolution` / `aspectRatio` / `size_type` / `serviceline`。

## 测试模块（本仓库）

`src/devtest/newapi-route-eligibility.ts` 忠实镜像上述门槛：`isVideoModelRoutable` / `isVideoModelRoutableForGroup` / `isImageModelRoutable` / `matchesImageCapability` / `isVideoRequestEligible` / `evaluateVideoDiversion`(完整 check_diversion) / `evaluateImageDiversion`(check+applySnapshot)。规则 JSON 作入参（fixture 或 DB line=10 读入）。测试见 `tests/unit/devtest/newapi-route-eligibility.test.ts`。

### 已接入 verify 流水线（可测性接线）
`verify()` 两个可选入参把上述纯判定接进裁决流水线（opt-in，不传即不影响既有用例）：
- **`pricingAuthority: { model, resolution }`** → `resolveVerifyContext` 自动从飞书快照取刊例价作计费基准（视频=积分/秒、图片=每张）；调用方显式 `pointsPerSecond`/`customPoints` 优先，取数失败静默回退。
- **`diversionEligibility: { mediaType, video|image }`** → 挂载 `DiversionEligibilityProducer`，把**预测分流决策**（`evaluate*Diversion`）与**落库分流标记**（`extra.diversion`/`newapi_image`/`volcengine_ai_task.line`，取自 `dbRawCollection`）对照，产出可裁决信封 `SERVER_API:DIVERSION_ELIGIBILITY`（预测=实际→PASS，不符→FAIL，无落库→UNVERIFIED）。
集成测试见 `tests/unit/devtest/diversion-pipeline-integration.test.ts`。

### 自动拉取资格配置（闭环）
`src/devtest/diversion-config-reader.ts` 经可注入执行器（默认 `scripts/read-diversion-config.py`，只读 SSH 隧道）拉取 `pq_aivideo_diversion_config`(line=10) + `pq_model_config`，返回 `{routeMode, routeRules, groupRules, globalModelIds, aliasMap, globalApiKeyConfigured}`；fail-closed、脱敏，测试注入假执行器即 100% 离线覆盖。`toEligibilityRules(cfg, modelId)` 把它桥接成 `evaluate*Diversion` 的入参（routeMode/routeRules/groupRules/isGlobalModel/alias/hasGlobalApiKey）。**真实环境无需手喂规则**：`readDiversionConfig()` → `toEligibilityRules()` → `verify({ diversionEligibility })`。测试见 `tests/unit/devtest/diversion-config-reader.test.ts`。

## 数据可达性（跑真实资格断言需要的其中一种）

1. **本地 DB（最简）**：`SELECT name,value FROM pq_aivideo_diversion_config WHERE line=10`（取 `newapi_route_rules`/`newapi_route_group_rules`/`newapi_route_mode`/`newapi_global_api_key`）+ `pq_model_config(id,newapi_model_alias,is_newapi_global)` 解码模型ID。
2. **网关 API（权威源，需 `newapi.org_api_token`）**：`GET /api/organization/channel` → 渠道含 `models[].{model,resolutions,aspect_ratios}`+status+group。
3. **后台 AJAX（需管理员会话）**：`GET aivideo/channel/index`（isAjax）→ 每渠道 `models[].{model,resolutions,aspect_ratios}`。

> 无匿名接口。把上述任一导出（或某渠道的 route_rules JSON）给测试代理，即可离线断言 (模型,分辨率,画面比例,启用) 资格；无需真实提交。
