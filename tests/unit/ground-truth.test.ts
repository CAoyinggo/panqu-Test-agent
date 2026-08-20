// Phase 45：Ground Truth 注册表（ground-truth.ts）单元测试
// 覆盖：登记/查询/isTracked、非法 source 抛错、confidence<=0 视为不可追踪、
// groundTruthFor 批量构造、"没有 GT 不声称 accuracy" 原则。

import { describe, it, expect } from 'vitest';
import {
  GroundTruthRegistry,
  groundTruthFor,
  GROUND_TRUTH_SOURCES,
  isGroundTruthSource,
  type GroundTruthRecord,
  type GroundTruthSource,
} from '../../src/eval/ground-truth.js';
import { runDomain } from '../../src/eval/runner.js';

/** 构造一条 source 可能非法的记录（运行时校验，绕过 TS 枚举约束） */
function recordWithSource(source: string, id = 'x'): GroundTruthRecord {
  return { id, source: source as GroundTruthSource, confidence: 1 };
}

describe('GroundTruthRegistry 登记 / 查询 / isTracked', () => {
  it('登记后可查询（get / has / isTracked / confidence）', () => {
    const reg = new GroundTruthRegistry();
    reg.register({
      id: 'c-1',
      source: 'HUMAN',
      verifiedBy: 'tester',
      verifiedAt: '2026-01-01',
      confidence: 1,
    });
    expect(reg.get('c-1')).toMatchObject({ id: 'c-1', source: 'HUMAN', confidence: 1 });
    expect(reg.has('c-1')).toBe(true);
    expect(reg.isTracked('c-1')).toBe(true);
    expect(reg.confidence('c-1')).toBe(1);
  });

  it('未登记用例 → get undefined / isTracked false / confidence null', () => {
    const reg = new GroundTruthRegistry();
    expect(reg.get('ghost')).toBeUndefined();
    expect(reg.has('ghost')).toBe(false);
    expect(reg.isTracked('ghost')).toBe(false);
    expect(reg.confidence('ghost')).toBeNull();
  });

  it('size / list 反映登记情况', () => {
    const reg = new GroundTruthRegistry(groundTruthFor(['a', 'b', 'c'], { source: 'CURATED' }));
    expect(reg.size).toBe(3);
    expect(reg.list().map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('GROUND_TRUTH_SOURCES 枚举合法且 isGroundTruthSource 判定一致', () => {
    expect(GROUND_TRUTH_SOURCES).toEqual(['HUMAN', 'REAL_RUN', 'PRODUCTION', 'CURATED', 'GENERATED']);
    for (const s of GROUND_TRUTH_SOURCES) {
      expect(isGroundTruthSource(s)).toBe(true);
    }
    expect(isGroundTruthSource('ROBOT')).toBe(false);
    expect(isGroundTruthSource(42)).toBe(false);
  });
});

describe('非法 source 抛错', () => {
  it('未登记的 source 抛错', () => {
    const reg = new GroundTruthRegistry();
    expect(() => reg.register(recordWithSource('ROBOT'))).toThrow(/来源非法/);
  });

  it('缺 id（空字符串）抛错', () => {
    const reg = new GroundTruthRegistry();
    expect(() => reg.register({ id: '', source: 'HUMAN', confidence: 1 })).toThrow(/缺少 id/);
  });

  it('confidence 越界（<0 或 >1）抛错', () => {
    const reg = new GroundTruthRegistry();
    expect(() => reg.register({ id: 'y', source: 'HUMAN', confidence: 1.5 })).toThrow(/confidence/);
    expect(() => reg.register({ id: 'z', source: 'HUMAN', confidence: -0.1 })).toThrow(/confidence/);
  });
});

describe('confidence <= 0 视为不可追踪', () => {
  it('confidence=0 可登记成功，但 isTracked=false / confidence=null', () => {
    const reg = new GroundTruthRegistry();
    reg.register({ id: 'zero', source: 'CURATED', confidence: 0 });
    expect(reg.get('zero')).toBeDefined();
    expect(reg.has('zero')).toBe(false);
    expect(reg.isTracked('zero')).toBe(false);
    expect(reg.confidence('zero')).toBeNull();
  });
});

describe('groundTruthFor 批量构造', () => {
  it('默认 confidence=1，逐 id 生成记录', () => {
    const recs = groundTruthFor(['a', 'b'], { source: 'REAL_RUN', verifiedBy: 'ci' });
    expect(recs).toEqual([
      { id: 'a', source: 'REAL_RUN', verifiedBy: 'ci', verifiedAt: undefined, confidence: 1 },
      { id: 'b', source: 'REAL_RUN', verifiedBy: 'ci', verifiedAt: undefined, confidence: 1 },
    ]);
  });

  it('可覆盖 confidence / verifiedAt', () => {
    const recs = groundTruthFor(['c'], {
      source: 'GENERATED',
      confidence: 0.8,
      verifiedAt: '2026-02-02',
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toEqual({
      id: 'c',
      source: 'GENERATED',
      verifiedBy: undefined,
      verifiedAt: '2026-02-02',
      confidence: 0.8,
    });
  });
});

describe('“没有 GT 不声称 accuracy” 原则', () => {
  it('未登记 GT 的用例 tracked=false 且 score=null（绝不虚构得分）', () => {
    const reg = new GroundTruthRegistry();
    // 仅登记一条 Ground Truth
    reg.register({ id: 'req-ambiguous-01', source: 'CURATED', verifiedBy: 'phase45', confidence: 1 });

    const report = runDomain('REQUIREMENT', { groundTruthRegistry: reg });

    const untracked = report.results.filter((r) => !r.tracked);
    expect(untracked.length).toBeGreaterThan(0);
    for (const r of untracked) {
      expect(r.score).toBeNull();
      expect(r.passed).toBe(false);
      expect(r.errors.some((e) => e.includes('tracked=false'))).toBe(true);
    }

    // 已登记的那条被真实追踪并获得得分
    const tracked = report.results.filter((r) => r.tracked);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].caseId).toBe('req-ambiguous-01');
    expect(tracked[0].score).not.toBeNull();
    expect(tracked[0].tracked).toBe(true);
  });
});
