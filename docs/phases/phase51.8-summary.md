# Phase 51.8：Production Scale Acceptance

> 版本：v4.26.0｜日期：2026-08-21｜容量数据分类：LOAD TEST；Web/API/CLI 验收为 REAL execution against deterministic test environment

## Production Acceptance Topology

连续三轮运行以下规模：

- 5 Projects
- 20 scoped users（每项目 4）
- 每轮 500 个真实默认 Benchmark case refs
- 每轮 100 Evaluation jobs
- 10 Workers
- 8 domains：Requirement、Test Design、Risk、Selection、RCA、Defect、Healing、Release

三轮均满足 submitted=100、completed=100、failed=0、queued=0、running=0；每轮 500 case refs 全部进入结果；P0 Miss、False Pass、Unsafe Healing 为 0。这里的用户、项目和流量属于 LOAD TEST，不表述为 production usage。

## API / RBAC / Audit

新增并验证：

- `GET /evaluation/queue|workers|scale`
- `GET /benchmarks/:id/integrity`
- `POST /data/archive|restore`
- `GET /metrics/aggregated|drift`
- `GET /recovery/status`

所有端点继续使用 JWT、Project Scope 和 RBAC。QA 可读取自己项目，跨项目 403；Archive/Restore 需要 RELEASE_APPROVE，QA 写入 403；成功 Archive/Restore 写入 project-scoped audit。

## CLI

Phase 51 CLI 支持 `agent evaluation queue|workers`、`agent benchmark integrity|archive`、`agent data archive|restore`、`agent metrics aggregate|drift`、`agent system scale|recovery`。所有命令只读取显式文件/当前状态；无输入时返回 `source=EMPTY` 和零记录，不生成数据，也不伪称生产结果。

## Web Dashboard / E2E

新增 `/scale`：Evaluation Throughput、Active Workers、Queue、P95/P99、Cost、Data Growth、Archive、Drift、Recovery；支持 Project、Time Range、Model、Benchmark filters；读取 Aggregated Evaluation History；展示 Benchmark checksum integrity、Drift Signals 和 Lifecycle Archive/Restore。

新增的五个套件：`scale.spec.ts`、`multi-project.spec.ts`、`evaluation-history.spec.ts`、`benchmark-integrity.spec.ts`、`drift.spec.ts`。Phase 51 Web 专项 10/10 PASS。

## Safety Acceptance

- Cross Project Access = 0
- Unauthorized Evaluation = 0
- Unauthorized GroundTruth Modification = 0
- Unauthorized Benchmark Modification = 0
- Unauthorized Production AI Change = 0
- Evaluation Loss = 0；Duplicate Terminal Evaluation = 0
- Benchmark / Ground Truth corruption accepted = 0

## Verification

- `npm run phase51:test`：49/49 PASS。
- `npm run phase51:scale`：15/15 PASS；`npm run phase51:recovery`：9/9 PASS。
- `npm run phase51:web`：10/10 PASS。
- TypeScript、root build、Web production build：PASS。
- Phase 51 CLI 8 个只读/状态命令真实执行 exit 0；EMPTY 被如实标注。
- Full Vitest：1838 PASS / 18 SKIP；Full Web E2E：113/113；Web Unit：72/72。
- Agent Core/Eval/E2E/Autonomous：450/8/2/26；Platform Unit/Integration/E2E：227/94/16；Health=HEALTHY。
- Phase 39 / Phase 40：PASS。

完整历史回归与各脚本最终数字见 `docs/phases/phase51-summary.md`。
