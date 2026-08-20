# Phase 45 Ground Truth Registry（无 Ground Truth 不声称 Accuracy）

> 核心原则：没有 Ground Truth 就不能声称 Accuracy。每条评测用例必须关联一条 Ground Truth 记录；没有记录 → `tracked=false` → `score=null`，禁止虚构准确率。

## 一、Ground Truth 记录结构

定义于 `src/eval/ground-truth.ts`：

```ts
type GroundTruthSource = 'HUMAN' | 'REAL_RUN' | 'PRODUCTION' | 'CURATED' | 'GENERATED';

interface GroundTruthRecord {
  id: string;              // 对应 EvaluationCase.id
  source: GroundTruthSource; // 来源标签（合法枚举校验）
  verifiedBy?: string;     // 核验人 / 核验主体（如 phase45、QA 人工）
  verifiedAt?: string;     // 核验时间
  confidence: number;      // 0~1，人工核实置信度
}
```

合法性校验（`register` 时强制）：

- `id` 缺失 → 抛错。
- `source` 非合法枚举 → 抛错。
- `confidence` 非数值或不在 0~1 → 抛错。

## 二、来源枚举

| 来源 | 说明 | confidence 惯例 |
| --- | --- | --- |
| `HUMAN` | 人工标注 / 人工核验 | 通常 1 |
| `REAL_RUN` | 来自真实测试运行的记录 | 由记录方声明 |
| `PRODUCTION` | 来自生产环境的真实观测 | 由记录方声明 |
| `CURATED` | 评测构建方精心构造并核验 | 由构建方声明（v1 基准为 1） |
| `GENERATED` | 生成器产出 | 必须显式声明，避免滥用 |

## 三、GroundTruthRegistry

```ts
class GroundTruthRegistry {
  register(record: GroundTruthRecord): this;  // 校验并登记
  get(id): GroundTruthRecord | undefined;     // 查询记录
  has(id): boolean;                           // 有记录且 confidence > 0
  isTracked(id): boolean;                     // = has(id)
  confidence(id): number | null;              // 有效 confidence，否则 null
  size: number;
  list(): GroundTruthRecord[];
}
```

**关键规则**：`isTracked(id)` 要求「有记录 **且** `confidence > 0`」。登记但 `confidence <= 0` 视为不可追踪，防"随便标个来源就放行"。

## 四、tracked=false → score=null 规则

运行器（`src/eval/runner.ts`）逐用例判定：

```ts
const tracked = registry.isTracked(c.id);
if (!tracked) {
  // 无 Ground Truth → tracked=false，score=null（绝不虚构）
  return {
    caseId: c.id, domain, score: null, passed: false, tracked: false,
    expected: undefined, actual: undefined,
    errors: ['未登记 Ground Truth（tracked=false，score=null）'],
  };
}
```

影响：

- `score` 为 `null`，**不参与**领域得分均值与 Overall 计算。
- `passed=false`（未追踪即视为未通过，但不计为失败）。
- 领域报告的 `tracked` / `untracked` 分别统计；得分只基于 `tracked` 用例。

## 五、标准工厂 groundTruthFor

便捷构造一批用例 ID 到同来源记录：

```ts
function groundTruthFor(
  ids: string[],
  opts: { source: GroundTruthSource; verifiedBy?: string; verifiedAt?: string; confidence?: number },
): GroundTruthRecord[];
```

`confidence` 缺省为 1。

## 六、默认注册（v1 基准）

`src/eval/runner.ts` 的 `buildDefaultGroundTruth` 将 8 领域全部 238 条用例登记为：

```ts
{ source: 'CURATED', verifiedBy: 'phase45', confidence: 1 }
```

即 v1 基准：

- 全部用例 **tracked**（真实运行 `untracked = 0`）。
- 全部来源 `CURATED`、核验主体 `phase45`、置信度 `1`。

## 七、使用建议

1. **新增用例必须同步登记 GT**，否则该用例会被静默跳过（score=null），口径会误导。
2. **真实数据沉淀**：真实运行 / 生产环境观测到的失败，应升版基准并用 `REAL_RUN` / `PRODUCTION` 来源登记，保留 `verifiedBy` / `verifiedAt` 追溯。
3. **置信度治理**：`GENERATED` 来源的用例必须显式声明 `confidence`，低置信度（<=0）用例不允许声称 Accuracy。
4. **防循环论证**：GT 必须独立于评估器产生，评估器以确定性实现实际输出与 GT 比对，而非用评估器输出当 GT。
