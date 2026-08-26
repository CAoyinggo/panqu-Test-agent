# Phase 21.1 变更报告：Multi-Business 业务注册中心

> 阶段目标：将既有 feature / scene 插件机制正式升级为「业务注册中心」。
> 新增业务只通过 BusinessDefinition + BusinessAdapter 接入，不修改 Core Engine / Pipeline / Assertion。

## 一、本阶段变更

### 新增 `src/business/`（6 个文件，未修改任何既有 src 文件）

| 文件 | 说明 |
|---|---|
| `business-schema.ts` | `BusinessDefinition` / `RiskPolicy` / `TestPolicy` 数据模型 + `BUSINESS_JSON_SCHEMA`（ajv 校验）+ `normalizeBusinessDefinition`（environments 缺省补 test）+ `validateBusinessDefinition` |
| `registry.ts` | `BusinessRegistry`：register（重复 id 抛错）/ unregister / get / has / list（id 稳定排序）/ `resolveByFeature` / `resolveByCapability` / `resolveByScene`；`getBusinessRegistry()` 全局单例（首次调用自动加载内置业务）+ `resetBusinessRegistry()`（测试用） |
| `adapters/business-adapter.ts` | `BusinessAdapter` 接口（matchFeature / resolveScene / defaultAdapterName / assertionProfile）+ `DefaultBusinessAdapter` 通用实现：仅凭定义即可完成接入（零代码）；wan3 保留既有 7 项默认断言档案与 adapter 名 |
| `definitions/index.ts` | 6 个内置业务定义：`wan3`（与现状对齐：scene=video、4 项能力、billing/concurrency/timeout 风险聚焦）、`image-generation`、`chat`、`music`、`digital-human`、`workflow` |
| `loader.ts` | `loadBuiltinBusinesses` + `loadBusinessDefinitionsFromDir`（外部 `*.json` 目录，校验失败告警跳过、id 冲突不覆盖）+ `initBusinessRegistry`；外部目录由环境变量 `BUSINESS_DEFS_DIR` 指定 |
| `index.ts` | 统一导出 |

### package.json

新增 `agent:business:test`（`vitest run tests/unit/business-registry.test.ts`），无命名冲突。

### 业务定义结构

```ts
interface BusinessDefinition {
  id: string;            // wan3 / image-generation / chat / ...
  name: string;
  version: string;
  scenes: string[];      // 对应 SceneHandler 可处理的 scene
  environments: string[];
  capabilities: string[];
  riskPolicy?: RiskPolicy;   // forbiddenActions / requireApproval / maxConcurrency / focusRiskCategories
  testPolicy?: TestPolicy;   // defaultSuite / p0Required / coverageThreshold / maxCasesPerRun / allowedEnvironments
}
```

### 零代码接入机制

外部定义目录（`BUSINESS_DEFS_DIR`）下每个 `*.json` 即一个业务：ajv 校验通过后自动注册，
目录不存在静默跳过，单文件失败不影响其他文件，id 冲突跳过不覆盖。新增业务无需修改任何代码。

## 二、测试结果

### 新增单元测试 `tests/unit/business-registry.test.ts`（24 条）

- Schema：合法定义通过 / environments 缺省补默认 / 缺 id 失败 / 非对象失败 / coverageThreshold 越界失败 / 策略字段保留
- Registry：6 内置业务注册、重复注册抛错、get/has/unregister/clear、resolveByFeature / resolveByCapability / resolveByScene、list 稳定排序
- Adapter：wan3 保持既有行为（adapter 名 + 7 项断言档案）、新业务映射、大小写不敏感
- Loader：外部 JSON 加载、非法文件跳过、id 冲突不覆盖、目录不存在返回 0、init 合并内置+外部、可关闭内置
- 验收场景 1：image-generation 仅凭定义 + 默认适配器完成接入

### 回归（任务书要求：Build → Unit Test → Agent Test → Regression）

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:business:test` | 24/24 PASS |
| `npm run agent:test` | 34 文件 / 450 用例 PASS（零变化） |
| `npm test` | 49 文件 / 737 用例 PASS + 18 skipped（713 → 737，仅新增业务测试） |

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 新增 `src/business/`（registry / business-schema / loader / adapters） | ✅ 四个组件齐备（另加 definitions 与 index） |
| `BusinessDefinition`（id/name/version/scenes/environments/capabilities/riskPolicy/testPolicy） | ✅ 完整实现 + ajv 校验 |
| 新增 image-generation / chat / music / digital-human / workflow | ✅ 5 个新业务 + wan3 共 6 个 |
| 新增业务时不能修改 Core Engine | ✅ 本阶段未修改 `src/core/`、`src/agents/`、`src/plugins/`、`src/assertions/` 任何文件；外部定义目录支持零代码接入 |
| 验收命令 `npm run agent:business:test` | ✅ 已添加并通过 |

## 四、约束符合性与风险

- 未重建 Test Engine / Assertion / Memory / Pipeline；`src/business/` 为纯增量模块
- wan3 定义与现状完全对齐（scene=video、adapter 名 'wan3'、7 项默认断言档案），既有行为零变化
- 注册中心目前为「声明式基础设施」：pipeline / engine 的实际路由接线（adapter 类型放宽、
  默认断言按业务路由、inferScene 查注册表）属于 breaking change 面，按 readiness 报告的
  缓解策略留待后续子阶段增量实施，本阶段不动 core
- 风险：`resolveScene` 采用子串包含匹配（与 SceneHandler.match 语义一致），业务 scene 命名
  需避免互为子串（当前 6 业务 scene 无冲突）
- 风险：外部定义目录加载为启动时一次性注册，运行期热更新需调用方显式重新初始化

## 五、下一步

进入 **Phase 21.2 Test Asset Management**：新增 `src/test-assets/`，统一 TestAsset 模型
（Requirement / TestCase / TestPlan / Risk / DataPlan / Execution / RCA / Defect / HealingPatch / Knowledge），
支持创建 / 查询 / 版本 / 归档 / 恢复 / 关联 / 影响分析，形成 Requirement → TestCase → Execution →
Failure → RCA → Defect → Fix → Regression 完整追踪链；同步规划 Change Impact Analysis 与
Test Reuse Engine 的接口预留。
