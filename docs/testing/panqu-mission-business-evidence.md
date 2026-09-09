# Panqu 业务证据协调器（4.32.0）

## 方向与真实业务依据

这一轮强化的是跨步骤、跨进程的业务事实与决策，不是增加 Skill 文案或 MCP 工具数量。内核保存“哪些事实已经证实、还缺哪一段”，恢复后只做必要动作。

2026-09-09 对本地当前源码的观察，不等同于部署版本或业务验收规则：

| 真实代码入口 | 观察到的协议/时序 | 内核对应处理 |
| --- | --- | --- |
| aiworkflow/composables/canvas-flow/adapters/canvas-flow-api-client.ts：TaskDetailResponse | taskId、requestId、projectId、nodeRuns、updated_at 为独立字段 | 按任务、请求和目标节点关联；版本可得时拒绝旧观察覆盖新事实 |
| aiworkflow/composables/canvas-flow/core/use-canvas-execution-recovery.ts | WebSocket缺失时按原taskId补查，终态/当前画布匹配后更新 | 有界查询原任务，不因断线生成新任务 |
| aibaseos/application/admin/service/AiworkflowTaskMetaService.php | request_id、easyai_canvas_task_id、easyai_callback_task_id、workflow_node_id、上游任务ID不是同一标识 | 账单必须明确绑定当前提交任务命名空间；不猜“另一个ID应该也一样” |
| aibaseos/application/admin/service/AiworkflowNodeService.php：failTaskFromCallback/refundFailedTask | 先提交任务失败事务，再执行独立幂等退款 | 任务失败不意味着退款已经完成；保留失败后继续核对最终账务 |
| aibaseos/application/admin/controller/aiworkflow/CanvasWorkflow.php：getTask | GET代理任务详情后会同步回调任务ID | 该观察属于已授权任务流程，不能宣传成绝对无业务写入的普通GET |
| aiworkflow/composables/canvas-flow/core/use-execution-engine.ts：账户score更新 | 返回score用于更新用户账户信息 | 不把余额变化或估价当任务最终扣款 |

本轮未发现可直接确认的、统一暴露最终结算和退款状态的任务级公共接口，因此不编造接口、不读取数据库、不复用管理端账户账单。操作者仍须提供经确认的账单协议；没有协议时首次生成零请求阻断。

## 三阶段事实与决策

| 已有事实 | 内核状态和下一步 | 不允许发生 |
| --- | --- | --- |
| 任务进行中 | POLLING / OBSERVE_TASK | 当作失败、重新提交 |
| 任务成功、资产尚未可读 | BLOCKED / VERIFY_MEDIA，保留已有结算 | 丢掉任务状态或伪造媒体通过 |
| 视频已解码匹配、账单pending | SETTLING / OBSERVE_SETTLEMENT | 再查已完成任务或重复下载视频 |
| 任务失败、退款pending | SETTLING，known failures保留，继续对账 | 把失败当免费，或“失败已结束”后丢掉账务 |
| 账单暂时503 | BLOCKED，保留task/media事实，可续查原账单 | 擦掉成功证据或发新生成请求 |
| 输出尺寸/时长冲突 | 保留已解码资产和失败，补齐结算后FAILED | 用后来另一份输出抹掉已发现失败 |
| 最终账单完整且输出匹配 | PASSED | 数值金额没有finality也通过 |
| 任务归属/终态证据冲突 | BLOCKED / RESOLVE_EVIDENCE_CONFLICT | 自动覆盖旧证据、无限重试 |

每次证据读取/解码前持久记录意图和计数，完成后保存白名单事实。只在本机任务目录恢复；没有后台调度、退款写入、取消任务、自动重新生成或跨任务全局预算。已有提交的定向观察不再依赖旧前端源码或素材；运行仍要求相同planHash、驱动配置/actor/Origin和有效审批。

## 最终结算配置

evidence.requests 记录适配器读取/解码意图次数，不等于服务器实际收到的HTTP数；例如本地缺配置可能在发送前返回。复核实际副作用需服务端/受控fixture计数，不能用本地计数推断已扣费。

沿用 operator config 的 receipt，并新增 settlement。以下仅解释结构，路径、状态值、金额单位和ID命名空间必须来自真实接口契约，不应原样当成生产配置：

```json
{
  "source": "已核对的任务级最终结算契约来源",
  "path": "/verified-ledger/{taskId}",
  "taskIdPointer": "/taskId",
  "chargedMilliCreditsPointer": "/debit",
  "settlement": {
    "statePointer": "/state",
    "finalValue": "settled",
    "pendingValues": ["pending", "refunding"],
    "amountMeaning": "DEBIT_MINUS_REFUND",
    "refundedMilliCreditsPointer": "/refund"
  }
}
```

金额必须为非负安全整数milliCredits（1000=1积分）。DEBIT_MINUS_REFUND要求明确扣款和退款，退款不能大于扣款；缺失退款不是0。FINAL_NET_DEBIT表示接口字段已经是明确最终净扣款，不能同时提供退款指针，避免重复相减。状态严格按类型和值匹配；true、1、字符串"1"不互换。无finality、未知状态、数值字符串、身份冲突不通过。

配置只声明接口语义，不能证明该接口实际已部署或正确结算；实际业务验收仍要独立账单证据。最终净扣款不代表历史峰值扣款；本轮不验证扣款/退款时限，不猜失败必须免费。模型不能自己填写finalValue以让一个金额看起来已完成。

## 兼容、安全与验证

普通MCP仍只读；Mission使用原受审批入口。新计划首次生成前缺少最终结算契约即阻断，不能花费后才发现永远缺Oracle。原有金额字段不再单独支持新策略PASS。旧终态journal保留历史结论，但status/run/resume不宣称其满足新策略；显示BLOCKED并要求明确证据迁移，不自动重提。旧未结束任务在原绑定下可继续观察；改变账单配置会改变驱动身份，不能静默挪用旧journal或审批。

持久化只保留状态、合法标识、来源时间、哈希、解码元数据、最终金额、失败/缺口和请求计数，不保存签名URL、原始错误响应、账单文本或凭证。最终结算之后停止自动读账单；这不是永久账务监控。未知提交继续保留预算和原任务不确定性，不新增查询/取消/补单权限。

专项39项覆盖独立本地HTTP、实际FFmpeg视频解码、结算延迟、失败退款、账单/存储故障、来源时间戳、冲突隔离、并发、前端源码变化后的恢复及CLI跨进程。它证明内核策略，不证明真实供应商、真实财务结算、UI、语义质量或Trae模型行为。下一步业务验收需目标环境、真实任务级最终账单契约、账户权限和精确预算。
