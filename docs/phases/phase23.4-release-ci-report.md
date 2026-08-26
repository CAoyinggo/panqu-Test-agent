# Phase 23.4：Autonomous Release → CI/CD 报告

> 目标：把 Autonomous Release Decision 接入真实 CI/CD Pipeline，形成统一 Release Contract + 统一 CI Exit Code + 真实流水线门禁。

## 一、完成内容

### 1. 统一 Release Contract（`src/release-ci/release-ci.ts`）

新增 `ReleaseDecision` 契约，完整 10 字段：

```ts
interface ReleaseDecision {
  releaseId: string;
  runId: string;
  feature?: string;
  decision: 'PASS' | 'REVIEW' | 'BLOCK' | 'SYSTEM_ERROR';
  confidence: number;
  checks: ReleaseCheck[];
  evidence: Evidence[];
  blockReasons: string[];
  recommendations: string[];
  traceId: string;
  createdAt: string;
}
```

输出路径：`output/<date>/<feature>/release-decision.json`（`releaseDecisionPath` / `writeReleaseDecision`）。

### 2. CI Exit Code（任务书九）

```text
0 = PASS
1 = BLOCK
2 = REVIEW
3 = SYSTEM_ERROR
```

`releaseExitCode` 统一映射；**REVIEW 绝不返回 0**。真实 shell 验证全部正确：

```text
fixture=pass   decision=PASS          expect=0 got=0 OK
fixture=review decision=REVIEW        expect=2 got=2 OK
fixture=block  decision=BLOCK         expect=1 got=1 OK
fixture=error  decision=SYSTEM_ERROR  expect=3 got=3 OK
```

### 3. CLI（`bin/release-gate.ts`）

```bash
node dist/bin/release-gate.js --run-id run-xxxx [--date yyyy-mm-dd] [--feature wan3] [--json]
node dist/bin/release-gate.js --decide '<ReleaseDecisionInput JSON>' [--feature wan3] [--json]
```

对应命令：`npm run agent:release:ci`（build + CLI）。

### 4. 自治预算防无限循环（任务书二十）

`AutonomousBudget` 新增 `maxDecisionDepth`（默认 20）、`maxConsecutiveReplans`（默认 2）：

- `checkAutonomousBudget` 用 `>` 判定超限（允许等于阈值），超过 → `AUTONOMOUS_STOP`，输出 `reason/budget/trace`。
- `runAutonomousRegression` 每次执行递增 `decisionDepth`；FAIL 递增 `consecutiveReplans`，PASS 重置连续计数。
- 现有 19 个自治回归测试全部通过，不破坏 22.6 场景。

### 5. CI 门禁脚本（`scripts/ci/agent-release-gate.mjs`）

- 读取 `run-summary.json`（23.5 端到端流水线生成）或确定性内置 fixture（`GATE_FIXTURE=pass|block|review|error`）。
- 聚合为 `ReleaseDecisionInput` → 调用规则引擎 → 写 `release-decision.json` → 退出码 0/1/2/3。
- Deterministic First：决策由规则引擎推导，脚本不调用 LLM。

### 6. GitHub Actions（`.github/workflows/agent-release-gate.yml`）

流程：Checkout → Install → Build → Agent Preflight → Autonomous Regression → CI Exit Code 自检 → Autonomous Pipeline → Release Decision → Gate。

```text
PASS         → workflow success
BLOCK        → workflow failure
SYSTEM_ERROR → workflow failure
REVIEW       → 触发独立 approval job（environment: release-approval）
```

REVIEW 门禁：`approval` job 仅在决策为 REVIEW 时运行，绑定 `environment: release-approval`（需配置 Required reviewers）。未人工批准前该 job 保持 pending，workflow 不会成功；**AI 生成的决策只能触发审批，无法绕过 GitHub Environment Approval**。

### 7. GitLab CI（`.gitlab-ci.yml`）

新增 `agent-release-gate` job（deploy 阶段，需 test + 安全扫描）：

```text
0=PASS → 继续发布
1=BLOCK → job 失败，阻断
2=REVIEW → job 失败并提示人工评审（REVIEW 绝不返回 0）
3=SYSTEM_ERROR → job 失败
```

`release:image` 增加 `needs: agent-release-gate`，门禁不通过则镜像不会构建推送。

## 二、测试与回归

```text
npm run agent:release-ci:test   11 PASS
npm test                        1008 PASS + 18 skipped
npm run agent:test              450 PASS
```

## 三、验收指标对照

| 指标 | 结果 |
|------|------|
| Release PASS | ≥ 2（BASE + fixture=pass，exit 0） |
| Release REVIEW | ≥ 2（Scenario 5 + fixture=review，exit 2） |
| Release BLOCK | ≥ 2（Scenario 6 + fixture=block，exit 1） |
| CI Exit Code | 100%（0/1/2/3 真实 shell 验证） |
| 不破坏现有流水线 | npm test / agent:test 全部通过 |

## 四、说明

- `agent:autonomous:e2e` 命令在 23.5 落地，届时 workflow 的 Autonomous Pipeline 步骤会生成真实 `run-summary.json`；当前阶段使用确定性汇总兜底。
- REVIEW 的 GitLab 实现采用「job 失败 + 阻断发布」语义，保证 REVIEW 绝不静默通过；人工评审后修复或批准再重跑。
