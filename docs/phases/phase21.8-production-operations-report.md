# Phase 21.8 变更报告：Production Operations

> 阶段目标：统一 AI Test Operations 运维视图（健康/执行/失败/Flaky/RCA/Defect/Healing/
> 成本/Coverage/Knowledge/Agent Quality），`npm run agent:dashboard` 输出 JSON/HTML，
> Release Gate 发布门禁，Model Evaluation 模型横向对比。

## 一、本阶段变更（全部纯增量，未修改既有文件）

### 1. `src/operations/operations-schema.ts` + `operations-aggregator.ts`

- `buildOperationsView(input)`：聚合 11 类运维数据为统一快照
  - 总体状态判定：健康检查失败 / 通过率 <50% → **CRITICAL**；开放缺陷 / 隔离用例 → **DEGRADED**；否则 **HEALTHY**
  - `highlights` 关注项按严重度分级：`[CRITICAL]` 健康失败/通过率过低、`[HIGH]` 严重/开放缺陷、`[MEDIUM]` Flaky 隔离/覆盖率 <90%/质量分 <70
  - 自愈恢复率 = recovered / applied
- `renderOperationsHtml(view)`：自包含 HTML 运维页（状态徽章 + 11 个分区卡片 + 关注项列表，CJK 字体，HTML 转义）

### 2. `src/operations/release-gate.ts`（发布门禁）

`evaluateReleaseGate(input)` 四项检查：

| 检查项 | 规则 |
|---|---|
| P0 | 全部通过（P0 = PASS） |
| P1 | 通过率 ≥ 98%（可配） |
| Coverage | ≥ 90%（可配） |
| Critical Defect | = 0 |

全部达标 → `RELEASE=PASS`，任一不满足 → `RELEASE=BLOCK` 并列出全部阻断原因。

### 3. `src/operations/model-evaluation.ts`（模型横向对比）

`compareModels(results)`：同一套件在 Model A/B/C 上的 Quality / Latency / Cost / Failure 四维归一化（最优=1），等权综合评分：
- 输出排名（同分按模型名字典序）、综合冠军、各维度最优模型、结论摘要
- 零值/空输入边界安全，完全确定性

### 4. `bin/dashboard.ts` + 脚本

- `npm run agent:dashboard`：自动聚合 `output/health.json` 与 `agent-summary.json`（支持 `--input data.json` 合并显式数据），输出 `operations-dashboard.json` + `operations-dashboard.html`
- `package.json`：新增 `agent:release:test`、`agent:dashboard`

## 二、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:release:test` | 1 文件 / 14 用例 PASS |
| `node dist/bin/dashboard.js` | 实际运行成功，输出 JSON + HTML |
| `npm run agent:test` | 450 用例 PASS（无回归） |
| `npm test` | 849 用例 PASS + 18 skipped（835 → 849，+14） |
| `npm run agent:eval` | 8 用例 PASS |
| `npm run agent:e2e` | 2 用例 PASS |

## 三、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 统一 AI Test Operations（11 类数据） | ✅ buildOperationsView |
| `npm run agent:dashboard` 输出 JSON/HTML | ✅ 实际运行验证 |
| Release Gate：P0=PASS、P1≥98%、Coverage≥90%、Critical Defect=0 | ✅ evaluateReleaseGate |
| Model Evaluation 横向对比（Quality/Latency/Cost/Failure） | ✅ compareModels |
| 复用既有 health/dashboard/ci-result | ✅ 聚合 health.json 与 agent-summary.json |

## 四、下一步

Phase 21 全部 8 个子阶段完成，进入最终验收（见 phase21-final-acceptance-report.md）。
