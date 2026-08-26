# Phase 24.6：Event Bus + Notification 报告

## 1. 目标

统一事件总线（In-Process，不引入 Kafka / RabbitMQ）+ 统一通知通道（Feishu / DingTalk / Email / Webhook），覆盖任务书重要事件。

## 2. 新增模块

| 文件 | 职责 |
| --- | --- |
| `src/platform/events/events.ts` | `PlatformEvent` / `PlatformEventType`（24 种，覆盖任务书 17 + 任务书 10） |
| `src/platform/events/event-bus.ts` | `EventBus`：按类型订阅 / 全局订阅 / 发布顺序派发 / 退订 / 监听器异常隔离 |
| `src/platform/notifications/channel.ts` | `NotificationMessage` / `NotificationChannel` + console / webhook / feishu / dingTalk / email 五类通道（均可注入 sender） |
| `src/platform/notifications/dispatcher.ts` | `NotificationDispatcher`：事件 → 标题/严重度/正文 映射 + 多通道并行分发（单通道失败不阻断） |

## 3. 关键设计

- **事件 → 通知模板**：`EVENT_NOTIFICATION_TEMPLATES` 覆盖 Release BLOCK（critical）、P0 Failure（critical）、Release REVIEW（warning）、Worker Down（error）、Production Deny（critical）、Budget Exhausted（error）、Flaky Quarantine / Healing Approval / Scheduler Failure 等全部重要事件。
- **通道可测试性**：所有 HTTP 类通道（webhook / feishu / dingTalk）支持注入 `sender`，email 支持注入 `send`，无需真实网络即可验证 payload 格式；默认走全局 `fetch`。
- **EventBus 进程内实现**：`publish` 顺序派发，单个监听器异常不阻断总线与其他监听器，满足第一阶段"不引入消息中间件"约束。

## 4. 验收结果

| 检查项 | 结果 |
| --- | --- |
| Build（`tsc --noEmit`） | ✅ 通过 |
| 单元测试 `tests/unit/notification.test.ts` | ✅ 15 / 15 PASS |
| `npm test` | ✅ 1157 PASS（含旧用例，无回归） |
| `npm run agent:test` | ✅ 450 / 450 PASS |

覆盖：订阅/退订/全局订阅/发布顺序/事件类型完整性/监听器异常隔离/五类通道 payload/事件映射严重度/多通道分发容错。

## 5. 与任务书对应

- 任务书 10（Notification）：✅ 四类通道 + 重要事件映射。
- 任务书 17（Event Bus）：✅ In-Process EventBus，全部事件类型。

## 6. 后续

- EventBus 与 Run 生命周期 / 审批 / Release 决策在 24.7 Service Layer 接线（Run 状态变化 → 发事件 → 通知）。
- 24.8 运维视图消费事件统计。

下一阶段：24.7 Platform API + Service Layer（API 与 CLI 共用）。
