// 单元测试：缺陷生命周期（Phase 21.4 Defect Lifecycle）
// 覆盖：状态机 / 处置 / 回归验证 / 失败签名 / 重复判定 / processFailure 端到端 / 持久化
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DefectLifecycleTracker,
  buildFailureSignature,
  canTransition,
  createDefectLifecycleTracker,
  detectDuplicate,
  scoreDuplicate,
  signatureOverlap,
  type FailureReport,
} from '../../src/defect-lifecycle/index.js';

/** 推进到指定状态的辅助函数 */
function advanceTo(tracker: DefectLifecycleTracker, id: string, status: 'FIXING' | 'REGRESSION'): void {
  const steps = status === 'FIXING'
    ? ['REVIEW', 'CREATED', 'ASSIGNED', 'FIXING'] as const
    : ['REVIEW', 'CREATED', 'ASSIGNED', 'FIXING', 'FIXED', 'REGRESSION'] as const;
  for (const s of steps) tracker.transition(id, s);
}

describe('defect-lifecycle - 状态机', () => {
  it('canTransition 合法/非法判定', () => {
    expect(canTransition('DRAFT', 'REVIEW')).toBe(true);
    expect(canTransition('FIXED', 'REGRESSION')).toBe(true);
    expect(canTransition('REGRESSION', 'FIXING')).toBe(true); // 回归失败重开
    expect(canTransition('DRAFT', 'FIXED')).toBe(false);
    expect(canTransition('CLOSED', 'DRAFT')).toBe(false);
  });

  it('完整正向链路 DRAFT → … → VERIFIED → CLOSED', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({ feature: 'wan3', title: '1080P 生成失败', severity: 'P1' });
    expect(record.status).toBe('DRAFT');
    for (const s of ['REVIEW', 'CREATED', 'ASSIGNED', 'FIXING'] as const) tracker.transition(record.id, s);
    tracker.resolve(record.id, 'FIXED');
    tracker.transition(record.id, 'REGRESSION');
    tracker.regressionResult(record.id, true);
    tracker.transition(record.id, 'CLOSED');
    const final = tracker.get(record.id)!;
    expect(final.status).toBe('CLOSED');
    expect(final.resolution).toBe('FIXED');
    expect(final.history.length).toBe(8); // 8 次迁移
    expect(final.history[0]).toMatchObject({ from: 'DRAFT', to: 'REVIEW' });
  });

  it('非法迁移抛错', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({ feature: 'wan3', title: 'x' });
    expect(() => tracker.transition(record.id, 'FIXED')).toThrow('不合法');
    expect(() => tracker.transition('no-such', 'REVIEW')).toThrow('不存在');
  });

  it('摄入校验：缺 feature / title 抛错，重复 id 抛错', () => {
    const tracker = createDefectLifecycleTracker();
    expect(() => tracker.ingest({ title: 'x' })).toThrow('缺少 feature');
    expect(() => tracker.ingest({ feature: 'wan3' })).toThrow('缺少 title');
    tracker.ingest({ id: 'def-1', feature: 'wan3', title: 'x' });
    expect(() => tracker.ingest({ id: 'def-1', feature: 'wan3', title: 'y' })).toThrow('已存在');
  });
});

