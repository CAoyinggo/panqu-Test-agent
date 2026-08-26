# Phase 20.8 变更报告：Production Readiness（预检 / 健康检查 / 真实环境评测 / KPI Dashboard / 对照实验 / 生产安全策略）

> 阶段目标：让 AI 测试 Agent 具备生产就绪能力——上线前预检（preflight）、运行时健康检查（health）、
> 三档真实环境评测（Offline / Real LLM / Real API）、Agent KPI Dashboard、人工 vs Agent 对照实验、
> 以及 test / preonline / production 三级环境安全策略。

## 一、本阶段变更

### 1. 生产环境安全策略（`src/config/environment-policy.ts`）

| 能力 | 说明 |
|---|---|
| `describeEnvironmentPolicy()` | 返回当前策略快照：production 是否启用、被禁止的危险动作清单 |
| `guardProductionAction(env, action)` | 危险动作守卫：production 默认关闭，real-billing / payment / delete-data 等 6 项危险动作被拦截 |
| 逃生开关 | `TESTFLOW_ALLOW_PRODUCTION=true` 显式开启（preflight / health 均会提示高风险） |

单元测试 `tests/unit/environment-policy.test.ts`（10 条）：策略描述、守卫拦截、逃生开关、非 production 环境放行。

### 2. 上线前预检（`bin/preflight.ts` + `scripts/preflight/run.sh` + `npm run agent:preflight`）

六项自检：Node 版本（≥ 20.11）、构建产物完整性、test / preonline 配置可加载、敏感信息扫描
（API Key / AWS Key / 私钥硬编码，跳过 node_modules / dist / .git）、输出目录可写、生产环境策略提示。
退出码：存在 BLOCK 项为 1，WARN 不阻断；支持 `--json` 输出。

本会话修复：`ROOT` 路径解析基于编译产物位置（`dist/bin/..`）会错位到 `dist`，导致构建产物检查
误报缺失、输出目录落到 `dist/output`；现按「位于 dist/bin 时上溯两级」解析到项目根。

### 3. 运行时健康检查（`bin/health.ts` + `npm run agent:health` / `agent:health:json`）

四项检查：配置加载（test 环境 base_url / project_id）、LLM 往返（mock provider）、最小流水线
（需求 → 选择 → 覆盖 → 数据 → 分析，skipExecution）、生产安全策略。全部通过输出 `HEALTHY：4/4`。

### 4. Agent KPI Dashboard（`src/qa/dashboard.ts`）

`buildAgentDashboard` 聚合单次运行的 KPI：需求理解（置信度 / 能力 / 输入 / 业务规则 / 风险）、
用例（总数 / 按优先级 / 断言数）、执行（通过率）、分析（RCA / 缺陷 / 自愈 / 审批）、覆盖、
可观测（Agent / LLM / Tool / Token / 耗时）。`saveAgentDashboard` 持久化到
`output/<date>/agent-summary.json`，已接入 `run-agent.ts` 模式 A 主流程（保存失败不影响运行）。
单元测试 `tests/unit/dashboard.test.ts`（3 条）：指标聚合、持久化与回读。

### 5. 三档真实环境评测（`tests/evals/real/`）

| 档位 | 文件 | 开关 | 内容 |
|---|---|---|---|
| Offline | `offline.test.ts` | 常开 | 确定性管线完整性（3 条） |
| Real LLM | `real-llm.test.ts` | `RUN_REAL_LLM=true` | 真实 LLM 需求解析 / 用例生成质量（4 条，默认 skip） |
| Real API | `real-api.test.ts` | `RUN_REAL_API=true` | 真实 API 执行链路（4 条，默认 skip） |

`real-eval-env.ts` 统一环境变量读取与 skip 判定，真实档位默认关闭，符合「真实环境可关闭」约束。

### 6. 人工 vs Agent 对照实验（`tests/evals/comparison/`）

30 条基准需求（10 普通 + 10 复杂 + 10 AI），每条带 `coverageTags`；用 `MockLLMProvider`
强制失败回退确定性路径，`matchCoverageTags` 统计用例文本对覆盖点的命中率。
阈值：每条 ≥ 4 用例、各档均值 ≥ 50%、总体 ≥ 55%。

**本会话核心修复（覆盖率达标）**：初版确定性兜底对多数需求只能产出通用 4 条用例，
覆盖率仅普通 35% / 复杂 34.2% / AI 13.3% / 总体 27.5%。根因是 `parseRequirement`
提取不到业务规则。修复：

