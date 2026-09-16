---
name: panqu-newapi-diversion
description: 处理 Panqu 主站已有图片与视频模型增加或修改 NewAPI 两级分流变更 (IMAGE_DIVERSION_CHANGE / VIDEO_DIVERSION_CHANGE) 的研发自测、契约生成与生产验收智能体决策树。
---

# Panqu NewAPI 分流变更智能体决策树 (panqu-newapi-diversion)

本 Skill 是面向 Coding Agent 与测试工程师的**分流变更决策指南**，专门规范已有图片模型 (#201 Nano Banana 等) 与已有视频模型 (#84 Wan 3.0 等) 切流至 NewAPI 网关（`aiapis.panqu.com`）时的自测与验收。

---

## 一、分流变更场景决策树

```text
接收研发自然语言或 CLI 输入
           │
           ▼
[判断 1] 媒体类型与变更类型
  ├── 包含图片模型且属于已有分流调整 ──► 场景: IMAGE_DIVERSION_CHANGE (#201 等)
  └── 包含视频模型且属于已有分流调整 ──► 场景: VIDEO_DIVERSION_CHANGE (#84 等)
           │
           ▼
[判断 2] 全量开放属性 (is_newapi_global)
  ├── is_newapi_global = 1 (全量模型) ──► 全局直达 NewAPI，安全裁剪“组织路由组隔离测试”
  └── is_newapi_global = 0 (组织模型) ──► 必须测试“组织绑定切流”与“无绑定回退直连”
           │
           ▼
[判断 3] 事实探知与定价完整性
  ├── 存在静态已知定价 (如 #84=14pt/s, #201=5pt) ──► 采纳静态契约，允许执行
  └── 未知模型或缺少定价 ──► 标记 MANUAL_REQUIRED，阻断通过 (BLOCKED / Fail-Closed)
           │
           ▼
[判断 4] 最小充分 TestPlan 生成与执行
  probe (环境探活) ──► plan (契约与计划) ──► execute (执行) ──► verify (四态验收)
```

---

## 二、事实探知优先级与 ChangeContract 规范

智能体在 `plan` 阶段必须遵循严格的事实探知优先级：

$$\text{SOURCE\_INPUT} > \text{SOURCE\_STATIC\_CONTRACT} > \text{SOURCE\_DEFAULT\_FALLBACK}$$

- **严禁**将 `SOURCE_DEFAULT_FALLBACK` 当作真实事实直接给出 `ACCEPTED` 判决。
- **静态冲突**：若研发显式传入的别名/规格与静态白名单冲突，产生 `CONFIG_MISMATCH` 阻断。
- **ChangeContract 契约必备字段**：
  1. `scenario`: `IMAGE_DIVERSION_CHANGE` 或 `VIDEO_DIVERSION_CHANGE`
  2. `modelId` & `mediaType`
  3. `beforeState`: 原链路直连状态 (`flowType='direct'`, `routeLine=0`, `decision='FALLBACK_DIRECT'`)
  4. `afterState`: 预期切流状态 (`flowType='diversion'`, `routeLine=10`, `decision='NEWAPI_GLOBAL' | 'NEWAPI_IMAGE' | 'NEWAPI_ORG_GROUP'`)
  5. `requiredFacts`: `['modelId', 'mediaType', 'flowType', 'alias', 'pricing']`
  6. `routingExpectation`: 切流预期、新分流线、组织分组快照
  7. `pricing`: 真实刊例单价与核销基准

---

## 三、最小充分测试用例集与安全裁剪矩阵

测试智能体必须生成**解释性测试计划**：对纳入的用例说明必要性 (`rationale.whyIncluded` / `riskAddressed`)，对跳过的用例说明依据 (`skippedTests.whySkipped` / `rule`)。

### 3.1 核心测试用例（必测）

| 用例 ID | 所属分层 | 纳入理由 (whyIncluded) | 防范风险 (riskAddressed) |
|---|---|---|---|
| `baseline-direct` | routing | 比对未切流特征请求，核验依然走原渠道直连 | 防止非目标流量或非相关业务线被误伤劫持 |
| `routing-global` / `routing-group` | routing | 核验满足条件的正向请求命中两级分流 (LINE=10) | 防止切流配置遗漏导致流量未切入 NewAPI |
| `gateway-candidate` | routing | 核验 NewAPI 网关上游渠道候选与每日积分限额 | 防止网关上游无有效渠道或超额打垮网关 |
| `artifact-mp4` / `artifact-png` | artifact | 解码 MP4 Box 结构 (moov/mdat) 或 PNG IHDR 物理尺寸 | 防止分流至上游供应商后返回损坏文件或假文件 |
| `billing-invariants` | billing | 核验三大账务不变量（防重复扣费、退款幂等、失败净扣归零） | 防止两级分流改造引发线上资金资损 |

### 3.2 安全裁剪用例（剪枝规则）

| 跳过用例 ID | 适用场景 | 裁剪原因 (whySkipped) | 裁剪规则 (rule) |
|---|---|---|---|
| `route-group-isolation` | 全量模型 (`is_newapi_global=1`) | 模型已全量开放，所有组织无条件走全局 NewAPI Key，无需组织隔离 | `全量模型免组织隔离` |
| `boundary-refimg` | 生图模型无参考图 | 该模型 `maxRefImages=0`，接口本身不支持参考图，无需超限拦截 | `非参考图模型跳过参考图边界` |
| `fallback-policy` | 非 Seedance 视频模型 | 阿里万相/RH 等模型分流失败直接报错退出，无火山重试降级队列 | `非重试模型跳过重试降级` |
| `gateway-eligibility-guard` | 视频模型 | 视频仅支持预设宽高比，自定义像素准入门禁仅适用于生图接口 | `视频模型跳过生图网关准入门禁` |

---

## 四、生产级四态验收判决系统 (Fail-Closed)

验收环节必须严格输出四态判决之一，禁止二元化：

1. **`ACCEPTED`**：
   - 任务终态为 `SUCCESS`；
   - 媒体产物物理结构解析成功（MP4 容器解码正常 / PNG 物理尺寸吻合）；
   - 账务流水净扣与预期刊例价完全一致；
   - 三大账务不变量全部为 `PASS`；
   - Baseline 回归比对为 `CLEAN`（仅允许预期的 routing 字段切流，不允许 pricing/artifact 发生非预期漂移）；
   - 提供底层落库证据（`extraConfirmed=true`）与网关渠道证据（`gatewayChannelConfirmed=true`）。
2. **`REJECTED`**：
   - 任务失败且扣费不为 0（违背失败净扣归零）；
   - 产物损坏不可解码；
   - 积分产生非预期漂移；
   - Baseline 回归检测到非预期突变。
3. **`BLOCKED`**：
   - 缺少真实刊例单价（依赖 `SOURCE_DEFAULT_FALLBACK` 兜底）；
   - 缺少有效环境凭据，无法连接目标系统；
   - 静态契约存在 `CONFIG_MISMATCH` 冲突。
4. **`UNVERIFIED`**：
   - 区分“证据不足”与“没有问题”：仅在 HTTP API 表面观察成功，但未提供数据库 extra 落库或网关渠道验证凭据；
   - 回归比对在证据不全时标记 `regressionStatus: UNKNOWN`，严禁假定 `CLEAN`。

---

## 五、人工确认证据清单与只读 SQL 模板

在验收阶段，若无法直接获得内部数据库或网关底层权限，智能体必须为测试人员提供**免责自证 SQL 模板**：

### 5.1 视频分流底层落库核验 (extra.diversion = 10)

```sql
-- 验证 aivideo 任务真实写入 NewAPI 分流标记
SELECT id, status, task_type, extra, user_group_id, created_at 
FROM pq_aivideo_new 
WHERE id = <taskId> 
LIMIT 1;
-- 期望验证项：JSON 字段 extra 中包含 "diversion": 10
```

### 5.2 图片分流底层落库核验 (extra.newapi_image = 1)

```sql
-- 验证生图任务真实写入 NewAPI 分流标记
SELECT id, task_status, extra, user_group_id, created_at 
FROM pq_ai_tasks 
WHERE id = <taskId> 
LIMIT 1;
-- 期望验证项：JSON 字段 extra 中包含 "newapi_image": 1
```

### 5.3 用户积分账务流水核对 (防资损与不变量)

```sql
-- 验证该任务账务流水记录（预扣与结算，或失败退款）
SELECT id, user_id, task_id, score, memo, type, created_at 
FROM pq_user_score_logs 
WHERE task_id = <taskId> 
ORDER BY id ASC;
-- 期望验证项：
-- 1. 成功任务：预扣/结算积分与刊例定价一致，无重复扣费；
-- 2. 失败任务：必定存在等额退款，净扣分必须为 0。
```

### 5.4 NewAPI 网关调用日志排查

```sql
-- 核验网关层是否真实接收到来自主站的请求并路由至预期渠道
SELECT id, model_name, token_name, channel_id, quota, prompt_tokens, completion_tokens, created_at 
FROM newapi_logs 
WHERE token_name = 'panqu_test' AND model_name = '<modelAlias>' 
ORDER BY id DESC LIMIT 5;
```

---

## 六、标准 CLI 与 MCP 调用范式

```bash
# 1. 规划阶段：输入自然语言或参数，生成带理由与裁剪依据的最小测试计划
devtest plan "给 201 增加 NewAPI 全量分流"
devtest plan "把 84 视频模型切到 NewAPI --points-per-second 14"

# 2. 执行阶段：受控派发真实任务或离线仿真
devtest execute --model 201 --media image --price 5 --session-file session.json

# 3. 验收阶段：全量证据核对与三态回归检验
devtest verify --task <taskId> --model 201 --media image --price 5 --session-file session.json
```
