# Phase 23.1 Unified Decision Trace 阶段报告

## 一、目标

将 Tool Trace / LLM Trace / Execution Trace / Decision Trace 统一为四轨 AgentTrace，全部事件通过 `runId / taskId / caseId / traceId / spanId` 关联，可完整还原整轮自治决策链路。复用现有 `src/agents/observability/` 与 `src/decisions/`，不建立第二套 Trace 存储。

## 二、改动

### 1. `src/decisions/`（扩展，向后兼容）
- `DecisionKind` 增加 `replanning`（现共 7 类：requirement / risk / selection / priority / stopping / replanning / release）。
- `DecisionRecord` / `RecordDecisionInput` 增加可选 `caseId` 与 `outputs`（Trace 关联与决策输出可还原）。

### 2. `src/agents/observability/unified-trace.ts`（新增）
`UnifiedTracer` 聚合器组合 `AgentTracer`（span 来源）+ `DecisionRecorder`（决策单一数据源）：

```text
UnifiedTrace
├── spans           ← AgentTracer.toTrace().spans
├── toolEvents      ← UnifiedTracer.recordTool（事件级）
├── llmEvents       ← UnifiedTracer.recordLLM（事件级）
├── executionEvents ← UnifiedTracer.recordExecution（caseId/result/priority）
├── decisionEvents  ← DecisionRecorder（含 caseId/outputs/decisionType）
└── summary         ← passes/failures/skipped/replanCount/stopDecision/releaseDecision
```

### 3. `src/agents/index.ts`
导出 `unified-trace.js`。

## 三、测试

`tests/unit/unified-trace.test.ts`（6 个用例）+ `tests/unit/decisions.test.ts`（更新为 7 类 + caseId/outputs）：

- 四轨聚合齐全
- runId/taskId/caseId/traceId/spanId 关联
- 整轮链路还原：runId → priority → execution(FAIL) → replan → stopping → release
- summary 统计（passes/failures/skipped/replanCount/stopDecision/releaseDecision）
- 空轨迹
- 决策单一数据源（写入 DecisionRecorder 不重复存储）

## 四、回归

```text
npm run agent:trace:test     6 PASS
npm run agent:decision:test  6 PASS
npm test                     975 PASS + 18 skipped（较 22 收尾 +7）
npm run agent:test           450 PASS
```

## 五、下一步

**Phase 23.2 Portfolio → Regression**：新增 `PortfolioPolicy` 配置接口，将 Portfolio 计划接入 Autonomous Regression Controller，实现「100 个用例 + Model B 变更 → 受影响筛选 → Regression Plan」而非全量。
