# 图片模型代码定位

2026-09-08 核对快照；路径相对各子仓库。新模型不必与已有 provider 同型，先核对当前路由和能力结构。模型清单以当前项目为准，不把此文件变成静态白名单。

## aiworkflow / aipanco

以 aiworkflow 为核对源，aipanco 当前分支需独立确认。

- `composables/admin/usePlatform.ts`、`usePlatform.types.ts`：平台模型、类型、能力、缓存、配置 ID 与计费描述。
- `components/canvas-flow/plugins/image-node/manifest.ts`、`plugin.ts`、`use-image-node-platform-models.ts`、`image-param-defaults.ts`。
- `components/canvas-flow/plugins/shared/model-option-identity.ts`：选项身份与真实模型名。
- `composables/canvas-flow/canvas-image-generation-modes.ts`、`canvas-image-generation-mode-compatibility.ts`：模式、模型能力与比例的兼容交集。
- image-node kind 为 media.image，接收 TEXT/IMAGE、输出 IMAGE。平台加载器筛选 image_generate/image_edit；有参考图时选 image_edit 能力，不能只看模型展示名。
- `components/image-edit/` 与 `pages/image-edit/`：图片编辑器交互入口，独立于画布节点；先辨明修改的是编辑交互还是模型请求。

候选测试在 `test/`：canvas-image-generation-modes、canvas-image-generation-mode-compatibility、canvas-image-aspect-ratios、canvas-editable-image-loader、remote-image-validation（`.test.ts`）。阅读测试判断源码检查和实际行为的边界，按已存在的 runner 执行；不要凭空新增 `npm test` 假设。

## aidrawos

`components/nodes/imgNode.tsx`、`types/node.ts`、`lib/api/node.ts` 为画布图片节点线索。该项目是 React/XYFlow，不使用 Nuxt 插件 manifest/GraphSnapshot；沿当前实际请求继续找生成端点。

## PHP 宿主：aibaseos / aiseaos / aihomeos

以下以 aibaseos 核对；其他宿主先确认实际路由：

- `frontend/src/pages/project_image/` 的 index/detail/generate 页面，以及 `frontend/src/pages/imageedit/` 的局部重绘、擦除、扩图、放大与模型相关页面。
- `application/admin/service/OnedrawService.php`、`NewapiImageDiversionService.php`、`TengxunImageTaskService.php`；`application/common/library/AgentEarthGptImage.php`。
- `application/admin/model/ModelConfig.php`、`application/admin/service/PointsService.php`：实际配置与计费调用。不得用例子里的模型 ID、TaskType 数值或价格替代本次配置。
- 编辑源码 `frontend/src/` 和模板 `application/admin/view/`，不要改编译产物 `public/assets/` 或框架 `thinkphp/`。

## Go 异步服务

在实际运行的 `panqu/` 或 `panqurh/` 中追踪 `internal/consumer/registry.go`、对应 image processor、`internal/scheduler/query_*_task.go`、`internal/dal/query_task.go`、`internal/model/image_model.go`。两个服务并非同一版本，不默认都要改。

已有测试线索（aibaseos）：`panqu/internal/consumer/image_edit_processor_test.go`、`agentearth_image_processor_test.go` 与 `panqurh/internal/model/image_model_test.go`。先检查依赖与副作用；验证本地处理/输入分支不等于已经调用真实 provider、保存资产或完成结算。
