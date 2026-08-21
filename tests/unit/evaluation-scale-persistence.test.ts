import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvaluationScaleService } from '../../src/eval/scale/operations.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Phase 52.1 durable Evaluation Scale state', () => {
  it('Queue/Metrics/Recovery/Lifecycle/Benchmark/Drift/Audit 原子持久化并恢复', () => {
    const service = new EvaluationScaleService();
    const state = service.forProject('project-a');
    state.queue.enqueue({ id: 'running-job', projectId: 'project-a', domains: ['RISK'] });
    state.queue.claim('worker-before-restart');
    service.setWorkers('project-a', [{ id: 'worker-1', status: 'BUSY', processed: 4, failedAttempts: 1, busyMs: 20 }]);
    service.setCapacity('project-a', {
      workers: 1, submitted: 5, completed: 4, failed: 0, queued: 1, running: 0, retries: 1,
      throughputPerSecond: 2, wallTimeMs: 2000, queueDelay: { p50: 1, p95: 2, p99: 3 },
      execution: { p50: 4, p95: 5, p99: 6 }, workerUtilization: 0.8,
    });
    service.ingestMetrics('project-a', [{
      id: 'metric-1', timestamp: '2026-08-21T00:00:00.000Z', projectId: 'project-a', model: 'm1',
      benchmark: 'RISK_BENCHMARK_v1', score: 0.9, latencyMs: 10, cost: 0.01, success: true,
    }]);
    const baseline = { score: 0.95, benchmarkChecksum: 'sum', benchmarkHealthy: true, modelVersion: 'm1', promptVersion: 'p1', latencyMs: 10, cost: 0.01 };
    service.setDrift('project-a', baseline, { ...baseline, score: 0.9 });
    state.recovery.detect('TELEMETRY', 'telemetry unavailable');
    state.lifecycle.add({ id: 'old-eval', projectId: 'project-a', kind: 'EvaluationResult', traceId: 'trace-1', createdAt: '2025-01-01T00:00:00.000Z', payload: { score: 0.9 } });
    service.archive('project-a', 'release-mgr', new Date('2026-01-01T00:00:00.000Z'));
    state.benchmarks.createVersion({
      name: 'RISK_BENCHMARK_v1', version: 'v1', domain: 'RISK', source: 'CURATED',
      cases: [{ id: 'r1', domain: 'RISK', input: { risk: true }, groundTruth: { category: 'dependency' }, metadata: {} }],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase52-scale-'));
    dirs.push(dir);
    const file = path.join(dir, 'scale-state.json');
    service.persistToFile(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    const restored = EvaluationScaleService.loadFromFile(file);
    const restoredState = restored.forProject('project-a');
    expect(restoredState.queue.get('running-job')).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(restoredState.workers[0].id).toBe('worker-1');
    expect(restored.aggregate('project-a', 'project')[0]).toMatchObject({ count: 1, averageScore: 0.9, p95LatencyMs: 10 });
    expect(restoredState.recovery.status()).toMatchObject({ health: 'DEGRADED' });
    expect(restoredState.lifecycle.get('old-eval')).toMatchObject({ tier: 'ARCHIVED', traceId: 'trace-1' });
    expect(restored.benchmarkIntegrity('project-a', 'RISK_BENCHMARK_v1').valid).toBe(true);
    expect(restored.drift('project-a').verdict).toBe('REVIEW');
    expect(restored.listAudit('project-a').map((entry) => entry.action)).toContain('DATA_ARCHIVE');
    expect(restored.restore('project-a', 'release-mgr')).toEqual({ restored: 1, unchanged: 0 });
  });

  it('不存在状态文件时安全返回空服务；不伪造项目', () => {
    const service = EvaluationScaleService.loadFromFile(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
    expect(service.snapshot()).toEqual({ schemaVersion: 1, projects: {}, audits: [] });
  });
});
