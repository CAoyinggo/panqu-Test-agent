// Phase 29.3 回归守卫：碰撞安全 ID
// 背景：容量基线（benchAuditOps 10万+ ops/s 写入）暴露了 `Date.now() + Math.random().toString(36).slice()`
// 组合 ID 在高吞吐下会碰撞（同毫秒 + 随机尾重复 → Repository.create 抛「实体已存在」）。
// 修复：src/core/id.ts 改用 crypto.randomUUID（128 bit 熵）作随机尾。
// 本测试验证：生成 ID 的格式、高并发下无重复、以及此前会碰撞的复现场景不再碰撞。

import { describe, it, expect } from 'vitest';
import { generateId } from '../../src/core/id.js';

describe('core/id.ts 碰撞安全 ID（29.3 修复）', () => {
  it('格式：<prefix>-<timestamp36>-<32位hex>', () => {
    const id = generateId('audit');
    expect(id).toMatch(/^audit-[0-9a-z]+-[0-9a-f]{32}$/);
  });

  it('同一毫秒内高频生成 10000 个 ID 无重复（碰撞缺陷回归守卫）', () => {
    // 原实现：同毫秒内 Date.now() 相同，随机尾仅数位 base36 → 高吞吐必碰撞。
    // 新实现：randomUUID 128 bit 熵 → 同一毫秒内大量生成仍唯一。
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const id = generateId('audit');
      expect(ids.has(id), `第 ${i} 个 ID 与已有 ID 碰撞：${id}`).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(10000);
  });

  it('不同前缀互不影响（audit / job / run 独立命名空间）', () => {
    const a = generateId('audit');
    const j = generateId('job');
    const r = generateId('run');
    expect(a.startsWith('audit-')).toBe(true);
    expect(j.startsWith('job-')).toBe(true);
    expect(r.startsWith('run-')).toBe(true);
    expect(a).not.toBe(j);
    expect(j).not.toBe(r);
  });

  it('generatePlatformRunId 使用碰撞安全随机尾', async () => {
    const { generatePlatformRunId } = await import('../../src/platform/runs/run-schema.js');
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = generatePlatformRunId();
      expect(id).toMatch(/^run-\d{14}-[0-9a-f]{32}$/);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });
});
