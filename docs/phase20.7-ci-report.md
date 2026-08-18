# Phase 20.7 变更报告：CI/CD 集成（六态门禁 + 分级执行）

> 阶段目标：把 AI 测试 Agent 接入 CI/CD，建立「P0/P1 快速门禁 + P2/P3 全量 Nightly」
> 的分级执行策略，产出六态结果（PASS/FAIL/WARNING/BLOCKED/KNOWN_ISSUE/FLAKY）与 P0 阻断规则。

## 一、本阶段变更

### 1. 新增 CI 六态结果模块（`src/qa/ci-result.ts`）

| 能力 | 说明 |
|---|---|
| `CiVerdict` | 六态结论：PASS / FAIL / WARNING / BLOCKED / KNOWN_ISSUE / FLAKY |
| `isEnvironmentError(r)` | 环境类错误识别：5xx / 429 / timeout / ECONNREFUSED / ENOTFOUND / ECONNRESET / EAI_AGAIN / network |
| `computeCiResult(outcome, options)` | 优先级感知判定：按 P0 / P1 / P2/P3 分类真实失败，并归一化环境错误 / 已知问题 / Flaky |
| `CiResultOptions` | `priorities` / `knownIssues` / `flakyCaseIds` / `blockOnP0` / `failOnP1` / `classifyEnvironment` / `ignoreFlaky` |

**六态判定规则**：

- P0 Fail（非已知 / 非环境 / 非 Flaky）→ **BLOCKED**（阻断发布，退出码 1）
- P1 Fail → **FAIL**（退出码 1）
- P2/P3 或未知优先级 Fail → **WARNING**（不阻断，nightly 关注，退出码 0）
- 仅环境错误（5xx / 429 / 超时 / 网络）→ **WARNING**
- 仅已知问题（open）→ **KNOWN_ISSUE**
- 仅 Flaky 标记 → **FLAKY**
- 全部通过 → **PASS**

优先级来源：优先取调用方提供的 `priorities` 映射（测试计划 / 选择器），其次回退读取用例结果自带的 `priority` 字段，保证 `--ci-status` / `--ci` 无需额外参数即可正确判定。

### 2. CLI 新增 CI 参数（`bin/run-agent.ts`）

| 参数 | 行为 |
|---|---|
| `--ci-status=<result.json>` | 独立 CI 模式：读取执行结果文件 → 归一化 → 计算六态 → 输出 JSON；BLOCKED / FAIL 退出码 1，其余 0 |
| `--ci` | 模式 A 附加：执行完成后计算六态结论，输出 CI 专属摘要与退出码（BLOCKED / FAIL → 1） |

`--ci-status` 已在顶层模式判断中加入（原先会落入 usage 分支），单独使用不再报用法错误。

### 3. 新增 CI 门禁脚本（`scripts/ci/agent-ci-gate.mjs`）

用确定性夹具分别验证 BLOCKED（P0 失败）、PASS（全过）、WARNING（环境错误）三态的
`--ci-status` 退出码与六态输出，并写入 GitHub Actions Summary（`$GITHUB_STEP_SUMMARY`）。
任一夹具不符即退出码 1，保证 CI 门禁在 PR 阶段即可拦截六态判定回归。

### 4. 新增 GitHub Actions 工作流（`.github/workflows/agent-test.yml`）

| Job | 触发 | 内容 |
|---|---|---|
| `p0-p1-gate` | PR / push main | Build + `agent:test`（单元）+ `agent:e2e`（Mock E2E）+ `agent:e2e:healing`（自愈闭环）+ `agent-ci-gate.mjs`（六态门禁） |
| `p2-p3-nightly` | 每日 UTC 18:00 / workflow_dispatch | 全量 `npm test` + 真实环境 E2E（`RUN_REAL_E2E=true`，注入 Secrets）+ `agent:eval`（Benchmark） |

