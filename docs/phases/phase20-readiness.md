# Phase 20 Readiness 分析报告

> 依据任务书第二十四节，实施前先扫描项目现状，输出 readiness 清单后从 Phase 20.1 开始。

## 1. 已完成（无需新增）

| 能力 | 现状 |
| --- | --- |
| LLM Provider 抽象 | `src/llm/types.ts` 已定义 `LLMProvider` 统一接口（`name` + `generate(request)`），`MockLLMProvider` / `OpenAICompatibleProvider` 已实现 |
| Provider 归一化 | `provider.ts` 已支持 mock / openai-compatible / deepseek / glm / doubao / anthropic-compatible |
| Model Router | `model-router.ts` 已实现 `TaskKind` 11 类 + `ModelTier`（high/medium/small）+ `DEFAULT_ROUTES` 分级路由 + 单例 |
| Agent Pipeline | `agent-pipeline.ts` 12 阶段闭环（核心 7 + 增强 6），含 AgentTracer/AgentBudget 横切 |
| Tool Registry | `tool-registry.ts` 已含权限（read/safe/risky/dangerous）、脱敏审计、生产环境拦截 |
| Memory | `json-memory.ts` + `memory-bridge.ts`，含相似失败/历史风险/已知问题检索 |
| CLI | `run-agent.ts` 已支持需求文本 + Phase 10-18 全部增强开关 |
| 报告 | `reports/` 已含 html / json / junit 三种 Reporter |
| CI/CD | `.github/workflows/test.yml` 传统回归 CI（push/PR） |
| E2E（Mock） | `tests/e2e/agent-e2e.test.ts` WAN3 15 步闭环（MockLLM + mock 引擎） |
| Eval（Offline） | `tests/evals/` Benchmark（failures/healing/requirements）+ `agent:eval` Overall 97 |

## 2. 缺失（Phase 20 需新增）

| 缺失项 | 归属子阶段 |
| --- | --- |
| LLM fallback/retry 链（Primary→Timeout/429/5xx→Fallback→Deterministic） | 20.1 |
| `LLM_FALLBACK_MODEL` / `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` 环境变量 | 20.1 |
| ModelRouter 档位环境变量可配置（`LLM_HIGH_MODEL` 等） | 20.1 |
| CLI LLM 参数（`--llm-provider/--model/--fallback-model/--llm-timeout/--max-tokens`） | 20.1 |
| 真实 API E2E（`tests/e2e/real/` + `RUN_REAL_E2E=false` 默认关闭） | 20.2 |
| 真实失败 RCA 验证（14 种失败：HTTP 400/401/403/404/429/500/502/503/Timeout/Dependency/Model/Billing/Data/Environment） | 20.3 |
| IssueTracker 抽象 + Jira/飞书/GitLab/GitHub Adapter（第一阶段仅 Draft） | 20.4 |
| Self-Healing 真实变更场景（3 个场景：path/字段/错误码） | 20.5 |
| QA Workflow 4 模式（`--plan-only` / `--analyze --rca` / `--resume task-id`） | 20.6 |
| `.github/workflows/agent-test.yml`（P0/P1 阻断规则 + 六态结果） | 20.7 |
| `scripts/preflight/` + `agent:preflight` | 20.8 |
| `agent:health`（Agent Health Check） | 20.8 |
| `tests/evals/real/`（Real LLM Eval + Real API Eval） | 20.8 |
| Agent KPI 记录 | 20.8 |
| `output/<date>/agent-summary.json`（QA Dashboard 数据） | 20.8 |
| environment policy（test/preonline/production 风险策略） | 20.8 |
| 人工 vs Agent 对照实验（10 普通 + 10 复杂 + 10 AI 需求） | 20.8 |

