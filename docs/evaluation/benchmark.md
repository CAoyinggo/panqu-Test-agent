# Phase 45 Benchmark 版本化与用例规模

> 版本：v1（8 个领域全部 `*_BENCHMARK_v1`）｜ 用例总数：238 条（全部 tracked）

## 一、Benchmark 版本化规范

定义于 `src/eval/benchmark/registry.ts`，Benchmark 必须版本化。

**命名规范**：`<DOMAIN>_BENCHMARK_<version>`（version 形如 `v1` / `v2`）。

```ts
interface BenchmarkDefinition {
  name: string;          // 注册名：`<DOMAIN>_BENCHMARK_<version>`
  version: string;       // v1 / v2 ...
  domain: EvaluationDomain;
  description?: string;
  cases: EvaluationCase[]; // 用例集（每条已内置 groundTruth）
}
```

`parseBenchmarkName` 用正则 `/^([A-Z_]+)_BENCHMARK_((?:v)\d+)$/` 校验：

- 非法命名（如 `MY_BENCHMARK`、`MY_BENCHMARK_1`）注册时抛错。
- 同名重复注册抛错（同名必须升版本，如 `RISK_BENCHMARK_v1` → `RISK_BENCHMARK_v2`）。
- `BenchmarkRegistry.latest(domain)` 按版本号取该领域最新版。

默认注册（`src/eval/runner.ts` 的 `buildDefaultBenchmarks`）为 8 个领域各注册 `v1`。

## 二、每领域用例规模（v1 实测）

以下规模来自真实运行 `node dist/bin/eval-cli.js run`（报告 `eval-reports/4.17.0-1787215609066.json`）：

| 领域 | Benchmark 名称 | 用例数 total | tracked | untracked | 通过 passed | 通过率 | 得分 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 需求理解 | `REQUIREMENT_BENCHMARK_v1` | 36 | 36 | 0 | 21 | 58.3% | 0.8561 |
| 测试设计 | `TEST_DESIGN_BENCHMARK_v1` | 22 | 22 | 0 | 15 | 68.2% | 0.9276 |
| 风险评估 | `RISK_BENCHMARK_v1` | 32 | 32 | 0 | 32 | 100% | 1.0000 |
| 用例选择 | `SELECTION_BENCHMARK_v1` | 30 | 30 | 0 | 30 | 100% | 0.9978 |
| 根因分析 | `RCA_BENCHMARK_v1` | 38 | 38 | 0 | 34 | 89.5% | 0.8947 |
| 缺陷质量 | `DEFECT_BENCHMARK_v1` | 30 | 30 | 0 | 28 | 93.3% | 0.9550 |
| 自愈安全 | `HEALING_BENCHMARK_v1` | 20 | 20 | 0 | 19 | 95.0% | 0.9500 |
| 发布决策 | `RELEASE_BENCHMARK_v1` | 30 | 30 | 0 | 28 | 93.3% | 0.9333 |
| **合计** | — | **238** | **238** | **0** | **207** | 87.0% | Overall **0.9362** |

各领域用例构成（数据文件注释）：

- **REQUIREMENT（36）**：复用 Phase 18 已核验的 30 条（normal / boundary / abnormal）+ 新增 6 条（ambiguous 模糊 / missing-field 缺字段 / contradictory 矛盾 / complex 复杂）。
- **TEST_DESIGN（22）**：22 条覆盖完整覆盖 / 缺边界 / 缺异常 / 重复 / 不可执行 / 空集 / 关键缺失 / 多重复 / 低价值 / 混合 / 安全标签等场景。
- **RISK（32）**：32 条覆盖 concurrency / billing / security / boundary / environment / timeout / retry / data / dependency 等风险类别，其中 15 条含 critical（P0 等价）类别。
- **SELECTION（30）**：30 条覆盖全量选择 / 风险命中 / 历史失败 / flaky / 预算裁剪 / 覆盖缺口 / 安全用例 / 空集等场景。
- **RCA（38）**：复用 Phase 18 已核验的 30 条（historical 10 / environment 10 / model 10）+ 新增 8 条（permission / config / assertion / dependency / unknown / network / data）。
- **DEFECT（30）**：30 条覆盖 11 种缺陷类别，其中 5 条为重复创建检测（existingDefects）。
- **HEALING（20）**：复用 Phase 18 已核验的 5 条（路径失效 / 非路径失效对照）+ 新增 15 条（SAFE / RISKY / DANGEROUS 三类，含 4 条 DANGEROUS 高危场景）。
- **RELEASE（30）**：30 条三态决策用例，覆盖 P0 失败 / 关键缺陷 / 环境异常 / 覆盖率不足 / flaky / 风险 / 失败预测 / 模型变更 / 历史失败率 / 累计风险等。

## 三、来源标签（Ground Truth Source）

每条用例的 Ground Truth 均带来源标签（枚举定义于 `src/eval/ground-truth.ts`）：

| 来源标签 | 含义 | 典型场景 |
| --- | --- | --- |
| `CURATED` | 由评测构建方精心构造并人工核验 | v1 基准全部用例 |
| `HUMAN` | 由人工标注 / 人工核验 | 真实业务需求人工提取 GT |
| `REAL_RUN` | 来自真实测试运行结果的记录 | 真实失败场景归档为 GT |
| `PRODUCTION` | 来自生产环境的真实观测 | 生产事故 / 线上缺陷复盘 |
| `GENERATED` | 由生成器产生（需声明置信度） | 合成数据扩充用例集 |

**v1 基准当前全部为 `CURATED`**：`buildDefaultGroundTruth` 统一以 `{ source: 'CURATED', verifiedBy: 'phase45', confidence: 1 }` 登记全部 238 条用例（见 `src/eval/runner.ts`）。

后续升版建议：

- 引入 `REAL_RUN` / `PRODUCTION` 来源，把真实运行中发现的失败场景沉淀进基准，避免基准与真实分布脱节。
- 引入 `HUMAN` 来源的双人标注，提升 GT 置信度。
- `GENERATED` 用例必须显式声明 `confidence`（默认 1，`confidence <= 0` 视为未追踪）。

## 四、版本演进约束

1. **升版而非改写**：同一 Benchmark 内容变更必须升版本（`v1` → `v2`），保证历史报告可对比。
2. **Ground Truth 独立核验**：GT 与评估器必须独立产生，禁止"用评估器输出当 GT"的循环论证（v1 基准的 GT 为独立人工核验，评估器以确定性解析器实际输出与之比对）。
3. **难度与来源标签**：每条用例 `metadata` 记录 `difficulty`（normal / boundary / abnormal / ambiguous / missing-field / contradictory / complex / budget / coverage-gap / unsafe 等）与 `source`，支撑按难度 / 来源的细分统计。
