# Phase 14 变更报告：Defect Agent（标准缺陷草稿）

> 阶段目标（任务书第十节）：FAIL → RCA → Defect Agent → 标准缺陷草稿。
> 铁律：缺陷生成与缺陷提交必须分离，第一阶段只能生成 Defect Draft，不能默认创建正式缺陷。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `src/agents/defect/defect-schema.ts` | `DefectDraft` 数据模型（标题/严重度/优先级/描述/复现步骤/预期/实际/影响范围/环境/证据/日志/响应摘要/相关用例/RCA 引用）+ JSON Schema + `buildDefect` / `normalizeDefect` / `validateDefect` |
| `src/agents/defect/defect-agent.ts` | Defect Agent（LLM 优先 + 确定性回退），产出缺陷草稿数组 |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `src/agents/index.ts` | 新增 defect 模块导出 |
| `package.json` | `agent:test` 追加 `tests/unit/defect-agent.test.ts` |

## 三、新增测试

| 测试文件 | 数量 | 覆盖点 |
|---|---|---|
| `tests/unit/defect-agent.test.ts` | 11 | 确定性生成（严重度映射：MODEL/BILLING→P1、ENV→P3）/ 无 RCA 兜底 / LLM 路径（RCA 引用确定性对齐）/ 失败回退 / 非法 JSON 回退 / 空失败 / 归一化 |

## 四、关键设计决策

1. **草稿与提交分离**：`DefectDraft.status` 恒为 `'DRAFT'`，Agent 绝不声称已提交缺陷；提交动作必须经 Phase 16 Approval。
2. **严重度/优先级由规则映射**（Deterministic First）：AUTH/BILLING/MODEL → P1/HIGH，ASSERTION/TIMEOUT/CONCURRENCY/DATA → P2/MEDIUM，ENV/NETWORK/TEST_CODE → P3/LOW。
3. **RCA 引用以确定性为准**：LLM 生成的草稿在归一化时强制对齐真实 RCA（caseId 匹配），防止 LLM 编造根因。
4. **LLM 批量生成**：一次调用为全部失败用例生成草稿数组（≤10 条），失败则逐条确定性生成。

## 五、验证结果

- `npm run build` ✅
- 新增单测：11/11 通过
- `npm test`（全量回归）：28 文件 / 502 测试通过（较 Phase 13 的 491 增加 11）
- 未破坏既有能力（Analysis/RCA/Flaky 等全部保持）

## 六、进入 Phase 15 的前置说明

Phase 15 Self-Healing Agent 将复用 RCA 证据（响应结构变化）识别 API 字段/JSON Path 失效，
检测「测试代码 vs 服务变化」问题并生成修复 Diff 建议（仍需人工确认，不自动改码）。
