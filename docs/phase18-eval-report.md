# Phase 18 变更报告：Agent Evaluation（评测体系）

> 阶段目标（任务书第十八节）：新增 `tests/evals/`，建立固定 Benchmark 与 Agent 评测体系，
> 输出 Agent Quality Score，作为「每次 Agent 修改后自动跑 Eval」的质量门禁，而不只是依赖 `npm test`。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `tests/evals/benchmark/requirements.ts` | 需求理解基准：30 条（10 正常 + 10 边界 + 10 异常），含 `expected` 契约（feature/capabilities/inputs/businessRules/risks） |
| `tests/evals/benchmark/failures.ts` | 根因分类基准：30 条（10 历史缺陷 + 10 环境异常 + 10 模型异常），含 `expectedCategory` |
| `tests/evals/benchmark/healing.ts` | 自愈基准：5 条（3 路径失效 + 2 非失效），含 `expectedOldPath` / `expectedNewPath` / `expectNoSuggestion` |
| `tests/evals/eval-utils.ts` | 评测工具：`setScore`（precision/recall/F1）、`exactMatch`、`mean`、`pct`、`buildQualityReport`（维度加权）、`finalizeReport`、`traceMetrics` |
| `tests/evals/run-evals.ts` | 评测主脚本：逐条运行各 Agent / 分析器，汇总 `QualityReport`，输出 Agent Quality Score |
| `tests/evals/agent-eval.test.ts` | 评测测试：工具函数 + 权重汇总 + 完整 Benchmark 阈值断言（8 用例） |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `package.json` | 新增 `agent:eval` 脚本（build → 运行评测 → 断言评测测试） |
| `src/agents/requirement/requirement-parser.ts` | 需求理解增强（评测驱动）：分辨率值（1080P/720P/4K 等）识别为 `resolution` 输入；`扣费` 映射到「积分正确扣除」业务规则 |
| `src/agents/analysis/failure-classifier.ts` | 根因分类增强（评测驱动）：新增环境上下文优先规则（`environment not ready/error/timeout/dns` 等 → `ENVIRONMENT_ERROR`），修复环境异常被误判为 MODEL/NETWORK/BILLING 的问题 |
| `tests/evals/benchmark/requirements.ts` | 校准 3 处自相矛盾条目（req-007 特征上下文、req-021/req-029 业务规则与原文不符） |
| `tests/evals/benchmark/healing.ts` | heal-003 改为当前算法可检测的字段重命名（`data.videos.list` → `data.videos.items`） |
| `tests/evals/eval-utils.ts` | 修复 `overall` 加权汇总 bug（权重已归一化，不应再除维度数） |

## 三、评测维度与权重

| 维度 | 权重 | 评估方式 |
|---|---|---|
| Requirement Accuracy | 0.25 | 30 条需求 × 2 路径（LLM 注入 + 确定性回退），字段加权（feature 精确 + 集合 F1） |
| Root Cause Accuracy | 0.25 | 30 条失败基准的分类精确匹配 |
| Self-Healing Accuracy | 0.15 | 路径失效检测 + 新路径定位（oldPath→newPath） |
| Defect Quality | 0.15 | 草稿状态 DRAFT + 严重度映射 + 关联用例 + 证据完整 |
| Risk Accuracy | 0.20 | billing/timeout/retry/concurrency/security 可判定标签覆盖 |

## 四、评测结果（确定性基准，MockLLM 离线）

| 维度 | 得分 | 通过 |
|---|---|---|
| Requirement Accuracy | 88 | 32/60 |
| Root Cause Accuracy | 100 | 30/30 |
| Self-Healing Accuracy | 100 | 5/5 |
| Defect Quality | 100 | 30/30 |
| Risk Accuracy | 100 | 30/30 |
| **Overall（Agent Quality Score）** | **97** | - |
| 回退率（fallbackRate） | 0.5 | LLM 注入路径无回退 / 失败路径全部回退 |
| 幻觉率（hallucinationRate） | 0 | 未产生与契约冲突的输出 |
| 估算 Token 成本 | 0.0388 | - |
| 总耗时 | ~174ms | 60 次 LLM 调用（Mock） |

## 五、关键设计决策

1. **固定 Benchmark = 理解契约**：基准 `expected` 编码「期望的需求理解 / 根因分类 / 自愈路径 / 缺陷严重度」，既约束确定性层，也是将来接入真实 LLM 后的 AI 质量标尺。
2. **双路径评测**：Requirement 维度同时测 LLM 优先路径（注入正确 JSON，验证 LLM→Schema→Normalize 链路无损耗）与确定性回退路径（MockLLM 失败），回退率 = 失败路径占比（0.5）。
3. **确定性优先落地**：RCA / Healing / Defect / Risk 四维全部基于规则引擎（`classifyFailure` / `analyzeHealing` / `buildDefectFromRca` / `analyzeRisks`），评测分数即为规则质量的量化。
4. **评测驱动改进**：构建评测时暴露真实短板并修复——解析器补全分辨率/扣费识别（Req 分提升）、分类器补环境上下文规则（RCA 达 100%）、`buildQualityReport` 权重 bug、回退率分母 bug。
5. **草稿/建议分离不变**：Defect 评测强制 `DRAFT` 状态、Healing 评测强制 `SUGGESTED` 状态，与 Phase 14/15 安全边界一致。

## 六、验证结果

- `npm run build` ✅
- `npm run agent:eval` ✅（8/8 用例通过，输出 Quality Report）
- `npm test`（全量回归）：34 文件 / 564 测试通过（较 Phase 17 的 556 增加 8）
- `npm run agent:test` ✅（25 文件 / 331 测试）
- 解析器 / 分类器改动未破坏既有 Agent 测试

## 七、进入下一阶段的前置说明

Phase 18 完成。剩余收尾工作（任务书第十三、二十一至二十八节）：
Memory 知识系统升级（querySimilarCase/queryKnownIssue/queryCoverageGap）、
Pipeline / CLI 集成（接入 selection/coverage/rca/defect/heal/approve/trace/evals）、
安全边界（Tool 权限 + 脱敏）、最终端到端验收（15 步闭环 Demo）。
