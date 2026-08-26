# Phase 22.8 Autonomous Release Decision 阶段报告

## 一、目标

把 Release Gate（二元 PASS/BLOCK）升级为 AI Release Decision（三态 PASS / BLOCK / REVIEW），
所有决策必须携带结构化证据，禁止 LLM“我认为可以发布”。

## 二、新增模块

```text
src/release-decision/
├── release-decision-schema.ts   # 类型、三态、证据、阈值默认值
├── release-decision-engine.ts   # decideRelease 确定性决策引擎
└── index.ts                     # 统一导出
```

## 三、核心设计

### 3.1 决策层级（确定性）

```text
BLOCK  >  REVIEW  >  PASS
```

- **BLOCK（权威阻断信号，命中任一）**：P0 存在失败 / Critical 缺陷 > 0 / 测试环境异常。
- **REVIEW（软性风险信号）**：P1 通过率不足 / Coverage < 90% / 已知问题 > 0 / 不稳定用例超容忍值 / 整体风险 HIGH / 模型变更 / 历史失败率超阈值 / 失败预测超阈值。
- **PASS**：全部硬门禁与软风险信号均达标。

### 3.2 结构化证据（任务书十五）

每个信号输出 `{ type, value }`，决策与证据一一对应，可复现：

```json
{
  "decision": "BLOCK",
  "confidence": 0.74,
  "evidence": [
    { "type": "p0", "value": "4/5 passed" },
    { "type": "critical-defect", "value": "2 open" },
    { "type": "coverage", "value": "91.0%" }
  ],
  "blockingFactors": ["P0 全部通过：实际 4/5 passed", "Critical Defect = 0：实际 2 open"]
}
```

### 3.3 确定性置信度

```text
BLOCK   0.5 + 0.12 × (阻断信号数 + 软信号失败数)，上限 0.98
REVIEW  0.5 + 0.08 × 软信号失败数，上限 0.9
PASS    0.85（全部门禁与风险信号达标）
```

### 3.4 建议动作

按命中信号推导（修复 P0 / 关闭 Critical / 修复环境 / 补覆盖 / 补 P1 回归 / 隔离不稳定用例 / 评估已知问题影响面 / 模型变更补充回归），不依赖 LLM。

## 四、测试覆盖

`tests/unit/release-decision.test.ts`（18 个用例，全部通过）

- 三态决策正确性：全达标 → PASS；P0 失败 → BLOCK；Critical → BLOCK；环境异常 → BLOCK
- 任务书十四示例：P1 99% / Coverage 94% / Known Issue 1 / Flaky 2 / Risk Moderate → **REVIEW**（不是直接 PASS）
- 冲突信号：P0 失败 + Coverage 低 → 硬信号优先 BLOCK
- 证据结构：BLOCK/PASS 均输出完整结构化证据
- 边界：空数据（无 P0/P1 → PASS）、历史数据不足不误报、Coverage 恰 90%、P1 恰 98%
- 确定性：相同输入 → 相同决策/置信度/证据

## 五、回归结果

```text
npm run agent:release-decision:test   18 PASS
npm test                              946 PASS + 18 skipped
npm run agent:test                    450 PASS
```

## 六、下一步

完成 Phase 22 通用要求收尾：

- Test Portfolio（Core / Risk / Change / Historical / Exploration / Regression / Flaky）
- Exploration Testing（受 Risk / Budget / Permission 约束）
- Agent Decision Trace（Requirement / Risk / Selection / Priority / Stopping / Release）
- CLI `--autonomous` 与自治预算扩展
- Phase 22 最终验收报告（8 个新命令 + 5 个 Scenario）
