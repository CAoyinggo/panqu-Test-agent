# Phase 25.5 Metrics Activation 报告

## 一、目标与结论

25.4 已让遥测指标从真实数据计算（`tracked=false` 表示无数据）。25.5 补齐**自动激活**：
只要任一真实遥测样本写入对应通道，指标自动从 `tracked=false` 翻转为 `tracked=true`，
记录首次激活时间 / 最近样本时间 / 累计采样数；并让平台指标支持**时间窗口**（1h/6h/24h/7d/30d/release/version）。

```text
真实样本（recordLLM / verifyRca / recordFlaky / recordHealing / recordExecution）
  → MetricActivationTracker.mark(metric) → activated=true + firstActivatedAt + sampleCount++
  → 平台指标 tracked=false 自动翻转 tracked=true
metrics(window) → metricsSnapshot(window) → 时间窗口过滤后计算
```

**结论：25.5 完成。** 全部验收指标 PASS：

```text
npm test                  1328 PASS（新增 7）
agent:test                 450 PASS
Build + 平台单测 205 PASS + 平台集成 46 PASS
```

## 二、新增能力

### 1. `src/platform/telemetry/activation.ts`（指标激活跟踪器）
- `TrackedMetric`：cost / rcaAccuracy / flakyRate / healingRate / execution
- `MetricActivationRecord {id, metric, activated, firstActivatedAt, lastSampleAt, sampleCount}`（id = metric 名）
- `MetricActivationTracker.mark(metric)`：幂等——首样本激活并记首次时间；后续样本仅累加 `sampleCount` 与刷新 `lastSampleAt`
- `list()`：返回全部平台指标（未激活也返回 `activated=false`，绝不虚构）；`status()` / `activeCount()`
- 基于 `Repository<T>` 持久化，与平台数据同后端

### 2. TelemetryService 自动激活（`telemetry-service.ts`）
- 每个 record 方法末尾调用 `markActivated`：`recordLLM→cost`、`verifyRca→rcaAccuracy`、`recordFlaky→flakyRate`、`recordHealing→healingRate`、`recordExecution→execution`
- 激活跟踪失败仅 `console.warn`，不阻塞遥测主流程
- 新增 `activationStatus()`：全部指标激活状态 + 已激活计数

### 3. Service 层（`platform-service.ts` / `factory.ts`）
- `metrics(window: TelemetryPeriod = '7d')`：时间窗口参数透传 `telemetryMetricsInput(window)` → `metricsSnapshot(window)`
- 新增 `metricsActivation()`：暴露激活状态到平台/API/CLI
- 工厂注入 `MetricActivationTracker`（`metric-activations` 集合，同存储后端持久化）

### 4. CLI（`bin/platform-cli.ts`）
- `telemetry metrics/cost --window <1h|6h|24h|7d|30d|release|version>`（兼容 `--period`）
- 新增 `telemetry activation`：查看全部指标激活状态

## 三、测试

### 单元（`tests/unit/activation.test.ts`，5 例）
- 初始全部未激活（5 指标 activated=false / sampleCount=0 / firstActivatedAt=null）
- 各 record 方法自动激活对应指标（cost / rcaAccuracy / flakyRate / healingRate / execution）
- 激活幂等：多次样本 sampleCount 累加，firstActivatedAt 保持首次时间
- 时间窗口参数透传 metricsSnapshot（1h/7d/release）

### 集成（`tests/integration/telemetry-pipeline.test.ts` S4，2 例）
- 真实样本 → `metricsActivation()` 激活计数翻转 → 平台指标 tracked=true（cost/rcaAccuracy/flakyRate/healingRate；execution 未记录仍 false）
- `metrics('1h'|'7d'|'release')` 时间窗口参数正确传递

### 验证
```text
npm test                  1328 PASS
agent:test                 450 PASS
npm run platform:test      205 PASS（含 activation 5）
npm run platform:integration  46 PASS（含 telemetry-pipeline 5）
```

## 四、风险与说明

- Breaking Change：无。`metrics()` 新增可选窗口参数（默认 `7d`，向后兼容）；`TelemetryServiceOptions` 新增可选 `activation`
- 激活与指标本身解耦：激活记录生命周期（全量样本），指标窗口值按窗口实时计算——激活后窗口内无数据仍会 `tracked=false`（如 1h 内无新样本），语义严格
- 强约束满足：未虚构 Metrics、未把 Mock 当生产数据、未默认关闭鉴权
