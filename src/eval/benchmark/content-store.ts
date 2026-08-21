// Phase 51.5：内容寻址 Benchmark Storage。
// 相同 input + groundTruth + metadata 只存一份 blob；版本只保存轻量 manifest。
import { createHash } from 'node:crypto';
import type { EvaluationCase, EvaluationDomain } from '../contract.js';

export interface BenchmarkCaseRef {
  id: string;
  blobHash: string;
}

export interface BenchmarkManifest {
  name: string;
  version: string;
  domain: EvaluationDomain;
  createdAt: string;
  source: string;
  caseCount: number;
  groundTruthVersion: string;
  datasetMetadata: Record<string, unknown>;
  cases: BenchmarkCaseRef[];
  checksum: string;
}

export interface BenchmarkIntegrityReport {
  name: string;
  valid: boolean;
  checksum: string;
  expectedChecksum: string;
  caseCount: number;
  issues: Array<'CHECKSUM_MISMATCH' | 'MISSING_CASE' | 'DUPLICATE_CASE' | 'BLOB_CORRUPTION' | 'CASE_COUNT_MISMATCH'>;
  details: string[];
}

export interface ContentAddressedBenchmarkSnapshot {
  schemaVersion: 1;
  blobs: Record<string, Omit<EvaluationCase, 'id'>>;
  manifests: BenchmarkManifest[];
}

export class ContentAddressedBenchmarkStore {
  private readonly blobs = new Map<string, Omit<EvaluationCase, 'id'>>();
  private readonly manifests = new Map<string, BenchmarkManifest>();

  createVersion(input: {
    name: string;
    version: string;
    domain: EvaluationDomain;
    cases: EvaluationCase[];
    source: string;
    createdAt?: string;
    groundTruthVersion?: string;
    datasetMetadata?: Record<string, unknown>;
  }): BenchmarkManifest {
    if (this.manifests.has(input.name)) throw new Error(`Benchmark manifest 已存在：${input.name}`);
    const ids = new Set<string>();
    const refs: BenchmarkCaseRef[] = [];
    for (const evaluationCase of input.cases) {
      if (ids.has(evaluationCase.id)) throw new Error(`Benchmark duplicate case：${evaluationCase.id}`);
      ids.add(evaluationCase.id);
      const blob: Omit<EvaluationCase, 'id'> = {
        domain: evaluationCase.domain,
        input: structuredClone(evaluationCase.input),
        groundTruth: structuredClone(evaluationCase.groundTruth),
        metadata: structuredClone(evaluationCase.metadata),
      };
      const blobHash = digest(blob);
      if (!this.blobs.has(blobHash)) this.blobs.set(blobHash, blob);
      refs.push({ id: evaluationCase.id, blobHash });
    }
    const base = {
      name: input.name,
      version: input.version,
      domain: input.domain,
      createdAt: input.createdAt ?? new Date().toISOString(),
      source: input.source,
      caseCount: refs.length,
      groundTruthVersion: input.groundTruthVersion ?? input.version,
      datasetMetadata: structuredClone(input.datasetMetadata ?? {}),
      cases: refs,
    };
    const manifest: BenchmarkManifest = { ...base, checksum: digest(base) };
    this.manifests.set(manifest.name, structuredClone(manifest));
    return structuredClone(manifest);
  }

  getManifest(name: string): BenchmarkManifest | undefined {
    const manifest = this.manifests.get(name);
    return manifest ? structuredClone(manifest) : undefined;
  }

  materialize(name: string): EvaluationCase[] {
    this.assertHealthy(name);
    const manifest = this.manifests.get(name)!;
    return manifest.cases.map((ref) => ({ id: ref.id, ...structuredClone(this.blobs.get(ref.blobHash)!) }));
  }

