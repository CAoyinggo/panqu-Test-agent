# Phase 22.5 Failure Prediction 报告

## 目标
在执行之前预测哪些 Case 最容易失败：高失败概率 → 提前优先执行。全部为确定性统计，不引入 LLM / ML 平台。

## 新增模块
```text
src/failure-prediction/
├── failure-prediction-schema.ts   # 数据模型 + 默认配置
├── failure-prediction-engine.ts   # 七因子加权预测引擎
└── index.ts                       # 统一导出
```

## 核心设计
- 输入：历史失败 / Change Impact / Model / Environment / Risk / Flaky / Defect（全部可选，缺失按 0）。
- 七因子权重（合计 1.0）：历史 0.3 + 变更 0.2 + 模型 0.1 + 环境 0.1 + 风险 0.1 + Flaky 0.1 + 缺陷 0.1。
- 输出：`failureProbability`、`predictedCategory`（PASS/FAIL/FLAKY/ENV）、`confidence`、`evidence`、`factors` 分解、`suggestedOrder`。
- 类别判定（确定性顺序）：概率 ≥ 阈值 → Flaky ≥ 阈值 判 FLAKY，否则 环境 ≥ 阈值 判 ENV，否则 FAIL；概率 < 阈值 → PASS。
- 当前版本未执行 → 证据“当前版本尚未执行” + 10% 未知风险补贴。
- 置信度：0.2 + 样本量/30×0.5 + 证据数×0.04，上限 0.95。
- 批量预测：按失败概率降序，同概率按 caseId 字典序，`suggestedOrder` 从 1 起（供 22.6 控制器“高概率先执行”）。

## 关键设计决策
- 复用 22.3 的 `computeFailureStats`（历史频率），不重复实现统计逻辑。
- 负值/越界输入经 `clamp01` 归一化，保证可复现。
- 冲突信号（Flaky 与 Env 同时高）按固定顺序判定，行为可预测、可测试。

## 测试
- `tests/unit/failure-prediction.test.ts`：9 个测试全过。
- 覆盖：任务书场景（Case A 0.01 无变更 vs Case B 0.35 + 0.8 变更 → B 优先）、类别判定（FAIL/FLAKY/ENV/PASS）、模型异常、环境异常、冲突信号、空数据、历史不足、未执行当前版本、边界 clamp、批量排序、确定性。

## 验收结果
```text
npm run build                         ✅
npm run agent:failure-prediction:test 9 PASS ✅
npm test                              899 PASS + 18 skipped ✅（此前 889）
npm run agent:test                    450 PASS ✅
```

## 下一步
进入 Phase 22.6 Autonomous Regression：自治回归控制器（select/prioritize/execute/observe/re-plan/stop）+ 动态重新规划 + 离线模拟（含 5 个 Scenario）。
