# Phase 28 总结报告：工程治理（Engineering Governance & Tech Debt）

- 版本：v4.4.0
- 日期：2026-08-19
- 前置版本：v4.3.0（Phase 27 完成，commit b91025e，全量回归 1420 PASS / 18 skipped）

## 目标

以「低复杂度、高价值」优先，清理 Phase 27 审计与历史 QA 报告已识别的工程治理缺口，建立技术债登记机制：

1. 删除死代码（`src/utils/time.ts`）。
2. 统一配置模块：消除 `env.ts` / `env-loader.ts` 重复（QA 报告 DEFECT-05 / RISK-07）。
3. 消除平台层对 agents 域的反向运行时依赖（`audit-log.ts` 的 `redactSensitive`）。
4. 文档治理：README 目录结构与测试数据同步。
5. 建立 Technical Debt Registry（任务书第 21 节要求）。

## 发现的问题

| 严重度 | 问题 | 根因 | 处置 |
|---|---|---|---|
| P1 | `env.ts` 与 `env-loader.ts` 四函数重复；`engine.ts` 冗余 `applyEnvToConfig` 调用 | 历史演进未统一配置模块 | 28.2 删除 `env.ts`，单一来源 `env-loader.ts`，移除冗余调用 |
| P1 | 平台 `audit-log.ts` 运行时依赖 agents 域 `tool.js`（违反分层） | 脱敏工具放错层 | 28.3 上移至 `core/redact.ts` |
| P2 | 死代码 `utils/time.ts`（20 行零引用） | 未随迭代清理 | 28.1 删除 |
| Medium | 脱敏缺陷：`X-Api-Key`（连字符变体）漏脱敏 | `includes` 只匹配下划线原形 | 28.3 修复：字段名归一化分隔符 |
| P2 | README 目录结构滞后、测试数自相矛盾 | 未随模块变化同步 | 28.4 同步 |

## 实施内容

### 28.1 死代码清理

删除 `src/utils/time.ts`（20 行，经全仓搜索确认 src/tests/bin/scripts 均无引用）。

### 28.2 配置模块统一

- 确认 `env.ts`（58 行）与 `env-loader.ts`（156 行）重复 `getEnvVar / getEnvFromEnv / applyEnvSessionOverrides / getNotifierConfig`；`env.ts` 独有的 `applyEnvToConfig` 已被 `loadConfigFromEnv` 全面覆盖。
- `engine.ts`：导入切换至 `env-loader.ts`，删除 L356 冗余 `applyEnvToConfig(cfg, envName)` 调用（`loadConfig` 已合并 TESTFLOW_* 覆盖）。
- `execution-run-tool.ts`：`getEnvFromEnv` 改从 `env-loader.ts` 导入。
- 删除 `src/config/env.ts`；全仓确认无残留引用。

### 28.3 反向依赖治理 + 脱敏缺陷修复

- 新建共享模块 `src/core/redact.ts`（`redactSensitive` / `SENSITIVE_KEYS`）。
- `src/agents/tools/tool.ts`：删除本地重复定义，改为 `export { redactSensitive, SENSITIVE_KEYS } from '../../core/redact.js'`（API 兼容）。
- `src/platform/audit/audit-log.ts`：改从 `../../core/redact.js` 导入 → 平台层不再依赖 agents 域。
- 修复脱敏缺陷：字段名 `key.toLowerCase().replace(/-/g, '_')`，使 `X-Api-Key` 等连字符变体命中 `api_key` 规则。

### 28.4 文档治理

- README 目录结构：`core/` 增加 `redact`、`config/` 说明 `env-loader` 单一来源、`platform/` 增加 `security`、`utils/` 移除 `time`、新增 `CHANGELOG.md` 条目、测试数统一为 121 文件/1426 用例。
- 版本/测试数/报告索引全文同步 v4.4.0。

### 28.5 技术债登记

- 新建 `docs/TECH-DEBT.md`：13 项债务（DEBT-01 ~ DEBT-13），含级别/分类/状态/处置；本阶段解决 4 项（DEBT-02/03/04/10），新增 2 项（DEBT-12/13），附阶段趋势表。

