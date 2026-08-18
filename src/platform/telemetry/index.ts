// Telemetry（Phase 25.4）：真实运行遥测 + 成本账本 + RCA 真值 + Flaky / Healing / Release
// 所有指标只从真实数据计算；无数据 tracked=false。

export {
  TelemetryService,
  DEFAULT_PRICING,
} from './telemetry-service.js';
export type { TelemetryServiceOptions, LlmUsageInput, HealingMetrics, ModelPricing } from './telemetry-service.js';
export {
  TelemetryEventStore,
  CostLedger,
  RcaVerificationStore,
  FlakyRecordStore,
  HealingRecordStore,
  ReleaseRecordStore,
  newId,
} from './telemetry-store.js';
export {
  TelemetryRunContext,
  TelemetryLLMProvider,
  withLLMTelemetry,
  runContext,
} from './llm-telemetry.js';
export type { RunTelemetryContext } from './llm-telemetry.js';
export { periodStartMs } from './telemetry-types.js';
export { MetricActivationTracker, ALL_TRACKED_METRICS } from './activation.js';
export type { MetricActivationRecord, TrackedMetric } from './activation.js';
export type {
  TelemetryEvent,
  TelemetryEventType,
  CostLedgerEntry,
  RcaVerification,
  FlakyRecord,
  HealingRecord,
  ReleaseRecord,
  TelemetryPeriod,
  MetricSample,
  CostBreakdown,
} from './telemetry-types.js';
