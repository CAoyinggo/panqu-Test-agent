# Phase 45 评测架构总览（AI Test Quality Evaluation）

> 版本：v4.17.0（被测平台）｜ 评测链路：Deterministic First（规则引擎）｜ 文档定位：全平台 AI 评测的统一架构说明

## 一、背景与目标

Phase 45 为平台引入统一的 **AI 测试质量评测** 能力：对 AI 测试智能体在 8 大核心领域上的产出质量进行可量化、可追踪、可对比的评测。

核心目标：

1. **统一契约**：所有领域共用一个 `EvaluationCase` / `EvaluationResult` 契约，禁止各模块自定义互不兼容的 Score 契约。
2. **真实不虚构**：没有 Ground Truth 的用例 `tracked=false`、`score=null`，绝不虚构准确率。
3. **可回归**：支持版本间对比（baseline vs candidate）与回归门（BLOCK / REVIEW / PASS）。
4. **可追踪成本**：每次评测记录 token / latency / cost，支撑 Quality/Cost 联合优化。

## 二、8 大评测领域

评测覆盖 AI 测试智能体的 8 个核心环节，领域枚举定义于 `src/eval/contract.ts`：

| 领域枚举 | 中文标签 | 评测内容 | Benchmark 数据 | 评估器 |
| --- | --- | --- | --- | --- |
| `REQUIREMENT` | 需求理解 | 从需求文本解析 feature / capabilities / inputs / businessRules / risks 的准确度 | `src/eval/benchmark/data/requirement.ts` | `src/eval/evaluator/requirement.ts` |
| `TEST_DESIGN` | 测试设计 | 测试用例的覆盖度 / 冗余度 / 可执行性 / 关键用例存在性 | `src/eval/benchmark/data/test-design.ts` | `src/eval/evaluator/test-design.ts` |
| `RISK` | 风险评估 | 风险类别识别 Precision/Recall/F1 与 P0 关键风险漏判 | `src/eval/benchmark/data/risk.ts` | `src/eval/evaluator/risk.ts` |
| `SELECTION` | 用例选择 | 用例选择 Recall@TopK / 关键用例选中 / 跳过关键用例 | `src/eval/benchmark/data/selection.ts` | `src/eval/evaluator/selection.ts` |
| `RCA` | 根因分析 | 失败根因分类 Top-1 准确率 / Unknown 兜底率 | `src/eval/benchmark/data/rca.ts` | `src/eval/evaluator/rca.ts` |
| `DEFECT` | 缺陷质量 | 缺陷分类 / 严重度 / 优先级 / 重复检测 / 完整度 | `src/eval/benchmark/data/defect.ts` | `src/eval/evaluator/defect.ts` |
| `HEALING` | 自愈安全 | 自愈成功率 / 错误自愈 / 高危（掩盖 Bug）自愈 / 不动作 | `src/eval/benchmark/data/healing.ts` | `src/eval/evaluator/healing.ts` |
| `RELEASE` | 发布决策 | 三态决策 PASS/REVIEW/BLOCK 的 False Pass / False Block | `src/eval/benchmark/data/release.ts` | `src/eval/evaluator/release.ts` |

展示顺序即 `ALL_DOMAINS` 常量顺序（`src/eval/contract.ts`）。

## 三、统一评测契约（Unified Evaluation Contract）

定义于 `src/eval/contract.ts`，是全平台评测的数据契约：

```ts
// 评测用例
interface EvaluationCase<Input, GroundTruth> {
  id: string;              // 全局唯一用例 ID
  domain: EvaluationDomain; // 所属领域
  input: Input;            // 输入（需求文本 / 用例集 / 失败场景等）
  groundTruth: GroundTruth; // 独立人工核验的期望结果
  metadata?: EvaluationCaseMeta; // 难度、来源标签等
}

// 单条评测结果
interface EvaluationResult {
  caseId: string;
  domain: EvaluationDomain;
  score: number | null;   // 0~1；无 Ground Truth 时为 null
  passed: boolean;
  tracked: boolean;
  expected: unknown;
  actual: unknown;
  errors: string[];
  evidence?: unknown[];
  latencyMs?: number;
  cost?: number;          // 美元；确定性评测为 0
}
```

约定（代码注释原文）：

- `score` 为 **0~1 归一化**（1 为满分）；聚合层按需转百分比。
- `passed` 由阈值判定：**连续型默认 `>= 0.9`**，分类型要求精确匹配。
- **没有 Ground Truth 的用例 `tracked=false`，`score=null`，绝不虚构数值。**

`isPassed(score, threshold = 0.9)` 实现：

```ts
export function isPassed(score: number | null, threshold = DEFAULT_PASS_THRESHOLD): boolean {
  return score !== null && score >= threshold;
}
```

得分规约（`src/eval/score.ts`）：`roundScore` 统一截断到 4 位小数避免浮点噪声；`scoreDelta` 用于版本对比/回归门。

## 四、核心原则：无 Ground Truth 不声称 Accuracy

> "没有 Ground Truth 就不能声称 Accuracy。"（`src/eval/ground-truth.ts` 注释）