## 修改文件

- `src/core/redact.ts`（新增）
- `src/agents/tools/tool.ts`、`src/platform/audit/audit-log.ts`
- `src/core/engine.ts`、`src/agents/execution/execution-run-tool.ts`
- `tests/unit/redact.test.ts`（新增）
- `docs/TECH-DEBT.md`（新增）、`docs/phase28-summary.md`（本报告）
- `package.json`、`package-lock.json`、`src/platform/version.ts`、`README.md`、`CHANGELOG.md`

## 新增文件

- `src/core/redact.ts`（共享脱敏）
- `tests/unit/redact.test.ts`（6 项）
- `docs/TECH-DEBT.md`（技术债登记）

## 删除文件

- `src/config/env.ts`（重复配置模块，已并入 env-loader）
- `src/utils/time.ts`（死代码）

## 架构变化

- 新增共享底层 `src/core/redact.ts`（Core 层），成为 Agent 审计与平台审计的唯一脱敏来源，消除跨层反向依赖。
- 配置环境变量覆盖收敛到 `env-loader.ts` 单一来源，消除双实现歧义。
- 分层检查：平台层 `import type` agents 域共享类型（FailureCategory）保留（无运行时耦合，记录为 DEBT-11）。

## 测试

- 新增 `tests/unit/redact.test.ts`：掩码/嵌套/透传/深度上限/SENSITIVE_KEYS/单一来源（6 项）。
- 验收命令 `npm run phase28:test`：redact + tool-registry + engine + environment-policy 共 3 文件 33 用例 PASS。
- `agent:test`：34 文件 450 用例 PASS（engine 配置流变更无回归）。
- 全量回归 `npm test`：**1426 passed / 18 skipped**（121 文件，较上一版 +6）。

## 性能

- 纯静态重构：删除冗余 `applyEnvToConfig` 调用（减少一次整配置遍历），脱敏增加一次 `replace` 归一化（常数级，可忽略）。
- 无新增 IO/异步，无需重建性能基线。

## 安全

- 脱敏覆盖修复（连字符变体），减少敏感信息落审计日志/记忆的风险面。
- 反向依赖治理后，平台安全/审计模块与 agents 域解耦，降低 LLM 侧代码被平台关键路径引用的面。
- 删除死代码 = 删除潜在混淆面。

## 兼容性

- API：无公共接口变化（`redactSensitive` 从 `tool.js` 再导出保持兼容）。
- CLI / Storage / Migration / Trace：不变。
- 版本：package.json / version.ts / README / CHANGELOG / package-lock 全部同步 v4.4.0。

## 验收

- Build：PASS
- `npm run phase28:test`：3 文件 33 用例 PASS
- `npm run agent:test`：450 PASS
- 全量回归 `npm test`：1426 PASS / 18 skipped

## 遗留问题（登记于 TECH-DEBT）

- DEBT-01 双环境策略源（职责不同，暂不合并，保留边界文档）。
- DEBT-05 未使用模块 `assertion-visualizer.ts`（有测试的独立能力，待定保留/删除）。
- DEBT-06 性能基线缺失（**计划 Phase 29**）。
- DEBT-07 变异测试缺失（计划后续 Phase）。
- DEBT-08 覆盖率未含 `src/platform/**`（计划后续 Phase）。
- DEBT-09 迁移无 down/回滚（计划后续 Phase）。
- DEBT-11 平台 type-only 引用 agents 共享类型（可接受，低优先）。

## 下一阶段建议

1. **Phase 29 性能与容量基线**：建立 10/50/100/500 Runs 性能基线与回归门禁（任务书第 19 节硬性要求，DEBT-06）。
2. **Phase 30 平台覆盖率补齐**：coverage 纳入 `src/platform/**` 并补分支（DEBT-08）。
3. **Phase 31 迁移 down/回滚**：补齐 down 迁移与 backup→migrate→restore→rollback 验证（DEBT-09）。
