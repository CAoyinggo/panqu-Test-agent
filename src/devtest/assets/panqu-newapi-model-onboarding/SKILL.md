---
name: panqu-newapi-model-onboarding
description: 处理通过 NewAPI 网关接入新模型与新渠道（如 Wan 3.0 / Prime、RunningHub、TalkingData）、两级分流决策、全量开放开关 (is_newapi_global)、渠道参数配置（分辨率/画幅/首尾帧）、组织管理密钥绑定、SD 重试兜底及账单大盘数据同步的开发自测、契约审查与测试流程规范。当涉及分流逻辑变更、新供应商接入或 NewAPI 联调时使用。
---

# Panqu NewAPI 新模型接入与分流自测专属 Skill

本 Skill 专门规范 Panqu（盼趣AI）系统通过统一 API 网关（NewAPI，`aiapis.panqu.com`）**接入新模型、配置新渠道、执行两级分流决策以及开发自测**的标准规范。

本规范严格对齐产品需求文档《[0903 - 主站与Newapi对接v1.2版本](https://panqu-ai.feishu.cn/docx/W3cZd813YoNMnCxiT1zckWzenwe)》及主站核心实现（`aibaseos` 后端）。

---

## 一、两级分流决策架构

主站模型调用统一遵循**“主站业务资格前置判定 → NewAPI 权重与限额调度 → 上游供应商执行”**的两级决策体系：

```
用户发起模型生成请求
       │
       ▼
【第 1 级：主站前置资格判断】（aibaseos 负责）
   1. 分流模式检查：newapi_route_mode
       ├── off: 全部关闭，不分流，走历史直连
       ├── legacy: 故障快速回切，走旧版概率分流
       └── newapi: 进入 NewAPI 分流资格判断（默认）
   2. 硬性限制检查（isRequestEligible）：
       ├── 提示词长度 <= 5000 字（超长直接拦截）
       ├── 输出格式非 MOV（MOV 格式不支持分流）
       ├── 无真人人像（包含真人人像回退直连）
       └── Seedance 仅全能参考任务 (task_type=28) 且无参考视频支持分流；Wan 3.0 全能参考与首尾帧全量支持
   3. 全量模型判断（isGlobalModel）：
       ├── 是（pq_model_config.is_newapi_global == 1）：
       │     绕过组织路由组与角色绑定，直接使用全局 API Key（newapi_global_api_key），
       │     任务快照记 newapi_org_id=0, newapi_route_group_id=0, newapi_group=''，直达 NewAPI 全局渠道
       └── 否（非全量模型）：
             ├── 全局能力并集校验（isModelRoutable）：检查 newapi_route_rules 是否支持该模型/分辨率/画幅
             ├── 组织路由组解析（resolveByGroupIds）：由用户角色组通过 pq_newapi_route_group_org 解析对应路由组
             ├── 路由组可用性检查（isRouteGroupUsable）：路由组启用 (status=1) 且 NewAPI 密钥非空
             └── 分组能力精确校验（isModelRoutableForGroup）：检查路由组对应 newapi_group 内是否有渠道承接
                   │
                   ▼
【第 2 级：NewAPI 网关分发】（aiapis.panqu.com 负责）
   1. 根据传入的分组 (newapi_group，如 panqu_test / default) 过滤有效渠道
   2. 校验渠道每日积分限额（daily_quota_limit）与当前任务预估积分（points）
   3. 按渠道预设权重（weight）加权轮询分发至具体供应商
       │
       ▼
【后续链路：重试兜底与计费核算】
   1. 失败处理：SD 系列任务分流失败进入重试列表并标记 is_need_fallback 兜底；其他模型直接报错退出
   2. 计费核销：10 积分 = 1 元，按秒计费，账单大盘动态映射供应商
```

---

## 二、新模型接入与渠道配置七步 SOP

当业务需要新接入一个模型（如 Wan 3.0、Wan 3.0 Prime、RunningHub 新模型等）时，必须按以下步骤闭环：

### 步骤 1：模型元数据与全量开关配置
1. 在 `pq_model_config` 表中注册模型：
   - 配置 `id`、`show_name`、`newapi_model_alias`（NewAPI 内部请求名，在 `Ai.php` 中维护别名映射）；
   - 设置 `is_newapi_global`（1: 全量开放，直接走全局渠道；0: 分组开放，需组织绑定）。
   > **注意**：需求规定全量开放“默认开启”，但数据库 schema 初始可能为 `DEFAULT 0`，接入新模型时务必明确该模型的初始开关状态。

### 步骤 2：NewAPI 网关只读核验
1. 访问 `https://aiapis.panqu.com/keys`（测试分组）；
2. **安全铁律**：对 NewAPI 实例实行**零写操作**（不创建、不修改、不删除任何 Key、渠道、分组与令牌）；
3. 只读确认上游渠道是否已部署并绑定对应模型（如 Wan 3.0 对应渠道 #36，TD 对应 #41 等）。

### 步骤 3：主站 CMS 渠道参数配置
在主站后台【渠道管理】编辑渠道参数：
- **分类**：视频生成 / 图片生成；
- **模型能力**：
  - 全能参考：包含文、图、音频生成视频，若勾选“支持参考视频”则允许参考视频；
  - 首尾帧：支持首尾帧插值生成模式；
- **视频分辨率**：480P、720P、768P（新增）、1080P、2K、4K；
- **画幅比例**：
  - Wan 3.0 / Prime：自适应、9:16、16:9、4:3、3:4、1:1；
  - 图片模型：1:1、4:3、3:4、16:9、9:16、3:2、2:3、5:4、4:5 共 9 种。

### 步骤 4：同步路由能力规则
保存渠道后，主站通过 `NewapiProviderService` 自动同步：
- 全局能力并集表：`newapi_route_rules`（`{"video": {modelId: {resolutions, aspect_ratios}}}`）；
- 分组精确能力表：`newapi_route_group_rules`（按 group 分组记录）。

### 步骤 5：组织管理与密钥绑定
1. 默认组织（如 PQ-001）包含主站所有普通用户，系统直接关联 NewAPI 默认分组密钥；
2. 企业搜索必须精准匹配（搜索关键字 `1` 时，ID 为 `1` 的企业必须排在第一位）；
3. 移动分组时必须二次确认，支持勾选移交和全选，未勾选企业留在原组织。

### 步骤 6：异常重试与兜底策略
1. 核对任务控制器中的异常捕获：
   - 仅 SD 系列模型（Seedance 2.0 / 2.5 等）在分流失败时标记 `is_need_fallback=1`，进入分流重试列表展示兜底结果；
   - 非 SD 模型（如 Wan 3.0、Wan 3.0 Prime）分流失败直接报错，**不得进入重试列表**。

### 步骤 7：计费预估与账单大盘数据同步
1. 计费公式：`10 积分 = 1 元`，按秒计费（生成时长 × 输出单价 + 参考视频时长 × 参考单价）；
2. 确保账单大盘（`/billing/dashboard`）已同步新渠道供应商编码与新模型任务类型（如 Wan 3.0 对应 105/106/28/10）。

---

## 三、测试与验证安全准则（必遵准则）

1. **NewAPI 零写原则**：严禁向 NewAPI 网关（aiapis.panqu.com）发起任何写操作（禁止添加、修改渠道与密钥）。
2. **测试数据标识**：所有端到端测试任务名称必须带 `devtest_` 前缀（如 `devtest_wan3_e2e`、`devtest_prime_e2e`）。
3. **CMS 操作可回滚**：在 CMS 上的任何测试操作（如开关单模型 `is_newapi_global`）必须先记录基线，操作完成后必须立即调用原接口回滚并复核。
4. **凭证脱敏与安全**：禁止输出或记录任何明文 Cookie、Bearer Token 或 API Key（必须打码为 `sk******`）。
5. **需求划掉项保护（删除线保护）**：
   - 菲玲渠道（P2）——需求划掉，系统未接入，状态一致；
   - 接入主站剩余视频及图片模型（P2）——需求划掉；
   - 主站代码同步海外站（P1）——需求划掉。
   **划掉项绝对不计入系统缺陷或漏测项**。
6. **自动化执行工具**：
   通过专属测试命令一键执行 21 项契约与决策流检验：
   ```bash
   devtest flow api-diversion --project-root /Users/mac/agents/panqu-ai
   ```

---

## 四、参考文件索引

- 详细代码映射：[code-map.md](references/code-map.md)
- 详尽参数边界表：[input-constraints.md](references/input-constraints.md)
- 新模型接入 SOP 指引：[onboarding-sop.md](references/onboarding-sop.md)
