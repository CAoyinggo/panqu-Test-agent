// Eval 模块统一导出（Phase 45）：AI Test Quality Evaluation
// 模块结构：
//   contract.ts      统一评测契约（EvaluationCase / EvaluationResult / 领域枚举）
//   ground-truth.ts  Ground Truth 注册表（无 GT → tracked=false → score=null）
//   metrics.ts       统一度量（precision/recall/F1/混淆/Top-K）
//   score.ts         得分规约（roundScore / isPassed / scoreDelta）
//   cost.ts          评测成本追踪（tokens / latency / cost）
//   versioning.ts    评测系统版本信息（model / prompt / tool / agent）
//   runner.ts        统一评测运行器（8 领域聚合 + 关键安全指标）
//   regression.ts    版本对比 + 回归门
//   replay.ts        决策重放（确定性：same input → same output）
//   benchmark/       版本化 Benchmark 注册表与 8 领域用例集
//   evaluator/       各领域评估器

export * from './contract.js';
export * from './ground-truth.js';
export * from './metrics.js';
export * from './score.js';
export * from './cost.js';
export * from './versioning.js';
export * from './runner.js';
export * from './regression.js';
export * from './replay.js';

export { BenchmarkRegistry, parseBenchmarkName } from './benchmark/registry.js';
export type { BenchmarkDefinition } from './benchmark/registry.js';
