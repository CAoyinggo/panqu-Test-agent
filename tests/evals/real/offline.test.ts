// 三档评测：Offline 档（Phase 20.8）
// 始终运行：验证离线确定性能力（MockLLM 往返 / 离线流水线 / 确定性回退），不依赖任何网络与密钥。
import { describe, it, expect } from 'vitest';
import {
  createAgentContext,
  ToolRegistry,
  NoopMemory,
  runAgentPipeline,
  createDataPrepareTool,
} from '../../../src/agents/index.js';
import { MockLLMProvider } from '../../../src/llm/index.js';

function makeContext() {
  const llm = new MockLLMProvider({
    defaultResponse: JSON.stringify({ feature: 'wan3', confidence: 0.9, summary: 'ok', capabilities: ['提交任务'], inputs: ['prompt'], businessRules: ['积分扣减'], risks: ['积分不足'] }),
  });
  const tools = new ToolRegistry();
  tools.register(createDataPrepareTool());
  const context = createAgentContext({
    taskId: 'eval-offline',
    feature: 'wan3',
    environment: 'test',
    tools,
    memory: new NoopMemory(),
    llm,
  });
  return { llm, context };
}

describe('Eval-Offline：离线确定性档', () => {
  it('MockLLM 往返返回预期内容', async () => {
    const { llm } = makeContext();
    const res = await llm.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toContain('wan3');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('离线流水线（skipExecution）生成用例 + 需求理解 + 覆盖分析', async () => {
    const { context } = makeContext();
    const result = await runAgentPipeline(
      {
        requirementText: '测试 WAN3 文生视频：720P/1080P 分辨率、任务状态 SUCCESS、积分正确扣除',
        environment: 'test',
        options: { skipExecution: true },
      },
      context,
    );
    expect(result.testCases.length).toBeGreaterThan(0);
    expect(result.requirement.feature).toBeTruthy();
    expect(result.stages.requirement).toBe(true);
    expect(result.stages.testDesign).toBe(true);
    expect(result.outcome.executed).toBe(false);
  });

  it('MockLLM 报错时走确定性回退（不抛异常）', async () => {
    const llm = new MockLLMProvider({ failureMode: { type: 'error', message: '模拟 LLM 错误' } });
    const tools = new ToolRegistry();
    const context = createAgentContext({
      taskId: 'eval-offline-fallback',
      feature: 'wan3',
      environment: 'test',
      tools,
      memory: new NoopMemory(),
      llm,
    });
    const result = await runAgentPipeline(
      {
        requirementText: '测试 WAN3 文生视频：720P 分辨率、任务状态 SUCCESS',
        environment: 'test',
        options: { skipExecution: true },
      },
      context,
    );
    // 确定性优先：增强阶段失败不中断，核心阶段回退仍产出用例
    expect(result.testCases.length).toBeGreaterThan(0);
    expect(result.requirement.feature).toBeTruthy();
  });
});