## 3. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 真实 LLM 无法离线验证 | CI/单测环境无 Key，真实调用仅能靠环境开关 | Mock 与 Real 双模式，`LLM_*` 未配置时默认 Mock |
| 真实 API 误触发 | 误触发真实业务会消耗积分/影响线上 | `RUN_REAL_E2E=false` 默认关闭，显式开启才执行 |
| 真实失败证据不足 | 无证据 RCA 结论危害大 | 强制 事实/证据/推断/置信度/排除项 结构输出 |
| 生产环境危险操作 | 自动创建缺陷/自愈/改数据 | 已有 ToolPermission + 审批，新增 environment policy |
| fallback 掩盖真实错误 | 盲目回退掩盖配置错误 | 仅 Timeout/429/5xx/网络 触发回退，其余错误直接暴露 |
| CI 消耗 LLM/GPU/积分 | 每次 PR 全量跑成本高 | CI 仅 P0/P1，P2/P3 nightly |

## 4. 需要新增文件

```
src/llm/llm-errors.ts            # LLM 错误分类 + 可重试判定
src/llm/fallback-provider.ts     # FallbackLLMProvider（主→备→确定性）
src/config/llm.ts                # LLM 运行时配置加载（env + CLI 合并 + 路由联动）
tests/e2e/real/                  # 真实 API E2E（20.2，默认关闭）
tests/evals/real/                # 真实 LLM/API Eval（20.8）
src/agents/issues/               # IssueTracker 接口 + Adapter（20.4）
scripts/preflight/               # 预检脚本（20.8）
.github/workflows/agent-test.yml # Agent CI（20.7）
docs/phases/phase20-<n>-report.md       # 各阶段变更报告
```

## 5. 需要修改文件

```
src/llm/provider.ts        # LLMConfig 扩展 + createLLMProvider 支持 fallback 包装
src/llm/model-router.ts    # 档位环境变量加载
src/llm/index.ts           # 导出新模块
bin/run-agent.ts           # LLM 参数 + QA 4 模式
src/agents/orchestration/agent-pipeline.ts  # QA Dashboard JSON / KPI（20.8）
package.json               # agent:health / agent:preflight / agent:eval:real 等脚本
tests/unit/llm-provider.test.ts   # fallback 链用例
tests/unit/model-router.test.ts   # 环境变量档位用例
```

## 6. 需要新增环境变量

```
LLM_PROVIDER              LLM_BASE_URL              LLM_API_KEY
LLM_MODEL                 LLM_FALLBACK_MODEL        LLM_TIMEOUT
LLM_MAX_TOKENS            LLM_TEMPERATURE           LLM_HIGH_MODEL
LLM_MEDIUM_MODEL          LLM_SMALL_MODEL           RUN_REAL_E2E
```

## 7. 需要新增测试

| 测试 | 阶段 |
| --- | --- |
| fallback 链（timeout/429/5xx→fallback→deterministic；非重试错误不回退） | 20.1 |
| LLM 环境变量加载（fallback/maxTokens/temperature） | 20.1 |
| ModelRouter 档位环境变量覆盖 | 20.1 |
| 真实 API E2E 开关（RUN_REAL_E2E=false 不触发） | 20.2 |
| 真实失败 RCA 结构验证（证据/置信度/排除项） | 20.3 |
| IssueTracker Draft 阶段（Approval 前禁止 createIssue） | 20.4 |
| Self-Healing 3 场景 Patch→重执行→恢复 | 20.5 |
| QA Workflow 4 模式 CLI | 20.6 |
| CI 六态结果判定 | 20.7 |
| Preflight / Health 检查 | 20.8 |

## 8. 结论

Phase 20 基线良好：LLM 抽象、Model Router、Pipeline、Tool 安全边界、Memory、CLI、Mock E2E 均已具备。
缺口集中在「真实环境接入与控制」：fallback 链、真实 E2E/Eval 开关、IssueTracker、Preflight/Health、Agent CI 与生产安全策略。
按任务书顺序从 **Phase 20.1 Real LLM（fallback + 路由 + CLI）** 开始。
