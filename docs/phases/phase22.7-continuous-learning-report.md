# Phase 22.7 Continuous Learning 阶段报告

## 一、目标

把 Memory / Knowledge 从「保存、查询、去重、排序、过期」升级为「执行结果自动改变知识权重」，形成完整学习闭环：

```text
Execution → Knowledge Update → Risk Update → Selection Update → Next Execution
```

同时保证「知识不能无限增强」：设置 Knowledge Weight Decay（时间衰减），除非新证据继续验证，否则历史信息自动降低权重。

## 二、新增模块

```text
src/learning/
├── learning-schema.ts      # 类型与配置（recentWindow / priorityThresholds / decay 锚点）
├── continuous-learning.ts  # applyEvidence / decayLearningState / ContinuousLearner
└── index.ts                # 统一导出
```

## 三、核心设计

### 3.1 执行证据 → 权重更新（applyEvidence）

每次执行结果到达时，完全由确定性统计重算：

```text
failureRate  = failures / runs
recentRate   = 最近 recentWindow 次失败占比
confidence   = 0.3 + recentRate × 0.7
riskWeight   = failureRate × confidence
priority     = 由 riskWeight 阈值推导（P0 ≥ 0.6 / P1 ≥ 0.35 / P2 ≥ 0.15 / 其余 P3）
decay        = 1（新证据重新验证，权重衰减重置）
```

- 连续 PASS → recentRate ↓ → confidence ↓ → riskWeight ↓ → priority 可能降级。
- 连续失败 → recentRate ↑ → confidence ↑ → riskWeight ↑ → priority 升级。
- 不依赖 LLM 计算基础指标，全部可复现。

### 3.2 Knowledge Weight Decay（decayLearningState）

无新证据时按时间衰减（任务书十三锚点）：

```text
< 30 天     权重 = 1
30 ~ 60 天  权重 = 0.9
60 ~ 90 天  权重 = 0.7
90 天以上    权重 = 0.4 × 0.9^((age-90)/30)，下限 minDecay = 0.05
```

新证据到达 → decay 重置为 1，历史权重由最新行为重新验证。

### 3.3 Selection Update 闭环（applyToCases）

```text
case-a 失败 → 学习风险权重 1.0 → 用例优先级 P2 → P0 提升
case-p0 通过 → 学习风险权重低，但原 P0 不降级（保底）
case-untracked → 无学习状态，不受影响
```

riskScore = max(原用例 riskScore, 学习 riskWeight)，学习结果真正参与下一轮 Test Selection。

### 3.4 知识沉淀（toKnowledgeInputs）

导出 `risk-insight` 知识条目（含 runs / failures stats），直接兼容 Phase 21.5 KnowledgeStore。

## 四、测试覆盖

`tests/unit/learning.test.ts`（10 个用例，全部通过）

- Decay 锚点：0 / 30 / 60 / 90 天与 90 天后继续衰减、minDecay 下限
- 无新证据：30/60/90 天权重按锚点下降，优先级可能降级
- 高风险知识连续 20 次 PASS → 权重与优先级下降
- 连续 5 次失败 → 权重与优先级上升（recentWindow=5）
- 新证据重置 decay
- 批量学习 + 状态查询
- Selection Update：P2 → P0 提升、P0 不降级、无状态用例不受影响
- decayAll 空状态 / 正常衰减
- toKnowledgeInputs 沉淀
- 建议优先级阈值（确定性）

## 五、回归结果

```text
npm run agent:learning:test   10 PASS
npm test                      928 PASS + 18 skipped
npm run agent:test            450 PASS
```

## 六、下一步

进入 **Phase 22.8 Autonomous Release Decision**：

- 将 Release Gate 升级为 AI Release Decision（PASS / BLOCK / REVIEW）
- 输出 confidence / reasons / blockingFactors / recommendedActions / 结构化 evidence
- 新增 `agent:release-decision:test`
