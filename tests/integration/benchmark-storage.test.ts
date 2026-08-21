import { describe, expect, it } from 'vitest';
import { createAIQualityService } from '../../src/ai-quality/service.js';
import { ContentAddressedBenchmarkStore } from '../../src/eval/benchmark/content-store.js';

describe('Phase 51.5 Benchmark storage scaling integration', () => {
  it('导入默认真实 Benchmark 两个逻辑版本，内容 blob 跨版本去重', () => {
    const service = createAIQualityService();
    const store = new ContentAddressedBenchmarkStore();
    for (const def of service.benchmarkRegistry.list()) {
      store.createVersion({
        name: def.name, version: def.version, domain: def.domain, cases: def.cases,
        source: 'CURATED', groundTruthVersion: def.version, datasetMetadata: { description: def.description ?? '' },
      });
      store.createVersion({
        name: def.name.replace(/v1$/, 'v2'), version: 'v2', domain: def.domain, cases: def.cases,
        source: 'VERSIONED_REFERENCE', groundTruthVersion: def.version, datasetMetadata: { description: def.description ?? '' },
      });
    }
    const stats = store.stats();
    expect(stats.versions).toBe(16);
    expect(stats.logicalCases).toBe(476);
    // 238 个逻辑 case 中本身已有 1 对相同内容，因此两版共 476 refs 仅需 237 blobs。
    expect(stats.uniqueBlobs).toBe(237);
    expect(stats.deduplicatedCases).toBe(239);
    expect(stats.dedupRatio).toBe(0.5021);
    for (const manifest of store.snapshot().manifests) expect(store.integrity(manifest.name).valid).toBe(true);
  });
});
