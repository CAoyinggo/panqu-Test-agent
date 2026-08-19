# Phase 26.7 Observability / Alerting — 阶段报告

> 阶段：26.7 / 8
> 范围：接入真实飞书通知（6 类关键通知含丰富上下文）+ 全链路事件发布点补全
> 状态：✅ 完成
> 证据级别：**Offline（E2E/单测）+ Staging Real（staging 数据目录 CLI 完整链路真实 HTTP 投递）**

---

## 一、目标

让关键业务事件（阻塞发布 / P0 失败 / Run 失败 / 审批请求 / Worker 下线 / 生产访问拒绝）经「事件总线 → 通知分发器 → 真实飞书通道」真实到达飞书，且每条通知携带丰富上下文便于告警追踪定位：

- **上下文后缀**：`[run=<runId> env=<env> project=<projectId> t=<timestamp>]`（缺省字段以 `-` 占位）。
- **飞书 text 风格 payload**：`{ msg_type: 'text', content: { text: '[severity] title\nbody' } }`，真实 HTTP POST。
- **配置驱动**：设置 `FEISHU_WEBHOOK_URL`（或 `FEISHU_WEBHOOK`）后平台事件真实投递飞书；缺省仅 console。
- 离线可复现：本地 HTTP mock 飞书端点（真实 Node http server + 真实 fetch）验证链路，无需真实飞书密钥。

## 二、扫描结论（复用点与缺口）

| 项 | 结论 |
|---|---|
| 复用点 | 事件总线（24.6）+ NotificationDispatcher 已存在；`feishuChannel`（text 风格 payload，`{ msg_type, content.text }`）已实现 |
| 复用点 | `wireNotifications` 已把事件总线全量接到 notifier |
| 缺口 | 通知正文缺环境/项目/时间戳上下文 → 新增 `ctxSuffix(e)` 统一后缀并接入全部模板 |
| 缺口 | WorkerOffline 正文未渲染 reason → 模板增强为 `心跳超时/下线（${reason}），Job 已回收` |
| 缺口 | RunFailed 缺 environment/projectId → `failRun` 发布事件补充上下文 |
| 缺口 | P0Failure / ReleaseBlock / ApprovalRequested / WorkerOffline 无真实发布点 → 在 real-run / release-gate-drill / recovery-drill 补齐 |
| 缺口 | 平台未装配飞书通道 → factory 新增 `feishuWebhookUrl` 选项；CLI 从环境变量读取 |

## 三、产出清单

| 文件 | 说明 |
|---|---|
| `src/platform/notifications/dispatcher.ts`（修改） | `ctxSuffix` 上下文后缀接入全部模板；WorkerOffline 渲染 reason |
| `src/platform/ops/real-run.ts`（修改） | P0 FAIL 发布 `P0Failure`；决策 BLOCK 发布 `ReleaseBlock` 后 `failRun` |
| `src/platform/ops/release-gate-drill.ts`（修改） | REVIEW 分支发布 `ApprovalRequested`（含 approvalId） |
| `src/platform/ops/recovery-drill.ts`（修改） | Worker 下线（S1）发布 `WorkerOffline`（含 reason） |
| `src/platform/service/platform-service.ts`（修改） | `failRun` 的 `RunFailed` 补充 `environment` / `projectId` 上下文 |
| `src/platform/service/factory.ts`（修改） | `feishuWebhookUrl` 选项；配置后注册 `feishuChannel` |
| `bin/platform-cli.ts`（修改） | CLI 从 `FEISHU_WEBHOOK_URL ?? FEISHU_WEBHOOK` 读取飞书地址 |
| `.env.example` / `.env.staging.example`（修改） | 记录 `FEISHU_WEBHOOK_URL` / `FEISHU_MENTION` |
| `tests/e2e/notification-real.test.ts`（新建，4 例） | 真实业务链路（BLOCK 三类告警 / REVIEW 审批告警 / 事件层告警 / 6 类通知上下文 + payload 结构） |

## 四、演练设计

- **链路**：`bus.publish → wireNotifications(subscribeAll) → NotificationDispatcher.notifyEvent → feishuChannel.send → 真实 fetch POST`。
- **上下文**：`ctxSuffix(e)` 拼接 `[run= env= project= t=]`；severity 分级（critical / error / warning / info）。
- **六类关键通知**：ReleaseBlock（critical）/ P0Failure（critical）/ RunFailed（error）/ ApprovalRequested（warning）/ WorkerOffline（error）/ ProductionDeny（critical）。
- **真实业务触发**：`platform gate block` 用故障注入（WAN3-CORE-001 P0 FAIL）真实触发 BLOCK → 顺次发布 RunCreated / RunStarted / P0Failure / ReleaseBlock / RunFailed，全链路投递 mock 飞书。
- **离线可复现**：`startMockFeishu()`（Node http server 监听随机端口）接收真实 fetch POST；`FEISHU_WEBHOOK_URL` 指向 mock，与配置真实飞书走同一代码路径。
- **并发稳健**：等待断言改为「按目标文本全部到达」（`waitForTexts`），避免全量回归并发下前置通知抢占等待窗口导致误报。

