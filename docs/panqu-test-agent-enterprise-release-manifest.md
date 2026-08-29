# panqu-Test-agent 企业一期发布清单（Release Manifest）

本文档把「企业一期试点」相关文件按 Git 提交范围分类，明确哪些文件必须进入提交、哪些已受跟踪、哪些是无关脏变更。

> 状态基于 `git status --short`（生成时刻）。未执行任何 `git add` / `git commit` / `git push`。

---

## 一、依赖追踪（入口 → import / build 依赖）

追踪以下入口的运行时 / 编译依赖（仅相对仓库内的本地依赖，`node:*` 内置模块不列）：

```
.trae/mcp.json
  └─ command "node" → 参数 ${workspaceFolder}/mcp-bridge/trae-test-mcp-stdio.js
                       （启动后 spawn dist/bin/run-plan.js，shell=false）

mcp-bridge/trae-test-mcp-stdio.js
  └─ require('./execute-test-plan-schema.js')

mcp-bridge/execute-test-plan-schema.js
  └─ （无本地依赖，纯 CommonJS 零依赖）

mcp-bridge/package.json
  └─ {"type": "commonjs"}（父包为 ESM，需显式声明）

bin/run-plan.ts
  ├─ ../src/agents/plan/plan-contract.ts
  └─ ../src/agents/orchestration/plan-run-service.ts

src/agents/orchestration/plan-run-service.ts
  ├─ ../../utils/atomic-fs.ts
  ├─ ../../utils/run-id.ts
  ├─ ../plan/plan-contract.ts
  ├─ ../plan/plan-policy-gate.ts
  └─ ./plan-executor.ts

src/agents/orchestration/plan-executor.ts
  ├─ ../../core/path-extractor.ts
  ├─ ../../core/assertion-operators.ts
  └─ ../plan/plan-contract.ts

src/agents/plan/plan-contract.ts
  └─ （仅 node:crypto、node:net）

src/agents/plan/plan-policy-gate.ts
  └─ ./plan-contract.ts

（二级工具依赖）
src/utils/atomic-fs.ts        └─ ./fs-utils.ts
src/utils/fs-utils.ts         └─ ./logger.ts
src/core/assertion-operators.ts └─ ./path-extractor.ts、./errors.ts
src/utils/run-id.ts           └─ （仅 node:crypto）

（build 依赖）
package.json（"build": tsc + copy-assets）、tsconfig.json、scripts/copy-assets.mjs
  └─ 产出 dist/bin/run-plan.js（stdio MCP 的实际执行入口）
```

---

## 二、REQUIRED_ALREADY_TRACKED

已被 Git 跟踪、且当前干净（未出现在 `git status` 的 M/?? 中）的文件。它们无需 `git add`，但构成本次发布的既有基础。

**构建基础设施：**
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- `scripts/copy-assets.mjs`

**运行时刻工具依赖（被 plan-* 源文件 import）：**
- `src/utils/atomic-fs.ts`
- `src/utils/fs-utils.ts`
- `src/utils/logger.ts`
- `src/utils/run-id.ts`
- `src/core/path-extractor.ts`
- `src/core/assertion-operators.ts`
- `src/core/errors.ts`
- `src/core/execution-context.ts`
- `src/core/redact.ts`
- `src/utils/metrics.ts`

**工具依赖链（补充说明）：**

```
atomic-fs
  → fs-utils
    → logger
      → execution-context / redact
        → metrics（类型依赖）
```

**既有的验证测试（属于 14 文件测试集，但已跟踪）：**
- `tests/unit/policy-gate.test.ts`
- `tests/unit/execution-plan-enforcement.test.ts`
- `tests/unit/run-id.test.ts`
- `tests/unit/path-extractor.test.ts`
- `tests/unit/assertion-operators.test.ts`

---

## 三、REQUIRED_NEW_OR_MODIFIED

必须进入本次提交的未跟踪（`??`）文件及其原因。共 **21 项**。

