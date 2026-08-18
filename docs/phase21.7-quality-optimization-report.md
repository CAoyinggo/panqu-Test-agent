# Phase 21.7 变更报告：Quality Optimization

> 阶段目标：建立 Test Quality Score（九维度）→ Feature Quality Score 与多维趋势，
> 并实现 Flaky Lifecycle（STABLE→SUSPECTED→FLAKY→QUARANTINED→FIXED→STABLE，
> 连续 N 次稳定自动恢复），复用既有 classifyStatus 分类信号。

## 一、本阶段变更（全部纯增量，未修改既有文件）

### 1. `src/quality/quality-schema.ts`（Test Quality Score）

九维度加权（权重合计 1.0）：

| 维度 | 权重 | 方向 |
|---|---|---|
| Coverage | 0.15 | 越高越好 |
| Risk Detection | 0.15 | 越高越好 |
| RCA Accuracy | 0.15 | 越高越好 |
| False Positive Rate | 0.10 | 越低越好（取反） |
| False Negative Rate | 0.10 | 越低越好（取反） |
| Flaky Rate | 0.10 | 越低越好（取反） |
| Healing Success | 0.10 | 越高越好 |
| Human Intervention Rate | 0.10 | 越低越好（取反） |
| Defect Duplicate Rate | 0.05 | 越低越好（取反） |

- `computeTestQualityScore(metrics)` → `{ score: 0~100, dimensions }`（各维度归一值供趋势/报告）
- `gradeOf(score)`：A ≥90 / B ≥80 / C ≥70 / D ≥60 / F

### 2. `src/quality/quality-tracker.ts`（Feature Quality Score + 趋势）

- `record`：自动计算得分与等级，落为 `QualityRecord`（scope test/feature + version/model/environment 归属）
- `featureScore(feature)`：该 feature 最新质量得分（Feature Quality Score）
- `trend(by)`：按 **day / week / version / feature / model / environment** 分组，输出 `{ key, count, avgScore }`

### 3. `src/quality/flaky-lifecycle.ts`（Flaky 生命周期）

状态机：`STABLE → SUSPECTED → FLAKY → QUARANTINED → FIXED → STABLE`

| 流转 | 触发 |
|---|---|
| STABLE → SUSPECTED | 稳定用例出现失败 |
| SUSPECTED → STABLE | 恢复通过，解除怀疑 |
| SUSPECTED → FLAKY | 疑似后再次失败，确认 Flaky |
| FLAKY → QUARANTINED | 持续失败，自动隔离 |
| QUARANTINED → FIXED | 隔离期连续 N 次通过（默认 3，中途失败重置计数） |
| FIXED → STABLE | 修复后持续稳定一次，恢复正常 |
| FIXED → FLAKY | 修复后复发 |

- `syncFromPassRate(caseId, passRate, runs)`：**复用既有 `classifyStatus`**（FLAKY/UNSTABLE → FLAKY 状态；BROKEN 不属 Flaky 不改变状态）
- 手动 `quarantine` / `markFixed`；`history` 全量流转事件；`summary` 状态计数 + 隔离名单
- `save` / `static load`（损坏文件降级为空）

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:quality:test` | 1 文件 / 11 用例 PASS |
| `npm run agent:test` | 450 用例 PASS（无回归） |
| `npm test` | 835 用例 PASS + 18 skipped（824 → 835，+11） |

关键验证：完整生命周期循环（含隔离期失败重置计数）、FIXED 复发回退、classifyStatus 信号同步、六维趋势分组。

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| Test Quality Score 九维度 | ✅ 权重合计 1.0，确定性计算 |
| Feature Quality Score | ✅ featureScore |
| 按日/周/版本/Feature/Model/Environment 趋势 | ✅ trend 六维 |
| Flaky Lifecycle 六态循环 | ✅ 含自动隔离与自动恢复 |
| 连续 N 次稳定自动恢复 | ✅ recoveryThreshold（默认 3） |
| 复用既有 Flaky 能力 | ✅ classifyStatus 作为分类信号 |

## 四、下一步

进入 **Phase 21.8 Production Operations**：统一 AI Test Operations 运维视图（`agent:dashboard` JSON/HTML）、
Release Gate（P0=PASS、P1≥98%、Coverage≥90%、Critical Defect=0）、Model Evaluation 横向对比。
