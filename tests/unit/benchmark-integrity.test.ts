import { describe, expect, it } from 'vitest';
import { ContentAddressedBenchmarkStore } from '../../src/eval/benchmark/content-store.js';
import type { EvaluationCase } from '../../src/eval/contract.js';

const makeCase = (id: string, value = 1): EvaluationCase => ({
  id, domain: 'RISK', input: { value }, groundTruth: { category: 'dependency' }, metadata: { source: 'HUMAN' },
});

describe('Phase 51.5 Benchmark integrity', () => {
  it('相同 input + groundTruth + metadata 跨版本只存一份 blob', () => {
    const store = new ContentAddressedBenchmarkStore();
    store.createVersion({ name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', cases: [makeCase('r1')], source: 'CURATED' });
    store.createVersion({ name: 'RISK_BENCHMARK_v2', version: 'v2', domain: 'RISK', cases: [makeCase('r1-copy')], source: 'HUMAN' });
    expect(store.stats()).toEqual({ versions: 2, logicalCases: 2, uniqueBlobs: 1, deduplicatedCases: 1, dedupRatio: 0.5 });
    expect(store.materialize('RISK_BENCHMARK_v2')[0].id).toBe('r1-copy');
  });

  it('完整 manifest 包含 checksum/version/createdAt/source/caseCount/GT version/metadata', () => {
    const store = new ContentAddressedBenchmarkStore();
    const manifest = store.createVersion({
      name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', cases: [makeCase('r1')], source: 'REAL_RUN',
      createdAt: '2026-08-21T00:00:00.000Z', groundTruthVersion: 'gt-v3', datasetMetadata: { project: 'p1' },
    });
    expect(manifest).toMatchObject({ version: 'v1', createdAt: '2026-08-21T00:00:00.000Z', source: 'REAL_RUN', caseCount: 1, groundTruthVersion: 'gt-v3', datasetMetadata: { project: 'p1' } });
    expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(store.integrity(manifest.name).valid).toBe(true);
  });

  it('检测 unexpected mutation 并 BLOCK Evaluation', () => {
    const store = new ContentAddressedBenchmarkStore();
    store.createVersion({ name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', cases: [makeCase('r1')], source: 'CURATED' });
    const snapshot = store.snapshot();
    snapshot.manifests[0].source = 'TAMPERED';
    const corrupted = ContentAddressedBenchmarkStore.import(snapshot);
    expect(corrupted.integrity('RISK_BENCHMARK_v1').issues).toContain('CHECKSUM_MISMATCH');
    expect(() => corrupted.materialize('RISK_BENCHMARK_v1')).toThrow('EVALUATION_BLOCKED');
  });

  it('检测 missing case 与 blob corruption', () => {
    const store = new ContentAddressedBenchmarkStore();
    store.createVersion({ name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', cases: [makeCase('r1')], source: 'CURATED' });
    const missing = store.snapshot();
    const [hash] = Object.keys(missing.blobs);
    delete missing.blobs[hash];
    expect(ContentAddressedBenchmarkStore.import(missing).integrity('RISK_BENCHMARK_v1').issues).toContain('MISSING_CASE');

    const changed = store.snapshot();
    changed.blobs[hash].input = { value: 999 };
    expect(ContentAddressedBenchmarkStore.import(changed).integrity('RISK_BENCHMARK_v1').issues).toContain('BLOB_CORRUPTION');
  });

  it('v11 corrupted → rollback target v10', () => {
    const store = new ContentAddressedBenchmarkStore();
    store.createVersion({ name: 'RISK_BENCHMARK_v10', version: 'v10', domain: 'RISK', cases: [makeCase('r10')], source: 'HUMAN' });
    store.createVersion({ name: 'RISK_BENCHMARK_v11', version: 'v11', domain: 'RISK', cases: [makeCase('r11', 2)], source: 'HUMAN' });
    const snapshot = store.snapshot();
    snapshot.manifests.find((manifest) => manifest.version === 'v11')!.caseCount = 99;
    const corrupted = ContentAddressedBenchmarkStore.import(snapshot);
    expect(corrupted.rollbackTarget('RISK_BENCHMARK_v11').name).toBe('RISK_BENCHMARK_v10');
  });

  it('同版本 duplicate case id 在写入时拒绝', () => {
    const store = new ContentAddressedBenchmarkStore();
    expect(() => store.createVersion({ name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', cases: [makeCase('same'), makeCase('same', 2)], source: 'CURATED' })).toThrow('duplicate');
  });
});
