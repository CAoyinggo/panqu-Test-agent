# Phase 45 各领域指标定义（Evaluation Metrics）

> 统一口径：所有指标由 `src/eval/metrics.ts` 公共度量计算，禁止各模块自造公式。得分均为 0~1，`passed` 阈值默认 0.9。

## 一、公共度量（metrics.ts）

| 函数 | 定义 |
| --- | --- |
| `prf(tp, fp, fn)` | precision / recall / F1（0~1；分母为 0 时记 0） |
| `setScore(actual[], expected[])` | 集合 F1（大小写不敏感）；期望空集且实际空 → 1，期望空集实际非空 → 0 |
| `exactMatch(actual, expected)` | 精确匹配（大小写不敏感）→ 0/1 |
| `mean(values)` | 均值（空列表返回 0） |
| `hitAtK(ranked, target, k)` | Top-K 命中判定 |
| `recallAtTopK(ranked, targets, k)` | 目标集在前 K 中被命中的 Recall（k<=0 视为全量评估） |
| `categoryConfusion(actuals, expecteds, cats)` | 多分类混淆矩阵 + 逐类 PRF |
| `accumulateConfusion(c, hit, predicted)` | 逐条累计混淆（tp/fp/fn/tn） |

得分规约（score.ts）：`roundScore` 截断 4 位小数；`scoreDelta(a,b)` 计算版本分数差（任一侧为 null → null）。

## 二、领域指标总表

| 领域 | 主得分公式 | 关键子指标 |
| --- | --- | --- |
| 需求理解 | 加权 F1 聚合（见下） | Completeness / Precision / Recall / F1 |
| 测试设计 | `0.35*覆盖 + 0.3*关键 + 0.2*冗余 + 0.15*可执行` | Requirement Trace / Redundancy / Deterministic Executability |
| 风险评估 | `0.6*F1 + 0.4*(1 - CriticalMissRate)` | Precision / Recall / F1 / P0 Miss |
| 用例选择 | `0.4*MustRun + 0.3*Critical + 0.2*Skip + 0.1*Precision@TopK` | Recall@TopK / Critical Selection Recall / Skipped Critical |
| 根因分析 | `exactMatch(category, expected)` | Accuracy(Top-1) / Top-3 / Unknown |
| 缺陷质量 | `0.35*分类 + 0.15*严重度 + 0.15*优先级 + 0.2*重复 + 0.15*完整度` | Duplicate / Severity / Category / Completeness |
| 自愈安全 | `正确动作 ? 1 : 0`（0/1 制） | Success / False / Unsafe / No-op |
| 发布决策 | `exactMatch(decision, expected)` | False Pass / False Block / Critical Release Miss |

## 三、各领域详细定义

### 1. 需求理解（REQUIREMENT，evaluator/requirement.ts）

调用确定性解析器 `parseRequirement` 得到 feature / capabilities / inputs / businessRules / risks，与 GT 比对。

- **Completeness（完整度）**：逐字段 F1 加权聚合，反映整体理解完整度。
- **Precision / Recall / F1**：对 capabilities / inputs / businessRules / risks 四个集合字段分别用 `setScore` 计算。

主得分权重：

```
score = 0.15*feature + 0.3*capabilities.F1 + 0.2*inputs.F1 + 0.2*businessRules.F1 + 0.15*risks.F1
```

feature 用 `exactMatch`（0/1），集合字段用 F1。

### 2. 测试设计（TEST_DESIGN，evaluator/test-design.ts）

评估 AI 生成的测试用例集：

- **Coverage Score**：`requiredCoverageTags` 在用例标签并集中的命中率（缺标签 → 记录 `覆盖缺失`）。
- **Critical Score**：`criticalCaseIds` 中关键用例的存在比例（缺失 → `关键用例缺失`）。
- **Redundancy Score**：实际重复对与期望重复对数的接近度。
  - 重复检测 `countDuplicatePairs`：同名 + 同优先级 + 同标签即为一对。
  - `redundancyScore = expected==actual ? 1 : max(0, 1 - |expected-actual|/max(1, expected))`。
- **Executability Score**：按下述「确定性可执行谓词」逐 Case 评估，得分为满足谓词的 Case 数 / 应可执行 Case 数，并与 `expectedExecutable` 的真值逐项对比。“至少 1 步 + 至少 1 条断言”仅是必要条件，不再是充分条件。

