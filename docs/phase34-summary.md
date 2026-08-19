# Phase 34 总结：断言可视化接入 HTML 报告（DEBT-05）

> 版本：v4.10.0 ｜ 日期：2026-08-19 ｜ 模式：持续自主开发（CONTINUOUS AUTONOMOUS DEVELOPMENT）

## 一、目标

解决 DEBT-05（P2）：`utils/assertion-visualizer.ts`（513 行断言可视化引擎，Diff View / History Trend / Assertion Heatmap 三大协议）仅被自身测试引用，是系统唯一「未使用模块」开放债。经审计确认：模块为纯函数实现、无外部依赖、有 36 项通过测试的独立能力，删除即损失能力；本阶段采用「变废为用」处置——接入 HTML 报告器对外提供能力，而非删除。

## 二、扫描发现

| 项 | 现状 | 处置 |
|---|---|---|
| 断言可视化引擎未接入产品入口 | `utils/assertion-visualizer.ts` 被 `tests/unit/assertion-visualizer.test.ts`（36 项）引用，src 内无直接引用 | 接入 `reports/html-reporter.ts`，HTML 报告新增 4.4 断言可视化节 |
| HTML 报告缺少断言失败差异明细 | 4.3 断言详情仅展示「期望 vs 实际」单格文本，无节点级差异结构 | 复用 Diff View 协议输出路径/变更类型/期望/实际/说明明细表 |
| HTML 报告缺少断言健康度总览 | 无断言稳定性/失败频次视图 | 复用 Assertion Heatmap 协议输出热度矩阵 + Flakiness Index |

## 三、实施内容

### 34.1 接入入口（`src/reports/html-reporter.ts`）

- import `visualizeAssertion` / `buildAssertionHeatmap` 及类型 `AssertionHeatmap` / `DiffDetail` / `HeatmapCell`。
- `buildReport` 内新增可视化数据计算逻辑（`assertGroupLabels` 之后）：
  - `assertionMatrix`：由声明式断言 `assertChecks` 映射（assertionId = `project_id-name`、failureCount = pass ? 0 : 1、totalRuns = 1）；
  - `heatmap`：矩阵非空时经 `buildAssertionHeatmap(vizModuleName, assertionMatrix)` 生成；
  - `diffViews`：对每条失败断言经 `visualizeAssertion({...}).diff_view` 生成节点级差异视图。

### 34.2 报告 4.4 断言可视化渲染节

- **Diff 视图**：失败断言逐条输出 `DiffDetail` 明细表（路径/变更类型/期望/实际/说明），表头含断言名与 `data_type` / `summary`；全部通过时显示「无失败差异视图」。
- **断言热力图**：矩阵表（断言/目标/路径/操作符/权重/失败率/运行数），权重着色 0 绿 / 1-3 黄橙 / 4-5 红，附 Flakiness Index 说明（基于本报告单次运行）。

### 34.3 守护测试（`tests/unit/html-reporter-visualization.test.ts`，4 项）

1. 失败断言输出 Diff 视图（diff_details 明细 + 断言名/类型/summary）；
2. 全通过时无失败差异视图但输出热力图；
3. 无声明式断言时无可视化数据（无 heatmap / 无 diff）；
4. HTML 特殊字符转义防注入（`<script>` 等不原样透出）。

## 四、修改 / 新增文件

- 新增：`tests/unit/html-reporter-visualization.test.ts`（4 项）、`docs/phase34-summary.md`。
- 修改：`src/reports/html-reporter.ts`（接入可视化 + 4.4 渲染节）、`package.json`（v4.10.0 + phase34:test 脚本）、`src/platform/version.ts`（4.10.0）、`package-lock.json`、`README.md`、`CHANGELOG.md`、`docs/TECH-DEBT.md`（DEBT-05 已解决 + 趋势行）。

## 五、测试与验收

| 项 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| 断言可视化接入相关回归 | `npm run phase34:test` | 87 项通过（html-reporter-visualization 4 + assertion-visualizer 36 + assertion-engine 22 + path-extractor 25） |
| 全量回归 | `npm test` | **1490 passed / 18 skipped**（128 个测试文件） |

## 六、性能 / 安全 / 兼容性

- **性能**：可视化计算仅在报告生成时执行（断言数级线性），无运行热路径影响；报告体量增加为可视化节 DOM，规模与断言数正比。
- **安全**：新增渲染内容一律经既有 `esc()` 转义（测试 4 守护注入），无新增 XSS 面。
- **兼容性**：`html-reporter.ts` 新增渲染节为纯增量（4.3 之后插入 4.4）；`visualizeAssertion` / `buildAssertionHeatmap` 既有测试全部通过，协议未改动；无公共 API 破坏。

## 七、遗留问题与下一阶段建议

1. **Phase 35 类型级反向依赖评估（DEBT-11，P2）**：`platform/telemetry-service.ts`、`platform/real-run.ts`、`audit-log.ts` 以 `import type` 引用 agents 域共享类型（FailureCategory）——type-only 无运行时耦合，可评估将共享 Schema 类型上移至 core 层统一，消除跨域类型耦合。
2. 低优先开放：DEBT-12（`resolvePrincipal` 历史版本残留，随 API 重构清理）、DEBT-13（时序敏感 E2E 观察）。
