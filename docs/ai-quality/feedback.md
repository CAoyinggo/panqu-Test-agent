# AI 反馈（Feedback Registry）

> Phase 46（43.1 / 43.2）：统一反馈注册中心——所有模块的 AI 质量反馈使用同一结构，禁止各自维护不同的 Feedback。

## 统一数据结构

```ts
interface AIFeedback {
  id: string;
  runId?: string;      // 关联测试运行
  caseId?: string;     // 关联用例 / 断言
  domain: 'REQUIREMENT' | 'TEST_DESIGN' | 'RISK' | 'SELECTION' | 'RCA'
        | 'DEFECT' | 'HEALING' | 'RELEASE';
  prediction: unknown; // AI 预测
  actual: unknown;     // 真值 / 人工更正
  feedbackType: 'CORRECT' | 'INCORRECT' | 'PARTIAL' | 'UNSAFE' | 'MISSING' | 'DUPLICATE';
  source: 'HUMAN' | 'PRODUCTION' | 'EVALUATION' | 'SYSTEM';
  channel?: 'HUMAN_CORRECTION' | 'RCA_VERIFICATION' | 'DEFECT_REVIEW' | 'RELEASE_REVIEW'
          | 'HEALING_REVIEW' | 'BENCHMARK_FAILURE' | 'PRODUCTION_INCIDENT' | 'FLAKY_CONFIRMATION';
  confidence?: number;
  verified: boolean;   // 是否人工核验
  verifiedBy?: string;
  verifiedAt?: string;
  note?: string;
  createdAt: string;
}
```

## 反馈来源（43.2）

已接入的渠道（`FeedbackChannel`）：

- `HUMAN_CORRECTION`：人工更正（如 AI RCA=NETWORK，人工更正为 MODEL → 自动 `INCORRECT`）
- `RCA_VERIFICATION`：根因核验
- `DEFECT_REVIEW`：缺陷评审
- `RELEASE_REVIEW`：发布评审
- `HEALING_REVIEW`：自愈评审
- `BENCHMARK_FAILURE`：基准失败
- `PRODUCTION_INCIDENT`：生产事故
- `FLAKY_CONFIRMATION`：Flaky 确认

## 接入方式

```ts
svc.ingest({
  domain: 'RCA',
  prediction: { category: 'NETWORK' },
  actual: { category: 'MODEL' },
  feedbackType: 'INCORRECT',   // AI=NETWORK、人工=MODEL → 自动记录 INCORRECT
  source: 'HUMAN',
  channel: 'RCA_VERIFICATION',
});
```

## 人工核验

反馈默认 `verified=false`，必须由具备 `RELEASE_APPROVE` 权限的角色（RELEASE_MANAGER / ADMIN）调用
`POST /api/ai-feedback/:id/verify` 核验。未核验反馈不进入自动聚类驱动生产变更。

## API

- `GET /api/ai-feedback`（可按 domain / source / verified 过滤）
- `POST /api/ai-feedback/:id/verify`

## 持久化

AIQualityService 支持 `persistToFile` / `loadFromFile`，反馈跨重启保留。
