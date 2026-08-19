# 技术债登记（Technical Debt Registry）

> 维护原则（Phase 28.5）：每阶段新增/解决/剩余债务在此登记；Debt Trend 随 Phase 变化。
> 级别：P0（立即处理，安全/正确性）/ P1（近期处理）/ P2（低优先，随重构清理）。

## 债务清单

| ID | 级别 | 分类 | 描述 | 首次登记 | 状态 | 备注 / 处置 |
|---|---|---|---|---|---|---|
| DEBT-01 | P1 | 双环境策略源 | `config/environment-policy.ts`（agent 层危险动作守卫）与 `platform/projects/environment-policy.ts`（平台层动作分级）并存，语义不同 | Phase 27 审计 | **已解决（Phase 33）** | 确认非同一职责模型，采用「保留 + 边界文档化 + 跨层一致性校验」：`docs/environment-policy-boundaries.md` 定义三层职责边界；平台层新增 `environmentTypeToTier`/`environmentTypeToMode`/`PRODUCTION_LIKE_GUARD_TIERS` 互操作契约；`tests/unit/environment-policy-coherence.test.ts`（15 项）守护 5 条不变量；并修复 agent 层 `resolveEnvironmentTier` 不识别 `preprod` 的跨层漂移缺口（现归入 preonline 档，危险动作拒绝） |
| DEBT-02 | P1 | 平台层反向依赖 | `platform/audit/audit-log.ts` 曾运行时依赖 `agents/tools/tool.js`（redactSensitive） | Phase 27 审计 | **已解决（Phase 28）** | 脱敏上移至 `core/redact.ts`，audit-log 改从 core 导入；tool.js 保留再导出 |
| DEBT-03 | P1 | 重复模块 | `config/env.ts` 与 `config/env-loader.ts` 四函数重复；`applyEnvToConfig` 被 `loadConfigFromEnv` 覆盖 | 既有 qa-report DEFECT-05 | **已解决（Phase 28）** | 删除 `env.ts`，engine/execution-run-tool 统一导入 `env-loader.ts`；移除 engine 冗余 `applyEnvToConfig` 调用 |
| DEBT-04 | P2 | 死代码 | `utils/time.ts`（20 行零引用） | Phase 27 审计 | **已解决（Phase 28）** | 已删除 |
| DEBT-05 | P2 | 未使用模块 | `utils/assertion-visualizer.ts`（513 行）仅被自身测试引用 | Phase 27 审计 | 开放 | 保留（有通过测试的独立能力）；待确认是否需对外提供或删除 |
| DEBT-06 | P0 | 性能基线缺失 | 无 10/50/100/500 Runs 性能基线与回归门禁 | Phase 27 审计 | **已解决（Phase 29）** | `src/platform/ops/perf-harness.ts` 唯一测量源 + `scripts/perf/run-perf.mjs`（baseline/gate）+ `tests/perf`（sanity 门禁）；`perf/baseline.json` 权威基线，相对退化 >2× 延迟 / <50% 吞吐即失败 |
| DEBT-07 | P0 | 变异测试缺失 | 无 Mutation Testing；Critical 变异阈值未建立 | Phase 27 审计 | **已解决（Phase 32）** | 引入 Stryker + `@stryker-mutator/vitest-runner`（vitest related + perTest 覆盖率分析）；`stryker.config.mjs` 变异目标集聚焦 7 个 Critical 源文件（security/rbac/approval-center/run-schema），门禁 high=80 / low=70 / break=60；总体变异分数 98.96%（191 杀死 / 2 已知等价存活 / 0 无覆盖），security / approval-center 100%、rbac 98.44%、runs 96.55%；脚本 `phase32:test` / `mutation:test` / `mutation:dry` |
| DEBT-08 | P1 | 覆盖率缺口 | vitest coverage include 未含 `src/platform/**` | Phase 27 审计 | **已解决（Phase 30）** | `vitest.config.ts` coverage include 纳入 `src/platform/**` 与 `src/core/id.ts`；新增 `tests/unit/platform-coverage-gap.test.ts`（15 项）补齐 events/notifications/migrations(Postgres)/environment-policy/scheduler/workers/checkpoint 缺口；平台层全子模块达标（行/函数/语句 ≥ 80，分支 ≥ 75），全量 Statements 90.45 / Branch 79.77 / Functions 91.51 / Lines 92.03 |
| DEBT-09 | P1 | 迁移框架缺口 | 迁移仅 up/status，无 down/回滚；未验证 backup→migrate→restore→rollback 链 | Phase 27 审计 | **已解决（Phase 31）** | `Migration.revert`（v1 回滚删集合表）+ `resolveRevertTarget`（仅回滚最新防跳级）+ `revertSqliteMigration` / `revertPostgresMigration`；CLI `migrate down sqlite|postgres|check`；`tests/integration/migrations-rollback.test.ts` 验证 backup→migrate→rollback→restore 三一致闭环 |
| DEBT-10 | P2 | 文档滞后 | README 曾多节测试数自相矛盾、目录结构滞后 | Phase 27 审计 | **已解决（Phase 28）** | 已统一 120 文件/1420 用例；目录结构已更新（含 security/、core/redact、env-loader、CHANGELOG） |
| DEBT-11 | P2 | 类型级反向依赖 | `platform/telemetry-service.ts`、`platform/real-run.ts`、`audit-log.ts` 以 `import type` 引用 agents 域共享类型（FailureCategory） | Phase 27 审计 | 开放 | type-only 无运行时耦合，可接受；后续可将共享 Schema 类型移至 core 层 |
| DEBT-12 | P2 | 重复实现 | `resolvePrincipal` 等身份解析逻辑历史版本残留（已并入 security 模块统一解析） | Phase 28 扫描 | 开放 | 低优先，随 API 重构清理 |
| DEBT-13 | P2 | 慢/易碎测试 | 部分 E2E 依赖固定 ISO 时间与端口，存在时序敏感用例 | Phase 28 扫描 | 开放 | 已通过固定 `now()` 与随机端口缓解；持续观察 flaky |

## 阶段债务趋势

| Phase | 新增债务 | 已解决债务 | 剩余债务 | 趋势 |
|---|---|---|---|---|
| Phase 27（生产安全加固） | 0（引入新模块，未产生新债） | DEBT-（无，未清理历史债） | 6 项开放 | 持平 |
| Phase 28（工程治理） | DEBT-12、DEBT-13（2） | DEBT-02、DEBT-03、DEBT-04、DEBT-10（4） | 7 项开放（DEBT-01/05/06/07/08/09/11 + 12/13） | 净下降 |
| Phase 29（性能与容量基线） | DEBT-14（1） | DEBT-06、DEBT-14（2） | 7 项开放（DEBT-01/05/07/08/09/11/12/13） | 净下降 |
| Phase 30（覆盖率补齐） | 0（无新债） | DEBT-08（1） | 6 项开放（DEBT-01/05/07/09/11/12/13） | 净下降 |
| Phase 31（迁移 down/回滚） | 0（无新债） | DEBT-09（1） | 6 项开放（DEBT-01/05/07/11/12/13） | 持平 |
| Phase 32（变异测试） | 0（无新债） | DEBT-07（1） | 5 项开放（DEBT-01/05/11/12/13） | 净下降 |
| Phase 33（环境策略边界） | 0（无新债） | DEBT-01（1） | 4 项开放（DEBT-05/11/12/13） | 净下降 |
