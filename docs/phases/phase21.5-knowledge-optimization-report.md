# Phase 21.5 变更报告：Knowledge Optimization

> 阶段目标：知识条目增加 confidence / usageCount / lastUsedAt / source / validUntil，
> 建立 ACTIVE → STALE → EXPIRED 生命周期（避免 Memory 越积越脏），
> 并让历史知识**真正参与决策**（失败率 → 风险权重 → 执行优先级），而不只是显示在报告里。

## 一、本阶段变更（全部纯增量，未修改既有文件）

### 1. `src/knowledge/knowledge-schema.ts`

- `KnowledgeType`：known-issue / failure-pattern / risk-insight / test-insight / environment-fact
- `KnowledgeEntry`：id / type / feature / title / content / **confidence** / **usageCount** / **lastUsedAt** / **source** / **validUntil** / status / tags / stats（决策用统计，如 `{ runs: 30, failures: 11 }`）
- `normalizeCreateKnowledgeInput`：type/feature/title 必填，confidence 0~1（默认 0.5），source 默认 manual
- `generateKnowledgeId(feature)`：`kb-<feature>-<序号>`

### 2. `src/knowledge/knowledge-store.ts`

| 能力 | 实现 |
|---|---|
| Deduplication | `add` 同 feature+type+title 合并：usageCount 累加、confidence 取大、tags/stats 合并、EXPIRED 复活为 ACTIVE |
| Ranking | `rank`：score = confidence×0.5 + 时效（30 天线性）×0.3 + log(使用频率)归一×0.2 |
| Confidence | `touch`：usageCount+1、lastUsedAt 刷新、confidence +0.01（上限 0.99） |
| Expiration | `refreshLifecycle`：ACTIVE→STALE（30 天未引用）、STALE→EXPIRED（90 天未引用或过 validUntil）、ACTIVE 过 validUntil 直接 EXPIRED；返回 `LifecycleTransition[]` |
| 复活 | `revive` 手动复活；同题再 `add` 自动复活 |
| 查询 | `query`：scope active（默认）/ stale / all + feature/type/tags/text 过滤 |
| 持久化 | `save` / `static load`（损坏文件降级为空知识库） |

与 Memory 分工：Memory 存原始执行记录，KnowledgeStore 存提炼后的可决策知识。

### 3. `src/knowledge/knowledge-advisor.ts`（知识参与决策）

- `failureRateOf(entry)`：从 stats 提取失败率（runs/failures，越界截断）
- `adviseFromKnowledge(entries, context)`：仅 ACTIVE + 同 feature + tags 交集命中（无 tags 视为 feature 级通用知识）；
  **riskWeight = 失败率 × 置信度**；失败率 ≥ `PRIORITY_BOOST_THRESHOLD`（0.2）→ `priorityBoost=true`（建议提高执行优先级）；按风险权重降序
- `boostedTagsFromAdvice(advice)`：输出需提权的用例标签集合（供用例 P2 → P1）

### 4. 导出与脚本

- `src/knowledge/index.ts`：统一导出
- `package.json`：新增 `agent:knowledge:test`

## 二、任务书示例场景验证

「过去 30 次：1080P + 10s 失败率 37%」知识（`stats: { runs: 30, failures: 11 }`，tags `['1080P','10s']`，confidence 1）：

```
adviseFromKnowledge → {
  failureRate ≈ 0.367,
  riskWeight  ≈ 0.367,
  priorityBoost: true,          // 失败率 ≥ 20%
  matchedTags: ['1080P', '10s'],
  reason: '历史失败率 36.7%（置信度 1），建议提高风险权重与执行优先级'
}
boostedTagsFromAdvice → ['1080P', '10s']   // 该类 Case 自动提权
```

## 三、测试结果

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run agent:knowledge:test` | 1 文件 / 16 用例 PASS |
| `npm run agent:test` | 34 文件 / 450 用例 PASS（无回归） |
| `npm test` | 58 文件 / 813 用例 PASS + 18 skipped（797 → 813，+16） |

## 四、与 Phase 21 任务书符合性

| 任务书要求 | 状态 |
|---|---|
| 每条知识增加 confidence / usageCount / lastUsedAt / source / validUntil | ✅ |
| Knowledge Ranking / Deduplication / Expiration / Confidence | ✅ rank / add 合并 / refreshLifecycle / touch |
| ACTIVE → STALE → EXPIRED，避免 Memory 越积越脏 | ✅ 30/90 天 + validUntil |
| 历史知识真正参与决策（失败率 → 风险权重 + 执行优先级） | ✅ adviseFromKnowledge + boostedTagsFromAdvice |
| 不引入向量库 | ✅ 确定性标签匹配 + 阈值判定 |
| 不重建 Memory | ✅ 纯增量新模块，与 Memory 分工 |

## 五、下一步

进入 **Phase 21.6 Cost Optimization**：记录 LLM/环境/API/GPU/积分/执行时间成本，
输出 Cost/Case、Cost/Feature、Cost/Regression、Cost/Defect，
并自动选择满足 Coverage ≥90% + Risk Coverage 100% + P0 Coverage 100% 的最小成本测试集合。
