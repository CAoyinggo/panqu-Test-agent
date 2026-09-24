---
name: panqu-billing
description: 处理 Panqu/盼趣的计费、积分预估、消费明细、账单大盘、扣费与退费对账的自测与审查。当涉及新增模型定价、刊例价、钱包扣费、充值记录、大盘趋势统计或数据库积分日志核验时使用。
---

# Panqu 计费、积分与对账专项

在 Panqu/盼趣项目中，所有涉及模型生成扣费、积分结算、刊例价变动、消费明细及管理后台账单统计的需求，必须读取本 Skill 并执行端到端闭环验证。

> **端到端真实代码流程**（计算 `calculatePoints` → 原子扣费 `deductPoints` → 失败幂等退费 → 账单大盘 → 成本/营收对账，含 `file:line` 与三大账务不变量强弱）见 [`references/billing-flow.md`](references/billing-flow.md)。

## 一、主战场与架构分层

- **核心主战场**：`aibaseos`（PHP ThinkPHP 5），核心文件为 `application/admin/controller/aivideo/v2/Billing.php`（478KB）与 `aivideo/v2/Task.php`。
  - 前端路由多通过 `billing/personal` 与 `billing/dashboard` 配合 `section` 参数进行请求分发。
- **中台预估计费**：`aipanqucenter`（NestJS），负责 `/integration-platform/models/estimatedBilling` 与 `/expense/user/getMany`。
- **底层数据表**：
  - `pq_absetting`：积分单价配置表（含 `list_price_points`）；
  - `pq_model_config`：模型配置与定价表；
  - `pq_score_log` 及 `pq_score_log_archive_*`：用户积分流水表（按月归档，跨月核查需注意合并归档表）。
