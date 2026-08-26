# Phase 13 变更报告：RCA 深度根因分析 + Flaky Test Agent

> 阶段目标（任务书第九节）：将 Analysis 拆分为 Failure Classifier → Evidence Collector → RCA Agent，
> 禁止「断言失败 → LLM 猜原因」，必须建立证据链并区分确定事实 / AI 推断 / 低置信度猜测。
> 同时新增 Flaky Test Agent（任务书第十四节）。

## 一、新增文件

| 文件 | 职责 |
|---|---|
| `src/agents/analysis/root-cause-schema.ts` | `RootCauseAnalysis` 数据模型 + JSON Schema + `buildRootCause` / `normalizeRootCause` / `validateRootCause` / `isRootCauseLike` |
| `src/agents/analysis/failure-classifier.ts` | 确定性失败分类器（超时 / 5xx / 401 / 计费 / 并发 / 网络 / 环境 / 数据 / 断言 / 未知），不依赖 LLM |
| `src/agents/analysis/evidence-collector.ts` | 证据链收集器：Assertion → HTTP Response → Scene Result → Environment → Metrics → Recent Changes → Historical Failures |
| `src/agents/analysis/root-cause-agent.ts` | RCA Agent（LLM 优先 + 确定性回退），强制「证据链先行」 |
| `src/agents/flaky/flaky-schema.ts` | `FlakyAnalysis` / `FlakyCaseRecord` / `flakiness_index` / STABLE-FLAKY-UNSTABLE-BROKEN 分类 |
| `src/agents/flaky/flaky-analyzer.ts` | 确定性 Flaky 统计（通过率 / 指数 / 分类 / 环境相关性 / 重试相关性 / 隔离） |
| `src/agents/flaky/flaky-agent.ts` | Flaky Agent（统计确定性优先，LLM 仅补充解释） |

## 二、修改文件

| 文件 | 修改内容 |
|---|---|
| `src/agents/index.ts` | 新增 6 个模块导出（root-cause / failure-classifier / evidence-collector / root-cause-agent / flaky 三件套） |
| `package.json` | `agent:test` 追加 `tests/unit/root-cause-agent.test.ts`、`tests/unit/flaky-agent.test.ts` |

## 三、新增测试

| 测试文件 | 数量 | 覆盖点 |
|---|---|---|
| `tests/unit/root-cause-agent.test.ts` | 13 | 证据链收集 / 确定性分类（TIMEOUT/AUTH/MODEL/ASSERTION）/ 历史相似失败 / LLM 失败回退 / LLM 路径证据合并 / 非法分类回落 / 归一化 |
| `tests/unit/flaky-agent.test.ts` | 11 | flakiness_index / 分类边界 / 隔离列表 / 环境相关性 / LLM 解释 / 归一化 |

## 四、关键设计决策

1. **Evidence First**：RCA Agent 先执行 `collectFullEvidence` 产出确定事实，LLM 只接收证据链（不接收原始数据），LLM 输出一律归入 `inferences`，确定事实恒来自证据链。
2. **确定性优先**：失败分类与 Flaky 统计全部由规则引擎计算（任务书第 21 节），LLM 仅做推断/解释。
3. **分类合法化**：LLM 非法 category 会先被 JSON Schema 校验拦截回退；即使通过校验也会在 `mergeEvidence` 中二次过滤回落确定性分类。
4. **Flaky 隔离**：`quarantineIds = flaky + unstable`，为后续「隔离 → 降低可信度 → 重试验证」提供依据。
5. **修复**：`DATA_ERROR` 正则收紧（原 `/data/` 误匹配 JSON 路径 `data.result.video.url`）；Flaky 分类阈值调整（0.25~0.75 为 FLAKY，边缘波动归 UNSTABLE）。

## 五、验证结果

- `npm run build` ✅
- 新增单测：24/24 通过
- `npm test`（全量回归）：27 文件 / 491 测试通过（较 Phase 12 的 467 增加 24）
- `npm run agent:test`：19 文件 / 266 测试通过

## 六、未破坏的既有能力

- Analysis Agent / Execution / Risk / Selection / Coverage 全部保持原行为（仅新增模块导出）
- 原有 491 个测试全部通过，无回归

## 七、进入 Phase 14 的前置说明

Phase 13 产物（RCA 根因分析 + Flaky 隔离列表）将作为 Phase 14 Defect Agent 的输入：
失败用例 → RCA → 标准缺陷草稿（与提交分离）。
