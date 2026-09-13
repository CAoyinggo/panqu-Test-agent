---
name: panqu-newapi-diversion
description: 处理 Panqu 主站与 NewAPI 网关对接、两级分流决策、渠道权重调度、多模型供应商接入的自测与审查。当涉及渠道管理、全量开放开关 (is_newapi_global)、组织密钥关联、菲玲/TD/万相分流及重试降级时使用。
---

# Panqu NewAPI 与两级分流决策专项

在 Panqu/盼趣系统中，自 v1.2 起引入 NewAPI（aiapis.panqu.com）作为统一 API 网关。模型生成请求的核心是**两级分流决策机制**，本 Skill 规范其自测验证与数据回滚。

## 一、两级分流核心架构

```
用户发起生成请求
      │
      ▼
【主站判断】（本次开发核心，aibaseos 负责）
  1. 模型是否全量开放？        ← pq_model_config.is_newapi_global
  2. 该用户组能否进行分流？     ← 用户组分流资格与组织关联
      │
      ├── 不满足 → 走原有分组逻辑（直连线路）
      │
      └── 满足 → 进入 NewAPI 分流
                  │
                  ▼
          【NewAPI 判断】（网关层负责）
            按 分组 (group) + 渠道权重 选择渠道
            例如：panqu_test 组 → 万相-yhuo (#36) / TD (#41) / RH-视频 (#39)
                  │
                  ▼
            最终供应商（阿里万相 / RunningHub / TalkingData 等）
```

## 二、关键业务规则与必测项

### 2.1 分流模式（DIVERSION）vs 直接接入模式（DIRECT）的明确划分

在测试过程中必须明确区分两大流派，严禁混淆测试要求：

1. **已有模型分流模式（DIVERSION）**：
   - 针对主站已有模型进行流量劫持与分流调度；
   - **核心必测**：
     - 两级准入判定（非真人、task_type=28、serviceline='r'）；
     - 满足条件正向命中切流（视频 `LINE=10`，图片 `newapi_image=1`）；
     - 资格不符或渠道异常时**平滑降级回退原直连链路**（`DIVERSION_FALLBACK_DIRECT`）；
     - 多企业路由组绑定鉴权与组织隔离（`PERMISSION_ISOLATION`）。
2. **新模型直接接入模式（DIRECT）**：
   - 针对新上线模型（如 Image 2.5、新视频直连模型），在业务端为**代码写死直连**；
   - **核心必测**：
     - **免路由组鉴权与免分流表配置**（路由快照记为 `route_group_id=0, org_id=0`）；
     - 代码白名单映射与全规格参数矩阵覆盖（`DIRECT_SPEC_MATRIX`，涵盖全部画幅与分辨率）；
     - 产物物理结构解析（MP4 Box 树 / PNG IHDR）；
     - 单模型刊例核销与失败退款净扣归零（`NET_CHARGE_ZERO`）。

### 2.2 异常分流、降级与幂等审计

- 若选中的供应商渠道返回不可用/超时，必须核验是否有兜底线路安全回退；
- 严格遵循 `BillingOracle` 与 `IdempotencyOracle` 的三大账务不变量（防重复扣费、退款幂等、失败净扣为 0）。

## 三、测试数据规范与回滚约定

- **测试数据前缀规范**：
  - 真实提交测试任务必须携带明确的前缀以备辨识，如：`devtest_wan3_e2e`、`devtest_prime_e2e`、`devtest_td_e2e`。
- **环境安全隔离**：
  - 严格限定在 `https://test.panqu.com` 测试环境与 `https://aiapis.panqu.com` 测试分组；
  - 严禁向生产租户发起测试请求。
- **数据回滚与清理**：
  - 测试创建的临时测试渠道参数或开关，在验证完成后必须恢复原状；
  - 生产出的测试视频/图片任务若无需留存，通过 `/aivideo/videonew/delete` 进行软删除清理。

## 四、面向公司同事的 Trae + MCP / CLI 自测指南

### 4.1 Trae MCP 智能体调用

同事在 Trae 中配置 MCP 服务后，可直接通过自然语言指示智能体执行：
- *已有模型分流测试*：“`请使用 devtest 测试 Wan 3.0 已有模型分流，验证正向切流与降级回退`”
- *新模型上线测试*：“`请使用 devtest 针对新模型执行直接接入测试，覆盖所有分辨率和画幅`”

### 4.2 极速 CLI 调用

```bash
# 已有模型分流测试（DIVERSION）
node dist/src/devtest/run-playwright-cli.js --flow diversion --model 84 --media video --plan-only

# 新模型直接接入测试（DIRECT）
node dist/src/devtest/run-playwright-cli.js --flow direct --model 99 --media video --alias "new-video-model" --plan-only
```