### 入口与配置
1. `.trae/mcp.json` — 项目级 MCP 入口，调用 `mcp-bridge/trae-test-mcp-stdio.js`。
2. `mcp-bridge/trae-test-mcp-stdio.js` — 唯一 stdio MCP 服务（canonical）。
3. `mcp-bridge/execute-test-plan-schema.js` — execute_test_plan 共享 Schema（被 stdio 引用）。
4. `mcp-bridge/PANQU_TRAE_AGENT_PROMPT.md` — 智能体人设提示词。
5. `mcp-bridge/package.json` — 声明 `{"type":"commonjs"}`，保证 CommonJS 脚本在 ESM 仓库内可运行。

### 确定性执行实现
6. `bin/run-plan.ts` — run-plan CLI 入口源文件。
7. `src/agents/orchestration/plan-run-service.ts` — plan/execute/status 编排。
8. `src/agents/orchestration/plan-executor.ts` — 确定性 HTTP 执行器。
9. `src/agents/plan/plan-contract.ts` — 计划归一化 / 用例分类 / 方法白名单。
10. `src/agents/plan/plan-policy-gate.ts` — 执行前 Policy Gate。

### 文档
11. `docs/panqu-test-agent-enterprise-pilot.md` — 企业一期试点文档。
12. `docs/panqu-test-agent-enterprise-release-manifest.md` — 本发布清单。

### 测试（本次新增 / 修改）
13. `tests/integration/stdio-mcp.test.ts` — stdio MCP 集成测试（指向仓库内资产）。
14. `tests/integration/stdio-mcp-portable.test.ts` — 可移植性测试（本轮补充两项）。
15. `tests/integration/run-plan-cli.test.ts` — run-plan CLI 集成测试。
16. `tests/unit/plan-contract.test.ts`
17. `tests/unit/plan-determinism.test.ts`
18. `tests/unit/plan-executor-transport.test.ts`
19. `tests/unit/plan-executor.test.ts`
20. `tests/unit/plan-policy-gate.test.ts`
21. `tests/unit/plan-run-service.test.ts`

---

## 四、UNRELATED_DIRTY_CHANGES

以下文件在 `git status` 中显示为已修改（` M`）或未跟踪（`??`），但**与本企业试点发布无关，不得进入本次提交**：

