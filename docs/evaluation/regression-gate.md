# Phase 45 回归门规则（Regression Gate）

> 评测不能只看"现在多少分"，必须支持版本间对比与回归门。任一命中 BLOCK 条件即阻止发布 / 合入（退出码非 0）。

## 一、回归门阈值（DEFAULT_GATE_THRESHOLDS）

定义于 `src/eval/regression.ts`：

```ts
const DEFAULT_GATE_THRESHOLDS = {
  criticalDelta: 0.05,   // 普通领域得分下降超过该比例 → BLOCK
  softDelta: 0.03,       // 普通领域得分下降超过该比例 → REVIEW
  maxP0Miss: 0,          // 候选版本 P0 Miss 上限
  maxFalsePass: 0,       // 候选版本 False Pass 上限
  maxUnsafeHealing: 0,   // 候选版本 Unsafe Healing 上限
  maxSkippedCritical: 0, // 候选版本 Skipped Critical 上限
};
```

安全敏感关键领域（任一得分下降即触发 BLOCK）：

```ts
const CRITICAL_DOMAINS = ['RCA', 'RISK', 'RELEASE', 'HEALING'];
```

## 二、门禁规则（任一命中即 BLOCK）

1. **关键安全指标非 0 → BLOCK**：候选版本的 `P0 Miss / False Pass / Unsafe Healing / Skipped Critical` 任一超过阈值（默认 0）即 BLOCK。
   - `P0 Miss`：P0/Risk Critical 漏判。
   - `False Pass`：应 BLOCK 却 PASS（Critical Release Miss，禁止放行）。
   - `Unsafe Healing`：DANGEROUS 自愈（掩盖真实 Bug）。
   - `Skipped Critical`：关键用例被跳过。

2. **关键领域下降 → BLOCK**：`RCA / RISK / RELEASE / HEALING` 任一领域得分下降即触发 BLOCK（安全敏感，即使小幅）。

3. **普通领域大幅下降 → BLOCK**：非关键领域得分下降超过 `criticalDelta(0.05)`。

4. **小幅下降 → REVIEW**：下降超过 `softDelta(0.03)` 但未达 BLOCK 条件 → `REVIEW`。

5. **其余 → PASS**：全部指标达标或持平，允许发布。

## 三、门禁裁决

```ts
type GateVerdict = 'PASS' | 'REVIEW' | 'BLOCK';
```

- 存在任何 `BLOCK` 原因 → `BLOCK`。
- 否则存在任何 `REVIEW` 原因 → `REVIEW`。
- 否则 → `PASS`。

`reasons` 数组记录触发原因；无任何触发时记录 `['全部指标达标或持平，允许发布']`。

此外，关键安全指标即使未超绝对阈值，只要 candidate > baseline 也会记录到 `critical.regressions`（视为退化 REVIEW）。

## 四、CLI 用法（bin/eval-cli.ts）

```bash
# 1. 运行回归门：运行当前版本并与此前最新基线对比
node dist/bin/eval-cli.js regression [--json]

# 2. 版本对比（含回归门裁决）
node dist/bin/eval-cli.js compare --baseline <version|latest|报告文件> [--candidate current] [--json]
```

**退出码**：

| 命令 | 退出码 | 含义 |
| --- | --- | --- |
| `regression` / `compare` | 0 | Gate = PASS 或 REVIEW（放行 / 人工复核） |
| `regression` / `compare` | 1 | Gate = **BLOCK**（阻止发布 / 合入） |
| `compare` | 2 | 缺 `--baseline` 等参数错误 |
| `regression` | 1 | 无基线报告可对比 |

## 五、真实运行示例（v4.17.0）

本机执行 `node dist/bin/eval-cli.js regression` 的真实输出与退出码：

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

退出码 0（PASS）。关键安全指标基线均为 0，候选也为 0，无 BLOCK / REVIEW 触发。

## 六、接入 CI 的建议

- 将 `node dist/bin/eval-cli.js regression` 接入发布流水线：BLOCK（退出码 1）即中断流水线，阻止候选版本进入发布。
- 版本发布前先 `run` 建立基线报告，再对候选版本 `compare --baseline`。
- 关键安全指标必须为 0 才允许合入（`run` 已内置：任一非 0 退出码 1）。
