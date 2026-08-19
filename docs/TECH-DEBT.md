# 技术债登记（Technical Debt Registry）

> 维护原则（Phase 28.5）：每阶段新增/解决/剩余债务在此登记；Debt Trend 随 Phase 变化。
> 级别：P0（立即处理，安全/正确性）/ P1（近期处理）/ P2（低优先，随重构清理）。

## 债务清单

| ID | 级别 | 分类 | 描述 | 首次登记 | 状态 | 备注 / 处置 |
|---|---|---|---|---|---|---|
| DEBT-01 | P1 | 双环境策略源 | `config/environment-policy.ts`（agent 层危险动作守卫）与 `platform/projects/environment-policy.ts`（平台层动作分级）并存，语义不同 | Phase 27 审计 | 开放 | 已确认非同一职责模型；合并需统一 EnvironmentTier/Type 与动作分类，风险中；建议保留并维护职责边界文档 |
| DEBT-02 | P1 | 平台层反向依赖 | `platform/audit/audit-log.ts` 曾运行时依赖 `agents/tools/tool.js`（redactSensitive） | Phase 27 审计 | **已解决（Phase 28）** | 脱敏上移至 `core/redact.ts`，audit-log 改从 core 导入；tool.js 保留再导出 |
| DEBT-03 | P1 | 重复模块 | `config/env.ts` 与 `config/env-loader.ts` 四函数重复；`applyEnvToConfig` 被 `loadConfigFromEnv` 覆盖 | 既有 qa-report DEFECT-05 | **已解决（Phase 28）** | 删除 `env.ts`，engine/execution-run-tool 统一导入 `env-loader.ts`；移除 engine 冗余 `applyEnvToConfig` 调用 |
| DEBT-04 | P2 | 死代码 | `utils/time.ts`（20 行零引用） | Phase 27 审计 | **已解决（Phase 28）** | 已删除 |
| DEBT-05 | P2 | 未使用模块 | `utils/assertion-visualizer.ts`（513 行）仅被自身测试引用 | Phase 27 审计 | 开放 | 保留（有通过测试的独立能力）；待确认是否需对外提供或删除 |
| DEBT-06 | P0 | 性能基线缺失 | 无 10/50/100/500 Runs 性能基线与回归门禁 | Phase 27 审计 | 开放 | 计划 Phase 29：脚本 + 阈值 + 门禁 |
| DEBT-07 | P0 | 变异测试缺失 | 无 Mutation Testing；Critical 变异阈值未建立 | Phase 27 审计 | 开放 | 计划后续 Phase：引入 stryker 或等价变异工具 |
| DEBT-08 | P1 | 覆盖率缺口 | vitest coverage include 未含 `src/platform/**` | Phase 27 审计 | 开放 | 计划后续 Phase：纳入平台层并补分支 |
| DEBT-09 | P1 | 迁移框架缺口 | 迁移仅 up/status，无 down/回滚；未验证 backup→migrate→restore→rollback 链 | Phase 27 审计 | 开放 | 计划后续 Phase：down 迁移 + 回滚验证 |
| DEBT-10 | P2 | 文档滞后 | README 曾多节测试数自相矛盾、目录结构滞后 | Phase 27 审计 | **已解决（Phase 28）** | 已统一 120 文件/1420 用例；目录结构已更新（含 security/、core/redact、env-loader、CHANGELOG） |
| DEBT-11 | P2 | 类型级反向依赖 | `platform/telemetry-service.ts`、`platform/real-run.ts`、`audit-log.ts` 以 `import type` 引用 agents 域共享类型（FailureCategory） | Phase 27 审计 | 开放 | type-only 无运行时耦合，可接受；后续可将共享 Schema 类型移至 core 层 |
| DEBT-12 | P2 | 重复实现 | `resolvePrincipal` 等身份解析逻辑历史版本残留（已并入 security 模块统一解析） | Phase 28 扫描 | 开放 | 低优先，随 API 重构清理 |
| DEBT-13 | P2 | 慢/易碎测试 | 部分 E2E 依赖固定 ISO 时间与端口，存在时序敏感用例 | Phase 28 扫描 | 开放 | 已通过固定 `now()` 与随机端口缓解；持续观察 flaky |

## 阶段债务趋势

| Phase | 新增债务 | 已解决债务 | 剩余债务 | 趋势 |
|---|---|---|---|---|
| Phase 27（生产安全加固） | 0（引入新模块，未产生新债） | DEBT-（无，未清理历史债） | 6 项开放 | 持平 |
| Phase 28（工程治理） | DEBT-12、DEBT-13（2） | DEBT-02、DEBT-03、DEBT-04、DEBT-10（4） | 7 项开放（DEBT-01/05/06/07/08/09/11 + 12/13） | 净下降 |
