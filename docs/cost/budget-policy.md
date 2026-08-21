# Budget Policy

预算支持 daily、weekly、monthly、perRun、perEvaluation、perRelease。默认预警阈值为 90%，状态规则如下：

- 使用率 `< 90%`：`NORMAL`
- 使用率 `>= 90% 且 < 100%`：`WARNING`
- 使用率 `>= 100%`：`EXCEEDED`

Budget Guard 在执行前把 projected cost 加入 used；达到上限时返回 `AUTONOMOUS_STOP`，同时保留 reason、budget、used、remaining、trace。守卫复用现有 `checkAutonomousBudget`，因此成本、LLM 调用、用例数、时长、重规划与决策深度任一超限都能停止。

生产预算修改需要 `RELEASE_APPROVE` 人工权限，API/CLI 都写 Cost Audit。QA 和 Viewer 无修改能力。