describe('defect-lifecycle - 处置（Known Issue / Duplicate / Won\'t Fix）', () => {
  it('KNOWN_ISSUE → CLOSED 且进入已知问题清单', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({ feature: 'wan3', title: '偶发 503' });
    tracker.resolve(record.id, 'KNOWN_ISSUE', { note: '上游已知抖动' });
    expect(tracker.get(record.id)?.status).toBe('CLOSED');
    expect(tracker.get(record.id)?.resolution).toBe('KNOWN_ISSUE');
    expect(tracker.knownIssues().map((r) => r.id)).toContain(record.id);
  });

  it('DUPLICATE 记录 duplicateOf', () => {
    const tracker = createDefectLifecycleTracker();
    const origin = tracker.ingest({ feature: 'wan3', title: '原始 Bug' });
    const dup = tracker.ingest({ feature: 'wan3', title: '重复 Bug' });
    tracker.resolve(dup.id, 'DUPLICATE', { duplicateOf: origin.id });
    expect(tracker.get(dup.id)?.duplicateOf).toBe(origin.id);
    expect(tracker.get(dup.id)?.status).toBe('CLOSED');
  });

  it('WONT_FIX 关闭；FIXED 仅允许从 FIXING；REGRESSION_FAILED 必须走 regressionResult', () => {
    const tracker = createDefectLifecycleTracker();
    const wontfix = tracker.ingest({ feature: 'wan3', title: '低优问题' });
    tracker.resolve(wontfix.id, 'WONT_FIX');
    expect(tracker.get(wontfix.id)?.status).toBe('CLOSED');

    const draft = tracker.ingest({ feature: 'wan3', title: 'y' });
    expect(() => tracker.resolve(draft.id, 'FIXED')).toThrow('仅允许从 FIXING');

    advanceTo(tracker, draft.id, 'FIXING');
    tracker.resolve(draft.id, 'FIXED');
    expect(tracker.get(draft.id)?.status).toBe('FIXED');

    expect(() => tracker.resolve(draft.id, 'REGRESSION_FAILED')).toThrow('regressionResult');
  });
});

describe('defect-lifecycle - 回归验证', () => {
  it('回归通过 → VERIFIED；失败 → REGRESSION_FAILED 重开回 FIXING', () => {
    const tracker = createDefectLifecycleTracker();
    const pass = tracker.ingest({ feature: 'wan3', title: 'pass-case' });
    advanceTo(tracker, pass.id, 'REGRESSION');
    tracker.regressionResult(pass.id, true);
    expect(tracker.get(pass.id)?.status).toBe('VERIFIED');

    const fail = tracker.ingest({ feature: 'wan3', title: 'fail-case' });
    advanceTo(tracker, fail.id, 'REGRESSION');
    tracker.regressionResult(fail.id, false);
    expect(tracker.get(fail.id)?.status).toBe('FIXING');
    expect(tracker.get(fail.id)?.resolution).toBe('REGRESSION_FAILED');
  });

  it('仅 REGRESSION 状态可验证', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({ feature: 'wan3', title: 'x' });
    expect(() => tracker.regressionResult(record.id, true)).toThrow('仅 REGRESSION 状态可验证');
  });
});

describe('defect-lifecycle - 失败签名与重复判定', () => {
  it('buildFailureSignature 规范化（去数字/时间戳/URL）', () => {
    const sig = buildFailureSignature('HTTP 503 at 2026-08-18T10:00:00Z from https://a.com/x?id=123: Service Unavailable');
    expect(sig).not.toContain('503');
    expect(sig).not.toContain('https');
    expect(sig).toContain('service');
    expect(sig).toContain('unavailable');
    expect(buildFailureSignature(undefined)).toBe('');
  });

  it('signatureOverlap：相同错误高重叠，无关错误零重叠', () => {
    const a = buildFailureSignature('HTTP 503 Service Unavailable upstream timeout');
    const b = buildFailureSignature('HTTP 503 service unavailable, upstream timeout retry');
    const c = buildFailureSignature('billing points mismatch expected 10 got 8');
    expect(signatureOverlap(a, b)).toBeGreaterThan(0.5);
    expect(signatureOverlap(a, c)).toBe(0);
  });

  it('scoreDuplicate：feature/category/签名/用例四维计分', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({
      feature: 'wan3', title: '503 问题', category: 'NETWORK_ERROR',
      failureSignature: buildFailureSignature('HTTP 503 Service Unavailable'),
      relatedCases: ['tc-1'],
    });
    const failure: FailureReport = {
      caseId: 'tc-1', feature: 'wan3', category: 'NETWORK_ERROR',
      error: 'HTTP 503 service unavailable',
    };
    const { score, reasons } = scoreDuplicate(failure, record);
    expect(score).toBeGreaterThanOrEqual(5);
    expect(reasons).toContain('feature 一致');
    expect(reasons.some((r) => r.includes('根因类别'))).toBe(true);
  });

  it('detectDuplicate：已修复关闭的 Bug 不参与匹配（再现应视为回归）', () => {
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({
      feature: 'wan3', title: '已修复', category: 'MODEL_ERROR',
      failureSignature: buildFailureSignature('model output invalid'),
    });
    tracker.transition(record.id, 'CLOSED'); // 无 KNOWN_ISSUE resolution
    const verdict = detectDuplicate(
      { caseId: 'tc-9', feature: 'wan3', category: 'MODEL_ERROR', error: 'model output invalid' },
      [...tracker.query()],
    );
    expect(verdict.isDuplicate).toBe(false);
  });
});

