# 视频模型代码定位

2026-09-08 源码定位快照；所有路径相对对应子仓库。每次接新模型，以当前调用链核实路径/字段，名单和 provider 只是已有实现，不限制新模型。

## aiworkflow / aipanco

以下以 aiworkflow 核对；aipanco 同路径需核对当前版本。

- `composables/admin/usePlatform.ts`、`usePlatform.types.ts`：enabled/strict 类型列表、缓存及 PlatformModel 的 types、capabilities、enabled、permission、model_limits、model_billing、panqu_selmodels_id。
- `components/canvas-flow/plugins/video-node/`：manifest.ts、plugin.ts、use-video-node-platform-models.ts、video-generate-mode.ts、video-node-mode.ts、preference.ts、VideoParamsDialog.vue、VideoPanel.vue。
- `components/canvas-flow/plugins/shared/model-option-identity.ts`：UI value 使用 alias 或 name，realModelName 保留 name；不要将显示文字当 provider 参数。
- `composables/ai/videoEditConstraint.ts`、`composables/canvas-flow/core/video-node-derived-inputs.ts`、`composables/canvas-flow/canvas-flow-packet-utils.ts`：编辑与上游输入派生。
- video-node 的 kind 是 media.video；平台类型包含 video_generate、image_to_video、video_edit、omni_video，但模式启用仍取决于明确能力。参考图输入执行时的转换不应污染持久化设计。

候选测试：`test/canvas-video-selection-recovery.test.ts`、`canvas-video-duration-merge.test.ts`、`canvas-video-edit-params.test.ts`、`video-edit-constraint.test.ts`、`canvas-video-auto-whitelist.test.ts`、`canvas-storyboard-script-video.test.ts`。例如时长合并须保留素材真实小数精度；是否适用于新需求仍以需求为准。

## aidrawos

`lib/api/video.ts`、`types/video.ts`、`components/nodes/videoNode.tsx`。模型列表调用 `/aivideo/v2/video/getPanquaivideoModels`；提交使用 FormData 到 `/aivideo/videonew/add`。不要按 Nuxt 的节点参数结构直接复用请求。

## PHP 宿主：aibaseos / aiseaos / aihomeos

以下以 aibaseos 核对，其他宿主需沿实际路由确认：

- `application/admin/controller/aivideo/v2/Video.php`：getPanquaivideoModels / buildPanquaivideoModels。
- `application/admin/controller/aivideo/Videonew.php`、`application/admin/service/VideonewService.php`、`application/admin/service/aivideo/video/VideoTaskRouteResolver.php`。
- `application/admin/model/aiVideo/ModelConfig.php`、`application/admin/model/ModelConfig.php`、`application/admin/service/PointsService.php`。
- `frontend/src/pages/video/pipeline/modelSwitch.js`、`imageInput.js`；静态模板在 `application/admin/view/`。不要编辑编译产物 `public/assets/` 或框架 `thinkphp/`。

## Go 异步服务

在已确认运行的 `panqu/` 或 `panqurh/` 中检查 `internal/consumer/registry.go`、`unified_consumer.go`、对应 `*_processor.go`、`internal/scheduler/query_*_task.go`、`internal/dal/query_task.go`、`internal/service/query_task_service.go`。TaskType、QueueName 和可选 RoutingKey 不是同一标识。

已有测试线索（aibaseos）：`panqu/internal/consumer/minimax_h3_low_video_processor_test.go`、`panqu/internal/scheduler/query_minimax_h3_video_task_test.go`；`panqurh/internal/consumer/panqu_video_retry_processor_test.go`、`panqu_video_rh_processor_test.go`。先检查测试是否依赖 DB、Redis、队列或 provider；不要盲跑整个服务测试或启动 worker。