## 五、验证结果

### 5.1 Staging Real：CLI 完整链路（staging 数据目录 + mock 飞书端点）

`FEISHU_WEBHOOK_URL=http://127.0.0.1:<port>/webhook` 下执行 `platform gate block test`：

```json
GATE: { "total": 1, "pass": 0, "review": 0, "block": 1,
        "deploymentNotExecuted": 1, "bypassBlocked": 1, "allPass": true }
FEISHU_RECEIVED = 5 条真实通知：
  [info]     Run 已创建    run-… 已入队（test）[run=… env=test project=wan3 t=…]
  [info]     Run 已开始    run-… 开始执行[run=… env=test t=…]
  [critical] P0 失败       P0 用例 WAN3-CORE-001 失败，需立即关注[run=… env=test project=wan3 t=…]
  [critical] 发布阻塞      run-… 发布门禁 BLOCK：P0 失败 1 个：Release Gate 阻断（exit=1）[run=… env=test t=…]
  [error]    Run 失败      run-… 执行失败：P0 失败 1 个：Release Gate 阻断（exit=1）[run=… env=test t=…]
```

5 条通知均含 `[run= env= project= t=]` 上下文，真实 HTTP 投递成功。

### 5.2 Offline（E2E，4 例全 PASS）

1. **26.7.1** BLOCK Run 真实业务链路：ReleaseBlock / P0Failure / RunFailed 三类告警真实到达飞书；`[critical]`、runId、`P0 失败`、`Release Gate 阻断`、`env=test`、` t=` 断言全通过 ✅
2. **26.7.2** REVIEW Run 真实业务链路：ApprovalRequested 含 `approvalId` / `env=test` / ` t=` ✅
3. **26.7.3** 事件层：WorkerOffline（w1 / simulated-crash / env=test）+ ProductionDeny（autonomous-agent / deploy / env=production）经真实事件总线 + 真实 HTTP 到达 ✅
4. **26.7.4** 六类通知（ReleaseBlock / P0Failure / RunFailed / ApprovalRequested / WorkerOffline / ProductionDeny）全部含 `[run= env= t=]` 上下文；每条飞书 payload 均为 text 风格（`msg_type=text` + `content.text`）✅

### 5.3 单元测试（notification.test.ts 已有 15 例）

事件总线（订阅/退订/全局/顺序/完整性/异常容错）+ 通知模板 + 多通道分发容错全通过。

### 5.4 全量回归（26.7 改动后）

`npx vitest run` → **114 passed | 4 skipped（118 files）；1390 passed | 18 skipped（1408 tests）** 全绿。

## 六、证据分类

| 级别 | 结论 | 说明 |
|---|---|---|
| Mock | ✅ 全 PASS | 单测 15 例（模板/分发/总线） |
| Offline | ✅ 全 PASS | E2E 4 例（六类通知真实 HTTP 到达 + 上下文 + payload 结构） |
| Staging Real | ✅ 通过 | staging 数据目录 CLI 完整链路：BLOCK Run 5 条通知真实投递 mock 飞书 |
| Production | 未执行 | 本阶段不触碰生产环境；真实飞书为配置驱动（`FEISHU_WEBHOOK_URL`），与 mock 走同一代码路径 |

## 七、缺口与风险

1. 真实飞书机器人未配置（离线环境），采用本地 HTTP mock 端点验证完整链路；配置 `FEISHU_WEBHOOK_URL` 后同一代码路径投递真实飞书，payload 为飞书 text 风格（非 interactive 卡片）。
2. 全量回归曾出现 26.7.1 偶发失败：原等待逻辑按「通知条数」计数，BLOCK Run 实际发布 5 条（含前置 RunCreated/RunStarted），并发下前置通知抢占等待窗口导致 `Run 失败` 断言在超时内未命中；已改为「按目标文本全部到达」等待（`waitForTexts`），全量回归稳定全绿。
3. 通知正文长度受飞书 text 消息上限约束（当前每条 ≤ 数百字符），海量用例失败时不会逐条刷屏（仅关键事件）。

## 八、下一阶段

进入 **26.8 Production Pilot**：≥30 真实 Run + KPI + 10 个人工 QA 对照；创建 `tests/e2e/pilot-run.test.ts`。
