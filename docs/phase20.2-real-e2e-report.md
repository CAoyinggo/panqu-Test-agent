# Phase 20.2 变更报告：真实 API E2E（Real API E2E）

> 目标：不再只用 Mock Runner，接入真实测试环境验证「真实提交 / 任务查询 / 任务状态 / 模型 / 计费积分 / 错误码 / 超时 / 并发 / 历史数据」，
> 并跑通 Agent 全链路（需求→设计→风险→选择→覆盖→数据→真实 API→断言→分析→RCA→缺陷→记忆）。
> 安全约束：所有真实 E2E 默认关闭（RUN_REAL_E2E=false），真实「提交」再需 REAL_E2E_SUBMIT=true。

## 1. 变更内容

### 新增文件
| 文件 | 说明 |
| --- | --- |
| `tests/e2e/real/real-env.ts` | 真实环境辅助：`RUN_REAL_E2E` / `REAL_E2E_SUBMIT` / `REAL_E2E_ENV` 开关；配置加载；会话（cookie）加载；Http/Billing 构建；`describeReal`/`itReal`/`itRealSubmit` 门控 |
| `tests/e2e/real/real-api-e2e.test.ts` | 真实 API 层测试（9 条）：配置连通性 / 错误码（404、非法参数）/ 超时（短超时中止）/ 并发（并行只读）/ 计费积分（只读）/ 历史数据 / 模型 TOP / 真实提交+状态+详情+计费闭环（submit 门控） |
| `tests/e2e/real/real-agent-e2e.test.ts` | Agent 全链路真实执行（1 条）：需求→设计→风险→选择→覆盖→数据→真实 API 冒烟执行→断言→分析→RCA→缺陷→记忆；真实提交受上限约束（`REAL_E2E_MAX_CASES`，默认 2） |

### 修改文件
| 文件 | 变更 |
| --- | --- |
| `package.json` | 新增 `agent:e2e:real`（`vitest run tests/e2e/real`，默认跳过） |

## 2. 环境变量

```
RUN_REAL_E2E          true 启用真实 E2E（默认 false，未启用全部跳过）
REAL_E2E_SUBMIT       true 允许真实提交（进一步门槛，避免真实业务副作用）
REAL_E2E_ENV          test / preonline（默认 test）
REAL_E2E_MAX_CASES    Agent 链路真实提交上限（默认 2）
TESTFLOW_SESSION_COOKIES_PATH  会话文件路径（未配置时启用真实 E2E 会明确报错）
```

## 3. 安全与门控

- `RUN_REAL_E2E=false`（默认）：全部 10 条真实测试 skip，不触发任何真实业务
- `RUN_REAL_E2E=true`：只读校验执行（连通性/错误码/超时/并发/计费/历史/模型）
- `REAL_E2E_SUBMIT=true`：才执行真实提交（提交+状态+详情+计费闭环 / Agent 全链路）
- 缺失会话文件时明确抛错，绝不静默通过
- 未复用 Mock Runner 扩展，直接复用现有 `Http` / `Billing` 真实基础设施（未重写）

## 4. 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | PASS |
| `agent:e2e:real`（默认，无开关） | 10 skipped（未触发真实业务） |
| `RUN_REAL_E2E=true`（只读） | 8 passed / 2 skipped（真实环境连通性、错误码、超时、并发、计费、历史、模型全部通过） |
| `npm test` 回归 | 38 文件 / 616 用例 PASS（原 611 → +5，真实用例默认 skip 不计入失败） |
| `npm run agent:e2e`（Mock 闭环） | 2 用例 PASS（未删除） |
| 真实提交门控 | `REAL_E2E_SUBMIT` 未设时正确跳过，杜绝误触发 |

## 5. 约束符合性

- 未删除现有 Mock E2E（`tests/e2e/agent-e2e.test.ts` 保留）
- 真实环境可关闭：默认 `RUN_REAL_E2E=false` 不误触发真实业务
- 复用现有 `Http` / `Billing` / `FormData` 提交流程，未重写核心
- 真实提交受上限与双重开关约束，可审计、可复现
