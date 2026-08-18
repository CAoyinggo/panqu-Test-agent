# Phase 17 变更报告：Agent Observability + Budget + Model Router

> 阶段目标（任务书第十一节 / 第十五节 / 第二十节）：Agent 自身可观测性（Trace）、
> AI 测试预算控制、模型路由。用于判断「Agent 到底有没有比人工/传统自动化更有价值」。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `src/agents/observability/observability-schema.ts` | `AgentTraceSpan` / `AgentTrace` 数据模型 + `summarizeTrace` 汇总 |
| `src/agents/observability/tracer.ts` | `AgentTracer`：startSpan/endSpan + recordLLM/recordTool/recordRetry/recordFallback/recordError → Agent Trace |
| `src/agents/observability/budget.ts` | `AgentBudget`：Token/LLM 调用/Agent 调用/Tool 调用/时长限额，防无限循环 |
| `src/llm/model-router.ts` | `ModelRouter`：按任务类型分配 model/fallbackModel/timeout/temperature/maxTokens，档位映射 |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `src/agents/index.ts` | 新增 observability 模块导出 |
| `src/llm/index.ts` | 新增 model-router 导出 |
| `package.json` | `agent:test` 追加 `observability.test.ts`、`model-router.test.ts` |

## 三、新增测试

| 测试文件 | 数量 | 覆盖点 |
|---|---|---|
| `tests/unit/observability.test.ts` | 8 | Tracer 记录/汇总/状态（ok/fallback/error）/ 未结束 span 排除 / Tool 统计 / Budget 超限检测 / importTrace |
| `tests/unit/model-router.test.ts` | 9 | 默认路由（高/中/小档位）/ fallbackModel / 自定义档位 / configure 覆盖 / 单例 |

## 四、关键设计决策

1. **Agent Trace**：每个阶段记录 Token / Latency / LLM 成本（估算）/ Tool 调用与耗时 / 重试 / 回退 / 错误，整轮可汇总为 Agent Trace（可观测性基础）。
2. **成本估算可配置**：`CostConfig` 提供 input/output 每 1K token 成本，默认估算值。
3. **预算防循环**：`AgentBudget.check()` 任一限额超限即停止，防止「不断生成测试 → 不断执行 → 无限循环」。
4. **模型路由**：Requirement/Analysis/RCA→高能力；Test Design→中高；Risk/Selection/Coverage/Flaky/分类→小模型（任务书第二十节）；支持档位映射与单任务覆盖。

## 五、验证结果

- `npm run build` ✅
- 新增单测：17/17 通过
- `npm test`（全量回归）：33 文件 / 556 测试通过（较 Phase 16 的 539 增加 17）
- 未破坏既有能力
- 修复：`toTrace()` 丢弃同毫秒内结束的 span（改为 ended 标记跟踪）；状态判定改用 span 实际累计值

## 六、进入 Phase 18 的前置说明

Phase 18 Evaluation 将基于固定 Benchmark（10 正常 + 10 边界 + 10 异常需求 + 10 历史缺陷 + 10 环境异常 + 10 模型异常）
评估各 Agent 的准确性 / 质量 / 回退率 / Token 成本 / 延迟，输出 Agent Quality Score。
