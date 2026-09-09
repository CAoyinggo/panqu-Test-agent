# Panqu Mission：项目任务执行闭环

## 与模型提示词的分工

模型可以理解需求、建议候选方案、解释证据，但无权给出执行状态、捏造能力/价格、确认自己的扣费授权或重复提交。Mission 内核独立完成选型、预算核对、提交记录、轮询、恢复及结果检查。即使没有调用语言模型，受支持的结构化任务仍可运行。

| 输入或异常 | 内核行为 |
| --- | --- |
| 模型推荐昂贵配置或另一个模型 | 只在已确认的目标模型/模式中选最低已验证报价；记录建议被纠正 |
| 明确要求高质量，但预算不够 | 阻断，不降档后冒充覆盖 |
| 提交返回任务 ID | 进入 POLLING，不报通过 |
| 提交响应丢失或进程在提交阶段中断 | SUBMISSION_UNKNOWN，保留预算占用，禁止自动再提交 |
| 重复调用、并发调用 | 复用同一计划 journal；并发锁只允许一个执行者 |
| 恢复任务 | 继续查询原 taskId，不重新生成 |
| 错误项目/节点/任务 ID | 拒绝证据，不用其他任务结果填充本任务 |
| 成功响应但结果缺失/损坏 | 阻断；只得到 URL 不算视频生成成功 |
| 可解码但尺寸/时长不符 | 保留实测媒体属性并记录失败 |
| 未获得任务级实际扣费 | 保留 UNKNOWN，不用预计积分代替实际积分 |
| 实际扣费超过批准报价 | 记录超额失败，不继续提交 |

## 入口

```bash
devtest mission materials --folder ./test-media --ffprobe /absolute/path/ffprobe --ffmpeg /absolute/path/ffmpeg
devtest mission prepare-media --folder ./test-media --spec ./reference-constraints.json --ffprobe /absolute/path/ffprobe --ffmpeg /absolute/path/ffmpeg
devtest mission plan --spec ./mission.json --catalog ./verified-catalog.json --output ./mission-results
devtest mission run --plan ./mission-results/PLAN_HASH.plan.json --config ./operator-runtime.json --approval ./approval.json --output ./mission-results
devtest mission resume --plan ./mission-results/PLAN_HASH.plan.json --config ./operator-runtime.json --approval ./approval.json --output ./mission-results
devtest mission status --plan ./mission-results/PLAN_HASH.plan.json --output ./mission-results
```

这些示例不包含可执行的业务授权或默认生产环境。第一次接入应由操作者核对接口和配置；不要让模型自行创建审批文件。`status` 不需要凭证、不访问网络。`run/resume` 每次最多 30 次观察、单次窗口最多 60 秒；CLI 默认 1 个观察周期，操作员可设置 `maxCycles`（1…20）。到达观察边界后保留原任务，不把“还在运行”当成失败并重新生成。

`plan` 返回的 `plan_file` 相对于用户提供的 `--output`；`prepare-media` 返回的 `directory` 相对于 `--folder`。CLI 不输出可能被隐私脱敏替换的绝对路径，后续传参时与原目录拼接。

## 输入契约

类型定义为 `src/devtest/panqu-mission-types.ts`，HTTP 适配配置为 `src/devtest/panqu-mission-driver.ts`。

