# Phase 23.2 Portfolio → Regression 接入报告

## 一、目标

把 Phase 22 已有的 Test Portfolio 从「离线测试组合」接入 **Autonomous Regression Controller**，
形成 `Change → Impact → Portfolio → 选择 Core/Risk/Change/Historical → Exploration Budget → Regression Plan`
的生产回归计划链。关键约束：默认不执行全量（100 用例 + Model B 变更 → 只执行受影响 + Portfolio 兜底）。

## 二、改动清单

| 文件 | 改动 |
| --- | --- |
| `src/portfolio/portfolio-schema.ts` | 新增 `PortfolioPolicy` 接口与 `DEFAULT_PORTFOLIO_POLICY` 常量（coreRate / riskRate / changeRate / regressionRate / historicalTopN / explorationBudgetRate / excludeQuarantinedFlaky） |
| `src/portfolio/index.ts` | 导出 `PortfolioPolicy` / `DEFAULT_PORTFOLIO_POLICY` / `buildRegressionPlan` / `portfolioToAutonomousCases` |
| `src/portfolio/portfolio-regression.ts` | **新建**：`buildRegressionPlan`（影响筛选 + Portfolio 策略 → Regression Plan）、`portfolioToAutonomousCases`（接入自治回归用例映射） |
| `tests/unit/portfolio-regression.test.ts` | **新建**：10 个测试（验收场景全覆盖） |
| `package.json` | 新增 `agent:portfolio-regression:test` |

## 三、核心设计

### 选择逻辑（确定性、可解释）

```text
Change
  ↓ 受影响判定（changeTags 匹配变更关键词/类型，确定性规则）
  ↓
受影响用例 → 100% 进入计划（任何类别都优先）
  ↓
未受影响用例 → Portfolio 兜底：
  Core(P0)   coreRate（默认 100%）
  Risk       riskRate（默认 100%）
  Historical historicalTopN（Top N）
  Exploration explorationBudgetRate（有候选且预算 > 0 时至少 1 个）
  Flaky      excludeQuarantinedFlaky=true → 隔离排除 / false → 纳入
  Change / Regression → 默认不选（避免全量回归）
  ↓
fullRegression=true → 全部进入（策略显式要求 Full Regression）
```

### PortfolioPolicy 配置接口

```ts
interface PortfolioPolicy {
  coreRate: number;               // Core 选择率（默认 1 = 100%）
  riskRate: number;               // Risk 选择率（默认 1）
  changeRate: number;             // Change 选择率（默认 1）
  regressionRate: number;         // Regression 选择率（默认 1）
  historicalTopN: number;         // Historical Top N（默认 10）
  explorationBudgetRate: number;  // Exploration 预算率（默认 0.2）
  excludeQuarantinedFlaky: boolean; // 排除隔离不稳定用例（默认 true）
}
```

### 回归计划输出

```ts
interface PortfolioRegressionPlan {
  runId: string;
  change: ChangeEvent;
  policy: PortfolioPolicy;
  fullRegression: boolean;
  totalCases: number;
  affectedCaseIds: string[];      // 受影响用例
  affectedCount: number;
  portfolio: PortfolioCase[];     // 全部用例分类
  categoryStats: Record<PortfolioCategory, number>;
  selectedCaseIds: string[];      // 最终 Regression Plan
  selected: PortfolioCase[];
  skipped: Array<{ caseId: string; reason: string }>;
  executionRate: number;          // ≤ 1，证明未执行全量
  evidence: string[];             // 为什么选这些 / 为什么没选其他
  createdAt: string;
}
```

## 四、验收结果

### 100 用例 + Model B 变更（任务书核心验收）

```text
输入：100 个 TestCase，其中 34 个 changeTags 命中 wan3/text-to-video + model
变更：model:wan3/text-to-video（Model A → Model B）

受影响用例：34 / 100
Regression Plan：34 个（受影响全部进入）
跳过：66 个（未受影响纯 Regression，reason=「避免全量回归」）
executionRate：0.34（≠ 1，未执行全量）
```

### 测试结果

```text
agent:portfolio-regression:test   10 PASS
npm test                          985 PASS + 18 skipped（新增 10 个 23.2 测试）
agent:test                        450 PASS
```

## 五、测试覆盖

1. 100 用例 + Model B 变更 → 受影响筛选 → Regression Plan，不执行全量（executionRate=0.34）
2. 受影响用例全选（任何类别优先）
3. Portfolio 兜底（P0 / Risk / Historical Top N / Exploration）
4. Flaky 隔离（excludeQuarantinedFlaky=true 排除 / false 纳入）
5. fullRegression=true → 全量进入（策略显式要求）
6. 证据可解释（为什么选这些 / 为什么没选其他）
7. 确定性（相同输入相同计划）
8. DEFAULT_PORTFOLIO_POLICY 一致
9. portfolioToAutonomousCases 类别→优先级映射（Core→P0 / Risk,Change→P1 / Historical,Flaky→P2 / Exploration,Regression→P3）
10. model 变更标签 → modelRisk 风险信号

## 六、设计取舍

- **Exploration 预算至少 1 个**：当探索候选仅 1 个且预算率 20% 时，`Math.round(0.2)=0` 会把探索归零，修正为「有候选且预算率 > 0 时至少 1 个」，保证探索能力不因取整失效。
- **Regression 100% 语义**：Portfolio 策略中的 regressionRate 作用于受影响用例集合（受影响全选即 100%）；未受影响的纯 Regression 默认不进入计划，从而满足「不执行全量」的硬性验收。
- **与 22 阶段兼容**：未修改 `portfolio-engine.ts` / `selectPortfolio` 既有行为，仅在 `portfolio-schema.ts` 追加新接口。

## 七、下一步

进入 Phase 23.3 Exploration → Regression：探索生命周期状态机（GENERATED→SCREENED→APPROVED→EXECUTED→VALIDATED/REJECTED）、
maxExplorationDuration 预算、三进门禁（Risk / Budget / Permission）接入 Regression Plan。
