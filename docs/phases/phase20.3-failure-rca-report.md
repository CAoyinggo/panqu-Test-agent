# Phase 20.3 变更报告：真实失败 RCA（Real Failure Analysis）

> 目标：让 RCA 面对任务书要求的 14 种真实失败（HTTP 400/401/403/404/429/500/502/503、超时、
> 依赖、模型、计费、数据、环境），每种都产出「事实/证据/推断/置信度/排除项/建议」，
> 禁止「无证据结论」（不允许"可能是模型异常"这类猜测）。

## 1. 变更内容

### 修改文件
| 文件 | 变更 |
| --- | --- |
| `src/agents/analysis/root-cause-schema.ts` | `FailureCategory` 新增 `RATE_LIMIT_ERROR`（限流）与 `DEPENDENCY_ERROR`（依赖故障）；同步更新 JSON Schema enum 与 `FAILURE_CATEGORIES` |
| `src/agents/analysis/failure-classifier.ts` | 新增 `HTTP_STATUS_MAP` 精确状态码映射（400/401/403/404/408/429/500/502/503/504，置信度 0.95，优先于关键词规则）；新增 429→限流、依赖/上游→`DEPENDENCY_ERROR` 规则；`DATA_ERROR` 规则前移（避免 `data not found` 被 4xx 规则误判） |

### 新增文件
| 文件 | 说明 |
| --- | --- |
| `tests/e2e/real/real-failure-rca.test.ts` | 14 种真实失败 RCA 验证（16 条用例）：确定性分类 + 证据链 + 完整 RootCauseAgent；每条断言 category / confidence≥0.85 / facts 非空 / evidence 非空 / 排除项与建议字段输出；用 MockLLM（非 RootCause 输出）强制走确定性回退，证明结论全部来自证据链而非 LLM 猜测；另验证 LLM 输出含新分类时 schema 校验通过 |

## 2. 14 种真实失败分类映射

| 失败 | 分类 | 证据（facts） |
| --- | --- | --- |
| HTTP 400 | TEST_CODE_ERROR | 错误消息含 HTTP 400（置信度 0.95） |
| HTTP 401 | AUTH_ERROR | 错误消息含 HTTP 401 |
| HTTP 403 | AUTH_ERROR | 错误消息含 HTTP 403 |
| HTTP 404 | TEST_CODE_ERROR | 错误消息含 HTTP 404 |
| HTTP 429 | RATE_LIMIT_ERROR | 错误消息含 HTTP 429 |
| HTTP 500 / 502 / 503 | MODEL_ERROR | 错误消息含 HTTP 5xx |
| 超时 | TIMEOUT | timedOut=true + 超时消息 |
| 依赖故障 | DEPENDENCY_ERROR | 依赖/上游服务不可用 |
| 模型服务异常 | MODEL_ERROR | 模型健康检查失败 + service unavailable |
| 计费失败 | BILLING_ERROR | 积分扣费失败/余额不足 |
| 数据失败 | DATA_ERROR | 测试数据缺失/data not found |
| 环境失败 | ENVIRONMENT_ERROR | 环境未就绪/未启动 |

每条输出结构符合任务书要求：`category / confidence / evidence / excludedCauses / recommendedAction / facts / inferences`。

## 3. 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | PASS |
| 真实失败 RCA（16 条） | PASS（14 种分类全部命中，证据链完整，确定性回退 source=rules） |
| `npm test` 回归 | 39 文件 / 632 用例 PASS（原 616 → +16） |
| LLM 合法分类 | 新分类 `RATE_LIMIT_ERROR` 通过 schema 校验且保留证据链事实 |

## 4. 约束符合性

- 无证据结论被强制禁止：所有 RCA 断言 `facts.length > 0` 且 `evidence.length > 0`
- 未重写 Core / Pipeline / Assertion，仅在分类器与 schema 上扩展
- 向后兼容：新增枚举成员，既有分类语义不变（400/404 仍归测试代码，5xx 仍归模型）
- 全部合成失败场景 offline 常驻验证，无真实副作用
