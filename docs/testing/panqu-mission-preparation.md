# Panqu 自主任务准备（4.31.0）

## 与 Skill 的差距

Skill 告诉模型如何做；此入口由确定性代码读取项目状态、构建请求、核对全部候选成本并持久化下一步。模型不再负责手写 catalog、生成 payload 或查找 JSON pointer。仍需人提供真实需求、环境身份、确认范围与授权；不能让模型凭空生成业务规则或批准自己的付费操作。

## 使用入口

在目标业务项目根目录执行；隔离安装时将 `devtest` 替换为 `node .trae/devtest-runtime/node_modules/test-flow/dist/bin/run-devtest.js`。

```bash
devtest mission readiness
devtest mission prepare --intent ./intent.json --config ./operator-runtime.json --access ./read-access.json --output ./mission-results
```

`readiness` 不需要环境或凭证、不访问网络。它检查项目类型及相关源码锚点，返回 ADAPTER_READY 或 BLOCKED；不是业务环境健康/验收结论。准备成功返回 READY_FOR_APPROVAL、候选价格、选中参数、预算、相对于输出目录的 planFile 和下一步。之后按 [Mission 使用说明](panqu-mission.md) 的 `run/resume/status` 操作，执行审批必须绑定该计划 hash。保留的 `plan/materials/prepare-media` 入口不变，共八个子命令。CLI 不自动代用户批准计划。

## 三份准备输入

完整类型见 `src/devtest/panqu-mission-types.ts` 的 PanquMissionIntent / PanquMissionReadAccess，以及 `src/devtest/panqu-mission-driver.ts` 的运行配置。

- Intent：schema 为 `panqu.mission-intent.v1`；稳定 intentId、已确认且有来源的 requirement、projectId、nodeId、maxMilliCredits、audio。outputProfiles 明确列出本次确认范围内的 quality/aspectRatio/width/height 和各自来源，不从分辨率名称猜像素。可用 required.quality/durationSeconds 指定不能降档的边界；可覆盖 prompt，否则读取已保存节点文案。
- Config：profile 为 NUXT_CANVAS_V1；originEnv / headersEnv 仅保存环境变量名，实际地址和身份 Header 由进程环境提供；actorRef 与读取授权一致。可选 apiBasePath。准备本身不需要手写 Nuxt 参数绑定；后续执行仍需要经确认的媒体工具、资产 Origin 和任务级账单配置。
- ReadAccess：schema 为 `panqu.mission-read-access.v1`；accessId、allowedOrigin、projectId、actorRef、environment、expiresAt；scope 固定 MODELS_CANVAS_ESTIMATE_ONLY，estimateUnit 固定 PANQU_CREDIT，maxEstimateRequests 为 1…24。它只授权读取模型/节点和估价，不授权生成。必须先确认配置代理返回的金额确为盼趣积分，而非上游货币。

凭证不能写入这些 JSON、报告、Skill 或命令行。解析失败只返回错误码，不回显可能含敏感内容的原始 JSON。输出计划保存在操作者指定的本地目录，其中包含任务文案与节点快照，应按业务数据管理。

## 内核实际检查

准备先核对 Nuxt 相关源码指纹、AST 路由及请求参数锚点，再读取当前 strict 模型列表和保存画布。仅支持单个 `media.video` 的 generate/text_to_video 模式；模型身份、别名、提示词计数、音频、输出格式、分辨率/宽高/比例和条件时长按实际能力核对。缺失能力不补猜；参考输入、参数绑定、上游依赖和活动运行均拒绝，不能删掉它们来凑成单节点。

确认的 outputProfiles 决定本轮输出测试范围，不是声称覆盖模型全部分辨率。在该范围内枚举完整有限合法组合；范围型时长必须有步长。组合最多 24 个，准备总窗口 60 秒，逐项询价且不自动重试。任何报价缺失、冲突、身份不符或单位未知都不生成最低价计划。金额向上取整到整数 milliCredits（1000 = 1 积分）；不能假定低画质/短视频必定便宜。显式高质量/长时长要求预算不足时直接阻断，不降档。

计划报价最长有效 120 秒，并受读取授权到期时间限制。首次提交前重读模型、画布及全部候选报价，重建 payload、核对选中参数与最小成本；包括未选中候选的价格变化也会阻断。源码或输入变化必须重新准备并重新批准。

稳定 intentId 绑定需求和执行上下文。同一 intent 的准备与执行共用持久化锁；新计划使旧计划失效。已有提交时重新 prepare 返回 EXISTING_TASK 和原任务的恢复/核对动作，零业务请求，不因报价或读取授权过期而重提。run/resume 仍执行各自授权校验。提交响应丢失保持未知，不假设未扣费。

## 明确边界

v4.32.0 的[业务证据协调器](panqu-mission-business-evidence.md)要求首次生成前提供最终结算契约；prepare 的能力/报价就绪不是账单接入就绪，也不批准实际生成。实际任务详情可能触发 PHP 的回调 ID 同步，不能仅因 HTTP GET 就宣传为绝对无写入；只在原任务执行授权内调用。

当前自动准备仅覆盖 Nuxt 文生视频单节点。PHP 模型列表不足以建立完整时长/报价契约，返回 MISSION_PHP_AUTOPLAN_CONTRACT_MISSING；原手工 Catalog 执行路径保留。图片、参考素材上传、图生/首尾帧、上游工作流、UI、语义质量、批量输出和跨任务全局预算没有自动化。

源码锚点不是全应用语义解释器。相关文件需解析和匹配，项目其他解析诊断另外保留；ADAPTER_READY 不会清除普通 DevTest 的全项目缺口。47 项专项使用独立本地 HTTP 和真实小视频解码，验证内核行为；不代表真实供应商生成、实际账单或业务验收已通过。
