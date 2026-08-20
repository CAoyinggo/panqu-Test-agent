# Prompt 版本管理（Prompt Versioning）

> Phase 46（43.7）：`Prompt` 与 `PromptVersion` 分离，每个版本记录 content / model / createdBy /
> createdAt / benchmarkScore / status，支持回滚与 A/B。

## 版本结构

```ts
interface PromptVersion {
  id: string;
  promptKey: string;       // 逻辑名（如 risk）
  version: string;         // v1 / v2 / v3 ...
  content: string;         // Prompt 内容
  model?: string;          // 关联模型
  createdBy: string;       // 创建人（禁止 AI 自批）
  createdAt: string;
  benchmarkScore?: number; // 该版本在基准上的得分
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ROLLED_BACK';
  parentVersion?: string;  // 父版本（回滚链）
}
```

## 版本生命周期

- 新版本创建为 `DRAFT`，经离线评测与人工审批后激活为 `ACTIVE`
- 回归时可 `ROLLED_BACK` 恢复到基线版本
- 同 `promptKey` 保留完整版本历史（risk-v1 → risk-v2 → risk-v3）

## 公平比较

同一个 Benchmark 可对多个 Prompt 版本进行公平比较（`agent prompt compare`），
对比维度见 [shadow-canary.md](./shadow-canary.md) 中的 A/B 指标（Accuracy / Latency / Cost / Failure Rate / Safety）。

## API / CLI

- `GET /api/prompts`（按 key 过滤）
- `GET /api/prompts/:id/versions`（同 key 全部版本）
- `agent prompt list` / `compare`
