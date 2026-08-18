// 单元测试：Requirement Normalizer（Phase 10 需求理解增强）
// 覆盖：统一归一化入口 / 文档与 Markdown 提取 / goal·constraints·risks 确定性提取 / 版本化 / 审计摘要
import { describe, it, expect } from 'vitest';
import {
  normalizeRequirementInput,
  extractRequirementText,
  withRequirementVersion,
  summarizeRequirement,
  parseRequirement,
  normalizeRequirement,
} from '../../src/agents/index.js';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常，禁止真实扣费，仅限测试环境执行。';

describe('requirement-normalizer - 统一归一化入口', () => {
  it('字符串输入 → 规则解析出完整 Requirement（含 goal/constraints/risks/version）', () => {
    const req = normalizeRequirementInput(DEMO_REQ);
    expect(req.feature).toBe('wan3');
    expect(req.goal).toContain('文生视频');
    expect(req.capabilities).toContain('text-to-video');
    expect(req.inputs).toContain('resolution');
    expect(req.dependencies).toContain('积分服务');
    expect(req.constraints).toContain('禁止真实扣费');
    expect(req.constraints).toContain('仅限测试环境执行');
    expect(req.risks).toContain('billing');
    expect(req.risks).toContain('concurrency');
    expect(req.version).toBe('v1');
    expect(req.source).toBe(DEMO_REQ);
  });

  it('结构化对象输入 → 规整新字段并保留', () => {
    const req = normalizeRequirementInput({
      feature: 'wan3',
      goal: '验证文生视频完整链路',
      capabilities: ['text-to-video'],
      inputs: ['prompt'],
      requirements: [{ name: 'resolution', values: ['720P', '1080P'] }],
      businessRules: ['任务提交成功'],
      dependencies: ['模型服务'],
      constraints: ['禁止真实扣费'],
      risks: ['billing'],
    });
    expect(req.goal).toBe('验证文生视频完整链路');
    expect(req.constraints).toEqual(['禁止真实扣费']);
    expect(req.risks).toEqual(['billing']);
    expect(req.version).toBe('v1');
  });

  it('空文本抛错', () => {
    expect(() => normalizeRequirementInput('')).toThrow();
  });
});

describe('requirement-normalizer - 文档/Markdown 提取', () => {
  const DOC = `# 文生视频测试需求

## 目标
验证文生视频完整链路。

## 范围
- 覆盖 720P、1080P 分辨率
- 支持 5 秒和 10 秒视频

## 业务规则
- 任务提交成功
- 积分正确扣除

> 约束：禁止真实扣费、仅限测试环境执行。

\`\`\`json
{"ignored": true}
\`\`\`

参考 [需求文档](https://example.com/docs/wan3) 详见。`;

  it('extractRequirementText 去除代码块/表格/链接/标题符号', () => {
    const plain = extractRequirementText(DOC);
    expect(plain).not.toContain('```');
    expect(plain).not.toContain('#');
    expect(plain).not.toContain('https://');
    expect(plain).not.toContain('ignored');
    expect(plain).toContain('文生视频');
    expect(plain).toContain('720P');
  });

  it('文档输入 → 可解析出需求（markdown 输入走提取分支）', () => {
    const req = normalizeRequirementInput(DOC, { source: DOC });
    expect(req.feature).toBe('wan3');
    expect(req.inputs).toContain('resolution');
    expect(req.businessRules).toContain('积分正确扣除');
    expect(req.constraints).toContain('禁止真实扣费');
    expect(req.source).toBe(DOC);
  });

  it('RequirementAgent 支持 format=markdown 输入', async () => {
    const { RequirementAgent, createAgentContext, ToolRegistry, NoopMemory } = await import('../../src/agents/index.js');
    const { MockLLMProvider } = await import('../../src/llm/index.js');
    const agent = new RequirementAgent();
    const context = createAgentContext({
      taskId: 't',
      feature: 'wan3',
      environment: 'test',
      tools: new ToolRegistry(),
      memory: new NoopMemory(),
      llm: new MockLLMProvider(),
    });
    const req = await agent.execute({ text: DOC, format: 'markdown', version: 'v2' }, context);
    expect(req.feature).toBe('wan3');
    expect(req.version).toBe('v2');
    expect(req.source).toBe(DOC);
    expect(req.goal).toBeTruthy();
  });
});

describe('requirement-normalizer - 版本化与摘要', () => {
  it('withRequirementVersion 附版本不覆盖既有字段', () => {
    const req = parseRequirement(DEMO_REQ);
    const v2 = withRequirementVersion(req, 'v2');
    expect(v2.version).toBe('v2');
    expect(v2.feature).toBe('wan3');
    expect(v2.businessRules.length).toBeGreaterThan(0);
  });

  it('summarizeRequirement 产出可读审计摘要', () => {
    const req = normalizeRequirementInput(DEMO_REQ);
    const s = summarizeRequirement(req);
    expect(s).toContain('wan3');
    expect(s).toContain('风险[');
    expect(s).toContain('billing');
    expect(s).toContain('concurrency');
  });
});

describe('requirement-parser - 确定性 goal/constraints/risks 提取', () => {
  it('正常需求：goal 取原文短语', () => {
    const req = parseRequirement('测试文生视频功能，验证任务提交成功与积分正确扣除');
    expect(req.goal).toBeTruthy();
    expect(req.risks).toContain('billing');
  });

  it('异常场景：识别 exception/timeout 风险', () => {
    const req = parseRequirement('测试订单超时与异常失败，模型服务返回错误');
    expect(req.risks).toContain('timeout');
    expect(req.risks).toContain('exception');
  });

  it('无风险关键词时风险不编造', () => {
    const req = parseRequirement('测试视频封面图生成功能');
    expect(req.risks ?? []).not.toContain('security');
  });

  it('normalizeRequirement 规整对象含新字段', () => {
    const req = normalizeRequirement({ feature: 'wan3', goal: 'g', constraints: ['c'], risks: ['r'], version: 'v3' });
    expect(req.goal).toBe('g');
    expect(req.constraints).toEqual(['c']);
    expect(req.risks).toEqual(['r']);
    expect(req.version).toBe('v3');
  });
});
