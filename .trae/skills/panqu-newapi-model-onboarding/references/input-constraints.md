# Panqu NewAPI 新模型接入与分流边界约束检查表

本文档逐项提取《[0903 - 主站与Newapi对接v1.2版本](https://panqu-ai.feishu.cn/docx/W3cZd813YoNMnCxiT1zckWzenwe)》需求中的格式、大小、数量、提示词、默认值、计费阶梯、分流条件、划掉项与违规拦截规则。

---

## 一、主站硬性资格拦截规则（isRequestEligible）

| 规则项 | 约束条件 | 产品测试关注 (哪里有问题/预期行为) | 研发排查与修改位置 (改哪里) |
| :--- | :--- | :--- | :--- |
| **提示词长度** | 严格限制字数 `<= 5000` | 超出 5000 字必须前置拦截，报错“提示词最多 5000 个字”，严禁发起付费生成 | `application/admin/controller/aivideo/PlotService.php` (前置参数校验函数) |
| **输出视频格式** | 禁止 `mov` 格式走分流 | `output_format='mov'` 时必须平滑降级回退直连原链路（返回 line 0），不能报错 | `application/admin/controller/aivideo/PlotService.php` (`isRequestEligible`) |
| **真人人像** | 包含真人人像时不走 NewAPI | `hasRealHuman=true` 命中人像检测规则时前置回退直连，防范敏感合规风险 | `application/admin/controller/aivideo/PlotService.php` (`checkHumanFace`) |
| **Seedance 参考视频** | Seedance 带参考视频不走 NewAPI | `ref_videos` 非空时强制回退直连链路（line 0），不能强制切入 NewAPI 导致报错 | `application/admin/controller/aivideo/PlotService.php` (`isRequestEligible`) |
| **Seedance 任务类型** | 仅全能参考任务支持分流 | `task_type=28`（全能参考）方可切流；首尾帧或其他旧模式必须走直连 | `application/admin/controller/aivideo/PlotService.php` (任务分发分支) |
| **Seedance 排除模型** | 排除特定直连模型 | 模型 ID 16 (Seedance 2.0 Fast)、58 (Seedance 2.0 Mini) 必须强制回退直连 | `application/admin/controller/aivideo/PlotService.php` (白名单数组) |
| **Wan 3.0 参考视频** | NewAPI 已支持 Wan 3.0 参考视频 | Wan 3.0 携带参考视频必须允许走 NewAPI 分流，不得误拦截 | `application/admin/controller/aivideo/PlotService.php` |

---

## 二、新渠道与新模型参数与毛利约束表

| 渠道 / 模型 | 业务分类 | 支持分辨率 | 支持画幅比例 | 产品测试质检重点 (资损/功能) | 研发刊例配置与代码位置 (改哪里) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **阿里 Wan 3.0** (`#36/#84`) | 视频分流 | 480P, 720P, 1080P | 自适应, 9:16, 16:9, 4:3, 3:4, 1:1 | 重点核查 1080p 成本 (¥2.88)，刊例需 >=42pt 防倒挂 | `PlotService.php` + 数据库表 `pq_model_point` |
| **阿里 Wan 3.0 Prime** (`#88`) | 视频分流 | 480P, 720P, 1080P | 自适应, 9:16, 16:9, 4:3, 3:4, 1:1 | 验证全能参考（支持参考视频）、首尾帧及毛利率 >=30% | `PlotService.php` + 数据库表 `pq_model_point` |
| **RunningHub 视频** (`#39`) | 视频直连 | 480P, 720P, **768P (新增)**, 1080P | 所有宽高比 | 校验新增 768P 分辨率映射；sd2.0 fast 仅限 720P | `application/admin/controller/aivideo/Videonew.php` |
| **RunningHub 图片** (`#40/#901`) | 图片直连 | 1K, 2K, 4K | 9 种宽高比例 | 拦截未配刊例白嫖漏洞 (1k: 20pt, 2k: 40pt) | `Image25Service.php` + 数据库表 `pq_model_point` |
| **TalkingData (TD)** (`#41`) | 视频分流 | 480P, 720P, 1080P, 4K | 所有宽高比 | 验证全能参考（无参考视频）；sd2.0, sd2.5 降级安全性 | `PlotService.php` + 路由配置表 `pq_aivideo_diversion_config` |

---

## 三、管理端交互与数据约束

| 模块 | 检查项 | 约束规则 | 验收标准（确定性 Oracle） |
| :--- | :--- | :--- | :--- |
| **模型管理** | 全量开关 `is_newapi_global` | 0=分组分流，1=全量分流 | 单个切换与批量切换均必须持久化，回滚后状态严格一致 |
| **模型管理** | 列表字段与类型筛选 | 展示模型ID、名称、NewAPI别名、关联渠道、是否全量开放 | 必须支持按视频/图片/音频类型筛选 |
| **渠道管理** | 菜单名称 | 菜单由「NewAPI渠道管理」更名为「渠道管理」 | 确认菜单名称变更为渠道管理 |
| **渠道管理** | 去掉新增渠道 | 渠道管理只做参数编辑，不做新增 | 页面工具栏仅保留刷新，无新增按钮 |
| **渠道管理** | 线路名称规则 | 首列线路名改为渠道拼音首字母大写 | 如万相显示 WX、TalkingData 显示 TD、火山显示 HS |
| **组织管理** | 默认分组密钥 | 包含主站所有普通用户 | 自动填充 NewAPI 默认分组密钥（前端以掩码展示） |
| **组织管理** | 企业精准搜索 | 搜索关键字 `1` | 匹配结果中 ID 为 `1` 的企业必须排在第一位 |
| **组织管理** | 移动分组二次确认 | 选中已有归属企业时二次弹窗确认 | 支持勾选移交企业 + 全选；勾选移入新组，未勾选保留原组 |
| **分流重试** | 重试范围约束 | 仅限 SD 系列模型失败进入兜底 | SD 系列失败标记 `is_need_fallback=1` 并展示兜底结果；Wan 3.0 等非 SD 报错退出 |
| **计费核销** | 汇率与计费单位 | 10 积分 = 1 元人民币 | 按秒计费（生成时长 × 输出单价 + 参考视频时长 × 参考单价） |

---

## 四、需求划掉项排除规范（删除线保护）

以下 3 项经飞书文档富文本删除线（`strikethrough: true`）属性确认，属于本期已划掉范围，**严格不作为系统缺陷、漏测项或阻塞项**：

1. ~~**接入渠道：菲玲（P2）**~~：已划掉，系统未接入，状态一致。
2. ~~**接入主站剩余视频及图片模型（P2）**~~：已划掉（存量直连历史能力，非本期新接入）。
3. ~~**主站代码同步到海外站（P1）**~~：已划掉。