### 已修改（` M`，与本发布无关）
- `README.md`
- `bin/run-devtest.ts`
- `docs/01-测试流程SOP.md`
- `docs/02-模板合集.md`（已删除）
- `docs/02-测试用例模板.md`
- `docs/03-数据需求清单模板.md`
- `docs/04-新任务启动检查清单模板.md`
- `docs/05-项目说明模板.md`
- `docs/README.md`
- `docs/devtest.md`
- `docs/prompts/dev-selftest-agent.prompt.md`
- `docs/testing/developer-handoff-release-checklist.md`
- `docs/testing/testcase-v2-schema.md`
- `src/acceptance/acceptance-execution-plan.ts`
- `src/acceptance/acceptance-pipeline.ts`
- `src/acceptance/acceptance-report.ts`
- `src/acceptance/api-operation-binding.ts`
- `src/acceptance/canonical-requirement.ts`
- `src/acceptance/index.ts`
- `src/acceptance/requirement-fact-ledger.ts`
- `src/acceptance/requirement-ir.ts`
- `src/acceptance/requirement-parser.ts`
- `src/acceptance/scenario-runner.ts`
- `src/acceptance/test-case-generator.ts`
- `src/acceptance/test-case-quality-gate.ts`
- `src/acceptance/test-objective.ts`
- `src/acceptance/test-point.ts`
- `src/acceptance/test-strategy-engine.ts`
- `src/agents/data/data-analyzer.ts`
- `src/agents/execution/execution-agent.ts`
- `src/agents/execution/execution-run-tool.ts`
- `src/agents/index.ts`
- `src/agents/orchestration/agent-pipeline.ts`
- `src/agents/prompts/builtin.ts`
- `src/agents/requirement/requirement-schema.ts`
- `src/agents/test-design/business.ts`
- `src/agents/test-design/test-design-agent.ts`
- `src/agents/test-design/testcase-generator.ts`
- `src/agents/test-design/testcase-schema.ts`
- `src/devtest/artifacts.ts`
- `src/devtest/devtest-runner.ts`
- `src/devtest/dimension-selector.ts`
- `src/devtest/oracle-engine.ts`
- `src/devtest/source-sync.ts`
- `src/devtest/types.ts`
- `src/platform/ops/real-run.ts`
- `tests/acceptance/acceptance-e2e.test.ts`
- `tests/acceptance/api-binding-integration.test.ts`
- `tests/acceptance/canonical-strategy.test.ts`
- `tests/acceptance/developer-handoff-e2e.test.ts`
- `tests/acceptance/pilot-adversarial.test.ts`
- `tests/acceptance/report.test.ts`
- `tests/acceptance/scenario-executability-gate.test.ts`
- `tests/acceptance/scenario-markdown-parser.test.ts`
- `tests/acceptance/scenario-parser-loader-strictness.test.ts`
- `tests/acceptance/scenario-quality.test.ts`
- `tests/acceptance/templates/scenario.md`
- `tests/acceptance/test-design-foundation.test.ts`
- `tests/acceptance/test-point-dsl.test.ts`
- `tests/e2e/agent-e2e.test.ts`
- `tests/e2e/cost-dashboard.test.ts`
- `tests/evals/comparison/human-vs-agent.test.ts`
- `tests/evals/real/offline.test.ts`
- `tests/integration/api-run.test.ts`
- `tests/integration/devtest-mode.test.ts`
- `tests/integration/platform-execution-safety-contract.test.ts`
- `tests/unit/agent-pipeline.test.ts`
- `tests/unit/contracts/phase1-samples.test.ts`
- `tests/unit/data-session.test.ts`
- `tests/unit/devtest/source-sync.test.ts`
- `tests/unit/prompt-registry.test.ts`
- `tests/unit/test-design-agent.test.ts`
- `tests/unit/testcase-generator-business.test.ts`

### 未跟踪（`??`，与本发布无关）
- `docs/prompts/devtest-implementation-agent.prompt.md`
- `docs/testing/devtest-p0-business-runtime.md`
- `docs/testing/standardization-governance.md`
- `docs/testing/test-design-intelligence.md`
- `src/acceptance/business-model.ts`
- `src/acceptance/standardization-gate.ts`
- `src/acceptance/test-case-scenario-adapter.ts`
- `src/acceptance/test-design-intelligence.ts`
- `src/agents/test-design/canonical-generator.ts`
- `tests/acceptance/helpers/scenario-template.ts`
- `tests/acceptance/p0-business-model.test.ts`
- `tests/acceptance/p0-v2-scenario-adapter.test.ts`
- `tests/acceptance/standardization-governance.test.ts`
- `tests/acceptance/standardization-reusability.test.ts`
- `tests/acceptance/test-design-intelligence.test.ts`
- `tests/e2e/p0-reference-scenarios.test.ts`
- `tests/helpers/scenario-runtime.ts`

---

## 五、候选 `git add` 命令（逐步明确路径，禁止 `git add .` / `git add -A`）

> 仅列出，不实际执行。执行前请再次确认工作区无其它你想要纳入的变更。

```bash
git add -- .trae/mcp.json
git add -- mcp-bridge/trae-test-mcp-stdio.js
git add -- mcp-bridge/execute-test-plan-schema.js
git add -- mcp-bridge/PANQU_TRAE_AGENT_PROMPT.md
git add -- mcp-bridge/package.json
git add -- bin/run-plan.ts
git add -- src/agents/orchestration/plan-run-service.ts
git add -- src/agents/orchestration/plan-executor.ts
git add -- src/agents/plan/plan-contract.ts
git add -- src/agents/plan/plan-policy-gate.ts
git add -- docs/panqu-test-agent-enterprise-pilot.md
git add -- docs/panqu-test-agent-enterprise-release-manifest.md
git add -- tests/integration/stdio-mcp.test.ts
git add -- tests/integration/stdio-mcp-portable.test.ts
git add -- tests/integration/run-plan-cli.test.ts
git add -- tests/unit/plan-contract.test.ts
git add -- tests/unit/plan-determinism.test.ts
git add -- tests/unit/plan-executor-transport.test.ts
git add -- tests/unit/plan-executor.test.ts
git add -- tests/unit/plan-policy-gate.test.ts
git add -- tests/unit/plan-run-service.test.ts
```

