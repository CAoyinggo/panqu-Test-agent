# DevTest 通用测试标准

本目录的当前标准只服务于需求驱动生成，不绑定产品、项目、功能、接口或技术实现。

当前发布版本为 `v4.38.0`。根项目的完整入口和安全边界见[主 README](../README.md)，版本变化见[CHANGELOG](CHANGELOG.md)。

## 唯一标准入口

1. [通用测试流程 SOP](01-测试流程SOP.md)
2. [通用测试用例模板](02-测试用例模板.md)
3. [通用测试数据需求清单](03-数据需求清单模板.md)
4. [通用任务启动检查清单](04-新任务启动检查清单模板.md)
5. [通用测试实施说明](05-项目说明模板.md)
6. [TEST_CASE_V2 Schema 与生成规则](testing/testcase-v2-schema.md)
7. [Business Model、Adapter 与 Runtime Readiness](testing/devtest-p0-business-runtime.md)
8. [标准化治理与资产分类](testing/standardization-governance.md)
9. [测试设计智能标准](testing/test-design-intelligence.md)
10. [开发自测智能体 Prompt](prompts/dev-selftest-agent.prompt.md)
11. [DevTest 持续优化 Prompt](prompts/devtest-implementation-agent.prompt.md)
12. [Developer Self-Test 使用指南](testing/developer-self-test.md)
13. [TestCase V2 Schema](testing/testcase-v2-schema.md)
14. [开发交接与发布检查清单](testing/developer-handoff-release-checklist.md)

## 当前能力导航

- 结果与报告：统一执行契约、覆盖台账、产品缺陷/测试阻断/未测/通过清单与统计对账；独立适配器不代表全部平台入口已迁移。

- 规划与执行：自主场景规划、执行 DAG、模型规格矩阵、Git 改动影响分析。
- 诊断与证据：测试环境只读探针、任务受控监视、失败复现包、计费与毛利核算。
- 协作与门禁：PR 综合审查、Check Run/Commit Status 载荷、评论命令、CI 工作流和合并后发布动作载荷。
- 安全边界：MCP 默认 Mock，不接收明文 Cookie；真实探针仅允许受信测试环境；仿真能力不能当作真实系统结果；GitHub 动作均需外部 MCP 显式执行。

## 标准链

```text
通用测试标准
↓
Requirement Model
↓
Business Model
↓
Business Scenario
↓
动态测试维度
↓
TEST_CASE_V2
↓
Execution
↓
Evidence
↓
Oracle
↓
Report
```

标准字段、生成器、Execution Contract 和 Report 必须保持同源。历史报告、演练记录和项目资产不构成当前标准，也不得被 Generator、Schema、Quality Gate、Report 或开发者入口引用。
