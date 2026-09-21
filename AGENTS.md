# Panqu AI DevTest — Coding Agent Rules

本项目必须遵守 docs/ARCHITECTURE_FREEZE.md。
未经人工明确授权，禁止改变核心架构。

## 任务交付总结规范（Codex Handoff / 强制模板）
每次执行完任务，回复末尾必须附加一个独立的、可一键复制的代码块（使用 ```markdown 标记），并且**必须严格按以下格式输出**，严禁省略字段或更改结构，以最小 Token 消耗高密度传达事实：

```markdown
# [CODEX_HANDOFF] 任务名称

TARGET:
一句话说明目标。

STATUS:
COMPLETE / PARTIAL / BLOCKED

CHANGED:
- 文件：具体行为变化
- 文件：具体行为变化

VERIFIED:
- 测试命令和结果
- 构建结果
- diff check 结果

OPEN_RISKS:
- 尚未确认的问题
- 仍可能存在的漏洞

INVARIANTS:
- 下一步不得破坏的规则

NEXT:
- 下一步只做什么
- 明确不做什么
```
