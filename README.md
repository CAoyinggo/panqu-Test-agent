# 盼趣AI 测试执行流程（test-flow）

> 版本：v3.4（数据工厂与环境检测版）｜ 更新：2026-08-17 ｜ 维护：AI 测试智能体

标准化、可一键执行的多业务 AI 功能测试智能体框架。每个业务功能在 `src/cases/{feature}/` 下独占一个子文件夹即可独立接入，无需改动框架代码。

**完整项目说明请查看：**

[test-flow 项目完整说明](file:///Users/mac/agents/test-flow-project-overview/test-flow-project-overview.html)

该 HTML 文档覆盖：项目概述、架构总览、执行流程、断言系统（通用断言引擎 + 17 操作符）、三大执行能力（数据生成 / Mock 录制回放 / 动态并发）、测试体系（225 条单元测试）、报告与通知、CLI 参数、CI/CD 与安全、扩展指南、版本历史与快速开始。

## 快速开始

```bash
cd /Users/mac/agents/test-flow
npm install
npm run build

# 一键执行（--task 支持：功能子目录 / 根目录全量 / 单文件）
node dist/bin/run-test.js --task src/cases/wan3 --func wan3
node dist/bin/run-test.js --task src/cases
```

详细参数说明与扩展指引见上方 HTML 项目说明文档。
