# Phase 22.6 Autonomous Regression 报告

## 目标
从固定 Test Suite 回归升级为自治回归：Change → Risk Prediction → Failure Prediction → Adaptive Selection → Adaptive Execution → Adaptive Stop。新增 Autonomous Regression Controller 与离线 Simulation。

## 新增模块
```text
src/autonomous/
├── autonomous-schema.ts        # 数据模型：模式 / 预算 / 用例 / 决策 / Replan / 结果
├── autonomous-budget.ts        # 自治预算检查（5 项上限 → AUTONOMOUS STOP）
├── autonomous-regression.ts    # 自治回归控制器（闭环核心）
├── simulation.ts               # 离线模拟（5 个 Scenario，完全离线）
└── index.ts                    # 统一导出
bin/run-autonomous.ts           # CLI：--autonomous 开关（默认 false）
```

## 核心设计
- 控制器闭环：Select（失败预测排序）→ Prioritize（P0 优先 + 集群提升）→ Execute → Observe → Re-Plan（同标签失败提升 / 暂停低优先级）→ Stop（自适应停止 / 预算上限）。
- 复用已有模块：22.5 `predictFailureBatch`（执行顺序）、22.4 `evaluateStopping`（停止判定）、22.3 统计因子。不新增 Agent、不引入 LLM。
- 执行队列排序（确定性）：优先级 → 提升标记 → 失败概率降序 → caseId 字典序。高失败概率用例提前优先执行（任务书 Scenario 1/二十七）。
- 动态重新规划（任务书十一）：失败用例的 changeTags 关联用例自动提升；同标签集群失败达到阈值或 P0 失败 → 暂停低优先级，仅执行 P0。
- P0 失败为权威信号：立即 BLOCK（不受停止模块 minExecutedCases 防过早保护影响），转 RCA 与 Release BLOCK 判定。
- 覆盖门禁：仅当覆盖率达标（或已 BLOCK）才评估安全停止条件，避免零风险场景过早停止。
- 自治预算（任务书二十五）：maxReplans/maxAutonomousCases/maxAutonomousCost/maxAutonomousDuration/maxLLMCalls；达到任一上限 → AUTONOMOUS STOP 并输出原因。
- 自治模式（任务书二十四）：manual（仅分析）/ assisted（AI 规划 + 逐用例审批）/ autonomous（自动规划/选择/停止）；--autonomous 默认 false。production 危险动作（Release BLOCK）始终需人工审批。

## 5 个 Scenario（任务书三十）
1. 模型变更：模型 B 相关用例（高变更 + 历史失败）优先执行。
2. 连续失败：同类用例连续失败 → 触发重新规划，提升相关用例优先级。
3. 测试已充分覆盖：Coverage≥90% + P0=100% + 信息增益低 → 自适应停止。
4. 发现高风险失败：P0 失败 → 暂停低优先级 → Release BLOCK + 需人工审批。
5. 历史问题重新出现：已知问题复现 → 不重复创建缺陷 + 提升相关用例优先级。

## 测试与验收
- `tests/unit/autonomous-regression.test.ts`：19 个测试全过（5 个 Scenario + 5 项预算 + 3 模式 + 3 决策正确性 + 确定性）。
- 决策正确性（任务书二十七）：Case B（失败率 0.35 + 变更 0.8）先于 Case A（0.01 + 无变更）；P0 failure → BLOCK；Coverage 90% + P0 100% + 信息增益低 → stop=true。
- CLI：`node dist/bin/run-autonomous.js --autonomous` 离线运行 5 个 Scenario 并输出决策轨迹。
- 保留命令：npm run agent:dashboard / agent:health 依赖未改动。

## 验收结果
```text
npm run build                            ✅
npm run agent:autonomous:test            19 PASS ✅
npm run agent:autonomous:run             ✅（5 个 Scenario 全部离线可运行）
npm test                                 918 PASS + 18 skipped ✅（此前 899）
npm run agent:test                       450 PASS ✅
```

## 下一步
进入 Phase 22.7 Continuous Learning：执行结果自动改变知识权重 + Knowledge Weight Decay（30 天 0.9 / 60 天 0.7 / 90 天 0.4），形成 Execution → Knowledge Update → Risk Update → Selection Update 闭环。
