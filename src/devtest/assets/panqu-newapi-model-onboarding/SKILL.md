---
name: panqu-newapi-model-onboarding
description: 处理 Panqu 新图片与新视频模型直接接入 (IMAGE_NEW_MODEL / VIDEO_NEW_MODEL) 的研发自测、契约审查、规格覆盖与生产验收智能体决策树。
---

# Panqu 新模型接入自测智能体决策树 (panqu-newapi-model-onboarding)

本 Skill 是面向 Coding Agent 与测试工程师的**新模型接入决策指南**，专门规范新图片模型（如 #950 Direct）与新视频模型（如 #960 Direct）上线时的契约建立、规格矩阵覆盖与生产验收。

---

## 一、新模型接入决策树

```text
接收研发自然语言或 CLI 输入 (例: "接入 960 视频模型 --price 7")
                      │
                      ▼
[判断 1] 媒体类型与变更类型
  ├── 包含图片模型且为新接入 ──► 场景: IMAGE_NEW_MODEL (#950 等)
  └── 包含视频模型且为新接入 ──► 场景: VIDEO_NEW_MODEL (#960 等)
                      │
                      ▼
[判断 2] 事实探知与单价核实 (Fail-Closed)
  ├── 显式传入单价 (--price / --points-per-second) ──► 采纳为真实定价，isPricingDetermined=true
  └── 未提供定价 (缺少刊例价) ──► 拒绝使用兜底价，阻断通过 (BLOCKED / MANUAL_REQUIRED)
                      │
                      ▼
[判断 3] 链路属性与规则剪枝 (DIRECT 模式)
  ├── 新模型代码直连接入 (flowType='direct') ──► 安全裁剪 NewAPI 网关调度与组织隔离用例
  └── 必须覆盖: 规格支持契约、任务创建提交、产物物理结构核验、单价计费核销
                      │
                      ▼
[判断 4] 4 步标准闭环执行
  probe (环境探活) ──► plan (契约与计划) ──► execute (执行) ──► verify (四态验收)
```

---

## 二、事实探知优先级与 ChangeContract 规范

智能体在 `plan` 阶段必须遵循严格的事实探知优先级：

$$\text{SOURCE\_INPUT} > \text{SOURCE\_STATIC\_CONTRACT} > \text{SOURCE\_DEFAULT\_FALLBACK}$$

- **新模型定价铁律**：未知新模型绝对禁止使用 `5 pt` 或 `28 pt` 的默认 fallback 作为真实依据给出通过判决。
- **ChangeContract 必备字段**：
  1. `scenario`: `IMAGE_NEW_MODEL` 或 `VIDEO_NEW_MODEL`
  2. `modelId` & `mediaType`
  3. `beforeState`: `flowType='none'`, `pricing='未确定'`
  4. `afterState`: `flowType='direct'`, `routeLine=0`, `decision='FALLBACK_DIRECT'` (免分流直连模式)
  5. `requiredFacts`: `['modelId', 'mediaType', 'alias', 'pricing', 'supportedResolutions']`
  6. `routingExpectation`: `mode: 'DIRECT'`, `willDivert: false`, `routeLine: 0`
  7. `pricing`: `points` (图片按张) 或 `pointsPerSecond` (视频按秒)，来源必须为 `SOURCE_INPUT` 或静态已知

---

## 三、最小充分测试用例集与安全裁剪矩阵

测试智能体必须生成**解释性测试计划**：对纳入的用例说明必要性 (`rationale.whyIncluded` / `riskAddressed`)，对跳过的用例说明依据 (`skippedTests.whySkipped` / `rule`)。

### 3.1 核心测试用例（必测）

| 用例 ID | 所属分层 | 纳入理由 (whyIncluded) | 防范风险 (riskAddressed) |
|---|---|---|---|
| `routing-direct` | routing | 验证新模型直连线路 0 判定 | 防止新上线模型被错误拦截或分流至未配置网关 |
| `gateway-eligibility-guard` | boundary | 网关前置准入门禁拦截（超长文本/非法格式） | 防止非法参数穿透打垮下游推理服务 |
| `real-task-submit` | execution | 向主站真实发起任务提交请求并获取有效 taskId | 验证鉴权、参数白名单与主库任务记录落库能力 |
| `artifact-mp4` / `artifact-png` | artifact | 解析 MP4 Box 树 (moov/mdat/stco) 或 PNG IHDR 物理尺寸 | 防止供应商返回空文件、损坏流或假规格 |
| `billing-invariants` | billing | 核验计费单价精准扣费与三大账务不变量 | 防止单价配置错误产生资损或失败未退款 |