describe('defect-lifecycle - processFailure 端到端（避免重复建 Bug）', () => {
  const FAILURE: FailureReport = {
    caseId: 'tc-pay-01', feature: 'wan3', category: 'NETWORK_ERROR',
    error: 'HTTP 503 Service Unavailable from upstream gateway',
  };

  it('首次失败创建新 DRAFT；相同失败再次出现 → 关联已有 Bug 不新建', () => {
    const tracker = createDefectLifecycleTracker();
    const first = tracker.processFailure(FAILURE);
    expect(first.duplicate).toBe(false);
    expect(tracker.size()).toBe(1);
    expect(tracker.get(first.defectId)?.status).toBe('DRAFT');

    // 同一问题再次回归失败（不同用例）
    const second = tracker.processFailure({ ...FAILURE, caseId: 'tc-pay-02' });
    expect(second.duplicate).toBe(true);
    expect(second.defectId).toBe(first.defectId);
    expect(tracker.size()).toBe(1); // 没有新建 Bug
    const record = tracker.get(first.defectId)!;
    expect(record.relatedCases).toEqual(expect.arrayContaining(['tc-pay-01', 'tc-pay-02']));
    expect(second.verdict.reasons.length).toBeGreaterThan(0);
  });

  it('不同失败创建独立 Bug', () => {
    const tracker = createDefectLifecycleTracker();
    tracker.processFailure(FAILURE);
    const other = tracker.processFailure({
      caseId: 'tc-bill-01', feature: 'wan3', category: 'BILLING_ERROR',
      error: 'billing points mismatch expected 10 got 8',
    });
    expect(other.duplicate).toBe(false);
    expect(tracker.size()).toBe(2);
  });

  it('KNOWN_ISSUE 状态的 Bug 持续吸收相同失败', () => {
    const tracker = createDefectLifecycleTracker();
    const first = tracker.processFailure(FAILURE);
    tracker.resolve(first.defectId, 'KNOWN_ISSUE');
    const again = tracker.processFailure({ ...FAILURE, caseId: 'tc-pay-03' });
    expect(again.duplicate).toBe(true);
    expect(again.defectId).toBe(first.defectId);
    expect(tracker.size()).toBe(1);
  });
});

describe('defect-lifecycle - 持久化', () => {
  it('save / load 往返一致，损坏文件降级空跟踪器', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-'));
    const file = path.join(dir, 'tracker.json');
    const tracker = createDefectLifecycleTracker();
    const record = tracker.ingest({ feature: 'wan3', title: 'x' });
    tracker.transition(record.id, 'REVIEW');
    tracker.save(file);

    const loaded = DefectLifecycleTracker.load(file);
    expect(loaded.size()).toBe(1);
    expect(loaded.get(record.id)?.status).toBe('REVIEW');
    expect(loaded.get(record.id)?.history).toHaveLength(1);

    fs.writeFileSync(file, '{bad');
    expect(DefectLifecycleTracker.load(file).size()).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
