// 三档评测：Real LLM 档（Phase 20.8）
// 需配置真实 LLM（LLM_PROVIDER / LLM_API_KEY / LLM_BASE_URL）或 RUN_REAL_E2E=true 才运行，
// 否则整组跳过。验证真实 LLM 的需求理解与用例生成可解析、可落地。
import { describe, it, expect } from 'vitest';
import {
  RequirementAgent,
  TestDesignAgent,
  createAgentContext,
  ToolRegistry,
  NoopMemory,
} from '../../../src/agents/index.js';
import { createRuntimeLLM } from '../../../src/config/llm.js';
import { REAL_LLM_ENABLED, evalTiers } from './real-eval-env.js';

describe.skipIf(!REAL_LLM_ENABLED)('Eval-RealLLM：真实 LLM 档', () => {
  const llm = createRuntimeLLM({});
  const context = createAgentContext({
    taskId: 'eval-real-llm',
    feature: 'wan3',
    environment: 'test',
    tools: new ToolRegistry(),
    memory: new NoopMemory(),
    llm,
  });

  it('档位门控：Real LLM 已启用且使用非 mock Provider', () => {
    expect(REAL_LLM_ENABLED).toBe(true);
    expect(llm.name).not.toBe('mock');
  });

  it('真实 LLM 需求理解：产出可解析的 Requirement', async () => {
    const agent = new RequirementAgent();
    const req = await agent.execute('测试 WAN3 文生视频：支持 720P/1080P/4K 分辨率、任务状态流转、积分扣减与余额校验', context);
    expect(req.feature).toBeTruthy();
    expect((req.capabilities ?? []).length).toBeGreaterThan(0);
  });

  it('真实 LLM 用例生成：产出含断言与步骤的 TestCase 列表', async () => {
    const req = await new RequirementAgent().execute('测试 WAN3 文生视频：验证 1080P 提交成功与积分正确扣除', context);
    const agent = new TestDesignAgent();
    const cases = await agent.execute({ requirement: req }, context);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => (c.assertions ?? []).length > 0)).toBe(true);
  });

  it('档位摘要可读', () => {
    const t = evalTiers();
    expect(t.realLLM).toBe(true);
    expect(t.offline).toBe(true);
  });
});