#### 确定性可执行谓词

一条 Case 只有同时满足以下条件才计入 Executable：

1. **Requirement trace 完整**：存在 `source.requirementId`、AC、Fact 和 Objective 引用；每个决定结果的断言回链至少一个 Fact。
2. **Requirement 可判定**：`requirementStatus=CONFIRMED`，Expected Response/State/Side Effect 不是 `UNKNOWN`；`INFERENCE/UNKNOWN` 来源不得评为可执行产品 Oracle。
3. **Precondition/Data 可准备与检查**：required `preconditionPlan` 具有检查方式；必需测试数据具有来源、引用和 owner/scope，不包含明文 Secret。
4. **Step 真实可执行**：至少一个 Step，每个 required Step 有稳定 ID、可用 Channel/Processor 或唯一 Operation 绑定，依赖可解析，且不是 `PLANNED`/纯自然语言动作。
5. **Deterministic Oracle 完整**：至少一条非 `DESIGN_EXPECTATION` 断言；每条必需断言有 target/operator/expected、Fact 与 Evidence 引用；`oracle.deterministic=true` 且 `oracle.status=READY`。
6. **Evidence 可采集可核验**：存在 required Evidence Requirement，其 Channel、Phase、Expectation、来源 Step、Fact 和 Assertion 引用完整，且有可用 Processor/Observer。
7. **Lifecycle/Safety 闭环**：写操作、可变数据和共享资源有可验证 Cleanup/隔离策略；required Dependency 无 `UNRESOLVED`；`readiness.status=READY` 且 `executionMode=EXECUTABLE`。

如果任一条件不满足，该 Case 评为 `DESIGNED_ONLY / NEED_CONFIRMATION / BLOCKED`，并记录具体缺口；不得用默认值或 Legacy fallback 将其计为 Executable。

Executability 是设计态指标，不等于已执行或已验证。运行指标必须分开计算 `GENERATED / EXECUTED / VERIFIED / EVIDENCE_COMPLETE`，禁止将 TestCase 已生成计入 Verified Coverage。

另识别：Duplicate Test（重复用例）、Low-value Test（全 P3）、Missing Critical Test（关键用例缺失）。

### 3. 风险评估（RISK，evaluator/risk.ts）

调用确定性风险分析 `analyzeRisks` 得到风险类别集合与高风险类别集合，与 GT 比对。

- **Precision / Recall / F1**：实际识别类别 vs `expectedCategories` 的 `setScore`。
- **P0 Miss（Critical Miss）**：`criticalCategories`（P0 等价）中未被识别为 **high 级别** 的类别数；`criticalMissRate = 漏判数 / criticalCategories 数`。

主得分：

```
score = 0.6*F1 + 0.4*(1 - criticalMissRate)
```

全局 `critical.p0Miss` 即 RISK 领域所有 Critical Miss 用例数（目标 = 0）。

### 4. 用例选择（SELECTION，evaluator/selection.ts）

调用确定性选择器 `selectTestCases`，与 GT 的 mustRun / shouldSkip / criticalCaseIds 比对。

- **Must-Run Recall**：mustRun 中实际被选中的比例。
- **Critical Selection Recall**：关键用例被选中的比例（`criticalCaseIds` 命中）。
- **Skipped Critical（跳过关键用例）**：`skippedCriticalRate = 关键用例未选中数 / criticalCaseIds 数`；任意 > 0 记 `跳过关键用例` 错误并计入全局 `critical.skippedCritical`。
- **Should-Skip 正确率**：应跳过用例未被错误选中的比例。
- **Recall@TopK / Precision@TopK**：`k = mustRun 数量`，前 k 命中 mustRun 的比例为 Precision@TopK。

主得分：

```
score = 0.4*mustRunRecall + 0.3*criticalRecall + 0.2*skipRate + 0.1*precisionAtTopK
```

### 5. 根因分析（RCA，evaluator/rca.ts）

调用确定性失败分类器 `classifyFailure` 得到 Predicted Category，与 GT 比对。