---

## 六、Fresh-clone 模拟结果

> 本轮为 workspace reconciliation 重新执行的真实快照结果（非占位数据）。

### 环境信息
- HEAD commit：`23577491819f7b343efd87b291afc55c9a7c08df`
- 临时快照路径：`/tmp/panqu-fresh-clone-sim`
- 覆盖方式：`git archive HEAD` 导出干净 HEAD，再覆盖 21 个 REQUIRED_NEW_OR_MODIFIED 文件

### 覆盖的 21 个文件
全部 21 个 REQUIRED_NEW_OR_MODIFIED 文件已成功覆盖到临时快照（`OVERLAY_COUNT=21`），无缺失。

### npm ci 结果
- 状态：成功（`added 448 packages`，5s）
- 说明：快照无 `.git`，`husky` prepare 脚本提示 `.git can't be found`（预期，不影响依赖安装）
- audit：2 moderate 漏洞（与发布闭包无关的传递依赖）

### npm run build 结果
- `npm run build`：成功（`BUILD_EXIT=0`，`tsc -p tsconfig.json && node scripts/copy-assets.mjs`）
- `dist/bin/run-plan.js`：已生成
- `node --check`：两个 mcp-bridge 脚本通过（`CHECK_STDIO=OK`、`CHECK_SCHEMA=OK`）

### 17 文件测试结果（fresh 快照）
- Test Files：17 passed (17)
- Tests：269 passed (269)
- Duration：2.46s
- 路径验证：快照内运行，未引用原工作区绝对路径

### 17 文件测试结果（当前工作区，用于对比）
- Test Files：17 passed (17)
- Tests：269 passed (269)
- Duration：2.75s
- 结论：fresh 快照与当前工作区测试数量一致（269/269）

### relocated ESM/CommonJS 正负例
- 负例（临时根 `type=module`、无 `mcp-bridge/package.json`、仍提供 fake `dist/bin/run-plan.js`）：启动失败，stderr 命中 `require is not defined`（模块类型不兼容），非 dist 缺失假失败
- 正例（恢复 `mcp-bridge/package.json` = `{"type":"commonjs"}`）：initialize 成功、tools/list 仅 `execute_test_plan`、action=plan 返回唯一 fake marker（`RELOCATED_FAKE_RUNPLAN_MARKER_7f3a9c1e`）

### MCP 冒烟（fresh 快照）
- initialize：成功（`protocolVersion=2025-03-26`，`serverInfo.name=panqu-test-mcp`）
- tools/list：仅返回 `execute_test_plan`
- action=plan：返回真实 `plan_id=plan-mtegtkys-773a2f3c46c0`、`run_id=01M16Y4SV583R0BAD7ZYTDWA7P`、`plan_hash=aac32e46368ffcbb198534c504c5b700eb818e4411599f436d2ddd8626b2f6d3`
- 网络：plan 阶段零网络请求

### 临时目录清理结果
- 快照目录 `/tmp/panqu-fresh-clone-sim`：已删除
- 临时脚本与日志（`/tmp/panqu-*.sh`、`/tmp/panqu-*.log`）：已删除
- MCP 冒烟产生的 `TESTFLOW_OUTPUT_DIR`：已删除

### 暂存区状态
- `git diff --cached --name-only`：为空（无任何已暂存变更，符合本轮禁止 stage 约束）

### 是否发现遗漏依赖
- 未发现遗漏依赖；21 项发布闭包在干净 HEAD 上独立构建、测试、冒烟均通过。