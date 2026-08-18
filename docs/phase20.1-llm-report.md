# Phase 20.1 变更报告：真实 LLM 接入（Real LLM Provider + Model Router）

> 目标：不绑定单一厂商，支持 OpenAI Compatible / DeepSeek / GLM / Doubao / Anthropic Compatible；
> 实现主备回退链 Primary →（Timeout/429/5xx/网络）→ Fallback → Deterministic Fallback；
> ModelRouter 档位环境变量可配置；CLI 支持 LLM 参数。

## 1. 变更内容

### 新增文件
| 文件 | 说明 |
| --- | --- |
| `src/llm/llm-errors.ts` | LLM 错误分类（timeout/http/network/unknown）+ 可回退判定（isRetryable）+ 回退事件类型 |
| `src/llm/fallback-provider.ts` | `FallbackLLMProvider`：主 → 备 → 确定性兜底，仅对可重试错误回退，非重试错误（400/401/403）直接暴露 |
| `src/config/llm.ts` | LLM 运行时配置：env + CLI 覆盖合并、联动 ModelRouter 档位、创建运行时 Provider、脱敏配置摘要 |
| `tests/unit/llm-fallback.test.ts` | 回退链单元测试（14 条：错误分类/超时/429/503/非重试/双失败确定性/事件监听） |
| `tests/unit/config-llm.test.ts` | 运行时配置测试（5 条：默认 Mock/CLI 优先/主备包装/档位联动/Key 不泄露） |

### 修改文件
| 文件 | 变更 |
| --- | --- |
| `src/llm/provider.ts` | `LLMConfig` 增加 `fallbackModel/maxTokens/temperature/deterministicFallback/onFallback`；`loadLLMConfigFromEnv` 支持 `LLM_FALLBACK_MODEL/LLM_MAX_TOKENS/LLM_TEMPERATURE`；`createLLMProvider` 配置 fallback 时返回 `FallbackLLMProvider` |
| `src/llm/model-router.ts` | 新增 `loadTiersFromEnv` / `applyTiersFromEnv`（`LLM_HIGH_MODEL/LLM_MEDIUM_MODEL/LLM_SMALL_MODEL`） |
| `src/llm/index.ts` | 导出 `llm-errors` / `fallback-provider` |
| `bin/run-agent.ts` | 新增 `--llm-provider/--model/--fallback-model/--llm-timeout/--max-tokens`；改用 `createRuntimeLLM`；报告输出 LLM 摘要 |
| `tests/unit/llm-provider.test.ts` | 新增环境变量加载（fallback/maxTokens/temperature）与 Fallback 包装用例 |
| `tests/unit/model-router.test.ts` | 新增环境变量档位加载/应用用例 |
| `tests/e2e/agent-e2e.test.ts` | 修复既有类型错误（`LoadedCase` 无 `id/priority`、plan 缺 `reason`），改用 `def.extra.agentTestCaseId` |
| `package.json` | `agent:test` 纳入 `llm-fallback` / `config-llm` |

## 2. 环境变量

```
LLM_PROVIDER          deepseek / glm / doubao / openai-compatible / anthropic-compatible / mock
LLM_BASE_URL          OpenAI 兼容端点
LLM_API_KEY           API Key（禁止写入代码）
LLM_MODEL             主模型
LLM_FALLBACK_MODEL    回退模型
LLM_TIMEOUT           超时毫秒
LLM_MAX_TOKENS        最大输出 token
LLM_TEMPERATURE       采样温度
LLM_HIGH_MODEL        高能力档位模型（Requirement/RCA/Analysis/Defect）
LLM_MEDIUM_MODEL      中档位模型（Test Design / Healing）
LLM_SMALL_MODEL       小档位模型（Risk/Selection/Coverage/Flaky/Classification）
```

## 3. CLI 用法

```bash
node dist/bin/run-agent.js "测试 DeepSeek API 可用性" \
  --llm-provider=deepseek \
  --model=deepseek-chat \
  --fallback-model=deepseek-reasoner \
  --llm-timeout=30000 \
  --max-tokens=4096
```

未配置任何 LLM 时默认 Mock（离线可测、CI 稳定）。

## 4. 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | PASS（含新增模块类型检查） |
| LLM 单测（3 文件 46 条 + config-llm 5 条） | PASS |
| `npm test` | 37 文件 / 611 用例 PASS（原 587 → +24） |
| `npm run agent:test` | 27 文件 / 381 用例 PASS（原 352 → +29） |
| `npm run agent:eval` | Overall 97，幻觉率 0（保持） |
| `npm run agent:e2e` | 2 用例 PASS（15 步闭环 + 安全边界） |
| CLI 集成 | `--llm-provider=mock --skip-execution` 全链路跑通 |

## 5. 约束符合性

- 未绑定单一厂商（五种 Provider 归一化为 OpenAI 兼容协议）
- API Key 仅从环境变量读取，未写入代码
- 向后兼容：未改动 Agent Pipeline / Core；未删除 Mock Benchmark / 现有 E2E
- Mock 与 Real 双模式：无 `LLM_*` 配置时默认 Mock
- 非可重试错误（400/401/403）不盲目回退，避免掩盖真实配置问题
