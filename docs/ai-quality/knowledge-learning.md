# Knowledge 学习与质量（Knowledge Learning / Quality / Decay）

> Phase 46（43.15 / 43.16 / 43.17）：真实错误可进入 Knowledge，但必须有 Source / Confidence /
> Verification / Version；Knowledge 质量持续统计，权重按 usage / success / failure / age 综合计算。

## Knowledge Learning（43.15）

真实错误进入 Knowledge 的流程：

```
Error → Verified → Knowledge Candidate → Review（人工） → Activate
```

**禁止**：LLM 自己产生知识 → 直接进入生产 Knowledge。

候选（`KnowledgeCandidate`）默认 `PENDING_REVIEW`，必须经人工 `approveCandidate` 才激活为生产
Knowledge（`KnowledgeItem`，带 `verified / version`）。

```ts
const c = svc.knowledge.createCandidate({ sourceRef, category, content, source, confidence });
svc.knowledge.approveCandidate(c.id, 'qa-admin'); // 人工 Review → 激活
```

## Knowledge Quality（43.16）

每条知识记录：

```ts
interface KnowledgeItem {
  id: string;
  category: string;
  content: string;
  source: string;
  confidence: number;
  verified: boolean;
  version: number;
  usageCount: number;    // 使用次数
  successCount: number;  // 成功次数
  failureCount: number;  // 失败次数
  lastUsedAt?: string;
  status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
}
```

质量统计（`qualityMetrics()`）：

- **Hit Rate**：总使用率
- **Success Rate**：成功使用 / 总使用
- **Outdated Rate**：超过 90 天未使用
- **Unused Rate**：从未使用

## Knowledge Decay 升级（43.17）

`EffectiveWeight = f(usage, success, failure, age)`，不再只按时间下降：

- 持续有效的旧知识（successRate 高、usage 多）→ **减缓衰减**
- 频繁导致错误（failure 比例高）→ **快速降权**
- 无使用记录 → 按时间衰减（90 天内 1，之后线性降至最低 0.1）

```ts
svc.knowledge.recordUsage({ knowledgeId, outcome: 'success' | 'failure' });
svc.knowledge.effectiveWeight(item); // 综合权重
```

## API / CLI

- `GET /api/knowledge/review`（候选 + 生产知识 + 质量指标）
- `agent knowledge review`
