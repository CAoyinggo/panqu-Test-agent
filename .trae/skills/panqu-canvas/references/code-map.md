# 画布代码定位

以下是 2026-09-08 核对的相对路径。先确定子仓库根目录；路径迁移时用 `rg --files` 和符号搜索追踪当前调用方，不直接沿用旧入口。只检查本次涉及的宿主，不默认同步修改所有相邻仓库。

## aiworkflow / aipanco：Nuxt + Vue Flow

以 aiworkflow 核对的入口为起点；aipanco 同名目录仍须独立检查。

- `components/canvas-flow/CanvasFlowEditor.vue`：编辑器。
- `composables/canvas-flow/core/use-canvas-flow-kernel.ts`、`use-plugin-registry.ts`：插件注册；registry 按 manifest.kind 索引，重复 kind 不应被默默覆盖。
- `components/canvas-flow/plugins/<kind>/`：manifest、plugin、Panel、Preview；类型见 `composables/canvas-flow/types/canvas-flow.types.ts`、`composables/canvas-flow/types/canvas-flow-plugin.types.ts`。
- `composables/canvas-flow/core/use-graph-store.ts`、`use-execution-engine.ts`、`use-canvas-sync.ts`、`canvas-flow-ws-handler.ts`、`use-undo-redo.ts`：图、执行、同步和历史。
- `composables/canvas-flow/adapters/canvas-flow-api-client.ts`：保存/读取协议。designSave 使用 flowVersion、flowNodes、flowEdges、flowViewport；flowNodeStates 已弃用，不能当设计数据源。flowInitialRuntimeSnapshot / flowRuntimeSnapshot 属于运行态。
- `composables/canvas-flow/canvas-platform-models-context.ts` 与 `components/canvas-flow/plugins/shared/model-option-identity.ts`：共享媒体模型能力和选项身份。

候选测试在 `test/`：canvas-spatial-graph-regression、canvas-node-render-mode、canvas-node-preferences、canvas-collaboration-execution-sync、canvas-version-history-contract、canvas-version-preview-auth-isolation、canvas-flow-wheel-zoom、canvas-performance-rendering、canvas-node-state-machine-warning（均为 `.test.ts`）。先读测试确认是运行行为还是源码契约检查。仓库文档出现 `yarn tsx --test test/canvas-*.test.ts`，但须先确认本地 runner 已安装、所选测试无外部副作用；不能假定存在 `npm test`。

## aidrawos：React / Next + XYFlow

- `components/nodes/nodeTypeMenu.tsx`、`useAddFlowNode.ts`、`flowNodeUtils.ts`、`imgNode.tsx`、`videoNode.tsx`、`textNode.tsx`。
- `types/node.ts`、`lib/api/node.ts`：实际节点数据和 GO API；不是 Nuxt GraphSnapshot 协议。
- 修改 Next 代码前按该仓库 AGENTS.md 阅读本地 Next 文档；不要仅凭框架记忆改 API。

## 需要沿后端追踪时

aibaseos、aiseaos、aihomeos 的 PHP、`panqu/`、`panqurh/` 服务并非必然同版。先用前端请求与当前路由确认实际宿主和 worker，再读取对应媒体 Skill；不能仅根据相似目录推断运行中的处理器。
