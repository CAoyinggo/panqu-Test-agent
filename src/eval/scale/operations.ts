import { ContentAddressedBenchmarkStore, type BenchmarkIntegrityReport } from '../benchmark/content-store.js';
import { DataLifecycleStore, type ArchiveArtifact } from '../lifecycle/index.js';
import { detectEvaluationDrift, EvaluationMetricsAggregator, type DriftReport, type DriftSnapshot, type EvaluationTelemetryRecord, type AggregationDimension } from '../metrics/index.js';
import { RecoveryCoordinator } from '../recovery/index.js';
import { EvaluationQueue } from './evaluation-queue.js';
import type { EvaluationWorkerState, WorkerPoolMetrics } from './worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationQueueJob } from './evaluation-queue.js';
import type { LifecycleRecord } from '../lifecycle/index.js';
import type { ContentAddressedBenchmarkSnapshot } from '../benchmark/content-store.js';
import type { EvaluationMetricsSnapshot } from '../metrics/index.js';
import type { RecoverySnapshot } from '../recovery/index.js';

export interface EvaluationScaleAudit {
  id: string;
  projectId: string;
  actor: string;
  action: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface EvaluationProjectOperations {
  queue: EvaluationQueue;
  workers: EvaluationWorkerState[];
  lifecycle: DataLifecycleStore;
  metrics: EvaluationMetricsAggregator;
  recovery: RecoveryCoordinator;
  benchmarks: ContentAddressedBenchmarkStore;
  capacity?: WorkerPoolMetrics;
  driftBaseline?: DriftSnapshot;
  driftCurrent?: DriftSnapshot;
  latestArchive?: ArchiveArtifact;
}

export interface EvaluationScaleSnapshot {
  schemaVersion: 1;
  projects: Record<string, {
    queue: EvaluationQueueJob[];
    workers: EvaluationWorkerState[];
    lifecycle: LifecycleRecord[];
    metrics: EvaluationMetricsSnapshot;
    recovery: RecoverySnapshot;
    benchmarks: ContentAddressedBenchmarkSnapshot;
    capacity?: WorkerPoolMetrics;
    driftBaseline?: DriftSnapshot;
    driftCurrent?: DriftSnapshot;
    latestArchive?: ArchiveArtifact;
  }>;
  audits: EvaluationScaleAudit[];
}

export class EvaluationScaleService {
  private readonly projects = new Map<string, EvaluationProjectOperations>();
  private readonly audits: EvaluationScaleAudit[] = [];

