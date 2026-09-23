# Panqu AI DevTest (v6.0.0) — Coding Agent Rules

本项目必须遵守 docs/ARCHITECTURE_FREEZE.md。
未经人工明确授权，禁止改变核心架构。
交付应让接手者看懂实际操作、修改原因、行为变化和验证边界。避免重复与空话，但不要为省 Token 删除关键事实。

## 任务交付总结（强制）
每次任务结束，回复末尾附独立的 ```markdown 代码块。各项可写多条，以说清事实为准；无内容写“无”。

```markdown
# [CODEX_HANDOFF] 任务名称
STATUS: COMPLETE | PARTIAL | BLOCKED
GOAL: 本次目标与实际完成范围
DONE:
- 实际操作：对什么做了什么；重要决策说明原因
CHANGED:
- 文件路径：具体改动；解决的原问题及现在的行为/效果
VERIFIED:
- 本次执行的命令或远端运行链接：结果、关键数字及验证范围
RISKS:
- 未解决问题、未验证范围或必须保持的架构约束
NEXT:
- 下一步可执行动作；明确本次未做且不应擅自做的事
```

`DONE` 写执行过程，`CHANGED` 写改动及价值，`VERIFIED` 写证据，不要用一项替代另一项。只把本次亲自运行或查到的结果写入 `VERIFIED`；历史结果注明“沿用”，未运行写“未运行”。远端 CI 附链接与结论。目标未完成用 `PARTIAL`/`BLOCKED`，在 `RISKS` 写明缺口。不要写“已优化”“全绿”等没有对象、命令或结果的空话。
