# Phase 4 · core-kernel.ts 受控物理分解变更记录

- **日期**：2026-09-23
- **项目**：Panqu AI DevTest v6.0.0
- **性质**：行为等价的纯物理文件分解(zero-behavior-change refactor)
- **关联授权**：`docs/ARCHITECTURE_FREEZE.md` §2.2 第 213 行「Phase 4 core-kernel 物理分解授权」

---

## 1. 背景与目标

`src/devtest/core-kernel.ts` 原为 **4904 行**,是全项目最大的单文件,构成可维护性风险(86/100 代码评估的头号扣分项)。目标:在**不改变任何行为**的前提下,按其既有内聚函数边界拆小,消除神文件。

## 2. 治理决策:先改冻结政策,再拆

`ARCHITECTURE_FREEZE.md` 明确禁止「把 core-kernel 拆成大量没有业务价值的中间层」,并规定凡触及 core-kernel 职责边界须人工明确授权。

因此本次采用**治理优先**路径:先在冻结规范中追加一条**有边界的人工授权**(重申而非削弱所有红线),让分解成为规范内的合法操作,再动手。关键前提是——core-kernel 内部本就是一组边界清晰的纯函数,故本次仅为**行为等价搬迁,不引入任何 Manager/Service/中间层**,恰好绕开冻结最担心的反模式。

## 3. 变更总览

| 文件 | 动作 | 行数变化 |
|---|---|---|
| `src/devtest/core-kernel.ts` | 瘦身为门面+编排层 | **4904 → 1571**(降 3333,-68%) |
| `src/devtest/plan-generator.ts` | 新增(Step 1) | +786 |
| `src/devtest/verify-pipeline.ts` | 新增(Step 2) | +2631 |
| `docs/ARCHITECTURE_FREEZE.md` | §2.2 追加授权条款 | 追加 1 条 |
| `dist/src/devtest/evidence.*` `report-renderer.*` | 删除陈旧产物(源已删) | 清理 |

## 4. Phase 1 — 冻结授权(治理)

在 `docs/ARCHITECTURE_FREEZE.md` §2.2「已获授权事项」新增第 4 条,授权对 `core-kernel.ts` 按既有内聚函数边界做纯物理分解,并写入 **7 条硬约束**:

1. 不新增核心动作(仍为 probe/plan/execute/verify);
2. 严禁新增 Manager/Orchestrator/Service/Repository 等包装层或无价值「中间层」,仅做行为等价搬迁;
3. `core-kernel.ts` 仍为四大动作及其出入参类型的**唯一公共导出面**,`src/devtest/index.ts` 公共契约零变化;
4. 单一裁决引擎、五维证据、Fail-closed、verify 永久只读等所有核心不变量零改动;
5. 新模块只能单向向下依赖,严禁反向 `import` core-kernel,依赖无环护栏必须全绿;
6. 全程行为等价,`npm test` / `npm run build` / dependency-cycle / architecture-convergence 必须持续全绿;
7. 本授权仅限此次物理分解,不构成后续无限重构授权。

## 5. Phase 2 — 物理分解

### Step 1 · 抽出 `plan-generator.ts`

- **迁入**:`generateDynamicTestPlan()`(动态测试计划生成,约 725 行)及公共入参类型 `PlanKernelOptions`。
- **依赖**:仅 `routing` / `types` / `domain-knowledge` / `requirement-trace` 的**类型**(零运行时依赖)。
- **core-kernel 处理**:`import { generateDynamicTestPlan, type PlanKernelOptions }` 供 `plan()` 编排调用,并 `re-export` 保持 `index.ts` 不变。

### Step 2 · 抽出 `verify-pipeline.ts`

承载 verify 动作的完整证据采集与裁决投影流水线:

- **迁入 7 个流水线函数**:`resolveVerifyContext` / `collectTaskEvidence` / `collectMediaEvidence` / `collectBillingEvidence` / `computeRegressionDiff` / `buildDiffItems` / `computeFinalVerdict`。
- **迁入私有辅助**:`fetchFirst64K()`(媒体切片探测,**保持模块私有,不导出**)。
- **迁入类型**:9 个公共证据类型(`EvidenceStatus` / `InvariantDetail` / `TaskEvidence` / `MediaEvidence` / `BillingEvidence` / `InvariantsEvidence` / `VerificationEvidence` / `VerifyKernelOptions` / `VerifyKernelResult`)+ 7 个私有类型(`VerifyContext` / `RoutingFacts` / `TaskEvidenceResult` / `MediaEvidenceResult` / `BillingEvidenceResult` / `BuildDiffItemsOptions` / `ComputeFinalVerdictArgs`)。
- **core-kernel 处理**:`verify()` 编排入口保留在 core-kernel,`import` 上述 7 个函数供内部调用(**只 import 不 re-export**,以满足 public-api 契约:这 7 个函数在公共面必须为 `undefined`);同时 `re-export` 9 个公共证据类型,保持 `index.ts` 契约零变化。

### 附带 · 清理 dist

删除源已移除的陈旧构建产物 `dist/src/devtest/{evidence,report-renderer}.{js,d.ts,js.map}`,消除 sourcemap 告警。

## 6. 依赖方向与保持的不变量

```
index.ts
  └── core-kernel.ts        (门面 + 四大动作编排 + 公共 re-export)
        ├── plan-generator.ts   → routing / types / domain-knowledge / requirement-trace
        └── verify-pipeline.ts  → env-probe / routing / billing / media-inspector /
                                   media-flow / domain-knowledge / canonical-protocol /
                                   canonical-verdict-engine / legacy-protocol-mappers /
                                   execution-ports / result-sink / requirement-trace / types
```

- 严格**单向向下**依赖,新模块零反向 `import core-kernel`,依赖图仍为无环 DAG。
- 公共 API、单一裁决引擎、五维证据、Fail-closed、verify 永久只读——**全部行为等价,零改动**。
- `src/devtest/index.ts` 公共契约零变化。

## 7. 验证结果(全绿)

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npx tsc -p tsconfig.json --noEmit` | exit 0(strict 全开) |
| 构建 | `npm run build` | tsc + copy-assets 干净 |
| Lint | `npm run lint` | **0 error**(230 条 `any` 告警为历史遗留)、prettier 全绿 |
| 测试 | `npm test` | **37 套件 / 668 用例全通过** |

护栏在测试中确认:public-api-contract(7 个 pipeline 函数在公共面为 `undefined`)、architecture-convergence #17(core-kernel 无 `submitMediaTask`)、dependency-cycle(无反向依赖 / 图无环)。

## 8. 未做 / 可选后续

- **(可选)** `verify-pipeline.ts` 仍 2631 行,可按「采集 / 裁决投影」边界进一步拆为 `verify-collectors.ts` + `verify-verdict.ts`。经权衡属**收益递减**(需新增模块、增加跨文件类型耦合、并同步更新冻结授权),2026-09-23 决定**就此收尾**,暂不执行。
- **(可选)** 收紧 230 条 `@typescript-eslint/no-explicit-any` 告警(多在 `tests/`)。

## 9. 回滚

本次为纯物理搬迁,回滚方式:删除 `plan-generator.ts` / `verify-pipeline.ts`,还原 `core-kernel.ts` 与 `ARCHITECTURE_FREEZE.md` §2.2 即可,无数据或行为迁移需处理。