- **Accuracy（Top-1）**：`exactMatch(category, expected)`；领域指标 `top1Accuracy` 与 `accuracy` 等价。
- **Top-3**：预留给 LLM 排名输出场景；当前规则分类器为 **Top-1 确定性输出**。
- **Unknown**：分类为 `UNKNOWN`（低置信兜底）的比例 `unknownRate`。
- **False Root Cause Rate**：得分为 0（完全判错）的比例。

主得分：

```
score = exactMatch(category, expected)   // 0/1
```

### 6. 缺陷质量（DEFECT，evaluator/defect.ts)

全链路：`classifyFailure`（分类）→ `buildDefectFromRca`（缺陷草稿）→ 重复检测。

- **Category（分类正确）**：缺陷类别 `exactMatch`。
- **Severity / Priority（严重度 / 优先级）**：分别 `exactMatch`。
- **Duplicate（重复检测）**：签名 `category:rootCauseKey(error)` 是否命中既有缺陷；与 `expectedDuplicate` 一致才得分（防 AI 反复创建同一 Bug）。
- **Completeness（完整度）**：步骤 >= 2、证据 >= 1、关联用例 >= 1，三项各占 1/3。

主得分：

```
score = 0.35*category + 0.15*severity + 0.15*priority + 0.2*duplicate + 0.15*completeness
```

### 7. 自愈安全（HEALING，evaluator/healing.ts）

运行确定性自愈分析 `analyzeHealing`，输出三态结果：

- **Outcome**：`NO_OP`（不动作）/ `CORRECT_FIX`（正确自愈）/ `WRONG_FIX`（错误自愈）。
- **Safety**：`SAFE`（正确自愈或正确不动作）/ `RISKY`（错误自愈）/ `DANGEROUS`（掩盖真实 Bug 的高危自愈）。

核心指标：

- **Healing Success Rate（自愈成功率）**：正确动作（期望自愈则 CORRECT_FIX，期望不动作则 NO_OP）用例占比，即领域得分（0/1 制）。
- **False Healing Rate（错误自愈）**：`WRONG_FIX` 占比（`riskyRate`）。
- **Unsafe Healing（高危自愈）**：`DANGEROUS` 占比；**目标必须为 0**（全局 `critical.unsafeHealing`），Healing 是高危能力，服务级故障/非路径失效严禁自愈。
- **No-op Rate（不动作率）**：`NO_OP` 占比。

DANGEROUS 判定：`expectNoSuggestion=true`（严禁自愈）却产出任何建议 → DANGEROUS；期望路径不变（wrong-path）却产出错误建议 → RISKY。

### 8. 发布决策（RELEASE，evaluator/release.ts）

运行确定性发布决策 `decideRelease` 得到三态 PASS / REVIEW / BLOCK，与 GT 比对。

- **Accuracy**：决策精确匹配率。
- **False Pass（应 BLOCK 却 PASS）**：`gt=BLOCK && actual=PASS`，即 **Critical Release Miss**，最严重，目标 = 0（全局 `critical.falsePass`）。
- **False Block（应 PASS 却 BLOCK）**：`gt=PASS && actual=BLOCK`（过度拦截）。
- **False Review**：其他决策错误。

主得分：

```
score = exactMatch(decision, expected)   // 0/1
```

## 四、领域级聚合指标（runner.ts computeDomainMetrics）

每个领域报告额外输出统一指标：`passRate`（通过率）、`meanScore`（平均分），以及领域特定率指标（`criticalMissRate`、`skippedCriticalRate`、`unsafeHealingRate`、`noOpRate`、`falsePassRate`、`falseBlockRate`、`falseReviewRate`、`duplicateRate`、`wrongSeverityRate`、`unknownRate`、`falseRootCauseRate`、`missingCriticalRate` 等）。

## 五、关键安全指标（目标全为 0）

| 指标 | 定义 | 来源领域 |
| --- | --- | --- |
| `p0Miss` | P0 / Risk Critical 漏判用例数 | RISK |
| `falsePass` | 应 BLOCK 却 PASS（Critical Release Miss） | RELEASE |
| `unsafeHealing` | DANGEROUS 自愈（掩盖真实 Bug） | HEALING |
| `skippedCritical` | 关键用例被跳过 | SELECTION |

任一非 0，`run` 命令退出码 1 且回归门 BLOCK。
