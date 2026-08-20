# Phase 46 总结：AI 质量优化、反馈学习与持续改进闭环

> 版本：v4.21.0（被测平台）｜ 日期：2026-08-20 ｜ 前置：Phase 45（AI 测试质量评测）
> 目标：让 AI Test Platform 形成「测试 AI 本身」的持续优化闭环：
> Failure → Error Analysis → Root Cause → Improvement Proposal → Candidate → Offline Evaluation →
> Regression Benchmark → Approval → Activate → Observe → Learn。

## 一、目标与核心原则

在 Phase 45（Evaluation / Benchmark / Ground Truth / Score / Regression Gate / Model Comparison /
Decision Replay）之上，建立真正的 AI 自身持续优化闭环。

核心原则：

1. **统一反馈结构**：所有模块（Human / RCA / Defect / Release / Healing / Benchmark / Production /
   Flaky）共用一个 `AIFeedback` 契约，禁止各自维护不同的 Feedback。
2. **先离线评测再上线**：禁止「发现问题 → 直接修改生产 Prompt」。必须
   `Proposal → Sandbox → Benchmark → Compare Baseline → Regression → Approval → Activate`。
3. **人工门禁**：Production Prompt / Model / Knowledge / Healing / Release 策略变更必须人工批准，
   **禁止 AI 自批**（RELEASE_APPROVE 权限，RELEASE_MANAGER / ADMIN）。
4. **安全上线**：新 Prompt / Model 先 Shadow（只读不生效），再 Canary（5% → 20% → 50% → 100%），
   异常自动停止扩展、严重异常自动回滚。
5. **Deterministic First**：错误分类 / 聚类 / 提案 / 评测全部确定性规则（可复现、不消耗 token）。
6. **完整审计**：每个优化动作记录 proposalId / actor / baseline / candidate / benchmark / approvalId /
   metrics / decision / timestamp，链路可追溯。

## 二、交付物清单

### 1. AI Quality 核心模块（src/ai-quality/）

```
src/ai-quality/
├── contract.ts            统一契约（Feedback / Taxonomy / Cluster / Proposal / Version / Experiment / Rollback / Audit）
├── feedback.ts            Feedback Registry（43.1）+ 错误分类推导（43.3）
├── error-analysis.ts      Error Cluster（43.4，确定性聚类键 domain+category）
├── improvement.ts         Improvement Proposal Store（43.5/43.6，Gate 43.11）
├── versioning.ts          Prompt / Model 版本管理（43.7/43.8）+ A/B 对比（43.9）
├── experiment.ts          Shadow / Canary（43.13/43.14）+ 自动回滚（43.12）
├── knowledge-learning.ts  Knowledge Learning / Quality / Decay（43.15/43.16/43.17）
├── ops.ts                 Continuous Evaluation + Benchmark 自动扩充 + Change Impact + Release Gate + Audit（43.19-43.24）
├── service.ts             聚合服务（ingest / autoProposals / aiQualityReport / snapshot / persistToFile）
└── index.ts               统一出口
```

### 2. API（43.26，src/platform/api/server.ts）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | /api/ai-feedback | 反馈列表（可按 domain/source/verified 过滤） | 认证 |
| POST | /api/ai-feedback/:id/verify | 人工核验反馈 | RELEASE_APPROVE |
| GET | /api/ai-errors | 错误聚类 | 认证 |
| GET | /api/ai-improvements | 改进提案列表 | 认证 |
| POST | /api/ai-improvements/:id/approve | 人工审批通过 | RELEASE_APPROVE |
| POST | /api/ai-improvements/:id/reject | 人工拒绝 | RELEASE_APPROVE |
| GET | /api/prompts | Prompt 版本列表 | 认证 |
| GET | /api/prompts/:id/versions | 同 key 全部版本 | 认证 |
| GET | /api/models | Model 版本列表 | 认证 |
| GET | /api/experiments | Shadow / Canary 实验 | 认证 |
| POST | /api/experiments | 创建实验（SHADOW/CANARY） | RELEASE_APPROVE |
| GET | /api/knowledge/review | 知识候选 + 生产知识 + 质量 | 认证 |
| GET | /api/ai-quality | AI 质量聚合报告 | 认证 |
| GET | /api/ai-quality/trends | 质量趋势 | 认证 |

### 3. CLI（bin/ai-quality-cli.ts，43.25）

| 命令 | 功能 |
| --- | --- |
| `agent ai-quality` | AI 质量聚合视图 |
| `agent feedback list` / `feedback verify` | 反馈列表 / 核验 |
| `agent eval errors` / `eval improve` | 错误聚类 / 改进提案 |
| `agent prompt list` / `prompt compare` | Prompt 版本 / A/B 对比 |
| `agent model list` / `model compare` | Model 版本 / A/B 对比 |
| `agent improvement list` / `approve` / `reject` | 提案管理（审批需人工） |
| `agent knowledge review` | 知识 Review |
| `agent canary status` / `promote` / `rollback` | Canary 管理 |

### 4. Web Dashboard（web/src/pages/AIImprovement.tsx）

导航「AI 改进」页面，含 7 个 Tab：

- 待核验反馈（verify）
- 错误聚类
- 改进提案（approve / reject）
- Prompt / Model 版本
- Shadow / Canary 实验
- 知识 Review
- AI 质量

