# 改进提案（Improvement Proposal）

> Phase 46（43.5 / 43.6）：根据 Error Cluster 自动生成改进提案，且**必须先离线评测、经人工审批后才能上线**。

## 提案结构

```ts
interface ImprovementProposal {
  id: string;
  clusterId?: string;            // 来源错误聚类
  target: 'PROMPT' | 'RULE' | 'MODEL' | 'TOOL' | 'KNOWLEDGE' | 'DATA';
  problem: string;               // 问题
  hypothesis: string;            // 假设
  expectedImprovement: string;   // 预期改进
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  evidence: unknown[];
  status: 'PROPOSED' | 'EVALUATING' | 'APPROVED' | 'REJECTED' | 'ACTIVATED' | 'ROLLED_BACK';
  baselineScore?: number;        // 基线得分
  candidateScore?: number;       // 候选得分（离线评测后）
  benchmark?: string;
  benchmarkVersion?: string;
  qualityScore?: number;         // 多目标评分（43.10）
  gateVerdict?: 'PASS' | 'REVIEW' | 'BLOCK';
  approvalId?: string; approvedBy?: string; approvedAt?: string;
  rejectedReason?: string;
  experimentId?: string;         // 关联 shadow/canary 实验
  rollbackId?: string;
  createdAt: string; updatedAt: string;
}
```

## 自动生成（43.5）

`svc.autoProposals()`：对每个 ErrorCluster 自动生成提案，每个聚类至多一个未处理提案（幂等）。

## 离线评测（43.6）

**禁止**：发现问题 → 直接修改生产 Prompt。

**必须**：

```
Proposal → Sandbox → Benchmark → Compare Baseline → Regression → Approval → Activate
```

`proposals.recordEvaluation()` 记录 baseline / candidate 得分并给出 `gateVerdict`。

## 提案状态机

```
PROPOSED → EVALUATING → APPROVED → ACTIVATED
                │           │
                └── REJECTED  └── ROLLED_BACK（回归自动回滚）
```

## 人工审批

以下操作必须由 `RELEASE_APPROVE` 权限（RELEASE_MANAGER / ADMIN）执行，**禁止 AI 自批**：

- `POST /api/ai-improvements/:id/approve`
- `POST /api/ai-improvements/:id/reject`

## API / CLI

- `GET /api/ai-improvements`
- `agent improvement list` / `approve` / `reject`