- **各模型刊例价格与分流对账数据源**：
  - 飞书 Wiki 价格表（基础刊例）：[各模型价格表 (Sheet: 1eZi7i)](https://panqu-ai.feishu.cn/wiki/TBikw4XZXiiygBkqphbckfkXnqF?sheet=1eZi7i)（待授权确认草案，详见 `references/official-pricing-catalog.md`）
  - 飞书 Wiki 价格表（分流线路与多渠道）：[分流与多线路对应表 (Sheet: 35279c / tM4eqI)](https://panqu-ai.feishu.cn/wiki/NNxfwgI2fih5iekmKABcSn2Wnne?sheet=35279c)（已通过 Keychain 鉴权验证，详见 `references/channel-cost-discount-catalog.md`；本地快照见 `references/feishu-live-pricing-cache.json`）
  - 说明：**测试分流场景时，默认必须使用已验真的分流与多线路表格（NNxfwgI2fih5iekmKABcSn2Wnne）里的价格作为断言基准**；未通过 API 鉴权的数据必须标记为待确认。新增模型或分流调整时，表格动态维护，作为 `DEVTEST_EXPECTATION` 与核销基准的客观事实源。


## 二、19 个核心账单端点清单

在生成测试用例与验证契约时，针对以下已验证的 19 个核心端点进行断言覆盖：

| 端点路径 | 方法 | 说明 | 核心断言与校验点 |
|---|---|---|---|
| `POST aivideo/points/preview` | POST | 积分预估接口 | 入参为 resource/extra，响应 `required_points` 必须与刊例价严格一致 |
| `GET billing/apiSummary` | GET | 企业汇总看板 | 校验可用积分、区间消耗、累计充值三项汇总计算无误 |
| `GET billing/dashboard?section=summary` | GET | 账单大盘累计消耗 | 支持筛选模型，返回指标必须包含新模型用量 |
| `GET billing/dashboard?section=modelDist` | GET | 模型调用分布饼图 | 新模型名称正确归类，禁止显示为“未知模型” |
| `GET billing/dashboard?section=models` | GET | 模型筛选下拉列表 | 包含本次新上线模型，禁止遗漏 |
| `GET billing/apiDashboardTrend` | GET | 消费趋势曲线 | 验证时间切换（今天/近7天/本月/自定义）数据聚合正确 |
| `GET billing/apiDetailRecords` | GET | 消费明细记录 | 分页列表，每条记录的 `points` 扣除与模型配置一致 |
| `GET billing/personal` | GET | 个人维度消费明细 | 支持 records/summary/projectTop，验证个人扣费账单 |
| `GET aivideoab/absetting/index` | GET | 积分单价配置列表 | 验证新模型 `list_price_points` 基础配置 |
| `GET aivideo/v2/character/getModelConfigs` | GET | 模型配置元数据 | 检查模型子分类、任务类型与计费规则配套 |
| `POST /integration-platform/models/estimatedBilling` | POST | NestJS 刊例价预估 | 验证前端画布节点连线预估费用链 |
| `POST /expense/user/getMany` | POST | NestJS 消费明细审计 | 校验 `billing_calculation_chain` 计费计算链完整性 |

## 三、12 条核心验收规则与测试断言

1. **账单-汇总维度**：企业主账号「累计消耗」「近7天消耗积分」「近7天任务总数」必须准确纳入新模型消耗。
2. **趋势与排行维度**：消耗趋势图与 TOP5 模型消耗排名必须包含新模型，且排序权重符合实际消费大小。
3. **消费明细规范**：模型功能必须适配，**绝对不能出现“未知模型”**（重点防范 `Billing.php` 中 `resolvePersonalRecordModelName` 兜底失效）。
4. **刊例价与实扣匹配**：实测任务提交后，实际扣除积分必须精确等于刊例价（例如 wan3 实扣 28 积分、prime 实扣 44 积分、td 实扣 60 积分）。
5. **任务失败不扣费/退费**：生成失败或超时取消的任务，冻结积分必须原路解冻或补偿退回，积分流水记录状态为退款。
6. **模型中转名称对齐**：非公认爆火模型统一用功能/需求写入名称进行中转名称展示，覆盖任务标签与后台统计。
7. **月度归档跨表查询**：核对历史积分变动时，必须验证 `pq_score_log_archive_YYYYMM` 归档表的连贯性。
8. **免费重试幂等性**：因上游供应商错误发起的任务重试，不得二次重复扣除用户积分。
9. **并发请求防重扣**：高并发提交相同 `idempotency_key` 任务时，必须幂等，只能扣减一次积分。
10. **零余额与余额不足拦截**：用户钱包可用积分小于 `required_points` 时，接口必须直接返回 402/错误码，禁止透支生成。
11. **多租户/分组隔离**：不同企业组织下的积分配置与消费明细必须严格数据隔离，禁止越权查询。
12. **账单大盘与明细总和一致性**：在指定时间窗口内，大盘汇总的消费积分总值必须等于明细列表中单笔积分扣减之和。

## 四、三大核心账务不变量（Billing Invariants）机器断言标准

在对账与自测过程中，系统通过 `BillingOracle` 与 `IdempotencyOracle` 强制核验以下三大数学不变量，任何一项违背均判定测试 FAIL：

| 不变量名称 | 机器判定条件 | 业务意义与防资损目标 | 违背判定表现 |
| :--- | :--- | :--- | :--- |
| **ANTI_DOUBLE_BILLING**<br>*(防二次扣费)* | `preDeductCount <= 1`<br>且相同 `clientToken` 仅 1 笔扣费 | 网络抖动、超时重试或并发重复点击时，绝不能对用户重复预扣积分 | 触发 `[INVARIANT_VIOLATED: ANTI_DOUBLE_BILLING]`，判定 `duplicateCharged=true` |
| **NET_CHARGE_ZERO**<br>*(失败净扣归零)* | `terminalStatus === 'FAILED'` 时：<br>`preDeduct - refunded === 0` | 上游渠道异常、超时、黑屏或业务失败的任务，用户净扣额严格为 0 pt | 若净扣 > 0 触发漏退款；若净扣 < 0 触发超额退款，均判定资金平衡违背 |
| **REFUND_IDEMPOTENCY**<br>*(退款幂等性)* | `refundCount <= 1` | 网关重复推送回调事件或人工/补偿多次触发时，退款流水严格只能入账 1 次 | 触发 `[INVARIANT_VIOLATED: REFUND_IDEMPOTENCY]`，防范重复退款薅羊毛资金漏洞 |

## 五、面向公司同事的 Trae + MCP / CLI 自测实操指南

本测试体系已被封装为通用 Skill，供团队同事在日常模型接入、分流调整与账单改动时自主调用：

### 5.1 方式一：在 Trae 中结合 MCP 智能体对话使用

1. **Trae 环境配置**（首次使用在项目根目录运行一次初始化）：
   ```bash
   node -e "import('./dist/src/devtest/trae-setup.js').then(m => m.initializeDevTestTrae(process.cwd()))"
   ```
   该命令会自动在 `.trae/mcp.json` 中注入 `devtest` MCP 服务，并将本 Skill 同步到 `.trae/skills/` 目录。
2. **在 Trae 聊天中直接向 AI 发送指令**：
   - *对账自测*：“`请调用 devtest 工具，针对 Wan 3.0 视频模型（ID 84）接入进行失败退款与防二次扣款自测`”
   - *分流自测*：“`请使用 devtest 检查已有模型分流方案，重点核查准入规则、反向降级回退与账单不变量`”
   - *新模型上线*：“`请使用 devtest 规划新图片模型 Image 2.5（ID 201）直连上线的全套测试方案`”

### 5.2 方式二：命令行自测（极速免配置，开箱即用）

```bash
# 1. 核验失败退款分支与 NET_CHARGE_ZERO 不变量（含 E2E 闭环 polling）
npm run devtest -- execute --model 84 --media video --expect-failure --wait

# 2. 核验新模型直接接入（DIRECT 模式，仅出计划不执行）
npm run devtest -- plan --flow direct --model 84 --media video

# 3. 核验已有模型分流（DIVERSION 模式，含两级决策与降级回退，仅出计划）
npm run devtest -- plan --flow diversion --model 84 --media video

# 4. 完整 E2E 闭环：提交 → 自动 polling → Artifact + Billing 验证
npm run devtest -- execute --model 84 --media video --wait
```
