# Phase 35 总结：类型级反向依赖上移 core（DEBT-11）

> 版本：v4.11.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-11（P2）：`platform/telemetry-service.ts`、`platform/real-run.ts`、`audit-log.ts` 以 `import type` 引用 agents 域共享类型（`FailureCategory`）。type-only 虽无运行时耦合，但构成「平台层 → agents 域」的跨域类型反向依赖，违反分层依赖方向（平台层不应依赖 agents 智能体域）；处置为将共享类型上移至 core 层统一权威。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| 平台层 3 处 `import type { FailureCategory }` | `telemetry-types.ts` / `telemetry-service.ts` / `real-run.ts` 从 `agents/analysis/root-cause-schema.js` 导入 | 改从 core 层导入 |
| 共享类型定义于 agents 域 | `FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory` 在 `root-cause-schema.ts`，该文件自包含（无内部导入） | 上移 core 层唯一权威，agents re-export 兼容 |
| `FAILURE_CATEGORIES` 为值 | `root-cause-agent.ts` 运行时使用（数组 includes 判定） | 必须保留值语义，core 层导出常量数组 |
| 无平台层依赖守护 | 无测试固化「平台层不得依赖 agents 域」 | 新增结构性依赖守护测试防回归 |
| 分类清单与 JSON Schema 无一致性校验 | RCA schema enum 与分类清单两份硬编码 | 新增一致性守护测试防漂移 |

## 三、实施内容

### 35.1 core 层唯一权威来源（新增 `src/core/failure-category.ts`）

- `FailureCategory` 类型（13 个分类字面量）、`FAILURE_CATEGORIES` 常量数组、`isFailureCategory` 类型守卫，从 `root-cause-schema.ts` 原样迁移（含逐项注释）。
- core 为最底层，不依赖任何域；agents / platform / autonomous 均可从 core 导入。

### 35.2 agents 域 re-export 兼容（修改 `root-cause-schema.ts`）

- 删除本地 `FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory` 定义；
- 改为 `import { type FailureCategory, FAILURE_CATEGORIES, isFailureCategory } from '../../core/failure-category.js'`（本地使用）+ `export { type FailureCategory, FAILURE_CATEGORIES, isFailureCategory } from '../../core/failure-category.js'`（对外兼容）；
- `root-cause-agent.ts` 的 `FailureCategory` / `FAILURE_CATEGORIES` 经 re-export 正常使用；`autonomous` 域经 agents 使用不受影响。

### 35.3 平台层解耦（3 处 import 改从 core）

- `src/platform/telemetry/telemetry-types.ts`、`src/platform/telemetry/telemetry-service.ts`、`src/platform/ops/real-run.ts`：`import type { FailureCategory } from '../../core/failure-category.js'`。
- 至此 **`src/platform/**` 对 agents 域零依赖**（Grep 全量验证无 `agents` import）。

### 35.4 守护测试（新增 `tests/unit/core-failure-category.test.ts`，6 项）

1. `FAILURE_CATEGORIES` 完整 13 项、无重复、与类型字面量一一对应；
2. `isFailureCategory` 正反例（合法分类 / 大小写敏感 / 非字符串）；
3. **同一权威源**：agents re-export 的数组/函数与 core 为同一引用（防双源漂移）；
4. agents re-export 兼容可用（经 root-cause-schema 导入的类型与函数工作正常）；
5. **一致性守护**：core 分类清单与 RCA JSON Schema `category.enum` 完全一致（防分类改动漂移）；
6. **结构性依赖守护**：递归扫描 `src/platform/**` 全部源文件，断言无 agents 域 import / 动态 import / require（防回归）。

## 四、修改 / 新增文件

- 新增：`src/core/failure-category.ts`、`tests/unit/core-failure-category.test.ts`（6 项）、`docs/phases/phase35-summary.md`。
- 修改：`src/agents/analysis/root-cause-schema.ts`（删除本地定义 + 导入 re-export）、`src/platform/telemetry/telemetry-types.ts`、`src/platform/telemetry/telemetry-service.ts`、`src/platform/ops/real-run.ts`（3 处改从 core 导入）、`vitest.config.ts`（coverage include 纳入 failure-category.ts）、`package.json`（v4.11.0 + phase35:test 脚本）、`src/platform/version.ts`（4.11.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-11 已解决 + 趋势行）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 失败分类模型 + RCA/defect/telemetry/real-run 相关回归 | `npm run phase35:test` | 100 项通过（core-failure-category 6 + root-cause-agent 13 + defect-agent 11 + defect-lifecycle + failure-prediction + telemetry 17 + telemetry-pipeline + real-run + real-failure-rca 16） |
| 全量回归 | `npm test` | **1496 passed / 18 skipped**（129 个测试文件） |

## 六、性能 / 安全 / 兼容性

- **性能**：纯类型/常量迁移，`FAILURE_CATEGORIES` 引用同一数组实例（无复制），运行时零开销；结构性守护仅在测试时扫描。
- **安全**：类型迁移不改变任何运行语义；分类判定逻辑（`isFailureCategory`）原样保留于 core，RCA 校验行为不变（相关 16 项 real-failure-rca 测试全绿）。
- **兼容性**：agents 域 `root-cause-schema.ts` re-export 保持既有导出（`FailureCategory` / `FAILURE_CATEGORIES` / `isFailureCategory`），`root-cause-agent.ts` 与 `autonomous` 域导入路径不变；平台层 3 处为同结构类型重导入（结构化类型系统兼容）；无公共 API 破坏。

## 七、遗留问题与下一阶段建议

1. **Phase 36 重复实现清理（DEBT-12，P2）**：`resolvePrincipal` 等身份解析逻辑历史版本残留（已并入 security 模块统一解析）——审计定位残留位置并清理，消除重复实现开放债。
2. 低优先开放：DEBT-13（时序敏感 E2E 观察）。
