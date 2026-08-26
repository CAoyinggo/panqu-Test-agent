# Phase 21.4 变更报告：Defect Lifecycle 缺陷生命周期

> 阶段目标：Phase 20 的 Defect 停留在 Draft；本阶段建立完整生命周期
> （DRAFT → REVIEW → CREATED → ASSIGNED → FIXING → FIXED → REGRESSION → VERIFIED），
> 支持 Known Issue / Duplicate / Won't Fix / Fixed / Regression Failed，
> 并实现「失败 → 搜索历史 Issue → 重复判定 → 关联已有 Bug」，避免同一问题每次回归创建新 Bug。

## 一、本阶段变更

### 新增 `src/defect-lifecycle/`（4 个文件，未修改任何既有 src 文件）

| 文件 | 说明 |
|---|---|
| `lifecycle-schema.ts` | 9 状态 + 5 处置结论；`DEFECT_TRANSITIONS` 合法迁移表（含回归失败 REGRESSION → FIXING 重开）；`canTransition`；`DefectRecord`（resolution / duplicateOf / relatedCases / failureSignature / category / history 迁移日志）；`normalizeIngestInput` 校验 |
| `duplicate-detector.ts` | **重复判定**：`buildFailureSignature` 失败签名规范化（去数字/时间戳/长 hex/URL）；`signatureOverlap`（Jaccard 关键词重叠）；`scoreDuplicate` 四维计分（feature +2 / category +2 / 签名重叠 ×4 / 用例重叠 +2，阈值 ≥5）；`detectDuplicate`（已修复关闭的 Bug 不参与匹配——再现视为回归而非重复） |
| `defect-tracker.ts` | `DefectLifecycleTracker`：ingest（Draft → DRAFT）/ transition（合法性校验 + 历史日志）/ resolve（KNOWN_ISSUE / DUPLICATE / WONT_FIX → CLOSED；FIXED 仅从 FIXING）/ regressionResult（通过 → VERIFIED，失败 → REGRESSION_FAILED 重开）/ query / knownIssues / **processFailure 端到端**（重复时并入已有 Bug 的 relatedCases，不新建）/ JSON 持久化 |
| `index.ts` | 统一导出 |

### package.json

新增 `agent:defect:test`。

### 核心链路：避免重复建 Bug

```text
失败（caseId / error / category）
  ↓ buildFailureSignature 规范化
  ↓ detectDuplicate：历史 Bug 四维评分（≥5 判重）
  ├─ 重复 → 关联已有 Bug（relatedCases 并入），不新建
  └─ 非重复 → 创建新 DRAFT（带签名，供后续判重）
```

## 二、测试结果

### 新增单元测试 `tests/unit/defect-lifecycle.test.ts`（17 条）

- 状态机：canTransition、完整正向链路（8 次迁移 + history 日志）、非法迁移抛错、摄入校验
- 处置：KNOWN_ISSUE 进已知问题清单、DUPLICATE 记录 duplicateOf、WONT_FIX、FIXED 状态约束、REGRESSION_FAILED 强制走 regressionResult
- 回归验证：通过 → VERIFIED、失败 → 重开回 FIXING + resolution、仅 REGRESSION 可验证
- 失败签名：规范化（去 503/时间戳/URL）、相同错误高重叠 / 无关错误零重叠、四维计分
- 判重边界：已修复关闭的 Bug 不参与匹配
- processFailure：首次新建、相同失败关联已有 Bug（size 不增、relatedCases 合并）、不同失败独立建单、KNOWN_ISSUE 持续吸收
- 持久化：save/load 往返、损坏降级

### 回归

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:defect:test` | 17/17 PASS |
| `npm run agent:test` | 34 文件 / 450 用例 PASS（零变化） |
| `npm test` | 53 文件 / 797 用例 PASS + 18 skipped（780 → 797） |

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 状态流 DRAFT → REVIEW → CREATED → ASSIGNED → FIXING → FIXED → REGRESSION → VERIFIED | ✅ 完整状态机 + 迁移合法性校验 + 历史日志 |
| Known Issue / Duplicate / Won't Fix / Fixed / Regression Failed | ✅ 5 种 resolution 全部支持 |
| 失败 → 搜索历史 Issue → 判断是否重复 → 关联已有 Bug | ✅ processFailure 端到端（测试验证重复时不新建） |
| 避免同一问题每次回归创建新 Bug | ✅ 判重阈值 ≥5 时并入已有 Bug；KNOWN_ISSUE 持续吸收 |
| 复用 Phase 1-20 | ✅ 与 Phase 20 DefectDraft / IssueTracker 并存：Draft 产出后进入生命周期跟踪；签名/判重为确定性实现不引入向量库 |

## 四、约束符合性与风险

- 未修改 Phase 20 的 `src/agents/defect/` 与 `src/agents/issues/`：生命周期为独立增量模块，
  接线点在「Draft 产出后 ingest」，不改变既有 Draft 门禁行为
- 判重为确定性签名匹配（与 Memory 相似失败检索同策略），阈值 5 可由调用方覆盖（scoreDuplicate 可单独调用）
- 风险：签名规范化对中文错误文本的分词粒度较粗（按标点/空格切分），中文场景判重召回偏低；
  后续可补充 n-gram 或接入 RCA category 权重提升
- 风险：`processFailure` 的「已修复关闭 Bug 不参与匹配」策略意味着修复后问题再现会新建 Bug
  （语义为回归），如需关联历史可通过 failureSignature 人工检索

## 五、下一步

进入 **Phase 21.5 Knowledge Optimization**：知识条目增加 confidence / usageCount / lastUsedAt /
source / validUntil 字段，建立 Knowledge Ranking / Deduplication / Expiration / Confidence 机制与
ACTIVE → STALE → EXPIRED 生命周期；历史知识真正参与决策（历史失败率 → 风险权重 / 执行优先级提升）。
