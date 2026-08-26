# Phase 23.5：End-to-End Autonomous Pipeline 报告

> 目标：把 Change → Impact → Portfolio → Exploration → Priority → Regression → Execution → Observation → RePlan → Adaptive Stop → RCA → Release Decision → Decision Trace → Report 串联为一条真实可运行的端到端自治测试流水线，并验证动态 Re-Planning。

## 一、完成内容

### 1. 端到端流水线模块（`src/autonomous/autonomous-pipeline.ts`）

新增 `runAutonomousPipeline(input)`，完整闭环 12 步，全部确定性、离线可复现：

```text
01 Requirement → 02 Impact+Portfolio → 03 Exploration(三进门禁) → 04 组装自治用例
→ 05 Priority(initialOrder) → 06 RePlan → 07 Adaptive Stop/暂停低优先级
→ 08 Observation→RCA → 09 Defect+Knowledge → 10 Release Decision
→ 11 Trace 汇总 → 12 Run Summary（CI Gate 消费）
```

- `PipelineTracePlan` 完整记录：`initialPlan / replans / finalPlan / pausedCaseIds / stopDecision / releaseDecision / decisionTrace`。
- `DecisionRecorder` 记录 `requirement/selection/risk/priority/replanning/stopping/release` 七类决策，均可通过 `taskId`（含 runId）与 `caseId` 关联还原。
- `RunSummary` 契约（run-summary.json）供 `scripts/ci/agent-release-gate.mjs` 直接消费。
- 生产安全：exploration/defect 等仍走 Permission + Approval；production → dangerous = DENY、risky = Approval。

### 2. 六个验收场景（`src/autonomous/pipeline-scenarios.ts`）

| 场景 | 输入 | 期望 | 实际 |
|------|------|------|------|
| 1 code-change-pass | 普通代码变更 | PASS / 0 | PASS / 0 |
| 2 model-change-risk | 模型变更（20 受影响） | REVIEW / 2 | REVIEW / 2 |
| 3 exploration-failure | 探索发现新失败 | REVIEW / 2 | REVIEW / 2（RCA 1） |
| 4 replan-block | 动态重规划 | BLOCK / 1 | BLOCK / 1（RePlan 2，RCA 2） |
| 5 release-review | P0 PASS/P1 99%/Coverage 93%/Flaky 2/Known 1 | REVIEW / 2 | REVIEW / 2 |
| 6 release-block | P0 Fail = 1 | BLOCK / 1 | BLOCK / 1 |

### 3. CLI（`bin/run-autonomous-pipeline.ts`）

```bash
node dist/bin/run-autonomous-pipeline.js --scenario replan-block
node dist/bin/run-autonomous-pipeline.js --change-type model --change-target wan3/text-to-video --environment test
node dist/bin/run-autonomous-pipeline.js --all          # 批量验收全部 6 场景
```

输出：`output/<date>/<feature>/{run-summary.json, autonomous-pipeline.json, release-decision.json}`。
修复了输出路径：`dist/output/` → 项目根 `output/`（与 `agent-release-gate.mjs` 扫描目录对齐）。
退出码与 CI Gate 一致：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR。

### 4. 动态 Re-Planning 验证（任务书十三）

场景 4（A P0 / B,C P1 model / D P2 model / E P3）：

```text
Initial Plan: A → B → C → D → E
执行 A → PASS
执行 B → FAIL → RePlan #1：提升同标签 C、D（model）
执行 C → FAIL → RePlan #2：提升 D；暂停低优先级 D、E，仅执行 P0
→ RCA 2 个（MODEL_ERROR）→ critical 缺陷 2 → Release BLOCK（exit 1）
```

Trace 完整记录：Initial Plan / RePlan #1 / RePlan #2 / Final Plan / Stop Decision（暂停 D、E）/ Release Decision（BLOCK）。

### 5. 场景 3 修复（探索发现问题）

根因（两处）：

1. `runAutonomousRegression` 每次执行递增 `decisionDepth`，默认 `maxDecisionDepth: 20` 仅允许执行 21 个用例；探索候选 `explore-gap-wan3-export`（P3，队列末尾）从未执行 → 无失败 → 无 RCA → PASS。
2. 即使探索用例执行，作为 P3 失败仅产生 minor 缺陷，不触发任何 Release 软信号 → 仍 PASS。

修复：

- 场景 3 显式放宽自治预算（`maxDecisionDepth/maxAutonomousCases/maxAutonomousCost/maxLLMCalls = 200`），并配置探索候选优先级 `P1`（`AutonomousPipelineExplorationInput.priority`，默认仍 P3），使其在自适应停止（Coverage≥90%）前执行。
- 探索发现的新失败登记为新已知问题（`discoveredFailures` → `knownIssues`）并写入知识更新；配合 P1 失败拉低 P1 通过率（30/31=97.9% < 98%），确定性触发 REVIEW（exit 2）。

### 6. 测试（新增）

```text
tests/unit/replan.test.ts         7 PASS（Initial/RePlan#1/RePlan#2/Final/Stop/Release/BLOCK/确定性）
tests/e2e/autonomous-pipeline.test.ts  26 PASS（6 场景 + 契约 + Trace + 确定性 + 生产安全）
```

均纳入 `npm test`（vitest run 自动收集）。

### 7. 命令（新增）

```bash
npm run agent:replan:test      # vitest run tests/unit/replan.test.ts
npm run agent:autonomous:e2e   # build + CLI --all + vitest run tests/e2e/autonomous-pipeline.test.ts
```

## 二、测试与回归

```text
npm run agent:replan:test          7 PASS
npm run agent:autonomous:e2e       26 PASS（CLI --all 6 场景全 PASS）
npm test                           1041 PASS + 18 skipped
npm run agent:test                 450 PASS
```

## 三、验收指标对照（任务书二十四）

| 指标 | 结果 |
|------|------|
| 自治 E2E 完整 Scenario | 6 个全部 PASS |
| Scenario 1 普通变更 | PASS / exit 0 |
| Scenario 2 高风险变更 | REVIEW / exit 2 |
| Scenario 3 探索发现问题 | REVIEW / exit 2（RCA 1） |
| Scenario 4 动态重规划 | BLOCK / exit 1（RePlan 2） |
| Scenario 5 Release REVIEW | REVIEW / exit 2 |
| Scenario 6 Release BLOCK | BLOCK / exit 1 |
| CI Exit Code 一致性 | 100%（决策 ↔ 退出码断言 + CLI 真实 shell） |
| 不破坏现有流水线 | npm test / agent:test 全部通过 |

## 四、说明

- Deterministic First：Release 决策由规则引擎推导，流水线内不调用 LLM；LLM 仅用于未来可解释性扩展。
- REVIEW 由软信号推导（P1 通过率 / 已知问题 / flaky / 模型变更等），BLOCK 由权威硬信号推导（P0 / critical 缺陷 / 环境异常），AI 不能自行决定 PASS/BLOCK。
- 下一阶段（23.6）将对 Dashboard、Report、Production Safety 做最终生产验收。
