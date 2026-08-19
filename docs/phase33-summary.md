# Phase 33 总结：环境策略职责边界与跨层一致性（DEBT-01）

> 版本：v4.9.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-01（P1）：系统存在三套环境相关策略模型——`config/environment-policy.ts`（agent 层危险动作守卫）与 `platform/projects/environment-policy.ts`（平台层动作分级）「双环境策略源」并存，语义不同，此前仅登记无处置。经审计确认二者**非同一职责模型**（另有 `platform/security/index.ts` 运行模式加固），粗暴合并风险高；本阶段采用「保留 + 职责边界文档化 + 跨层一致性校验」处置，并修复审计暴露的真实跨层漂移缺口。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| 三层环境策略模型并存 | agent 层执行启用守卫（能否执行）/ 平台层动作分级（要不要审批）/ 安全模块运行模式加固（运行安全级别） | 职责边界文档化，不合并 |
| 无跨层一致性校验 | 任一层单独演进可能造成安全漂移（如环境名映射不一致） | 新增互操作契约 + 15 项一致性校验 |
| **真实缺口：agent 层不识别 `preprod`** | `resolveEnvironmentTier` 仅识别 prod/preonline/pre/staging，`preprod` 落到默认 test 档 → 平台 `preprod` 环境在 agent 守卫下危险动作可放行 | 修复：`preprod` 归入 preonline 档（危险动作拒绝） |
| 平台 `production` 类型 read/safe 允许 | 与 agent 守卫生产档（需显式启用）语义不同 | 文档化为**有意的职责边界**（平台项目环境由管理员显式配置即授权） |

## 三、实施内容

### 33.1 跨层互操作契约（权威来源，`src/platform/projects/environment-policy.ts`）

- `environmentTypeToTier(type)`：`dev/test→test`、`staging/preprod→preonline`、`production→production`。
- `environmentTypeToMode(type)`：`dev→development`、`test→test`、`staging/preprod→staging`、`production→production`。
- `PRODUCTION_LIKE_GUARD_TIERS = ['preonline', 'production']`：平台 `isProductionLike` 为 true 的类型，其 agent 守卫档位必须落在此集合。

### 33.2 职责边界文档

新增 `docs/environment-policy-boundaries.md`：三层模型表、职责划分（为什么不是同一件事）、互操作契约、5 条不变量、已知边界、变更检查单。

### 33.3 修复跨层漂移缺口

`src/config/environment-policy.ts` 的 `resolveEnvironmentTier` 新增 `preprod` 别名 → preonline 档。此前平台 `preprod` 项目环境在 agent 守卫下被当作 test 档（危险动作可放行），现正确拒绝危险动作。

### 33.4 跨层一致性校验（`tests/unit/environment-policy-coherence.test.ts`，15 项）

1. 映射契约与 `resolveEnvironmentTier` / `resolvePlatformMode` 对同一环境名解析一致（防别名漂移）；
2. 生产类环境三模型一致（平台 `isProductionLike` ⇒ agent 生产类档位 ⇒ 运行模式生产安全 ⇒ dangerous deny）；
3. 危险动作跨层拒绝一致（禁止动作清单全覆盖）；
4. 纵深防御不变量（平台 `deny` ⇒ agent 守卫必拒绝，agent 不弱于平台）；
5. 禁止动作清单完整性 + 运行模式别名对齐。

## 四、修改 / 新增文件

- 新增：`docs/environment-policy-boundaries.md`、`tests/unit/environment-policy-coherence.test.ts`（15 项）、`docs/phase33-summary.md`。
- 修改：`src/platform/projects/environment-policy.ts`（互操作契约 + GuardTier/GuardMode 类型）、`src/config/environment-policy.ts`（`preprod` 别名修复）、`tests/unit/environment-policy.test.ts`（preprod 档位断言）、`package.json`（v4.9.0 + phase33:test 脚本）、`src/platform/version.ts`（4.9.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-01 已解决 + DEBT-07 清单行补齐 + 趋势行）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 跨层一致性 + 相关回归 | `npm run phase33:test` | 52 项通过（coherence 15 + environment-policy 10 + platform-project 12 + coverage-gap 15） |
| 全量回归 | `npm test` | **1486 passed / 18 skipped**（127 个测试文件） |

## 六、性能 / 安全 / 兼容性

- **性能**：新增为纯校验逻辑（映射函数 O(1)）与测试，无运行时热路径影响；不改变任何执行路径语义。
- **安全**：修复 `preprod` 档位漂移是**安全收紧**（平台 preprod 环境在 agent 守卫下危险动作此前可放行，现拒绝）；纵深防御不变量（平台 deny ⇒ agent 必拒绝）以测试固化。
- **兼容性**：`resolveEnvironmentTier` 新增别名 `preprod` 为纯增量（此前 `preprod` 归默认档，非既有显式语义）；平台层新增导出为纯增量；无公共 API 破坏。

## 七、遗留问题与下一阶段建议

1. **Phase 34 未使用模块处置（DEBT-05，P2）**：`utils/assertion-visualizer.ts`（513 行）仅被自身测试引用——评估对外提供入口（保留并文档化）或删除，消除唯一「未使用模块」开放债。
2. 低优先开放：DEBT-11（类型级反向依赖，type-only 可接受）、DEBT-12（resolvePrincipal 残留）、DEBT-13（时序敏感 E2E 观察）。
