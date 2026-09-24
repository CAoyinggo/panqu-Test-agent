# Panqu 画布 / 工作流 — 可测性边界与可测后端 (canvas-testability)

> **取证来源**：扫描 `/Users/mac/agents/panqu-ai`（aibaseos PHP + aiworkflow Nuxt）于 2026-09-24，关键 `文件:行号` 已抽样核对属实。
> **先读这条，否则结论会错**：aibaseos 的 PHP **不是画布后端，只是薄代理 + 本地元数据/计费镜像**；真正的画布引擎是独立的 **`easyai-server`**（图数据存 **MongoDB**），前端是 **Nuxt3 + Vue Flow 单页**。

## 谁拥有什么（四类真源分离）

| 层 | 拥有的数据 | 能否被无头 agent(API/DB) 断言 |
|---|---|---|
| **aibaseos MySQL** | 轻量元数据 `pq_aiworkflow_canvas`（`id/project_id/name/node_count/aiworkflow_project_id`）+ 计费/任务镜像 | ✅ **能**（本地、确定） |
| **easyai-server (MongoDB)** | 图内容 `flowNodes/flowEdges/flowViewport/flowVersion` + 运行态快照 + 生成引擎 | ❌ 只能隔代理打一枪，本地无可断言状态 |
| **aiworkflow 前端 (Nuxt)** | 拖拽/连线/布局/缩放/撤销/渲染/内存态 | ❌ 需浏览器/DOM 驱动，DevTest 不带 |
| **WebSocket（easyai 侧）** | 实时协作 presence + 任务推送 | ❌ 需活 ws + 多客户端 + 时序 |

架构注释直接写在 `aibaseos/application/admin/controller/aiworkflow/Canvas.php:13-33`（MySQL↔MongoDB 映射 + 建画布 SSO 流程）；代理默认目标 `ps.panqu.com`（`aiworkflow/BaseApi.php:214`），`CanvasFlow::load/save` 是纯代理（`aiworkflow/CanvasFlow.php:14/22/50`）。

## 一句话判决
> 能被 agent 稳定测的，是 aibaseos 本地的**计费/任务账本**与**元数据 CRUD**；**图内容、执行引擎、协作、实时推送都不在本地，测不到**。用 API 去断言"图对不对 / 界面对不对"是错的方向。

---

## ✅ 可测（API/DB，按价值排序）
1. **execute 计费契约（最高价值·纯本地·DB 可观测）**：预扣 → requestId 幂等 → 拒绝退费。见下方闭环。
2. **回调状态机**：`POST aiworkflow/api/task-callback` 造 success/failed/processing/agent/非终态各种 payload，断言 `TaskCallback::handle` 的入队与过滤、分支(complete/fail/refund)幂等（端到端落库需跑消费者命令，属"要跑"；过滤层与分支逻辑可脱机断言）。
3. **画布元数据 CRUD**：`Canvas.php` create/list/update/软删除 + `node_count` 同步（`:118/:159/:243/:267`），全本地。
4. **estimatedBilling 本地分支**（text/audio/workflow 走本地 `PointsService::calculatePoints`）。
5. **Auth / JWT / SSO 签发 + 项目可见性权限**（`Canvas.php:336 assertProjectVisible`）。

## ❌ 不可测（及原因）
- 前端画布交互（拖拽/布局/缩放/连线/撤销/复制/resize/面板渲染）——纯客户端态、无后端契约、需浏览器驱动。**坐标/参数只有在 1s 防抖自动保存 PUT 后才成为后端状态。**
- 实时协作（presence/多人共编/操作广播）——需活 ws + 多客户端 + 时序；DB 无协作文档态；**无 CRDT/OT 库**（package.json 无 yjs/automerge/sharedb），协作=乐观版本锁(HTTP 409)+presence TTL。
- WebSocket 实时任务**推送**——推送不可测，但任务**状态**可经 `getTask` 轮询 / `pq_volcengine_ai_task.status` 观测。
- **图内容正确性**（flowNodes/flowEdges）——存 easyai MongoDB，aibaseos 只代理，save/load 往返与 409 版本冲突语义都需活 easyai+Mongo。
- 真实媒体产物质量——easyai + 上游模型商，非本地。