  forProject(projectId: string): EvaluationProjectOperations {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        queue: new EvaluationQueue(), workers: [], lifecycle: new DataLifecycleStore(),
        metrics: new EvaluationMetricsAggregator(), recovery: new RecoveryCoordinator(),
        benchmarks: new ContentAddressedBenchmarkStore(),
      };
      this.projects.set(projectId, state);
    }
    return state;
  }

  setWorkers(projectId: string, workers: EvaluationWorkerState[]): void {
    this.forProject(projectId).workers = structuredClone(workers);
  }

  setCapacity(projectId: string, capacity: WorkerPoolMetrics): void {
    this.forProject(projectId).capacity = structuredClone(capacity);
  }

  ingestMetrics(projectId: string, records: EvaluationTelemetryRecord[]): number {
    return this.forProject(projectId).metrics.ingestMany(records.map((record) => ({ ...record, projectId })));
  }

  setDrift(projectId: string, baseline: DriftSnapshot, current: DriftSnapshot): void {
    const state = this.forProject(projectId);
    state.driftBaseline = structuredClone(baseline);
    state.driftCurrent = structuredClone(current);
  }

  drift(projectId: string): DriftReport {
    const state = this.forProject(projectId);
    if (!state.driftBaseline || !state.driftCurrent) return { verdict: 'PASS', signals: [] };
    return detectEvaluationDrift(state.driftBaseline, state.driftCurrent);
  }

  aggregate(projectId: string, dimension: AggregationDimension, key?: string) {
    return this.forProject(projectId).metrics.query(dimension, key);
  }

  benchmarkIntegrity(projectId: string, name: string): BenchmarkIntegrityReport {
    return this.forProject(projectId).benchmarks.integrity(name);
  }

  archive(projectId: string, actor: string, before?: Date): ArchiveArtifact {
    const state = this.forProject(projectId);
    state.latestArchive = state.lifecycle.archive({ projectId, before });
    this.audit(projectId, actor, 'DATA_ARCHIVE', { count: state.latestArchive.records.length, checksum: state.latestArchive.checksum });
    return structuredClone(state.latestArchive);
  }

  restore(projectId: string, actor: string): { restored: number; unchanged: number } {
    const state = this.forProject(projectId);
    if (!state.latestArchive) throw new Error(`项目 ${projectId} 没有可恢复 Archive`);
    const result = state.lifecycle.restore(state.latestArchive);
    this.audit(projectId, actor, 'DATA_RESTORE', result);
    return result;
  }

  scale(projectId: string) {
    const state = this.forProject(projectId);
    const projectMetrics = state.metrics.query('project', projectId)[0];
    const queue = state.queue.counts();
    const workers = structuredClone(state.workers);
    return {
      projectId,
      throughput: state.capacity?.throughputPerSecond ?? 0,
      activeWorkers: workers.filter((worker) => worker.status === 'BUSY').length,
      workers,
      queue,
      p50: state.capacity?.execution.p50 ?? 0,
      p95: state.capacity?.execution.p95 ?? projectMetrics?.p95LatencyMs ?? 0,
      p99: state.capacity?.execution.p99 ?? 0,
      queueLatency: state.capacity?.queueDelay ?? { p50: 0, p95: 0, p99: 0 },
      workerUtilization: state.capacity?.workerUtilization ?? 0,
      errorRate: projectMetrics?.failureRate ?? 0,
      retryRate: state.capacity?.submitted ? state.capacity.retries / state.capacity.submitted : 0,
      cost: projectMetrics?.cost ?? 0,
      dataGrowth: state.lifecycle.list().length,
      archive: state.lifecycle.stats(),
      drift: this.drift(projectId),
      recovery: state.recovery.status(),
      benchmarkStorage: state.benchmarks.stats(),
    };
  }

  listAudit(projectId: string): EvaluationScaleAudit[] {
    return this.audits.filter((entry) => entry.projectId === projectId).map((entry) => structuredClone(entry));
  }

  snapshot(): EvaluationScaleSnapshot {
    const projects: EvaluationScaleSnapshot['projects'] = {};
    for (const [projectId, state] of this.projects) {
      projects[projectId] = {
        queue: state.queue.snapshot(), workers: structuredClone(state.workers), lifecycle: state.lifecycle.snapshot(),
        metrics: state.metrics.snapshot(), recovery: state.recovery.snapshot(), benchmarks: state.benchmarks.snapshot(),
        capacity: structuredClone(state.capacity), driftBaseline: structuredClone(state.driftBaseline),
        driftCurrent: structuredClone(state.driftCurrent), latestArchive: structuredClone(state.latestArchive),
      };
    }
    return { schemaVersion: 1, projects, audits: structuredClone(this.audits) };
  }

  static restore(snapshot: EvaluationScaleSnapshot): EvaluationScaleService {
    if (snapshot.schemaVersion !== 1) throw new Error('Evaluation scale snapshot 版本不支持');
    const service = new EvaluationScaleService();
    for (const [projectId, stored] of Object.entries(snapshot.projects)) {
      service.projects.set(projectId, {
        queue: EvaluationQueue.restore(stored.queue), workers: structuredClone(stored.workers),
        lifecycle: DataLifecycleStore.restoreSnapshot(stored.lifecycle),
        metrics: EvaluationMetricsAggregator.restore(stored.metrics), recovery: RecoveryCoordinator.restore(stored.recovery),
        benchmarks: ContentAddressedBenchmarkStore.import(stored.benchmarks), capacity: structuredClone(stored.capacity),
        driftBaseline: structuredClone(stored.driftBaseline), driftCurrent: structuredClone(stored.driftCurrent),
        latestArchive: structuredClone(stored.latestArchive),
      });
    }
    service.audits.push(...structuredClone(snapshot.audits));
    return service;
  }

  persistToFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
    fs.renameSync(tmp, filePath);
  }

  static loadFromFile(filePath: string): EvaluationScaleService {
    return fs.existsSync(filePath)
      ? EvaluationScaleService.restore(JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvaluationScaleSnapshot)
      : new EvaluationScaleService();
  }

  private audit(projectId: string, actor: string, action: string, detail: Record<string, unknown>): void {
    this.audits.push({ id: `eval-scale-audit-${this.audits.length + 1}`, projectId, actor, action, at: new Date().toISOString(), detail });
  }
}
