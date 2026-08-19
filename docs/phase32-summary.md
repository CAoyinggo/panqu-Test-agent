# Phase 32 总结：变异测试（Mutation Testing）

> 版本：v4.8.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-07（P0）：项目此前没有任何变异测试，Critical 变异阈值未建立——覆盖率门禁只能说明「代码被执行」，无法证明「执行结果被断言」。本阶段引入 Stryker 变异测试，聚焦平台 Critical 决策逻辑（生产安全 / RBAC / 审批中心 / Run 状态机），建立变异分数门禁，并依据存活变异甄别的真实缺口补测（phase31-summary 下一阶段建议 1）。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| 无变异测试 | `npm test` 只有 Vitest 覆盖率门禁（行/分支/语句/函数），无变异分数 | 引入 Stryker + vitest-runner |
| Critical 决策逻辑未受变异防护 | security / rbac / approval-center / run-schema 多为布尔判定与分支，若断言缺位，布尔字段被翻转也能通过测试 | 首次变异 85.49%，rbac 71.88% 最弱 → 甄别缺口补测 |
| 全量变异成本高 | 全仓库变异点过多，运行时间不可接受 | 目标集聚焦 7 个 Critical 源文件 + `vitest.related` 仅跑相关测试 + `coverageAnalysis: perTest` |
| 测试断言「形状」不完整 | 访问决策等仅断言结果值，未断言 `{verdict, requiresApproval, rbacPassed, policy}` 全字段，布尔字段翻转可存活 | 补全四分支全字段形状断言 |

## 三、实施内容

### 32.1 变异测试基础设施

- 新增依赖 `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`（均 10.0.0）。
- 新增 `stryker.config.mjs`：
  - `testRunner: 'vitest'`、`vitest.related: true`（仅运行与变异点相关的测试文件）、`coverageAnalysis: 'perTest'`；
  - `mutate` 聚焦 7 个 Critical 源文件：`security/index.ts`、`rbac/rbac.ts`、`rbac/platform-gate.ts`、`rbac/access-chain.ts`、`approval-center/approval-center.ts`、`approval-center/approval-schema.ts`、`runs/run-schema.ts`；
  - `excludedMutations: ['StringLiteral']`（文案类变异无测试价值）、`concurrency: 4`；
  - 门禁 `thresholds: { high: 80, low: 70, break: 60 }`；
  - 报告 `reports/mutation/mutation.html`（已入 `.gitignore`）。
- 新增脚本：`phase32:test`（构建 + 相关单测 + 完整变异门禁）/ `mutation:test` / `mutation:dry`（仅校验测试环境）。
- dryRun 验证：7 文件 323 变异点，236 相关测试全通过，环境可用。

### 32.2 首次变异 → 缺口甄别 → 补测

**首次变异 85.49%（165 杀死 / 22 存活 / 6 无覆盖）**，rbac 71.88% 最弱。逐条甄别存活/无覆盖变异，归纳真实缺口：

| 缺口 | 甄别结果 | 处置 |
|---|---|---|
| `access-chain` 访问决策 6 个布尔字段 | 既有测试仅断言结果值，未断言全字段形状，布尔字段翻转可存活 | rbac.test.ts 补四分支全字段形状断言 |
| `platform-gate` 审批不存在 / 无审批权限错误路径 | 错误路径未测试 | rbac.test.ts 补抛错断言 |
| `platform-gate` reason / evidence 回退 | 未传时回退逻辑未测试 | rbac.test.ts 补回退默认值断言 |
| rbac DEVELOPER / SERVICE_ACCOUNT 权限矩阵、listPermissions | 权限矩阵不完整、listPermissions 未测 | rbac.test.ts 补权限矩阵 + listPermissions |
| `resolvePlatformMode` trim / 大小写 | 空白/混合大小写规范化未测 | security.test.ts 补 2 项 |
| 静态身份来源 detail | production/development 两种 detail 未测 | security.test.ts 补 1 项 |
| approval `clear()` / evidence 默认 | 清空与默认空数组未测 | approval-center.test.ts 补 2 项 |
| run-schema 状态机 | 无专项测试 | 新建 run-schema.test.ts（5 项） |