P0/P1 门禁只跑快速离线验证（单元 + Mock E2E，无需真实环境）；P2/P3 Nightly 跑全量回归与真实 LLM / API 验证。
真实环境开关保持默认关闭（`RUN_REAL_E2E=false`），符合任务书「真实环境可关闭」约束。

## 二、测试结果

### 新增单元测试 `tests/unit/ci-result.test.ts`（21 条）

- `isEnvironmentError`：5xx / 429 / 超时 / 网络错误识别，不误判普通断言失败
- `computeCiResult` 六态：P0→BLOCKED、P1→FAIL、P2/P3→WARNING、未知优先级→WARNING、环境错误→WARNING、已知问题→KNOWN_ISSUE、Flaky→FLAKY、混合→WARNING、全过→PASS、空集→PASS
- 选项覆盖：`blockOnP0=false`、`classifyEnvironment=false`、`ignoreFlaky=false`、summary 格式
- 结果自带 `priority` 字段（无映射）时 P0 失败仍 BLOCKED；映射优先级优先于自带字段

### CLI 冒烟（真实命令）

- `--ci-status=<result.json>` → `[WARNING]`（P2 失败 1 条，正确判定不阻断）退出码 0
- `--ci --json`（模式 A）→ 输出 CI 六态 JSON，退出码 0
- `--ci`（模式 A，无 JSON）→ 报告末尾输出 `【CI 状态】...` 摘要行
- 门禁脚本 `agent-ci-gate.mjs` → BLOCKED / PASS / WARNING 三态全部按预期（退出码 1 / 0 / 0）

### 全量回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm test` | 44 文件 / 692 用例 PASS + 10 skipped |
| `npm run agent:test` | 32 文件 / 437 用例 PASS（含新增 ci-result 21 条） |
| `npm run agent:e2e:healing` | 4 用例 PASS |

## 三、与 Phase 20 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 新增 `.github/workflows/agent-test.yml` | ✅ |
| PR 触发只执行 P0/P1 | ✅（`p0-p1-gate` job：单元 + Mock E2E + 自愈 + 六态门禁） |
| P2/P3 Nightly | ✅（`p2-p3-nightly` job：每日 UTC 18:00 全量 + 真实 E2E） |
| 六态结果（PASS/FAIL/WARNING/BLOCKED/KNOWN_ISSUE/FLAKY） | ✅（`computeCiResult` + 单测 + 门禁脚本） |
| P0 阻断规则 | ✅（P0 Fail → BLOCKED，退出码 1，`blockOnP0` 可关） |
| 真实环境可关闭（`RUN_REAL_E2E=false` 默认） | ✅（P0/P1 门禁完全离线；P2/P3 Nightly 显式开启） |

## 四、约束符合性与风险

- 未重构 Core / Pipeline / Assertion；未删除 Mock Benchmark 与现有 E2E
- P0/P1 门禁不依赖任何真实环境凭证（离线确定性），P2/P3 Nightly 通过 Secrets 注入真实凭证
- 门禁脚本使用确定性夹具，不发送任何真实请求、不修改生产代码
- 风险：GitHub Actions 的 `schedule` 触发仅对 main 分支生效；若需在 fork PR 上运行 P2/P3，需改用 `workflow_dispatch` 手动触发
- 风险：真实 LLM / API 相关 Secrets 未配置时，P2/P3 Nightly 的真实 E2E 步骤将跳过（`RUN_REAL_E2E` 下测试自身降级为 skip），不阻塞构建

## 五、下一步

进入 **Phase 20.8 Production Readiness**：`scripts/preflight/` + `npm run agent:preflight`、`npm run agent:health`、
`tests/evals/real/`（Offline / Real LLM / Real API 三档）、Agent KPI、QA Dashboard JSON
（`output/<date>/agent-summary.json`）、人工 vs Agent 对照实验、生产环境安全策略
（environment policy：test / preonline / production）。
