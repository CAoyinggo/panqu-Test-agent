# 环境策略职责边界（Environment Policy Boundaries）

> 登记：DEBT-01（Phase 27 审计）｜ 处置：Phase 33 文档化 + 跨层一致性校验 ｜ 维护：AI 测试智能体

## 背景

系统存在三套环境相关策略模型，职责不同、各自独立演进。此前被登记为 DEBT-01「双环境策略源」；经审计确认**三者非同一职责模型，不应粗暴合并**（统一需重构 EnvironmentTier/Type 与动作分类，风险高）。本阶段采用「保留 + 职责边界文档化 + 跨层一致性校验」处置。

## 三层模型

| 层 | 模块 | 模型 | 职责 | 调用方 |
|---|---|---|---|---|
| **agent 层执行启用守卫** | `src/config/environment-policy.ts`（Phase 20.8） | `EnvironmentTier`：test / preonline / production；危险动作字符串清单 `PRODUCTION_FORBIDDEN_ACTIONS` | **是否允许该动作在给定环境执行**：production 必须显式 `TESTFLOW_ALLOW_PRODUCTION=true` 才可启用；preonline / production 拒绝危险动作 | `src/exploration/exploration-lifecycle.ts`（探索执行 Permission 门禁） |
| **平台层动作分级** | `src/platform/projects/environment-policy.ts`（Phase 24.1） | `EnvironmentType`：dev / test / staging / preprod / production；`ToolActionLevel`：read / safe / risky / dangerous；决策 allow / approval / deny | **该动作在给定环境需要什么审批**：dangerous 在生产类环境 deny、在 dev/test approval；risky 在生产类 approval | `src/platform/rbac/access-chain.ts`（RBAC 第三道闸）、`src/platform/projects/project-service.ts`（checkAction） |
| **安全模块运行模式加固** | `src/platform/security/index.ts`（Phase 27.1） | `PlatformMode`：development / test / staging / production | **平台进程运行时的生产安全约束**：生产/预发强制非默认 JWT_SECRET、生产禁用默认口令与静态身份伪造 | `factory.ts`、`server.ts`、CLI、Preflight |

## 职责划分（为什么不是同一件事）

1. **启用守卫（agent 层）**回答「这个环境能不能跑、危险动作能不能执行」——面向 agent 执行上下文（探索/回归），是**执行使能**闸门。
2. **动作分级（平台层）**回答「这个动作在项目环境下要不要审批」——面向平台项目环境与 RBAC，是**审批策略**闸门。
3. **运行模式加固（安全模块）**回答「平台进程以什么安全级别运行」——面向平台服务装配与启动，是**运行时加固**闸门。

三者构成纵深防御：同一危险动作在平台生产类环境被分级为 deny/approval（平台闸门），在 agent 执行上下文再被启用守卫拒绝（agent 闸门）；平台进程本身按生产安全模式加固（运行时闸门）。

## 跨层一致性契约（权威来源）

平台层 `src/platform/projects/environment-policy.ts` 提供两个映射函数作为互操作契约：

- `environmentTypeToTier(type)`：`dev/test→test`、`staging/preprod→preonline`、`production→production`
- `environmentTypeToMode(type)`：`dev→development`、`test→test`、`staging/preprod→staging`、`production→production`
- `PRODUCTION_LIKE_GUARD_TIERS = ['preonline', 'production']`：平台 `isProductionLike` 为 true 的类型，其 agent 守卫档位必须落在此集合

## 不变量（必须有测试守护）

1. 映射契约与 `resolveEnvironmentTier` / `resolvePlatformMode` 对同一环境名的解析一致（防别名漂移）。
2. 生产类环境（staging/preprod/production）三模型一致：平台 `isProductionLike` true ⇒ agent 档位在生产类集合 ⇒ 映射运行模式为生产安全模式 ⇒ `dangerous → deny` 且 agent 守卫拒绝全部禁止动作。
3. 非生产类环境（dev/test）：`dangerous → approval`（需审批），agent 守卫放行交给审批分级（非危险动作在非生产放行）。
4. 纵深防御不变量：平台决策为 `deny` 时，agent 守卫对同一环境必拒绝（agent 不弱于平台）。
5. 禁止动作清单 `PRODUCTION_FORBIDDEN_ACTIONS` 全部对应危险级，在生产类环境全部被拒。

校验套件：`tests/unit/environment-policy-coherence.test.ts`（Phase 33）。

## 已知边界（文档化，勿擅自合并）

- 平台 `production` 类型环境的 read/safe 动作按策略为 `allow`（平台策略只管分级）；agent 守卫档位仍为 `production`（执行使能需 `TESTFLOW_ALLOW_PRODUCTION` 或由调用方显式授权）。差异是**有意的职责边界**：平台项目环境由管理员显式创建/配置即视为授权，agent 执行环境需显式开关。
- 平台 `preprod` 类型在 `PlatformMode` 无对应值，映射契约显式归入 `staging`（同为生产安全约束的演练档）。

## 变更检查单

修改任一策略源时，必须：

1. 同步更新 `docs/environment-policy-boundaries.md` 三层模型表与映射契约；
2. 运行 `npm run phase33:test`（跨层一致性套件 + 相关回归），确认不变量 1-5 全部通过；
3. 如改变映射，更新 `environmentTypeToTier` / `environmentTypeToMode` 的 doc 注释并在 CHANGELOG 记录。
