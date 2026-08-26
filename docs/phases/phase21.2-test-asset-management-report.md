# Phase 21.2 变更报告：Test Asset Management 测试资产管理

> 阶段目标：将 Requirement / TestCase / TestPlan / Risk / DataPlan / Execution / RCA / Defect /
> HealingPatch / Knowledge 纳入统一测试资产体系，支持创建 / 查询 / 版本 / 归档 / 恢复 / 关联 /
> 影响分析，形成完整追踪链；并落地 Test Reuse Engine（新需求不再默认重新生成全部测试）。

## 一、本阶段变更

### 新增 `src/test-assets/`（4 个文件，未修改任何既有 src 文件）

| 文件 | 说明 |
|---|---|
| `asset-schema.ts` | `TestAsset` 统一模型（id / type / version / feature / createdAt / updatedAt / status / tags / content / metadata）；10 类资产类型；10 种关联关系（derives / plans / executes / failed-as / caused / fixes / patches / mitigates / references / related）；`normalizeCreateAssetInput` 校验；`bumpVersion`（v1→v2）；`generateAssetId`（类型前缀） |
| `asset-store.ts` | `TestAssetStore`：create（重复 id 抛错）/ get / latest / listVersions / query（type / feature / status / tags / text / includeArchived / limit）/ update / newVersion（继承内容升版）/ archive / restore / link（幂等）/ unlink / linksOf / **trace（上下游 BFS 追踪链）** / **impact（下游影响分析 + 类型过滤）** / stats / save / load（JSON 持久化，损坏文件降级为空库） |
| `reuse-engine.ts` | **Test Reuse Engine**：`assessReuse(requirement, candidates)` 确定性打分（feature +3 / capability +2 / input +1 / rule +1）+ Gap 分析（参数取值 / 输入 / 业务规则未覆盖即缺口）；`findReusableCases(store, requirement)` 便捷入口 |
| `index.ts` | 统一导出 |

### package.json

新增 `agent:asset:test`（`vitest run tests/unit/test-assets.test.ts`）。

### 追踪链模型

```text
Requirement ──derives──▶ TestCase ──executes──▶ Execution
                                                    │ failed-as
                                                    ▼
Defect ◀──caused── RCA                     Regression ◀──fixes── Defect
TestCase ◀──patches── HealingPatch         TestCase ◀──mitigates── Risk
```

`trace(id)` 返回 upstream（谁派生/触发了我）与 downstream（我派生/触发了谁）；
`impact(id, type?)` 返回变更时的下游受影响资产（如需求变更 → 受影响用例集合）。

### 主键与版本设计

- 主键 = `id@version`：同一 id 多版本共存，`latest()` 取最新，`get(id, 'v1')` 取历史版本
- 查询默认取每个 id 的最新版本且排除 ARCHIVED（`includeArchived` 可开启）
- 与 Memory 分工明确：Memory 存执行经验记录，TestAssetStore 存受管理资产（版本 / 状态 / 关联图），不重建 Memory

## 二、测试结果

### 新增单元测试 `tests/unit/test-assets.test.ts`（23 条）

- Schema：归一化默认值（v1 / ACTIVE）、非法 type / 缺 feature / 非对象抛错、bumpVersion、generateAssetId 前缀
- Store：自动 id、重复 id 抛错、query 六维过滤、stats
- 版本 / 归档：newVersion 升版保留历史、继承内容、update 刷新、archive/restore 流转且归档默认不可查询
- 关联 / 追踪：link 幂等、非法 relation / 不存在资产抛错、unlink、trace 全链路（req→tc×2→exec→rca→def 双向 BFS）、impact 类型过滤
- 持久化：save/load 往返一致、文件不存在 / 损坏降级空库
- 复用引擎：打分规则验证、缺口识别（resolution=4K）、全覆盖建议复用、空候选、findReusableCases

### 回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:asset:test` | 23/23 PASS |
| `npm run agent:test` | 34 文件 / 450 用例 PASS（零变化） |
| `npm test` | 50 文件 / 760 用例 PASS + 18 skipped（737 → 760，仅新增资产测试） |

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 新增 `src/test-assets/` | ✅ |
| `TestAsset` 模型（id / type / version / feature / createdAt / updatedAt / status / tags / metadata） | ✅ 完整实现 + content 承载各类型结构化内容 |
| 统一管理 10 类资产（Requirement / TestCase / TestPlan / Risk / DataPlan / Execution / RCA / Defect / HealingPatch / Knowledge） | ✅ `TEST_ASSET_TYPES` 全量覆盖 |
| 创建 / 查询 / 版本 / 归档 / 恢复 / 关联 / 影响分析 | ✅ 全部支持 |
| Requirement → TestCase → Execution → Failure → RCA → Defect → Fix → Regression 追踪链 | ✅ 关联关系 + trace / impact |
| Test Reuse Engine（相似 Case 检索 + Gap 分析 + 只生成缺少用例） | ✅ assessReuse / findReusableCases（确定性打分，未引入向量数据库） |
| 验收命令 `npm run agent:asset:test` | ✅ 已添加并通过 |

## 四、约束符合性与风险

- 未重建 Memory / Test Engine / Assertion；`src/test-assets/` 为纯增量模块，未修改任何既有文件（package.json 仅加脚本）
- 复用引擎为确定性标签/取值匹配（与 Memory 相似失败检索同策略），符合「禁止默认使用向量数据库」
- 风险：`query` 的 text 匹配为子串检索，大规模资产下性能线性；后续可加索引（当前资产量级无压力）
- 风险：trace/impact 基于关联边，完整性依赖写入方正确建链；pipeline 接线（执行/RCA/Defect 落资产库并自动建链）
  属于集成工作，留待 21.3 持续回归阶段随 runId 贯穿一并实施，避免本阶段触碰 pipeline
- 遗留：`generateAssetId` 序号为进程内递增，跨进程可能重复；显式 id 是推荐用法，自动 id 仅用于临时资产

## 五、下一步

进入 **Phase 21.3 Continuous Regression**：新增 `src/regression/`（Scheduler / Planner / Trigger / History），
支持 PR / 发布 / 模型变更 / 配置变化 / 人工 / 定时触发；落地 Change Impact Analysis
（变更 → 受影响功能 / 场景 / 用例 / 风险 → 建议执行集合），复用 `TestSelectionAgent` 做回归选择，
引入统一 runId 贯穿 case / execution / trace / defect / knowledge，不执行全量 Case。
