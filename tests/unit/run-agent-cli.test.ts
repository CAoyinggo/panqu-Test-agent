import { describe, expect, it } from 'vitest';
import { parseAgentCliArgs } from '../../src/cli/agent-args.js';

describe('run-agent CLI argument contract', () => {
  it('支持 --model value，且 value 不会进入需求正文', () => {
    const args = parseAgentCliArgs(['测试视频生成', '--model', 'gpt-4o']);

    expect(args.requirement).toBe('测试视频生成');
    expect(args.llm.model).toBe('gpt-4o');
  });

  it('支持 --model=value', () => {
    const args = parseAgentCliArgs(['--model=gpt-4o', '测试视频生成']);

    expect(args.requirement).toBe('测试视频生成');
    expect(args.llm.model).toBe('gpt-4o');
  });

  it('拒绝同名参数重复出现，包括两种写法混用', () => {
    expect(() => parseAgentCliArgs([
      '测试视频生成',
      '--model', 'gpt-4o',
      '--model=gpt-4.1',
    ])).toThrow(/参数重复.*--model/);
  });

  it('拒绝参数缺值、空值以及后续 option 被误当成 value', () => {
    expect(() => parseAgentCliArgs(['测试视频生成', '--model'])).toThrow(/参数缺少值.*--model/);
    expect(() => parseAgentCliArgs(['测试视频生成', '--model='])).toThrow(/--model 缺少有效值/);
    expect(() => parseAgentCliArgs(['测试视频生成', '--model', '--json'])).toThrow(/参数缺少值.*--model/);
  });

  it('拒绝未知参数，不把未知 option 塞进需求正文', () => {
    expect(() => parseAgentCliArgs(['测试视频生成', '--modle', 'gpt-4o'])).toThrow(/未知参数：--modle/);
  });

  it('所有带值参数都消费自己的 value，并对数值参数严格校验', () => {
    const args = parseAgentCliArgs([
      '测试视频生成',
      '--env', 'test',
      '--memory=output/memory.json',
      '--max-tokens', '4096',
      '--budget-concurrency=4',
    ]);

    expect(args.requirement).toBe('测试视频生成');
    expect(args.env).toBe('test');
    expect(args.memoryPath).toBe('output/memory.json');
    expect(args.llm.maxTokens).toBe(4096);
    expect(args.budget.maxConcurrency).toBe(4);
    expect(() => parseAgentCliArgs(['正文', '--max-tokens=abc'])).toThrow(/--max-tokens 必须是正整数/);
  });
});