- 每条评测用例必须关联一条 Ground Truth 记录（`source` / `verifiedBy` / `verifiedAt` / `confidence`）。
- 用例未在 `GroundTruthRegistry` 登记，或登记但 `confidence <= 0` → `tracked=false` → `score=null`。
- **"为了 Dashboard 好看自动给 95%" 绝对禁止**。

评测框架的领域得分只统计 `tracked` 用例的均值，`untracked` 用例不进入得分、不计入通过数。

## 五、评测链路与模块结构（src/eval/）

```
src/eval/
├── contract.ts      统一评测契约（领域枚举 / EvaluationCase / EvaluationResult）
├── ground-truth.ts  Ground Truth Registry（无 GT → tracked=false → score=null）
├── metrics.ts       统一度量（precision/recall/F1/混淆矩阵/Top-K）
├── score.ts         得分规约（roundScore / isPassed / scoreDelta）
├── cost.ts          评测成本追踪（tokens / latency / cost）
├── versioning.ts    评测系统版本信息（model / prompt / tool / agent）
├── runner.ts        统一评测运行器（8 领域聚合 + 关键安全指标）
├── regression.ts    版本对比 + 回归门（BLOCK/REVIEW/PASS）
├── replay.ts        决策重放（确定性验证：same input → same output）
├── index.ts         模块统一导出
├── benchmark/
│   ├── registry.ts  版本化 Benchmark 注册表（<DOMAIN>_BENCHMARK_vN）
│   └── data/        8 领域 Benchmark 用例集（requirement / test-design / risk / selection /
│                    rca / defect / healing / release）
└── evaluator/       8 领域评估器（与 data/ 一一对应）
```

运行器（`src/eval/runner.ts`）工作流：

1. 读取 8 领域 Benchmark 用例集（各自携带 groundTruth）。
2. 逐用例查 `GroundTruthRegistry.isTracked(id)`：未追踪 → `score=null, tracked=false`；已追踪 → 调用对应领域评估器。
3. 聚合领域级报告 `DomainReport`（total / tracked / untracked / passed / score / metrics / failures / cost）。
4. 聚合全平台报告 `EvalReport`（version / versionInfo / overall / critical / cost）。

关键安全指标（`EvalReport.critical`，目标全部为 0）：

| 指标 | 含义 | 统计来源 |
| --- | --- | --- |
| `p0Miss` | P0 / Risk Critical 漏判用例数 | RISK 领域 `Critical Miss` |
| `falsePass` | 应 BLOCK 却 PASS（Critical Release Miss） | RELEASE 领域 |
| `unsafeHealing` | DANGEROUS 自愈（掩盖真实 Bug） | HEALING 领域 |
| `skippedCritical` | 关键用例被跳过 | SELECTION 领域 |

## 六、CLI 用法（bin/eval-cli.ts）

```bash
# 1. 构建 + 运行 8 领域评测（默认保存到 eval-reports/<version>-<timestamp>.json）
npm run build && node dist/bin/eval-cli.js run

# 可选参数
node dist/bin/eval-cli.js run --domain RCA       # 只跑单个领域
node dist/bin/eval-cli.js run --json             # JSON 输出
node dist/bin/eval-cli.js run --save my-report   # 指定保存文件名

# 2. 读取最新已保存报告
node dist/bin/eval-cli.js report [--json]

# 3. 版本对比（baseline vs candidate，输出回归门）
node dist/bin/eval-cli.js compare --baseline v4.19.0 [--candidate current] [--json]

# 4. 回归门（运行当前版本并与此前最新基线对比）
node dist/bin/eval-cli.js regression [--json]
```

**退出码约定**：

| 命令 | 退出码 0 | 退出码 1 | 退出码 2 |
| --- | --- | --- | --- |
| `run` | 关键安全指标全为 0 | 任一关键安全指标非 0（`P0 Miss / False Pass / Unsafe Healing / Skipped Critical`） | 未知领域 / 未知命令 |
| `compare` | Gate=PASS 或 REVIEW | Gate=BLOCK | 缺少 `--baseline` 等参数错误 |
| `regression` | Gate=PASS 或 REVIEW | Gate=BLOCK | 无基线报告可对比 |
| `report` | 成功输出 | 无已保存报告 | — |

## 七、输出：eval-reports/*.json

- 每次 `run` 保存一份完整 `EvalReport` 到 `eval-reports/<version>-<timestamp>.json`（如 `eval-reports/4.17.0-1787215609066.json`）。
- 每次 `compare` 额外保存 `eval-reports/compare-<baseline>-<candidate>-<timestamp>.json`。
- `report` / `compare --baseline` / `regression` 的基线读取基于 `eval-reports/` 目录按 mtime 最新的非 compare 文件。

报告 JSON 顶层字段：`version`（被测平台版本）、`generatedAt`、`versionInfo`（评测系统版本）、`domains[]`（8 领域）、`overall`（全部 tracked 用例均值）、`critical`（4 项关键安全指标）、`cost`（token 用量与美元成本）。

## 八、相关文档

- [Benchmark 版本化与用例规模](./benchmark.md)
- [Ground Truth Registry](./ground-truth.md)
- [各领域指标定义](./metrics.md)
- [版本对比与模型记录](./model-comparison.md)
- [回归门规则](./regression-gate.md)
- [Phase 45 完成总结](../phases/phase45-summary.md)