### 3.2 安全裁剪用例（剪枝规则）

| 跳过用例 ID | 裁剪原因 (whySkipped) | 裁剪规则 (rule) |
|---|---|---|
| `gateway-candidate` | 本次为 Direct 直连接入，不涉及 NewAPI 网关渠道加权与限额检查 | `DIRECT 接入免网关调度` |
| `route-group-isolation` | Direct 直连接入，免组织与路由组绑定鉴权 | `DIRECT 接入免组织隔离` |
| `fallback-policy` | Direct 直连接入，无 NewAPI 失败重试降级策略 | `DIRECT 接入无重试降级` |
| `boundary-refimg` | 该生图模型不支持参考图 (`maxRefImages=0`)，无需参考图超限测试 | `非参考图模型跳过参考图边界` |

---

## 四、执行与验证管道规范 (Execute & Verify Fail-Closed)

### 4.1 阻断规则 (Fail-Closed)
- 若 `contract.pricing.allowPass == false`（未提供单价）：
  - `execute()` 立即阻断并返回 `status: 'BLOCKED'`，拒绝以虚假单价派发任务；
  - `verify()` 立即阻断并返回 `acceptance: 'BLOCKED'`，绝不给出误导性通过。
- 当研发或测试通过 `--price` 或 `--points-per-second` 补充事实后，阻断解除。

### 4.2 验证与动态计费计算
- **视频模型**：按秒动态计算预期扣费：
  $$\text{expectedPoints} = \text{pointsPerSecond} \times \text{duration}$$
- **图片模型**：按张动态计算预期扣费：
  $$\text{expectedPoints} = \text{price}$$

---

## 五、生产级四态验收判决系统

1. **`ACCEPTED`**：
   - 任务终态为 `SUCCESS`；
   - 产物解码正常，物理结构解析通过；
   - 账务流水预扣与结算吻合预期，净扣与动态刊例价完全一致；
   - 不变量 `antiDoubleBilling=true`, `netChargeZero=true`, `refundIdempotency=true`；
   - 抽检产物 OSS 存储与物理完整性。
2. **`REJECTED`**：
   - 任务创建失败或终态为 `FAILED` 且退款失败；
   - 产物损坏、分辨率不匹配或文件大小异常（<100 字节）；
   - 扣费金额与刊例定价不符。
3. **`BLOCKED`**：
   - 缺少单价或 session 凭证；
   - 规格参数冲突。
4. **`UNVERIFIED`**：
   - 仅在脱机离线模式演算，无真实 session 与产物流水；
   - 未查验 OSS 物理产物。

---

## 六、人工确认证据清单与检验方法

新模型直接接入模式下，测试人员需人工确认以下两项核心物理证据：

### 6.1 视频模型物理产物与 OSS 存储抽检
1. **MP4 容器完整性**：
   - 抽检任务产物 URL，确认包含有效的 `moov`（媒体元数据）与 `mdat`（媒体数据）原子盒；
   - 确认 Web 端或主流播放器能够秒开流式播放（`moov` 位于文件头部或支持 Range 请求）。
2. **OSS 归档可用性**：
   - 核验主站返回的视频 CDN/OSS 地址可正常下载且文件大小与预期画质匹配（通常 720p 5s 视频在 1MB~5MB 之间）。

### 6.2 图片模型物理产物抽检
1. **PNG IHDR 结构**：
   - 解析 PNG 二进制前 33 字节，核对 IHDR 记录的宽和高与请求规格（如 1k/2k）精准一致。
2. **账务对账 SQL**：
   ```sql
   SELECT id, task_id, score, memo, type, created_at 
   FROM pq_user_score_logs 
   WHERE task_id = <taskId> 
   ORDER BY id ASC;
   ```

---

## 七、标准 CLI 与 MCP 调用范式

```bash
# 1. 规划阶段：输入自然语言，自动识别新模型场景并生成解释性测试计划
devtest plan "接入 960 视频模型 --points-per-second 7"
devtest plan "上线 950 新图片模型 --price 5"

# 2. 执行阶段：带入单价参数受控执行
devtest execute --model 960 --media video --points-per-second 7 --duration 5 --session-file session.json

# 3. 验收阶段：全量证据核对与产物物理结构验真
devtest verify --task <taskId> --model 960 --media video --points-per-second 7 --duration 5 --session-file session.json
```
