# DevTest 标准化治理

## 分类

| 分类 | 定义 | 是否可被默认主链引用 |
| --- | --- | --- |
| STANDARD | 通用 Requirement、Business Model、TEST_CASE_V2、Execution、Evidence、Oracle、Report 标准 | 是 |
| PROJECT_SPECIFIC | 只对某项目、产品、环境或实现成立的资产 | 否 |
| LEGACY | 历史协议、历史报告、迁移输入或兼容验证 | 否 |
| SINGLE_FEATURE | 为某一功能预置流程、字段、接口或断言的模板 | 否 |

## Standard Surface

- `docs/01-测试流程SOP.md` 至 `docs/05-项目说明模板.md`
- `docs/devtest.md`
- `docs/testing/testcase-v2-schema.md`
- `docs/testing/devtest-p0-business-runtime.md`
- `tests/acceptance/templates/scenario.md`
- `src/acceptance/`
- `src/agents/test-design/` 中当前通用 Schema、Agent 和注册表

标准资产不得引用其他三类资产。历史报告和项目回归可继续存在，但只能由显式测试命令选择，不能成为 Generator、Schema、Quality Gate、Report 或开发者默认入口。

## 自动 Gate

`checkStandardizationText()` 检查标准文档和模板中的项目/产品名、固定地址、固定凭据、固定接口、单功能模板和 Legacy Entry。`checkTestCaseStandardization()` 检查 Case 的模板来源元数据和非标准标签。

Quality Gate 将违规统一转换为：

```text
STANDARDIZATION_VIOLATION
disposition = BLOCKED
```

## 变更规则

1. 新增模板必须只描述结构和 proof obligation。
2. 示例只能作为 Requirement 实例进入测试，不能成为模板选择条件。
3. Generator 只能依据 Requirement、Business Model、Business Flow、State、Rule、Risk、Actor、Role、Ownership 和 Tenant/Project 动态选择能力。
4. 标准文档、Schema、Generator、Execution Contract、Report 和测试必须同步更新。
