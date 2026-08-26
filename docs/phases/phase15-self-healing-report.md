# Phase 15 变更报告：Self-Healing Agent（自愈建议）

> 阶段目标（任务书第十一节）：检测 API 字段 / JSON Path / 接口结构 / 参数 / 场景 / 错误码 / 测试数据 / Selector 变化。
> 铁律：LLM 一律不得自动修改核心代码；发现问题 → 生成 Diff → 风险评估 → 人工确认（Approval）→ 才允许修改。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `src/agents/self-healing/healing-schema.ts` | `HealingSuggestion` / `HealingAnalysis` 数据模型 + JSON Schema + 归一化 |
| `src/agents/self-healing/healing-analyzer.ts` | 确定性检测：路径失效判定 / 点分路径提取 / 路径相似度 / 最近路径搜索 / Patch 生成 |
| `src/agents/self-healing/self-healing-agent.ts` | Self-Healing Agent（确定性检测优先 + LLM 补充理由） |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `src/agents/index.ts` | 新增 self-healing 模块导出 |
| `package.json` | `agent:test` 追加 `tests/unit/self-healing-agent.test.ts` |

## 三、新增测试

| 测试文件 | 数量 | 覆盖点 |
|---|---|---|
| `tests/unit/self-healing-agent.test.ts` | 12 | 路径提取/相似度/最近路径搜索/路径失效判定 / 确定性分析（失效+新 Schema→建议；非失效→不产出；证据不足→不产出）/ Agent 路径（LLM 补理由不改路径；LLM 失败回退；无可修复项不调用 LLM）/ 归一化 |

## 四、关键设计决策

1. **绝不自动改码**：所有建议状态恒为 `SUGGESTED`；Patch 文本明确标注「请人工确认后应用」。LLM 被禁止声称已修改代码。
2. **Deterministic First**：路径失效检测、相似度匹配、Patch 生成全部由规则引擎完成；LLM 仅补充修复理由。
3. **证据不足不产出**：相似度 < 0.4 或无法定位新 Path 时不生成建议，避免误改。
4. **风险分级**：相似度 ≥ 0.8 → low 风险，否则 medium；提交 approval 时据此定级。

## 五、验证结果

- `npm run build` ✅
- 新增单测：12/12 通过
- `npm test`（全量回归）：29 文件 / 514 测试通过（较 Phase 14 的 502 增加 12）
- 未破坏既有能力

## 六、进入 Phase 16 的前置说明

Phase 16 Approval 将承接 Self-Healing 的 SUGGESTED 建议（以及缺陷提交、高风险执行等），
实现 AUTO / REVIEW / MANUAL / DENY 分级审批 + 审计日志 + 状态机（checkpoint/resume）。
