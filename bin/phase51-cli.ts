#!/usr/bin/env node
// Phase 51 运维 CLI。所有命令均操作真实输入文件；不会自动生成业务数据。
import path from 'node:path';
import fs from 'node:fs';
import { DataLifecycleStore, readArchive, writeArchive } from '../src/eval/lifecycle/index.js';
import { ContentAddressedBenchmarkStore, type ContentAddressedBenchmarkSnapshot } from '../src/eval/benchmark/content-store.js';
import { aggregateRaw, detectEvaluationDrift, type DriftSnapshot, type EvaluationTelemetryRecord } from '../src/eval/metrics/index.js';
import { RecoveryCoordinator } from '../src/eval/recovery/index.js';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === 'agent' ? rawArgs.slice(1) : rawArgs;
const command = args.slice(0, 2).join(' ');
const option = (name: string, fallback: string): string => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const statePath = path.resolve(option('state', 'data/evaluation-lifecycle.json'));
const archivePath = path.resolve(option('archive', 'data/archive/evaluation-archive.json'));
const inputPath = path.resolve(option('input', 'data/evaluation-scale-input.json'));

const readJson = <T>(filePath: string): T | undefined => fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) as T : undefined;

if (command === 'data archive') {
  const store = DataLifecycleStore.load(statePath);
  const projectId = option('project', '');
  const beforeRaw = option('before', '');
  const artifact = store.archive({
    projectId: projectId || undefined,
    before: beforeRaw ? new Date(beforeRaw) : undefined,
  });
  writeArchive(archivePath, artifact);
  store.persist(statePath);
  console.log(JSON.stringify({ archived: artifact.records.length, checksum: artifact.checksum, archivePath, stats: store.stats() }, null, 2));
} else if (command === 'data restore') {
  const store = DataLifecycleStore.load(statePath);
  const result = store.restore(readArchive(archivePath));
  store.persist(statePath);
  console.log(JSON.stringify({ ...result, archivePath, stats: store.stats() }, null, 2));
} else if (command === 'evaluation queue') {
  const input = readJson<{ queue?: unknown[] }>(inputPath);
  console.log(JSON.stringify({ source: fs.existsSync(inputPath) ? inputPath : 'EMPTY', queue: input?.queue ?? [], count: input?.queue?.length ?? 0 }, null, 2));
} else if (command === 'evaluation workers') {
  const input = readJson<{ workers?: unknown[] }>(inputPath);
  console.log(JSON.stringify({ source: fs.existsSync(inputPath) ? inputPath : 'EMPTY', workers: input?.workers ?? [], count: input?.workers?.length ?? 0 }, null, 2));
} else if (command === 'benchmark integrity') {
  const snapshot = readJson<ContentAddressedBenchmarkSnapshot>(inputPath);
  if (!snapshot) console.log(JSON.stringify({ source: 'EMPTY', benchmarks: [] }, null, 2));
  else {
    const store = ContentAddressedBenchmarkStore.import(snapshot);
    console.log(JSON.stringify({ source: inputPath, benchmarks: snapshot.manifests.map((manifest) => store.integrity(manifest.name)) }, null, 2));
  }
} else if (command === 'benchmark archive') {
  const snapshot = readJson<ContentAddressedBenchmarkSnapshot>(inputPath);
  const store = new DataLifecycleStore();
  if (snapshot) store.add({ id: `benchmark-store-${Date.now()}`, projectId: option('project', 'wan3'), kind: 'Benchmark', createdAt: new Date().toISOString(), payload: snapshot });
  const artifact = store.archive();
  writeArchive(archivePath, artifact);
  console.log(JSON.stringify({ source: snapshot ? inputPath : 'EMPTY', archived: artifact.records.length, checksum: artifact.checksum, archivePath }, null, 2));
} else if (command === 'metrics aggregate') {
  const records = readJson<EvaluationTelemetryRecord[]>(inputPath) ?? [];
  const aggregator = aggregateRaw(records);
  console.log(JSON.stringify({ source: records.length ? inputPath : 'EMPTY', count: records.length, hourly: aggregator.query('hourly'), daily: aggregator.query('daily'), project: aggregator.query('project'), model: aggregator.query('model'), benchmark: aggregator.query('benchmark') }, null, 2));
} else if (command === 'metrics drift') {
  const input = readJson<{ baseline: DriftSnapshot; current: DriftSnapshot }>(inputPath);
  console.log(JSON.stringify(input ? { source: inputPath, ...detectEvaluationDrift(input.baseline, input.current) } : { source: 'EMPTY', verdict: 'PASS', signals: [] }, null, 2));
} else if (command === 'system scale') {
  const input = readJson<Record<string, unknown>>(inputPath);
  console.log(JSON.stringify({ source: input ? inputPath : 'EMPTY', scale: input ?? { submitted: 0, completed: 0, workers: 0 } }, null, 2));
} else if (command === 'system recovery') {
  const recovery = new RecoveryCoordinator();
  console.log(JSON.stringify({ source: 'LIVE_DEFAULT', ...recovery.status() }, null, 2));
} else {
  console.error('Usage: phase51-cli [agent] evaluation queue|workers | benchmark integrity|archive | data archive|restore | metrics aggregate|drift | system scale|recovery');
  process.exitCode = 2;
}
