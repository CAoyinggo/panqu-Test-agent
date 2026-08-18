#!/usr/bin/env node
// AI Test Operations Dashboard（Phase 21.8）
// 聚合健康检查 / Agent 运行摘要等本地产物，输出统一运维视图（JSON + HTML）。
// 用法：
//   node dist/bin/dashboard.js                     # 自动聚合 output/ 下已有产物
//   node dist/bin/dashboard.js --input data.json   # 合并显式 OperationsInput（含 runs/flaky/defects/cost/knowledge/quality 等）
// 输出：<output>/operations-dashboard.json 与 operations-dashboard.html
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDir, todayStr } from '../src/utils/fs-utils.js';
import { buildOperationsView, renderOperationsHtml } from '../src/operations/operations-aggregator.js';
import type { OperationsAutonomousRun, OperationsInput } from '../src/operations/operations-schema.js';

function outputRoot(): string {
  return process.env.TESTFLOW_OUTPUT_DIR || path.join(process.cwd(), 'output');
}

function readJsonIfExists<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

interface HealthFile {
  ok: boolean;
  entries: Array<{ name: string; ok: boolean; detail?: string }>;
  summary?: string;
  at?: string;
}

interface AgentSummaryFile {
  taskId: string;
  feature: string;
  at?: string;
  execution?: { total: number; passed: number; failed: number };
  analysis?: { rcas?: number; defects?: number; healingSuggestions?: number };
  coverage?: Record<string, number>;
}

/** 自治运行摘要（run-summary.json 契约，Phase 23.6） */
interface AutonomousRunSummaryFile {
  runId: string;
  feature: string;
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  failed: number;
  replans: number;
  rcaCount?: number;
  coverage: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  stopReason?: string | null;
  portfolioRate?: number;
  explorationGenerated?: number;
  explorationScreened?: number;
  explorationRejected?: number;
  decision: string;
  releaseDecision: 'PASS' | 'REVIEW' | 'BLOCK';
}

/** 从 output/ 自动聚合可用产物 */
function collectFromDisk(root: string): OperationsInput {
  const input: OperationsInput = {};
  const today = todayStr();

  // 健康检查：root/health.json 或 root/<today>/health.json
  const healthFile =
    readJsonIfExists<HealthFile>(path.join(root, 'health.json')) ??
    readJsonIfExists<HealthFile>(path.join(root, today, 'health.json'));
  if (healthFile) {
    input.health = { ok: healthFile.ok, checks: healthFile.entries ?? [] };
  }

  // Agent 运行摘要：root/<today>/agent-summary.json 或 root/agent-summary.json
  const summary =
    readJsonIfExists<AgentSummaryFile>(path.join(root, today, 'agent-summary.json')) ??
    readJsonIfExists<AgentSummaryFile>(path.join(root, 'agent-summary.json'));
  if (summary?.execution) {
    input.runs = [
      {
        runId: summary.taskId ?? 'agent-run',
        feature: summary.feature ?? 'unknown',
        total: summary.execution.total ?? 0,
        passed: summary.execution.passed ?? 0,
        failed: summary.execution.failed ?? 0,
        at: summary.at,
      },
    ];
    input.rca = { total: summary.analysis?.rcas ?? 0 };
    input.defects = { total: summary.analysis?.defects ?? 0, open: summary.analysis?.defects ?? 0 };
    input.healing = { suggestions: summary.analysis?.healingSuggestions ?? 0, applied: 0, recovered: 0 };
    if (summary.coverage) input.coverage = summary.coverage;
  }

  // 自治运行摘要：output/<date>/<feature>/run-summary.json（Phase 23.6）
  const runs = collectAutonomousRuns(root);
  if (runs.length > 0) input.autonomous = { runs };
  return input;
}

/** 递归扫描 output 下所有 run-summary.json（按目录序稳定排列） */
function collectAutonomousRuns(root: string): OperationsAutonomousRun[] {
  const runs: OperationsAutonomousRun[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'run-summary.json') {
        const s = readJsonIfExists<AutonomousRunSummaryFile>(full);
        if (s?.runId && s.releaseDecision) {
          runs.push({
            runId: s.runId,
            feature: s.feature ?? 'default',
            total: s.total ?? 0,
            executed: s.executed ?? 0,
            skipped: s.skipped ?? 0,
            passed: s.passed ?? 0,
            failed: s.failed ?? 0,
            replans: s.replans ?? 0,
            rcaCount: s.rcaCount ?? 0,
            coverage: s.coverage ?? 0,
            riskLevel: s.riskLevel ?? 'LOW',
            stopReason: s.stopReason ?? null,
            portfolioRate: s.portfolioRate ?? 0,
            explorationGenerated: s.explorationGenerated ?? 0,
            explorationScreened: s.explorationScreened ?? 0,
            explorationRejected: s.explorationRejected ?? 0,
            decision: s.decision ?? '',
            releaseDecision: s.releaseDecision,
          });
        }
      }
    }
  };
  walk(root);
  return runs;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = outputRoot();
  ensureDir(root);

  const input = collectFromDisk(root);
  const inputIdx = process.argv.indexOf('--input');
  if (inputIdx > -1 && process.argv[inputIdx + 1]) {
    const explicit = readJsonIfExists<OperationsInput>(process.argv[inputIdx + 1]);
    if (explicit) Object.assign(input, explicit);
  }

  const view = buildOperationsView(input);
  const jsonFile = path.join(root, 'operations-dashboard.json');
  const htmlFile = path.join(root, 'operations-dashboard.html');
  fs.writeFileSync(jsonFile, JSON.stringify(view, null, 2), 'utf-8');
  fs.writeFileSync(htmlFile, renderOperationsHtml(view), 'utf-8');

  console.log('════════ AI Test Operations ════════');
  console.log(`状态：${view.status}`);
  console.log(view.summary);
  for (const h of view.highlights) console.log(`  · ${h}`);
  console.log(`JSON：${jsonFile}`);
  console.log(`HTML：${htmlFile}`);
  console.log('════════════════════════════════════');
}
