// 单元测试：Healing Loop 工具（Phase 20.5）
// 覆盖：parseHealingPatch / applyHealingPatch（path、field、error-code）/
// evaluateHealingApproval（审批门禁：DENY / REVIEW / AUTO）/ 新检测函数
import { describe, it, expect } from 'vitest';
import {
  parseHealingPatch,
  applyHealingPatch,
  evaluateHealingApproval,
  extractErrorCodeMismatch,
  classifyPathChange,
  buildHealingSuggestion,
} from '../../src/agents/index.js';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';

describe('healing-loop - parseHealingPatch', () => {
  it('解析路径补丁 from → to', () => {
    expect(parseHealingPatch("- path: 'data.result.url'\n+ path: 'data.output.url'"))
      .toEqual({ from: 'data.result.url', to: 'data.output.url' });
  });

  it('解析错误码补丁 from → to', () => {
    expect(parseHealingPatch("- expectedCode: '4001'\n+ expectedCode: '4003'"))
      .toEqual({ from: '4001', to: '4003' });
  });

  it('缺少 + 行 → 返回 null', () => {
    expect(parseHealingPatch("- path: 'a.b'")).toBeNull();
  });
});

describe('healing-loop - applyHealingPatch', () => {
  const base: TestCase = {
    id: 't1', feature: 'wan3', name: 'n', priority: 'P0', tags: [],
    steps: [{ action: 'submit' }],
    assertions: [
      { target: 'response', path: 'data.result.url', operator: 'equals', expected: 'v', severity: 'P0' },
    ],
    expected: { fields: { url: 'v' } },
  };

  it('json-path 补丁改写断言 path（不改原对象）', () => {
    const s = buildHealingSuggestion({
      caseId: 't1', type: 'json-path', oldPath: 'data.result.url', newPath: 'data.output.url',
      patch: "- path: 'data.result.url'\n+ path: 'data.output.url'", confidence: 0.8,
    });
    const { def, diff } = applyHealingPatch(s, base);
    expect(base.assertions[0].path).toBe('data.result.url'); // 原对象不变
    expect(def.assertions[0].path).toBe('data.output.url');
    expect(diff).toContain("data.output.url");
  });

  it('error-code 补丁改写期望值（断言 + expected.fields 同步）', () => {
    const s = buildHealingSuggestion({
      caseId: 't1', type: 'error-code', oldPath: 'error.code', newPath: '4003',
      patch: "- expectedCode: '4001'\n+ expectedCode: '4003'", confidence: 0.7,
    });
    const tc: TestCase = {
      ...base,
      assertions: [{ target: 'custom', operator: 'equals', expected: '4001' }],
      expected: { fields: { code: '4001' } },
    };
    const { def } = applyHealingPatch(s, tc);
    expect(def.assertions[0].expected).toBe('4003');
    expect(def.expected!.fields!.code).toBe('4003');
  });

  it('补丁缺少目标值 → 不应用并提示', () => {
    const s = buildHealingSuggestion({
      caseId: 't1', type: 'json-path', oldPath: 'a.b', patch: "- path: 'a.b'", confidence: 0.5,
    });
    const { diff } = applyHealingPatch(s, base);
    expect(diff).toContain('缺少目标值');
  });
});

describe('healing-loop - evaluateHealingApproval', () => {
  const suggestion = buildHealingSuggestion({
    caseId: 'c1', type: 'json-path', oldPath: 'a.b', newPath: 'a.c',
    patch: "- path: 'a.b'\n+ path: 'a.c'", confidence: 0.9, risk: 'low',
  });

  it('apply-healing 恒为变更类操作：未获人工批准不授予（REVIEW）', () => {
    const r = evaluateHealingApproval(suggestion, 'test', 'rejected');
    expect(r.decision).toBe('REVIEW');
    expect(r.granted).toBe(false);
  });

  it('人工 approved → 授予', () => {
    const r = evaluateHealingApproval(suggestion, 'test', 'approved');
    expect(r.granted).toBe(true);
  });

  it('生产环境 + P0 → MANUAL，仍需人工批准', () => {
    const highRisk = buildHealingSuggestion({
      caseId: 'c1', type: 'error-code', oldPath: 'error.code', newPath: '4003',
      patch: "- expectedCode: '4001'\n+ expectedCode: '4003'", risk: 'high',
    });
    const r = evaluateHealingApproval(highRisk, 'production', 'rejected');
    expect(r.decision).toBe('MANUAL');
    expect(r.granted).toBe(false);
  });
});

describe('healing - 新增检测函数', () => {
  it('extractErrorCodeMismatch：中英文两种表达', () => {
    expect(extractErrorCodeMismatch('断言错误码失败：期望 4001，实际 4003'))
      .toEqual({ oldCode: '4001', newCode: '4003' });
    expect(extractErrorCodeMismatch('expected 4001, got 4003'))
      .toEqual({ oldCode: '4001', newCode: '4003' });
    expect(extractErrorCodeMismatch('错误码 4003 与期望 4001 不一致'))
      .toEqual({ oldCode: '4001', newCode: '4003' });
  });

  it('extractErrorCodeMismatch：非错误码文本返回 null（如 503 服务错误）', () => {
    expect(extractErrorCodeMismatch('HTTP 503 Service Unavailable expected SUCCESS, got 503')).toBeNull();
  });

  it('classifyPathChange：结构变化 → json-path，叶子字段重命名 → api-field', () => {
    expect(classifyPathChange('data.result.url', 'data.output.url')).toBe('json-path');
    expect(classifyPathChange('data.result.video.url', 'data.output.video.url')).toBe('json-path');
    expect(classifyPathChange('data.task.status', 'data.task.taskStatus')).toBe('api-field');
  });
});
