# Phase 45 版本对比与模型记录（Model Comparison）

> 评测不能只看"现在多少分"，必须支持版本间对比：baseline vs candidate，并记录模型 / prompt / tool / agent 版本，才能判断「到底是代码变了，还是模型变了」。

## 一、版本记录（EvalVersionInfo）

定义于 `src/eval/versioning.ts`。任何一次 AI 评测必须记录：

```ts
interface EvalVersionInfo {
  model: string;         // 被评测模型（rules=确定性规则引擎；LLM 时为模型名）
  modelVersion: string;
  promptVersion: string;
  toolVersion: string;
  agentVersion: string;
}
```

默认值（确定性规则评测）：

```ts
{ model: 'rules', modelVersion: '1.0.0', promptVersion: 'n/a', toolVersion: 'eval-tool-v1', agentVersion: 'eval-agent-v1' }
```

**运行时覆盖**：接入 LLM 评测时经环境变量覆盖即可：

```bash
export EVAL_MODEL=gpt-4o
export EVAL_MODEL_VERSION=2024-11-20
export EVAL_PROMPT_VERSION=v2
export EVAL_TOOL_VERSION=eval-tool-v1
export EVAL_AGENT_VERSION=eval-agent-v1
```

每次 `run` 生成的报告中，`versionInfo` 字段即本次评测的系统版本快照，与 `version`（被测平台版本）一起持久化，保证可复现。

## 二、版本对比（compareVersions）

定义于 `src/eval/regression.ts`。将 baseline 报告与 candidate 报告对比，输出 `CompareResult`：

```ts
interface DomainComparison {
  domain: EvaluationDomain;
  label: string;
  baseline: number;    // 基线得分
  candidate: number;   // 候选得分
  delta: number;       // candidate - baseline（正 = 提升）
  trend: 'improved' | 'regressed' | 'unchanged';
}

interface CompareResult {
  baseline: string;
  candidate: string;
  generatedAt: string;
  domains: DomainComparison[];
  overall: { baseline; candidate; delta; trend };
  critical: {
    baseline: EvalReport['critical'];
    candidate: EvalReport['critical'];
    regressions: string[];   // 安全指标退化列表
  };
  gate: { verdict: 'PASS' | 'REVIEW' | 'BLOCK'; reasons: string[] };
}
```

趋势判定（`domainTrend`）：

- `delta > softDelta(0.03)` → `improved`。
- `delta < -softDelta(0.03)` → `regressed`。
- 其余 → `unchanged`。

## 三、模型 / Prompt / Tool / Agent 版本对比的意义

- 评测报告的 `versionInfo` 用于回答"这个分数是哪套模型 + 哪版 prompt + 哪版工具 + 哪版 agent 跑出来的"。
- 候选版本引入新模型 / 改 prompt / 升级工具时，必须先跑 `compare` 确认不回归再合入。
- 所有版本快照进入 `eval-reports/*.json`，支持跨版本回溯分析。

## 四、成本记录（Quality/Cost 优化）

定义于 `src/eval/cost.ts`。每次评测记录：

```ts
interface EvaluationCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  cost: number;        // 估算成本（美元）
}
```

计价（每 1K token，美元，可按模型覆盖）：

```ts
const DEFAULT_PRICING = { inputPer1K: 0.0015, outputPer1K: 0.002 };
```

规则：

- **确定性（规则）评测不消耗 token，cost = 0**。
- LLM 评测按 token 计价：`cost = input/1000*inputPer1K + output/1000*outputPer1K`。
- 显式传入的 `cost` 优先于估算。

报告同时给出 Score + Cost（见 `EvalReport.cost` 与各 `DomainReport.cost`），支撑 **Quality/Cost 联合优化**：在同等质量下选成本更低的模型 / prompt 版本，或在预算内追求质量上限。

**v4.17.0 真实运行成本**：`$0.000000`（0 tokens，0ms）——当前全部为确定性规则评测，不消耗 token。

## 五、CLI 用法

```bash
# 对比：baseline（指定版本或报告）vs candidate（默认 current=本次运行）
node dist/bin/eval-cli.js compare --baseline v4.19.0
node dist/bin/eval-cli.js compare --baseline latest --candidate current --json
node dist/bin/eval-cli.js compare --baseline 4.17.0-1787215609066.json   # 直接指定报告文件

# 回归门：运行当前版本与此前最新基线对比
node dist/bin/eval-cli.js regression
```

- `compare` 结果同时保存到 `eval-reports/compare-<baseline>-<candidate>-<timestamp>.json`。
- `compare` / `regression` 在 Gate=BLOCK 时退出码 1（阻止发布 / 合入）。

## 六、v4.17.0 真实对比输出（示例）

本机对同一版本（baseline = candidate = 4.17.0）运行 `compare --baseline latest` 的真实输出：

```
Eval Compare: 4.17.0 → 4.17.0
Overall: 93.6% → 93.6%（unchanged）
  需求理解: 85.6% → 85.6%（unchanged，Δ0.0%）
  测试设计: 92.8% → 92.8%（unchanged，Δ0.0%）
  风险评估: 100.0% → 100.0%（unchanged，Δ0.0%）
  用例选择: 99.8% → 99.8%（unchanged，Δ0.0%）
  根因分析: 89.5% → 89.5%（unchanged，Δ0.0%）
  缺陷质量: 95.5% → 95.5%（unchanged，Δ0.0%）
  自愈安全: 95.0% → 95.0%（unchanged，Δ0.0%）
  发布决策: 93.3% → 93.3%（unchanged，Δ0.0%）
Gate: PASS（全部指标达标或持平，允许发布）
```

（同版本对比为确定性评测必然 `unchanged`；接入不同模型 / prompt / 代码版本后，`compare` 将呈现真实的 improved / regressed 差异。）