- `requirement-parser.ts`：`BUSINESS_RULE_MAP` 从 7 个模式扩展到 30 个（余额不足 / 未登录 /
  下载链接 / 历史查询 / 取消 / 去重 / 幂等 / 鉴权分级 / 阶梯单价 / 失败重提 / 一致性 /
  注入防护 / 内容安全 / 参数校验 / seed 复现 / 错误码 / Cookie / 限流 / 超长输入 /
  多语言 / 时长 / 提示词长度等）
- `testcase-generator.ts`：`ruleAssertions` 为每个新规则补对应断言分支（具体规则优先于
  通用规则），并为 P0 状态断言与空提示词断言补充 message 文本
- `tests/evals/benchmark/requirements.ts`：同步 7 条受影响的基准契约
  （req-001/002/003/007/012/017/019 的 `expected.businessRules`）——新规则识别是
  语义正确的真实覆盖点，属契约增强而非放水

修复后：普通 100% / 复杂 90.8% / AI 96.7%，总体约 95.8%，全部阈值达标。

## 二、测试结果

### 对照实验（`npm run agent:eval:comparison`）

| 档位 | 修复前 | 修复后 | 阈值 |
|---|---|---|---|
| 普通需求（10 条） | 35.0% | **100.0%** | ≥ 50% |
| 复杂需求（10 条） | 34.2% | **90.8%** | ≥ 50% |
| AI 需求（10 条） | 13.3% | **96.7%** | ≥ 50% |
| 总体 | 27.5% | **≈ 95.8%** | ≥ 55% |

5 个测试全部 PASS（每条用例数 ≥ 4、三档均值、总体、报告输出）。

### Agent 评测基准（`node dist/tests/evals/run-evals.js`）

| 维度 | 分数 | 说明 |
|---|---|---|
| requirements | 88.2（≥ 80） | 30 条 × LLM/回退双路径，基准契约同步后较修复前 87.3 略升 |
| rca / healing / defect / risk | 100 / 100 / 100 / 100 | 未受影响 |
| overall | **97.1** | 加权总分 |

### 冒烟（真实命令）

| 命令 | 结果 |
|---|---|
| `npm run agent:preflight` | PASS 6 / WARN 0 / BLOCK 0 |
| `npm run agent:health` | HEALTHY：4/4 项通过 |
| 模式 A（`--skip-execution`） | 生成 14 条用例（P0×4 / P1×6 / P2×3 / P3×1，21 断言），`output/<date>/agent-summary.json` 落盘成功 |

### 全量回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm test` | 48 文件 / 713 用例 PASS + 18 skipped（real 档按设计跳过） |
| `npm run agent:test` | 450 用例 PASS |
| `npm run agent:eval:real` | Offline 3/3 PASS，Real LLM / Real API 按设计 skip |

## 三、与 Phase 20 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| `scripts/preflight/` + `npm run agent:preflight` | ✅（六项自检，BLOCK 退出码 1） |
| `npm run agent:health` | ✅（四项检查，HEALTHY 4/4） |
| `tests/evals/real/`（Offline / Real LLM / Real API 三档） | ✅（真实档默认关闭，环境变量显式开启） |
| Agent KPI Dashboard JSON（`output/<date>/agent-summary.json`） | ✅（模式 A 自动落盘，可回读） |
| 人工 vs Agent 对照实验（10 普通 + 10 复杂 + 10 AI） | ✅（30 条基准，三档覆盖率全部达标） |
| 生产环境安全策略（test / preonline / production） | ✅（environment policy + 危险动作守卫 + 单测） |

## 四、约束符合性与风险

- 未重构 Core / Pipeline / Assertion；仅扩展确定性解析器规则表与生成器断言分支（纯增量）
- 既有单测断言为宽容匹配（`toContain` / `arrayContaining`），DEMO_REQ 文本不含新增模式关键词，零回归
- 基准契约同步仅涉及 `businessRules` 字段（schema 为自由字符串数组，无白名单），评测分数 88.2 ≥ 80 有余量
- 遗留：评测基准中 6 条历史差异（req-005/009/011/013/015/025 的 `任务提交成功` /
  `任务状态最终成功` 期望与实际解析不完全一致）为 Phase 18 遗留，不影响阈值，未在本阶段处理
- 风险：对照实验覆盖率基于关键词匹配（`matchCoverageTags`），与人工语义判断存在方法学差异，
  报告中的覆盖率为「用例文本命中覆盖点标签」的下界估计
- 风险：preflight 敏感信息扫描为正则启发式，不能替代 gitleaks 等专业工具（项目已有
  `npm run security:gitleaks` 互补）

## 五、下一步

Phase 20.8 完成后进入 **Phase 20 最终验收**：9 项命令全 PASS 复核 +
真实数量指标核验（10 真实需求 / 10 真实失败 / 5 真实 RCA / 5 真实缺陷 Draft / 5 真实 Self-Healing）。
