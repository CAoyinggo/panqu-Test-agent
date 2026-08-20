# Phase 50 总结：Benchmark 候选并入（Review → Benchmark）

> 版本：v4.25.0（被测平台）｜日期：2026-08-20｜前置：Phase 49（Eval → Feedback 桥接，v4.24.0）

## 一、目标与闭环

Phase 49 已能把真实 Evaluation 失败桥接为 `PENDING_REVIEW` 候选，并由人工批准为 `APPROVED`。Phase 50 完成任务书 43.21 的终点：把已批准候选真正并入版本化 Benchmark Registry，使后续 Continuous Evaluation 使用扩充后的真实基准。

```text
真实评测失败 → Benchmark Candidate → 人工 Review(APPROVED)
             → Merge → Benchmark v2/v3 + HUMAN Ground Truth
             → 后续真实评测使用新版本
```

## 二、架构与实现

### 并入核心

- `src/ai-quality/benchmark-merge.ts` 新增 `mergeApprovedCandidates`、`mergeOne`、`candidateMatchesSource`。
- 仅查询并处理 `APPROVED` 候选；`PENDING_REVIEW`、`REJECTED`、`MERGED` 不会进入并入流程。
- 按候选 `domain + caseId` 从当前领域最新版 Benchmark 查找真实源用例；新用例复用源 `input` 与 `groundTruth`。
- 找不到真实源用例时保留候选 `APPROVED`，记录无法解析原因并跳过，不构造虚假输入。
- 新用例使用 `<sourceCaseId>~m<N>` 唯一 ID，metadata 记录 candidateId、feedbackId、reviewer、reviewedAt、benchmarkOrigin。

### Benchmark 与 Ground Truth

- `BenchmarkRegistry.extendWithCases(domain, extraCases)` 继承领域最新版全部用例并创建下一版本，如 `RISK_BENCHMARK_v1 → v2 → v3`。
- 按 case id 去重；无新增用例时保持当前版本，同名版本禁止覆盖。
- 每条并入用例登记 `source=HUMAN`、`confidence=1` 的 Ground Truth，未经登记不得声称 Accuracy。
- Service 快照新增 `benchmarkDefinitions` 与 `groundTruth`；恢复 Phase 49 旧快照时若字段缺失，自动回退默认 v1 Registry/Ground Truth，避免升级后空注册表。

### 状态机与审计

- `BenchmarkCandidateStatus` 新增 `MERGED`。
- `markMerged` 仅允许 `APPROVED → MERGED`，写入 `mergedCaseId` 与 `mergedBenchmark`；重复并入受状态机与 ID 去重双重保护。
- Service 为每条落地候选和整体操作写入 `ImprovementAudit`，可追溯执行人、目标版本、用例和跳过原因。

## 三、对外能力

### Service

- `mergeBenchmarkCandidates(by, { candidateIds?, domains? })`：组合 Candidate Store、Benchmark Registry、Ground Truth Registry 与 Audit。
- `evaluationReport(domains?)` 和 Continuous Evaluation 使用当前 Registry，因此 v2/v3 新用例会真实参与后续评测。

### API

- `POST /api/ai-quality/benchmark-candidates/merge`
- Body 可选：`candidateIds: string[]`、`domains: EvaluationDomain[]`。
- 仅具有 `RELEASE_APPROVE` 权限的人工角色可执行；未认证返回 401，QA 返回 403。
- 返回 merged、skippedUnresolvable、skippedNotApproved、mergedCases、benchmarkVersions 与真实提示信息。

### CLI

- `npm run agent:benchmark:merge -- --by <human>`
- 支持 `--candidate=<id>`（可多次）、领域过滤和 `--json`。
- 无可并入候选或缺少真实源用例时明确输出原因，不静默伪造。

### Web

- 「AI 改进 → Benchmark 扩充」新增“已并入”指标卡。
- 新增“并入已批准候选 → 新 Benchmark 版本”按钮；无 APPROVED 候选或非审批角色时禁用。
- 表格新增并入凭据列，展示 `mergedBenchmark / mergedCaseId`；`MERGED` 使用正向状态展示。

## 四、测试与验收

| 层级 | 命令 | 结果 |
| --- | --- | --- |
| Phase 50 单元 | `npm run agent:ai:unit` | 101/101（新增 benchmark-merge 8 项） |
| Phase 50 集成 | `npm run agent:ai:integration` | 29/29（新增 merge API 5 项） |
| 非浏览器 E2E | `npm run agent:ai:e2e` | 9/9（新增 S9） |
| AI Improvement 浏览器 E2E | `npm run web:e2e:ai` | 16/16 |
| 全量 Web E2E | `npm run web:e2e:test` | 103/103 |
| 全量 Vitest | `npm test` | 1789 通过 / 18 skip / 0 失败 |
| Platform 单元 / 集成 / E2E | `platform:test` / `platform:integration` / `platform:e2e` | 227 / 94 / 16 全绿 |
| Platform 健康检查 | `npm run platform:health` | `HEALTHY`（9 项检查全部通过） |
| Agent 核心 / Eval / E2E / Autonomous E2E | 对应四个历史脚本 | 450 / 8 / 2 / 26 全绿；自主流水线 6 场景决策与退出码一致 |
| Phase 39 / Phase 40 | `npm run phase39:test` / `npm run phase40:test` | 全绿（workflow 49、integration 94、platform E2E 16、Phase 40 专项 24） |
| 最终 Web 历史入口 | `npm run web:e2e` | 103/103 |

所有交接清单脚本均真实执行并以退出码 0 完成；无失败被跳过或伪装为通过。

## 五、不可破坏的铁律

1. **只并入 APPROVED**：必须先经过人工 Review，禁止 AI 自批或自动并库。
2. **禁止伪造输入**：找不到真实源用例即跳过，不能为完成并入而凭空构造 input。
3. **Ground Truth 必须登记**：并入用例登记 HUMAN Ground Truth，否则不得纳入 Accuracy。
4. **幂等且版本化**：MERGED 不可重复处理；重复 case id 去重；每次有效扩充创建新版本，不覆盖历史版本。
5. **人工门禁与全量审计**：API 使用 RELEASE_APPROVE，CLI 强制 `--by <human>`，操作及跳过结果完整留痕。
