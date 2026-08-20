// Phase 46 / 43.15 + 43.16 + 43.17：Knowledge Learning + Quality + Decay 单元测试
import { describe, it, expect } from 'vitest';
import { KnowledgeLearning } from '../../src/ai-quality/knowledge-learning.js';

describe('Knowledge Learning（43.15）', () => {
  it('错误 → 候选（PENDING_REVIEW）→ 人工 Review → 生产 Knowledge（带 source/confidence/verified/version）', () => {
    const kl = new KnowledgeLearning({ now: () => '2026-08-20T00:00:00.000Z' });
    const c = kl.createCandidate({
      sourceRef: 'fb-1', category: 'known-issue', content: '网关 503 时禁止路径自愈', source: 'PRODUCTION_INCIDENT', confidence: 0.8,
    });
    expect(c.status).toBe('PENDING_REVIEW');
    // 未 Review 前不进入生产
    expect(kl.itemSize()).toBe(0);

    const { candidate, item } = kl.approveCandidate(c.id, 'qa-admin');
    expect(candidate.status).toBe('ACTIVE');
    expect(candidate.reviewedAt).toBeTruthy();
    expect(item.verified).toBe(true);
    expect(item.verifiedBy).toBe('qa-admin');
    expect(item.version).toBe(1);
    expect(item.status).toBe('ACTIVE');
    expect(kl.itemSize()).toBe(1);
  });

  it('未经人工 Review 禁止进入生产；候选可拒绝', () => {
    const kl = new KnowledgeLearning();
    const c = kl.createCandidate({ category: 'failure-pattern', content: 'x', source: 'SYSTEM' });
    expect(kl.itemSize()).toBe(0);
    kl.rejectCandidate(c.id, 'qa-admin', '证据不足');
    expect(c.status).toBe('REJECTED');
    expect(c.rejectReason).toBe('证据不足');
  });
});

describe('Knowledge Quality（43.16）', () => {
  it('usage/success/failure 回填 + Hit/Success/Outdated/Unused 统计', () => {
    const kl = new KnowledgeLearning({ now: () => '2026-08-20T00:00:00.000Z' });
    const { item } = kl.approveCandidate(kl.createCandidate({ category: 'risk-insight', content: 'x', source: 'REAL_RUN' }).id, 'qa');
    kl.recordUsage({ knowledgeId: item.id, outcome: 'success', at: '2026-08-20T00:00:00.000Z' });
    kl.recordUsage({ knowledgeId: item.id, outcome: 'success', at: '2026-08-20T00:00:00.000Z' });
    kl.recordUsage({ knowledgeId: item.id, outcome: 'failure', at: '2026-08-20T00:00:00.000Z' });

    const { item: unusedItem } = kl.approveCandidate(kl.createCandidate({ category: 'test-insight', content: 'y', source: 'MANUAL' }).id, 'qa');

    const q = kl.qualityMetrics();
    expect(q.total).toBe(2);
    expect(q.totalUsages).toBe(3);
    expect(q.successRate).toBeGreaterThan(0.6);
    expect(q.unusedRate).toBe(0.5); // 1/2 未使用
    const per = q.perItem.find((p) => p.id === item.id);
    expect(per?.usageCount).toBe(3);
    expect(per?.successCount).toBe(2);
    expect(per?.failureCount).toBe(1);
    expect(per?.successRate).toBeCloseTo(0.6667, 2);
    void unusedItem;
  });
});

describe('Knowledge Decay 升级（43.17）', () => {
  it('EffectiveWeight 综合 usage/success/failure/age，持续有效的老知识减缓衰减', () => {
    const kl = new KnowledgeLearning({ now: () => '2026-08-20T00:00:00.000Z' });
    const now = Date.now();
    const oldDate = new Date(now - 200 * 86400000).toISOString(); // 200 天前

    // 老但持续成功
    const { item: goodOld } = kl.approveCandidate(kl.createCandidate({ category: 'known-issue', content: 'g', source: 'REAL_PRODUCTION', confidence: 0.9 }).id, 'qa');
    (goodOld as { createdAt: string }).createdAt = oldDate;
    for (let i = 0; i < 20; i++) kl.recordUsage({ knowledgeId: goodOld.id, outcome: 'success', at: '2026-08-20T00:00:00.000Z' });

    // 老但频繁失败
    const { item: badOld } = kl.approveCandidate(kl.createCandidate({ category: 'failure-pattern', content: 'b', source: 'REAL_RUN', confidence: 0.9 }).id, 'qa');
    (badOld as { createdAt: string }).createdAt = oldDate;
    for (let i = 0; i < 20; i++) kl.recordUsage({ knowledgeId: badOld.id, outcome: 'failure', at: '2026-08-20T00:00:00.000Z' });

    const goodW = kl.effectiveWeight(goodOld, now);
    const badW = kl.effectiveWeight(badOld, now);
    expect(goodW).toBeGreaterThan(badW); // 持续成功的老知识权重高于频繁失败的老知识
    expect(badW).toBeLessThan(0.5); // 频繁失败快速降权
  });

  it('无使用记录 → 按时间衰减', () => {
    const kl = new KnowledgeLearning();
    const { item } = kl.approveCandidate(kl.createCandidate({ category: 'environment-fact', content: 'e', source: 'MANUAL', confidence: 1 }).id, 'qa');
    const fresh = kl.effectiveWeight(item, Date.now());
    const old = kl.effectiveWeight(item, Date.now() + 300 * 86400000);
    expect(fresh).toBeGreaterThan(old);
  });
});
