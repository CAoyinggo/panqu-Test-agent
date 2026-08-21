# Phase 51.1：Multi-Project Evaluation Isolation

> 基线版本：v4.25.0｜基线提交：`35aeccd`｜日期：2026-08-21｜数据分类：REAL（仓库扫描/功能测试）、SIMULATED（E2E 用户与项目）

## Audit：Phase 50 实际状态

| 项目 | 扫描结论 |
| --- | --- |
| Phase 49 / 50 | 两阶段提交和实现均存在；Phase 50 已完成 Review → Benchmark、HUMAN Ground Truth、MERGED、版本化、API/CLI/Web |
| Current Version / Commit | `4.25.0` / `35aeccd`；扫描时工作树 clean，main 比远端领先 6，未 push |
| Current Tests | 交接基线 Vitest 1789 PASS / 18 SKIP；AI 101/29/9、Platform 227/94/16、Agent 450/8/2/26、Web E2E 103/103 |
| Evaluation Scale | `AIQualityService` 进程内同步执行；单服务全领域 238 个默认 Benchmark case；没有独立 Evaluation 调度器 |
| Benchmark Storage | Registry 版本化，但快照按版本保存完整 case 集；扩充版本会复制前版内容，尚无内容寻址去重 |
| GroundTruth Storage | `GroundTruthRegistry` 内存 Map，并进入 AI Quality JSON 快照；基线为单实例边界 |
| Worker Capacity | 平台通用 Scheduler/Worker 已存在，默认 `maxConcurrency=2`；AI Evaluation 尚未接入专用 Worker Pool |
| Queue Capacity | 平台 Run 队列存在；AI Evaluation 没有持久作业队列、租约、requeue 或去重提交 |
| Telemetry Scale | 平台有原始 telemetry 与按 Run 查询；AI Quality 历史为快照数组，Dashboard 尚依赖原始/全量读取 |
| API / CLI / Web | Phase 50 能操作闭环，但 AI Quality API 闭包、CLI 单文件、Web 页面均隐式绑定唯一实例 |

### Current Limitations 与 Phase 51 Minimal Path

最优先的真实缺口是 AI Evaluation 状态未按项目物理分区：平台 Run/Telemetry 已 project scoped，但 Benchmark、Ground Truth、Evaluation History、Knowledge 与 Audit 共享同一个 `AIQualityService`。因此最小安全路径是先建立强制 `projectId` 分区和 RBAC 校验，再把并发执行、队列、生命周期、去重存储、聚合与恢复建立在该分区键上。

## Implement

- 新增 `ProjectAIQualityRegistry`：每项目独立创建/挂载 `AIQualityService`，分区覆盖 Benchmark、Ground Truth、Evaluation、History、Telemetry、Feedback、Knowledge、Audit；支持多项目快照、恢复和原子持久化。
- API 从 JWT scopes、query/body/header 解析项目；显式项目必须存在且通过 `assertProjectAccess`。既有 AI 路由全部改为分区服务，并新增 `/api/evaluation/{report,benchmarks,ground-truth,history,telemetry,scope}`。
- CLI 支持全局 `--project <id>`，状态写入 `data/ai-quality-projects/<project>.json`；`wan3` 只读兼容旧单文件，写入采用临时文件原子替换。
- Web 登录保留后端 project scopes；AI Evaluation 请求自动携带 `projectId`；AI Improvement 增加 Evaluation Project 选择器，无 scope 的管理角色可读取项目列表切换。
- Web E2E 同时装配 `wan3` 与 `order` 两套独立服务和可识别反馈，验证 qa-a/qa-b 正向可见性、反向零泄漏和跨项目 API 403。

## Verification

| 层级 | 真实命令 | 结果 |
| --- | --- | --- |
| TypeScript / Web build | `npx tsc --noEmit && npm --prefix web run build` | PASS |
| Unit + Integration focused | `vitest run evaluation-isolation ... ai-improvement-api ... ai-benchmark-merge-api` | 21/21 PASS |
| Web E2E regression | Playwright `ai-improvement.spec.ts multi-project.spec.ts` | 18/18 PASS |
| Multi-project Web E2E | Playwright `multi-project.spec.ts` | 2/2 PASS |
| Full Vitest regression | `npm test` | 1795 PASS / 18 SKIP / 0 FAIL |

## Isolation Acceptance

- Cross Project Access：0；qa-a → order 和 qa-b → wan3 均 DENY。
- Cross Project Data Leakage：0；Benchmark、Ground Truth、反馈、历史、Telemetry、Knowledge、Audit 的可变状态无共享引用。
- Unauthorized GroundTruth / Benchmark Modification：0；既有 RELEASE_APPROVE 人工门禁继续生效，且先执行 project scope 校验。
- Compatibility：未显式传 `projectId` 的既有测试和单项目部署继续映射 `wan3`；新部署可注入多项目 Registry。

Phase 51.1 不声称完成并发容量或生产吞吐；这些属于后续 LOAD TEST 阶段。