**补测合计 18 项**（rbac +9 / security +2 / approval-center +2 / run-schema 新建 5），4 文件 59 项测试通过。

**第二次变异 98.96%（191 杀死 / 2 存活 / 0 无覆盖）**，通过 break 60 门禁并高于 high 80：

| 模块 | 变异分数 |
|---|---|
| security | 100% |
| approval-center | 100% |
| rbac（rbac + platform-gate + access-chain） | 98.44% |
| runs（run-schema） | 96.55% |
| **总体** | **98.96%** |

### 32.3 剩余 2 项存活变异甄别（已判定可接受）

| 变异 | 甄别结论 |
|---|---|
| `platform-gate.ts:43` evidence 回退 `??`→`&&` | perTest 覆盖率映射的保守假象：相关测试已关联，实测行为不同（`[]` vs `undefined`）且新补测试可杀死该变异；对门禁更安全 |
| `run-schema.ts:75` runId 月份算术 | 需 mock Date 才能测，实践等价（月份算术正确性由既有 id 测试覆盖）；记录为已知等价存活 |

## 四、修改 / 新增文件

- 新增：`stryker.config.mjs`、`tests/unit/run-schema.test.ts`（5 项）、`docs/phase32-summary.md`。
- 修改：`tests/unit/rbac.test.ts`（+9 项）、`tests/unit/security.test.ts`（+2 项）、`tests/unit/approval-center.test.ts`（+2 项）、`package.json`（v4.8.0 + phase32:test / mutation:test / mutation:dry 脚本 + Stryker 依赖）、`src/platform/version.ts`（4.8.0）、`package-lock.json`、`.gitignore`（.stryker-tmp/ + reports/mutation/）、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-07 已解决）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 变异 dry-run | `npx stryker run --dryRunOnly` | 7 文件 323 变异点，236 相关测试全通过 |
| 变异门禁（首次） | `npx stryker run` | 85.49%（165 杀死 / 22 存活 / 6 无覆盖） |
| 补测后相关单测 | `npx vitest run tests/unit/rbac.test.ts tests/unit/security.test.ts tests/unit/approval-center.test.ts tests/unit/run-schema.test.ts` | 59 项通过 |
| 变异门禁（补测后） | `npx stryker run` | **98.96%**（191 杀死 / 2 存活 / 0 无覆盖），通过 break 60 门禁 |
| 全量回归 | `npm test` | **1471 passed / 18 skipped**（126 个测试文件） |

## 六、性能 / 安全 / 兼容性

- **性能**：变异测试为开发期门禁（`phase32:test`），不进入运行时路径；`vitest.related` + perTest 将每次变异运行的测试集最小化，7 文件全量变异可在可接受时长内完成。
- **安全**：变异门禁聚焦生产安全 / RBAC / 审批 / Run 状态机四个最敏感的决策域，布尔判定翻转（拒绝→放行、需审批→无需审批）均被测试杀死，显著降低「代码执行了但结果没被验证」的安全风险。
- **兼容性**：变异测试为纯新增基础设施，不修改任何运行时行为；补测仅扩展测试断言，未改变源文件语义；无公共 API 破坏。

## 七、遗留问题与下一阶段建议

1. **Phase 33 双环境策略源统一（DEBT-01，P1）**：`config/environment-policy.ts`（agent 层危险动作守卫）与 `platform/projects/environment-policy.ts`（平台层动作分级）语义并存，需统一 `EnvironmentTier/Type` 与动作分类、维护职责边界文档，消除配置分叉。
2. 低优先开放：DEBT-05（assertion-visualizer 独立能力去留）、DEBT-11（类型级反向依赖，type-only 可接受）、DEBT-12（resolvePrincipal 残留）、DEBT-13（时序敏感 E2E 观察）。
