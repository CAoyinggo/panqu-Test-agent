# Run Template（运行模板）

> 版本：v4.14.0（Phase 39.3）｜ 模块：`src/platform/workflow/run-template.ts`

## 定位

QA 最高频需求："这套测试我上次跑过，再跑一次。" Run Template 把一次 Run 的 **Configuration** 保存为可复用模板，一键再跑。

**只复制 Configuration**（project / environment / suite / plan / mode / budget / release gate）。
**绝不复制 Execution Result / RCA / Release Decision / 旧状态 / 旧追踪**。

```ts
interface RunTemplate {
  id: string;
  projectId: string;
  name: string;
  environment: string;
  suiteIds: string[];
  mode: 'MANUAL' | 'REGRESSION' | 'AUTONOMOUS';
  budget?: number;
  releaseGate?: boolean;
  runCount: number;                 // 该模板被复用次数（复用溯源）
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

## 能力

| 操作 | Service 方法 | HTTP |
| --- | --- | --- |
| 创建 | `createTemplate(input, role)` | `POST /run-templates` |
| 从 Run 保存 | `saveTemplateFromRun(runId, name, actor, role)` | `POST /runs/:id/template` |
| 列表 | `listTemplates(filter?, scopes?)` | `GET /run-templates` |
| 详情 | `getTemplate(id)` | `GET /run-templates/:id` |
| 修改 | `updateTemplate(id, patch, role)` | `PATCH /run-templates/:id` |
| 运行 | `runTemplate(id, actor, role, scopes?)` | `POST /run-templates/:id/run` |

## 语义约束

- `saveTemplateFromRun` 只提取 Run 的配置字段（projectId / environment / suiteIds / mode / budget / releaseGate），**不读取 checkpoint / result / rca / decision**。
- `runTemplate` 生成**全新** Run：新 `runId`、状态从 QUEUED 开始、无任何旧结果；`templateId` 溯源记录 + `runCount` 自增。
- Run Again（`rerunRun`）是模板的特例：只复制配置，不复制状态与决策。

## CLI

```bash
agent template list
agent template create --name "WAN3 回归模板" --project wan3 --environment staging --mode AUTONOMOUS --suites <suiteId> --budget 10 --release-gate true
agent template run <templateId>
```
