# Trae Agent 与 DevTest 执行型智能体对比

## 结论

只有 `SKILL.md`，但连接了 MCP 并能操作任务的 Trae 智能体，已经不是“纯 Skill”了，而是：

```text
Trae 模型 + SKILL.md + MCP 执行工具
```

如果它的 MCP 已经实现任务提交、轮询、状态验证和报告，那么它可能与当前 DevTest 智能体表现接近。DevTest 没有天然优势，优势必须来自 MCP 后面的测试平台能力。

## 两者真正的区别

| 维度 | Trae Skill + MCP | DevTest 目标方案 |
| --- | --- | --- |
| 使用入口 | Trae IDE 对话 | Trae、npm、CLI、GitHub CI 均可 |
| 业务理解 | 主要由模型按 Skill 临时推理 | Requirement Model、Business Model 结构化保存 |
| Case 生成 | Agent 生成后交给 MCP | DevTest 内核生成并校验 `TEST_CASE_V2` |
| 规则约束 | Skill 属于软约束，模型可能遗漏 | Schema、Quality Gate 属于代码硬约束 |
| 执行能力 | 取决于 MCP 暴露的能力 | Scenario Adapter + Runner 统一执行 |
| 环境判断 | Agent 或 MCP 自行判断 | Runtime Readiness 动态计算 |
| 负向验证 | 依赖 Skill 是否记得 | 强制验证 Response、State、Non-Mutation、Side Effect |
| 结果可信度 | 取决于 MCP 返回内容 | Evidence 与 Oracle 绑定后才可 PASS |
| 生命周期 | MCP 需要自行实现 | Prepare、Cleanup、Dependency 已统一建模 |
| 团队自动化 | 通常依赖开发者打开 Trae | GitHub PR 可无人值守运行 |
| 可复现性 | 受模型、会话和 Skill 版本影响 | npm 版本、Commit、Case、runId 可追溯 |
| 门禁能力 | 通常是对话报告 | GitHub Check 可阻断合并 |

## Trae Skill + MCP 的优势

- 部署快，一个 Skill 加 MCP 配置即可使用。
- 开发者不需要学习额外平台。
- 原生拥有当前仓库和 IDE 上下文。
- 交互灵活，适合询问需求、调整范围和探索问题。
- 如果 MCP 设计得好，也可以完成真实任务执行。
- Skill 和智能体可以快速分享给团队。

因此，在“快速投入使用”和“开发者体验”上，Trae 方案目前可能更好。

## Trae Skill + MCP 的典型局限

这些局限并非 Trae 无法解决，而是必须由 MCP 后端额外解决。

### 1. Skill 不是强制规则

Skill 写了“禁止伪造 PASS”，不代表模型每次都能严格遵守。真正可靠的约束必须写在 MCP 服务和 Runner 中。

### 2. 测试设计容易受模型波动影响

相同需求多次运行，可能产生不同的 Case、优先级和结论。如果没有结构化模型、去重和 Quality Gate，很难稳定复现。

### 3. Agent 可能成为第二套 Generator

如果 Trae 根据 Skill 自己生成完整测试计划，再交给 MCP，Trae 实际上就建立了另一套 Case 生成逻辑，容易与 `TEST_CASE_V2` 漂移。

### 4. MCP“执行了任务”不等于“验证了业务”

很多 MCP 只能做到：

```text
提交任务 → 查询状态 → 返回成功
```

但真实测试还需要验证：

```text
资源状态
数据变化
非预期修改
金额或库存
消息或队列
关联资源
Cleanup
```

### 5. 本地环境容易漂移

不同开发者可能使用不同的 Skill、MCP 版本、Node.js 版本和配置。使用 npm 锁定版本并通过 GitHub Actions 执行，更容易保证一致性。

### 6. 难以成为正式合并门禁

Trae 会话中的结论通常不会自动绑定 Commit、阻断 PR 或保存 Evidence Artifact。GitHub CI 更适合承担最终质量结论。

### 7. 会话并不是审计系统

聊天记录无法替代结构化的 Requirement Trace、Case、runId、Evidence、Oracle 和历史报告。

## DevTest 应该保留的核心优势

DevTest 的壁垒不应是智能体 Prompt，而应是：

```text
统一 Business Model
+ TEST_CASE_V2
+ Quality Gate
+ Runtime Readiness
+ Scenario Runner
+ Evidence
+ Deterministic Oracle
+ GitHub Gate
```

即使以后把 Trae 换成其他 IDE、网页或另一个模型，测试结果仍应保持一致。

2026-09-08 更新：默认 Trae MCP 已切换到 DevTest 主链，旧 `PANQU_TEST_PLAN_V1` 入口仅保留兼容。
当前本地 MCP 支持计划、只读执行、幂等重试和状态查询；真实业务写操作仍通过已配置的 GitHub Workflow 运行。
这些能力不等于已完成真实客户环境验收，也不能据此宣称全面超过其他 Trae Agent。

## 推荐组合方式

最合理的策略不是与 Trae 智能体竞争，而是让它成为 DevTest 的入口：

```text
Trae Skill 负责交互
→ DevTest MCP 负责受控调用
→ DevTest 内核负责生成和执行
→ GitHub 负责门禁
```

如果 Trae Agent 最终调用同一个 DevTest MCP，那么两者不需要比较高低：Trae 提供优秀入口，DevTest 提供可信执行内核。真正不可替代的是后者，而不是智能体外壳。
