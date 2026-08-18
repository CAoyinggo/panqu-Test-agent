# Phase 25.4 Real Telemetry 报告

## 一、目标与结论

将平台从「指标无数据返回 null」升级为**真实运营遥测**：统一事件流 + 6 个类型化存储
（CostLedger / RCA 真值 / Flaky / Healing / Release）同后端落库，指标不再虚构，
`tracked=true` 仅在真实数据存在时激活。

```text
Run → Worker（runContext.run + LLM 装饰器）→ recordLLM → CostLedger → 平台指标（tracked=true）
RCA 预测 → 人工验证 → Ground Truth → rcaAccuracy（有真值才 tracked）
Flaky 运行记录 → flakyRate（case 波动占比）
Healing 决策 → successRate / falseHealingRate（rolledBack）/ recoveryRate
```

**结论：25.4 完成。** 全部验收指标 PASS：

```text
npm test                  1321 PASS（新增 21）
agent:test                 450 PASS
Build + 平台单测 200 PASS + 平台集成 44 PASS
CLI 端到端冒烟：Run 执行 → 2 次 LLM 调用 → cost/llm/execution 事件 6 条 → 成本 0.0001 元真实入账
```

## 二、新增能力

### 1. `src/platform/telemetry/`（遥测模块）
| 文件 | 能力 |
| --- | --- |
| `telemetry-types.ts` | `TelemetryEvent`（8 种类型）+ `CostLedgerEntry` + `RcaVerification` + `FlakyRecord` + `HealingRecord`（含 `rolledBack`）+ `ReleaseRecord`；`MetricSample {value, tracked, sampleCount, unit}`（无数据 `tracked=false`，禁止用 0 表示无数据）；`TelemetryPeriod`（1h/6h/24h/7d/30d/release/version）+ `periodStartMs` |
| `telemetry-store.ts` | 6 个类型化 Store（TelemetryEventStore / CostLedger / RcaVerificationStore / FlakyRecordStore / HealingRecordStore / ReleaseRecordStore），全部基于 `Repository<T>`，memory/json/sqlite/postgres 可替换 |
| `telemetry-service.ts` | `DEFAULT_PRICING` 模型单价表（元/百万 token）；`recordLLM` 按 `usage × 单价` 真实记账；`verifyRca` 计算 correct 真值；`flakyRate` 波动 case 占比；`healingMetrics` 三率；`costMetrics` 按 Run/Feature/Model/Project 汇总；`metricsSnapshot` 并行汇总；`inPeriod` 时间窗口过滤（release/version 不过滤） |
| `llm-telemetry.ts` | `TelemetryRunContext`（AsyncLocalStorage 将 LLM 调用关联到 runId/projectId/feature）；`TelemetryLLMProvider` 装饰器透明包装 LLMProvider，采集真实 usage（token/latency/cost），失败仅 `console.warn` 不影响 LLM |
| `index.ts` | 统一导出 |

### 2. 平台指标接入（`src/platform/operations/metrics.ts`）
- 新增 `MetricsTelemetryInput`（cost / costPerRun / costPerFeature / rcaAccuracy / flakyRate / healingRate）
- `computePlatformMetrics` 优先 telemetry；无 telemetry 时 `costPerRun` / `costPerFeature` 返回 `null + tracked=false`（不虚构），删除旧 `totalCost=llm+exec` 推测逻辑

### 3. Service 接线（`src/platform/service/factory.ts` / `platform-service.ts`）
- 工厂同步装配 6 个 telemetry Store（同一存储后端）；`PlatformBundle.telemetry` 导出
- `PlatformServiceDeps.telemetry`；`metrics()` / `dashboard()` 调用 `telemetry.metricsSnapshot('7d')` 构造 `MetricsTelemetryInput`
- 修复：`createPlatformService` 为同步函数，遥测实例化改为静态 import（原 `await import()` 非法）

### 4. CLI（`bin/platform-cli.ts`）
- Worker 执行路径接入真实遥测：`runContext.run({runId, projectId, feature})` 包裹 + `withLLMTelemetry` 装饰 Mock Provider → 真实 usage → CostLedger / cost / llm 事件；记录 execution 事件
- 新增 `telemetry` 命令组：`telemetry events [--run]` / `telemetry cost [--period]` / `telemetry metrics [--period]`

## 三、测试

### 单元（`tests/unit/telemetry.test.ts`，17 例）
- CostLedger 真实记账（token×单价）/ 未知模型回退默认 / 汇总 total/perRun/perModel / 无数据 tracked=false / costForFeature
- 时间窗口：`periodStartMs` 各周期起点（release/version 返回 0）/ costMetrics 超窗过滤（release 不过滤）
- RCA Ground Truth：verifyRca correct 判定 + accuracy 计算 / 无真值 tracked=false
- Flaky Rate：case 既有 pass 又有 fail 记 flaky / 无记录 tracked=false
- Healing 指标：successRate / falseHealingRate（rolledBack）/ recoveryRate / 无 applied 不追踪
- Release 决策记录；LLM 装饰器透明透传 + runContext 归属 + 遥测失败不影响 LLM；metricsSnapshot 汇总与全空不虚构

### 集成（`tests/integration/telemetry-pipeline.test.ts`，3 例）
- S1：Run → Worker（runContext + LLM 装饰器）→ CostLedger 按 run 归属 → 指标 `llmCost/costPerRun tracked=true` → dashboard 反映
- S2：RCA 预测 + 真实验证 / Flaky / Healing（含 rolledBack）/ Release 接入平台指标 + 事件流含全部 8 类
- S3：SQLite 后端遥测持久化（与平台数据同文件、跨实例可见）

### 验证
```text
npm test                  1321 PASS
agent:test                 450 PASS
npm run platform:test      200 PASS（含 telemetry 17）
npm run platform:integration  44 PASS（含 telemetry-pipeline 3）
```

## 四、风险与说明

- Breaking Change：无。`MetricValue` 新增可选 `sampleCount`；`metrics.test.ts` 旧成本用例更新为 25.4 语义（无遥测不虚构 costPerRun）
- `MockLLMProvider` 返回真实 usage（token = 内容长度），因此 CLI 冒烟成本为真实计算值；接入真实模型时无需改动遥测层
- RCA / Flaky / Healing 在 Agent 子系统（自主流水线）为仿真路径，本阶段提供生产级遥测钩子（`recordRca` / `recordFlaky` / `recordHealing` + `withLLMTelemetry`），由真实执行方接入即生效
- 强约束满足：未虚构 Metrics、未把 Mock 当生产数据、`tracked=false` 语义严格、未默认关闭鉴权