## 唯一高价值本地闭环（execute → 预扣 → 代理 → 回调 → 确认/退费）
`CanvasWorkflow::execute()`（`controller/aiworkflow/CanvasWorkflow.php:24`）→ `AiworkflowExecutionService::submitExecution()`（`service/AiworkflowExecutionService.php:48`）→ `AiworkflowNodeService::prepareExecution()`（`:91`，事务内）：
- 插 `pq_volcengine_ai_task`（status=PROCESSING, `line=3`, type=taskType）；
- 建 `pq_aiworkflow_task_meta`（requestId ↔ 外部 taskId 映射，**幂等去重靠它**）；
- **预扣** `PointsService::processAiTaskPoints()`（`AiworkflowNodeService.php:217`）→ 写 `pq_score_log type=2`；
- text/audio/emotion 分流到各自 execution service，**TTS 用独立表 `pq_volcengine_ai_tts_task`**；分镜 storyboard = 一次 execute → N 条本地任务。

回调（全在 panqu 侧，可断言）：easyai `POST task-callback` → `TaskCallback::handle` 过滤非终态后入队 `pq_aiworkflow_task_callback` → **PHP 命令消费者** `panquai:aiworkflow-callback` → `AiworkflowNodeService::handleTaskCallback`（`:449`）：success→回填产物URL+确认扣费；failed→**幂等退费** `refundAiTaskPointsWithIdempotency`（`:4626`，键 `score_log userid+task_id+source_id+type`）。

**最干净的用例**：同一 `requestId` 重放 → 不重复建任务、不重复扣费（断言 `pq_aiworkflow_task_meta` 去重 + `pq_score_log` 无重复 type=2）。

---

## 环境前置门槛（据此把用例标「本地已覆盖」vs「阻塞:需活 easyai」）
- **仅需 aibaseos 本地**（agent 可独立断言）：元数据 CRUD、execute 预扣/幂等/拒绝退费、回调过滤与分支逻辑、estimatedBilling 本地分支、Auth/JWT。
- **需活 easyai-server + MongoDB**：canvas-flow save/load、execute 真实提交代理、runtime-snapshot、getTask、模型列表——**代理失败 ≠ 模型生成失败，别误报**。
- **需跑消费者/中间件**：回调端到端落库需 `panquai:aiworkflow-callback` 命令 + RabbitMQ/Redis（属"要跑"，与"只测不跑"冲突，标注为受阻或另行编排）。

## 两条坑（写进用例）
1. **节点坐标/参数在 1s 防抖 PUT 前不落库**——断言持久化必须先触发/等待自动保存。
2. **设计态（easyai/Mongo）与运行态（`pq_volcengine_ai_task`）分属不同真源**——勿把运行态当设计断言、勿把代理响应当本地状态。

## 涉及表（aibaseos 本地）
`pq_aiworkflow_canvas`（元数据）、`pq_volcengine_ai_task`（任务镜像 line=3）、`pq_aiworkflow_task_meta`（requestId↔外部ID 幂等）、`pq_aiworkflow_task_callback`（回调入队）、`pq_score_log`（扣/退）、`pq_volcengine_ai_tts_task`（TTS 节点独立表）。扣费数值/task_type 映射见 [`../../panqu-billing/references/billing-flow.md`](../../panqu-billing/references/billing-flow.md) 与 video/image 专项，不在此重复。

---

> **给测试者的一句话**：画布的"创作体验"（拖拽/连线/协作/渲染）**不要用 DevTest 去测**——那是前端 + easyai 的活，需浏览器与活服务。DevTest 在画布上唯一稳、值得测的，是**执行触发的本地计费/任务账本闭环**（预扣→幂等→回调退费）。其余标注为「需活 easyai / 需浏览器」受阻，别把代理层失败误当成业务失败。

