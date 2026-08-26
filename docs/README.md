# 项目文档索引

项目根目录只保留运行、构建、容器和 CI 工具需要自动发现的文件；设计说明、操作手册和历史报告统一收录在本目录。

## 主题文档

- **TestCase 唯一权威入口**：[DevTest TestCase V2 字段与生成规则](testing/testcase-v2-schema.md)
- **开发自测**：[用例与报告模板](02-测试用例模板.md) + [智能体 Prompt](prompts/dev-selftest-agent.prompt.md)
- [DevTest Mode：需求驱动·开发者自助测试](devtest.md)
- [Acceptance 测试流程 SOP](01-%E6%B5%8B%E8%AF%95%E6%B5%81%E7%A8%8BSOP.md)
- [版本变更记录](CHANGELOG.md)
- [Legacy 断言 DSL 兼容说明](assertion-dsl.md)
- [环境策略边界](environment-policy-boundaries.md)
- [Memory 存储与迁移](operations/memory-storage.md)
- [运维与部署](operations/)
- [产品工作流](product/)
- [AI 质量治理](ai-quality/)
- [评测体系](evaluation/)
- [成本与容量治理](cost/)

## Current 与 Legacy 边界

- 当前自动生成链只以 TestCase V2/canonical Scenario 为执行契约。Markdown Scenario 可复制 [`tests/acceptance/templates/scenario.md`](../tests/acceptance/templates/scenario.md)。
- [`02-模板合集.md`](02-%E6%A8%A1%E6%9D%BF%E5%90%88%E9%9B%86.md)、`tasks/*.json`、旧式单行用例表和手填结果只作为 **LEGACY** 盘点/迁移输入，不能直接证明已执行或已验证。
- `docs/phases/`、`docs/reports/` 和带日期的 audit/report 是历史记录，不得作为当前字段定义或生成规则。

## 报告与历史

- [DevOps 验证报告](reports/devops/)
- Phase 里程碑、验收和演练报告统一存放在 [phases/](phases/)，按阶段编号检索。
