# Model 版本管理（Model Versioning）

> Phase 46（43.8）：记录 provider / model / modelVersion / configuration，支持同一个 Benchmark 对
> 多个模型进行公平比较。

## 版本结构

```ts
interface ModelVersion {
  id: string;
  provider: string;            // 如 deepseek
  model: string;               // 如 xxx
  modelVersion: string;        // 如 v4
  configuration: Record<string, unknown>; // temperature / maxTokens 等
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ROLLED_BACK';
  createdBy: string;
  createdAt: string;
}
```

## 公平比较

- 多个 ModelVersion 可在同一个 Benchmark（同一 Ground Truth 集）上比较
- `agent model compare --baseline <id> --candidate <id>` 输出 A/B 对比
- 对比维度：Accuracy / Latency / Cost / Failure Rate / Safety（见 [shadow-canary.md](./shadow-canary.md)）

## 安全约束

- **禁止**直接修改生产 Model
- Model 变更必须走 `Improvement Proposal → 离线评测 → 人工审批 → Shadow → Canary → 激活`
- **禁止 AI 自己批准自己的修改**

## API / CLI

- `GET /api/models`
- `agent model list` / `compare`
