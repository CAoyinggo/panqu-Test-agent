#!/usr/bin/env node
// Phase 51 运维 CLI。所有命令均操作真实输入文件；不会自动生成业务数据。
import path from 'node:path';
import { DataLifecycleStore, readArchive, writeArchive } from '../src/eval/lifecycle/index.js';

const args = process.argv.slice(2);
const command = args.slice(0, 2).join(' ');
const option = (name: string, fallback: string): string => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const statePath = path.resolve(option('state', 'data/evaluation-lifecycle.json'));
const archivePath = path.resolve(option('archive', 'data/archive/evaluation-archive.json'));

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
} else {
  console.error('Usage: phase51-cli data archive|restore [--state=<file>] [--archive=<file>] [--project=<id>] [--before=<iso>]');
  process.exitCode = 2;
}
