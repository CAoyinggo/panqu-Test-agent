// Phase 45：统一评测契约（contract.ts）单元测试
// 覆盖：EvaluationDomain 枚举、DOMAIN_LABELS 完整性、EvaluationResult.tracked=false 时 score=null 语义、
// isPassed 阈值判定（连续型 >= 0.9；null 恒为 false）。

import { describe, it, expect } from 'vitest';
import {
  ALL_DOMAINS,
  DOMAIN_LABELS,
  DEFAULT_PASS_THRESHOLD,
  isPassed,
  type EvaluationDomain,
  type EvaluationResult,
} from '../../src/eval/contract.js';

const EXPECTED_DOMAINS: EvaluationDomain[] = [
  'REQUIREMENT',
  'TEST_DESIGN',
  'RISK',
  'SELECTION',
  'RCA',
  'DEFECT',
  'HEALING',
  'RELEASE',
];

describe('EvaluationDomain 枚举', () => {
  it('恰好包含 8 个领域且无重复', () => {
    expect(ALL_DOMAINS).toHaveLength(8);
    expect(new Set(ALL_DOMAINS).size).toBe(8);
  });

  it('与预期领域集合完全一致', () => {
    expect([...ALL_DOMAINS].sort()).toEqual([...EXPECTED_DOMAINS].sort());
  });

  it('每个领域值均为合法枚举形态', () => {
    for (const d of ALL_DOMAINS) {
      expect(typeof d).toBe('string');
      expect(d).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('DOMAIN_LABELS 完整性', () => {
  it('每个领域都有非空中文标签', () => {
    for (const d of ALL_DOMAINS) {
      expect(DOMAIN_LABELS[d]).toBeTruthy();
      expect(typeof DOMAIN_LABELS[d]).toBe('string');
      expect(DOMAIN_LABELS[d].trim().length).toBeGreaterThan(0);
    }
  });

  it('DOMAIN_LABELS 的键与 ALL_DOMAINS 一一对应（无缺失、无多余）', () => {
    expect(Object.keys(DOMAIN_LABELS).sort()).toEqual([...ALL_DOMAINS].sort());
  });
});

describe('EvaluationResult.tracked=false 时 score 为 null 的语义', () => {
  it('tracked=false 的用例 score 必须为 null、passed=false', () => {
    const untracked: EvaluationResult = {
      caseId: 'untracked-1',
      domain: 'REQUIREMENT',
      score: null,
      passed: false,
      tracked: false,
      expected: undefined,
      actual: undefined,
      errors: ['未登记 Ground Truth（tracked=false，score=null）'],
    };
    expect(untracked.tracked).toBe(false);
    expect(untracked.score).toBeNull();
    expect(untracked.passed).toBe(false);
  });

  it('isPassed(null) 恒为 false（即使阈值降到 0）', () => {
    expect(isPassed(null)).toBe(false);
    expect(isPassed(null, 0.1)).toBe(false);
    expect(isPassed(null, 0)).toBe(false);
  });

  it('tracked=false 且 score=null 的用例不得被误判为通过', () => {
    const untracked: EvaluationResult = {
      caseId: 'untracked-2',
      domain: 'RISK',
      score: null,
      passed: false,
      tracked: false,
      expected: undefined,
      actual: undefined,
      errors: [],
    };
    expect(isPassed(untracked.score)).toBe(false);
    expect(untracked.passed).toBe(false);
  });
});

describe('isPassed 阈值判定', () => {
  it('默认阈值 0.9（连续型得分通过线）', () => {
    expect(DEFAULT_PASS_THRESHOLD).toBe(0.9);
  });

  it('score >= 阈值通过，< 阈值不通过（含边界）', () => {
    expect(isPassed(1)).toBe(true);
    expect(isPassed(0.95)).toBe(true);
    expect(isPassed(0.9)).toBe(true); // 边界含等
    expect(isPassed(0.899)).toBe(false);
    expect(isPassed(0.5)).toBe(false);
    expect(isPassed(0)).toBe(false);
  });

  it('支持自定义阈值', () => {
    expect(isPassed(0.8, 0.8)).toBe(true);
    expect(isPassed(0.79, 0.8)).toBe(false);
    expect(isPassed(0.5, 0.5)).toBe(true);
    expect(isPassed(0.5, 0.6)).toBe(false);
  });
});