- **Spec**：真实需求来源/原文、确认状态、待测 modelId/mode、image/video、预算、经实际检测的素材清单；可选模型建议 `proposal.variantId` 不具备授权。必须验证某个高成本/边界组合时使用 `requiredVariantId`。
- **Catalog**：操作员/可信项目适配器取得并核对的完整合法组合，每个组合包含实际 payload、尺寸/时长/数量/质量和积分上界，带来源、过期时间及相关源码 SHA-256。每个组合都是完整合法组合，不擅自对独立枚举做笛卡尔积。没有实时接口适配时不得把模型输出或旧的 UI 选项当作新报价。`1000 milliCredits = 1 积分`，只接受非负安全整数；字符串、NaN、负数、未知成本一律拒绝。
- **文案**：PHP payload 没有 cueword 时，必须提供带来源的 `promptConstraints`（minCodePoints/maxCodePoints），内核才生成短测试文案；也可以用 Spec.prompt 提供文案并按同一限制检查。不猜 token 限制，不覆盖已确认的其他输入规则。
- **Config**：`originEnv` 和 `headersEnv` 只保存环境变量名，身份 Header 只存在进程内存；`actorRef` 绑定执行者。配置 profile、可选 apiBasePath、assetOrigins、媒体工具绝对路径；Nuxt 还需当前节点模型/时长/质量字段的 JSON pointer。不得把 Cookie/Token 写进 JSON 文件或命令行。
- **Receipt**：可选配置 `source/path/taskIdPointer/chargedMilliCreditsPointer`，必须是当前项目真实、只读、任务级账单契约。没有账单契约可以保留生成和媒体证据，但不能得到完整 PASSED。Nuxt execute 返回的 score 未经确认不作为实际扣费。
- **Approval**：操作员确认后给出 approvalId、同一 planHash、积分上限、环境、唯一 allowedOrigin、有效期及 `retainTestAssets:true`（明确保留测试生成资产）。只允许 local/test/integration；local 只允许 loopback。MCP 不提供创建此审批的入口，也不将用户确认业务规则当作扣费授权。

报价是执行预算依据，不是服务端硬限额。内核能阻止超预算计划及重复提交，并发现服务端超收；不能保证存在计费缺陷的服务端绝不超扣。预算按一个 Mission 的一次生成提交管理，不是跨多个独立审批任务的账户全局限额。

Nuxt 的提示词通常位于具体节点参数中，目前必须由已核对的完整 payload 提供；若另传 Spec.prompt 而无相应适配，明确阻断，不静默丢弃用户文案。

## 已实现的项目协议

PHP 视频：刷新 CSRF、FormData 提交 `/aivideo/videonew/add`、POST 表单查询 `/aivideo/v2/task_status/apiGetStatus`，要求 PHP code 为数字 1，精确匹配目标 taskId。支持 apiBasePath，避免丢失 React 开发宿主的 `/fastadmin` 前缀。

Nuxt 画布：POST JSON `/canvas-workflow/execute`，限定单节点 mode；requestId 固定绑定计划 hash。GET `/canvas-workflow/tasks/{taskId}`，核对 taskId/projectId/nodeId、节点成功状态及目标类型输出。模型/参数字段必须使用该项目节点的明确绑定，不能套用 React 字段。

驱动预检核对项目关键文件的源码指纹、身份配置、请求模型/参数及素材哈希。两套协议保持隔离。新增 provider、模型和价格均不作为内核固定白名单。

## 证据、安全与已知边界

Journal 以计划 hash 定位，提交前 fsync 提交意图，临时文件原子替换保存状态。进程死亡恢复只在同一机器确认原 PID 已不存在后隔离旧锁；活跃锁、外机锁、不完整锁信息不能被强行删除。SUBMITTING 中断后始终进入未知提交，不伪造幂等保证。

媒体响应有字节上限、超时、Origin 允许列表并禁止跳转；不向资产服务转发应用凭证。文件使用 FFprobe/FFmpeg 识别并解码，限定媒体格式和本地协议，日志/进程时间/像素/时长有界。临时下载文件检查后清理，journal 保留哈希、大小、实测尺寸/时长；签名资产 URL、原始响应、CSRF 和身份信息不写入 journal。媒体工具是操作员信任的本地程序，不是 OS 沙箱。

本地素材目录只读，符号链接与伪装格式暴露为拒绝项；合成视频只写入新建子目录，不改原文件。当前支持小型 H.264/MPEG-4 合成参考视频。相关模式的具体合法尺寸/时长/大小必须来自确认的限制。

v4.31.0 已新增 Nuxt 文生视频单节点的[自主准备](panqu-mission-preparation.md)，自动获取能力/报价并构建 payload 和参数绑定，提交前重新核对；上文手工 plan 路径继续保留。

**未完成**：参考文件上传/URL 引用组装、其他项目/模式的自动能力与报价获取、跨 Mission 全局预算、批量输出、UI 自动操作、视觉内容/音质等语义 Oracle、全部后端/模型模式。当前前端需要已上传资产引用，不能把本地文件直接替代引用。未知项明确阻断；单个 Mission 的 PASSED 只代表声明的生成冒烟结构与账单证据，不代表完整业务验收。