审批类操作仅 RELEASE_MANAGER / ADMIN 可执行（非审批角色只读，按钮禁用）。

### 5. 测试

| 文件 | 数量 |
| --- | --- |
| tests/unit/feedback-registry.test.ts | 10 |
| tests/unit/error-analysis.test.ts | 5 |
| tests/unit/improvement-proposal.test.ts | 12 |
| tests/unit/prompt-model-version.test.ts | 6 |
| tests/unit/knowledge-learning.test.ts | 5 |
| tests/unit/shadow-canary.test.ts | 6 |
| tests/unit/ai-improvement-ops.test.ts | 12 |
| tests/unit/ai-quality-service.test.ts | 12 |
| tests/integration/ai-improvement-api.test.ts | 10 |
| tests/e2e/ai-improvement-flow.test.ts | 4 |
| tests/e2e/ai-quality-dashboard.test.ts | 4 |
| **合计** | **86** |

### 6. 文档（docs/ai-quality/ + 本总结）

- `docs/ai-quality/feedback.md`：统一反馈结构与接入渠道
- `docs/ai-quality/error-analysis.md`：错误分类与聚类
- `docs/ai-quality/improvement.md`：改进提案与离线评测
- `docs/ai-quality/prompt-versioning.md`：Prompt 版本管理
- `docs/ai-quality/model-versioning.md`：Model 版本管理与公平比较
- `docs/ai-quality/shadow-canary.md`：A/B 评测 / Shadow / Canary / 多目标评分
- `docs/ai-quality/knowledge-learning.md`：知识学习 / 质量 / 衰减
- `docs/ai-quality/rollback.md`：自动回滚 / 审计 / AI Release Gate
- `docs/phase46-summary.md`：本总结

## 三、核心 E2E（S1-S8）

| 编号 | 场景 | 验证 |
| --- | --- | --- |
| S1 | Feedback | AI 预测 P2 → 人工更正真值 P0 → 反馈 `INCORRECT`（未核验）→ 人工核验 `verified=true` |
| S2 | Error Analysis | 反馈 → ErrorCluster（domain + taxonomy 聚类） |
| S3 | Improvement | ErrorCluster → Proposal（自动生成、幂等） |
| S4 | Evaluation | Proposal → Benchmark → baseline/candidate Score + Gate PASS |
| S5 | Approval | Candidate → 人工审批 → `APPROVED` |
| S6 | Shadow | Candidate → Shadow → Compare（只读，不生效） |
| S7 | Canary | 5% → 20% → 50% → 100% → PROMOTED |
| S8 | Rollback | 生产 Quality Regression → 自动回滚 → Baseline Restore + 审计 |

以上 8 个场景在 `tests/unit/ai-quality-service.test.ts`（闭环单元）+ `tests/e2e/ai-improvement-flow.test.ts`
（HTTP 端到端）中全部通过。

## 四、验收结果

| 验收项 | 结果 |
| --- | --- |
| `npm run build` | 通过（tsc + copy-assets 无错误） |
| Phase 46 新增测试（11 文件） | **86 / 86 通过** |
| 关键安全指标（falsePass / p0Miss / unsafeHealing） | 全部为 0 |
| 人工门禁（RELEASE_APPROVE） | QA 写操作 403；RELEASE_MANAGER 成功 |
| 未授权访问 | 未认证读/写 → 401 |
| 持久化 | persistToFile / loadFromFile：反馈 / 提案 / 实验 / 审计跨重启保留 |

## 五、最终质量条件（可真实回答）

平台现在能真实回答：

- 为什么 AI 错了？→ `ErrorTaxonomy` 分类 + `suspectedCause` 根因启发（43.3/43.4）
- 为什么认为它错了？→ `AIFeedback`（prediction vs actual + source + channel + verified）
- 错误集中在哪里？→ `ErrorCluster`（domain + category + count + cases）
- 怎么改？→ `ImprovementProposal`（problem + hypothesis + target + risk）
- 改了以后有没有变好？→ 离线评测 baseline vs candidate（43.6）
- 变好有没有副作用？→ 多目标评分（Accuracy / Safety / Latency / Cost，43.10）
- 成本有没有增加？→ `cost` / `latencyMs` 对比（43.9）
- 上线后有没有回归？→ 观测 / Canary 各阶段检查 + 回归门（43.14/43.24）
- 如果回归怎么办？→ 自动回滚恢复基线 + 审计（43.12/43.19）

## 六、下一步建议

1. **真实 LLM 评测接入**：当前闭环全部为确定性规则（model=rules，cost=0）。接入真实 LLM 后，
   Feedback 将来自真实模型预测 vs Ground Truth，触发真实改进循环。
2. **Continuous Evaluation 定时化**：将 Nightly / Weekly / Release 评测接入调度（当前 ops 已提供
   ContinuousEvaluation 能力），Critical Regression 自动 Alert + Block Release。
3. **Benchmark 自动扩充生产化**：将真实 Production Failure / Human Correction / RCA Error /
   Release Miss / Unsafe Healing / Defect Error 自动沉淀为 Benchmark 新用例（当前已提供
   `addBenchmarkCase` 能力与候选机制），使 Benchmark 越来越接近真实业务。
4. **状态文件接入部署**：配置 `aiQualityStateFile`，使改进闭环状态在服务器重启后保留（当前已支持）。
