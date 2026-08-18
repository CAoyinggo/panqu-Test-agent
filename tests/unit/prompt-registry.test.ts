// 单元测试：Prompt Registry（Phase 10 Prompt 管理）
// 覆盖：注册 / 按版本获取 / 最新版本 / 版本列表（A/B Test 基础）/ 移除 / 清除
import { describe, it, expect } from 'vitest';
import {
  PromptRegistry,
  PromptDefinition,
  promptRegistry,
  registerRequirementPrompts,
  REQUIREMENT_PROMPT_V1,
} from '../../src/agents/index.js';

const p1: PromptDefinition = {
  key: 'test-design.v1',
  name: 'test-design',
  version: 'v1',
  purpose: '设计测试用例',
  inputSchema: { type: 'string' },
  outputSchema: { type: 'object' },
  model: 'medium',
  temperature: 0.3,
  system: 'design v1',
};

const p2: PromptDefinition = {
  key: 'test-design.v2',
  name: 'test-design',
  version: 'v2',
  purpose: '设计测试用例（增强）',
  inputSchema: { type: 'string' },
  outputSchema: { type: 'object' },
  model: 'medium',
  temperature: 0.3,
  system: 'design v2',
};

describe('prompt-registry - 注册与获取', () => {
  const reg = new PromptRegistry();

  it('注册后可精确获取', () => {
    reg.register(p1);
    const got = reg.get('test-design.v1');
    expect(got?.version).toBe('v1');
    expect(got?.system).toBe('design v1');
  });

  it('getVersion 未指定版本时取最新', () => {
    reg.register(p2);
    expect(reg.getVersion('test-design')?.version).toBe('v2');
  });

  it('getVersion 指定版本返回对应版本', () => {
    expect(reg.getVersion('test-design', 'v1')?.system).toBe('design v1');
  });

  it('listVersions 返回该名全部版本（A/B Test 基础）', () => {
    const all = reg.listVersions('test-design');
    expect(all.map((x) => x.version)).toEqual(['v1', 'v2']);
  });

  it('list 返回全部注册 Prompt', () => {
    expect(reg.list().length).toBe(2);
  });

  it('unregister 移除后不可获取', () => {
    expect(reg.unregister('test-design.v1')).toBe(true);
    expect(reg.get('test-design.v1')).toBeUndefined();
  });

  it('clear 清空全部', () => {
    reg.clear();
    expect(reg.list().length).toBe(0);
  });
});

describe('prompt-registry - Requirement Prompt 注册', () => {
  it('REQUIREMENT_PROMPT_V1 元数据完整', () => {
    expect(REQUIREMENT_PROMPT_V1.key).toBe('requirement.v1');
    expect(REQUIREMENT_PROMPT_V1.purpose).toContain('结构化 Requirement');
    expect(REQUIREMENT_PROMPT_V1.model).toBe('high');
    expect(REQUIREMENT_PROMPT_V1.temperature).toBe(0);
    expect(REQUIREMENT_PROMPT_V1.system.length).toBeGreaterThan(50);
  });

  it('registerRequirementPrompts 幂等注册到全局注册表', () => {
    registerRequirementPrompts();
    registerRequirementPrompts(); // 再次调用不覆盖
    expect(promptRegistry.get('requirement.v1')?.key).toBe('requirement.v1');
  });
});