  integrity(name: string): BenchmarkIntegrityReport {
    const manifest = this.manifests.get(name);
    if (!manifest) throw new Error(`Benchmark manifest 不存在：${name}`);
    const { checksum, ...unsigned } = manifest;
    const expectedChecksum = digest(unsigned);
    const issues: BenchmarkIntegrityReport['issues'] = [];
    const details: string[] = [];
    if (checksum !== expectedChecksum) {
      issues.push('CHECKSUM_MISMATCH');
      details.push(`manifest checksum expected=${expectedChecksum} actual=${checksum}`);
    }
    if (manifest.caseCount !== manifest.cases.length) {
      issues.push('CASE_COUNT_MISMATCH');
      details.push(`caseCount=${manifest.caseCount} refs=${manifest.cases.length}`);
    }
    const ids = new Set<string>();
    for (const ref of manifest.cases) {
      if (ids.has(ref.id) && !issues.includes('DUPLICATE_CASE')) issues.push('DUPLICATE_CASE');
      ids.add(ref.id);
      const blob = this.blobs.get(ref.blobHash);
      if (!blob) {
        if (!issues.includes('MISSING_CASE')) issues.push('MISSING_CASE');
        details.push(`missing blob ${ref.blobHash} for ${ref.id}`);
      } else if (digest(blob) !== ref.blobHash) {
        if (!issues.includes('BLOB_CORRUPTION')) issues.push('BLOB_CORRUPTION');
        details.push(`corrupted blob ${ref.blobHash} for ${ref.id}`);
      }
    }
    return { name, valid: issues.length === 0, checksum, expectedChecksum, caseCount: manifest.caseCount, issues, details };
  }

  assertHealthy(name: string): void {
    const report = this.integrity(name);
    if (!report.valid) throw new Error(`EVALUATION_BLOCKED BENCHMARK_INTEGRITY ${name}: ${report.issues.join(',')}`);
  }

  /** 损坏最新版时选取同领域最近的健康版本；不会修改或掩盖损坏记录。 */
  rollbackTarget(corruptedName: string): BenchmarkManifest {
    const corrupted = this.manifests.get(corruptedName);
    if (!corrupted) throw new Error(`Benchmark manifest 不存在：${corruptedName}`);
    if (this.integrity(corruptedName).valid) throw new Error(`Benchmark 未损坏，无需 rollback：${corruptedName}`);
    const candidates = [...this.manifests.values()]
      .filter((manifest) => manifest.domain === corrupted.domain && versionRank(manifest.version) < versionRank(corrupted.version))
      .sort((a, b) => versionRank(b.version) - versionRank(a.version));
    const target = candidates.find((manifest) => this.integrity(manifest.name).valid);
    if (!target) throw new Error(`没有可用的健康 Benchmark rollback target：${corruptedName}`);
    return structuredClone(target);
  }

  stats(): { versions: number; logicalCases: number; uniqueBlobs: number; deduplicatedCases: number; dedupRatio: number } {
    const logicalCases = [...this.manifests.values()].reduce((sum, manifest) => sum + manifest.caseCount, 0);
    const uniqueBlobs = this.blobs.size;
    return {
      versions: this.manifests.size,
      logicalCases,
      uniqueBlobs,
      deduplicatedCases: logicalCases - uniqueBlobs,
      dedupRatio: logicalCases === 0 ? 0 : Math.round((1 - uniqueBlobs / logicalCases) * 10_000) / 10_000,
    };
  }

  snapshot(): ContentAddressedBenchmarkSnapshot {
    return {
      schemaVersion: 1,
      blobs: Object.fromEntries([...this.blobs].map(([hash, blob]) => [hash, structuredClone(blob)])),
      manifests: [...this.manifests.values()].map((manifest) => structuredClone(manifest)),
    };
  }

  /** 导入后不自动“修复”损坏；由 integrity gate 检测并阻断。 */
  static import(snapshot: ContentAddressedBenchmarkSnapshot): ContentAddressedBenchmarkStore {
    if (snapshot.schemaVersion !== 1) throw new Error('Benchmark content store snapshot 版本不支持');
    const store = new ContentAddressedBenchmarkStore();
    for (const [hash, blob] of Object.entries(snapshot.blobs)) store.blobs.set(hash, structuredClone(blob));
    for (const manifest of snapshot.manifests) store.manifests.set(manifest.name, structuredClone(manifest));
    return store;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function versionRank(version: string): number {
  return Number(/^v(\d+)$/.exec(version)?.[1] ?? 0);
}
