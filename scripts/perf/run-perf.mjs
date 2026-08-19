#!/usr/bin/env node
// Phase 29 性能基准 CLI 门禁
// 用法：
//   node scripts/perf/run-perf.mjs                    # 运行基准并打印摘要（不落盘）
//   node scripts/perf/run-perf.mjs --baseline <file>  # 运行并更新基线（默认 perf/baseline.json）
//   node scripts/perf/run-perf.mjs --gate             # 运行并与基线比对（回归门禁，失败退出码 1）
//   node scripts/perf/run-perf.mjs --json             # 输出完整 JSON 报告
// 需先 build（npm run build）使 dist/src/platform/ops/perf-harness.js 存在。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const harnessUrl = pathToFileURL(path.join(root, 'dist', 'src', 'platform', 'ops', 'perf-harness.js')).href;
const { runPlatformPerf, evaluatePerfGate, PERF_THRESHOLDS } = await import(harnessUrl);

const args = process.argv.slice(2);
const isGate = args.includes('--gate');
const isJson = args.includes('--json');
let baselineFile = path.join(root, 'perf', 'baseline.json');
let hasBaselineArg = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline') {
    hasBaselineArg = true;
    if (args[i + 1] && !args[i + 1].startsWith('--')) baselineFile = path.resolve(root, args[i + 1]);
    i++;
  } else if (args[i].startsWith('--baseline=')) {
    hasBaselineArg = true;
    baselineFile = path.resolve(root, args[i].split('=')[1]);
  }
}
const latestFile = path.join(root, 'perf', 'latest.json');

function fail(msg) {
  console.error(`[perf:gate] FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`[perf] 运行平台性能基准（node ${process.version} / ${process.platform}-${process.arch}）…`);
  const report = await runPlatformPerf();

  fs.mkdirSync(path.dirname(latestFile), { recursive: true });
  fs.writeFileSync(latestFile, JSON.stringify(report, null, 2));

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n[perf] Run 生命周期（create → scheduler → worker → complete）：');
  for (const m of report.runLifecycle) {
    console.log(
      `  batch=${String(m.batchSize).padStart(4)}  create ${String(m.createOpsPerSec).padStart(7)} ops/s (p50=${m.createP50Ms}ms p95=${m.createP95Ms}ms p99=${m.createP99Ms}ms max=${m.createMaxMs}ms)  生命周期 ${String(m.lifecycleOpsPerSec).padStart(7)} runs/s (${m.lifecycleTotalMs}ms, 队列剩余=${m.jobsPendingAfter})`,
    );
  }
  console.log(`  Scheduler: ${report.schedulerOpsPerSec} ops/s | Audit: ${report.auditOpsPerSec} ops/s | Telemetry: ${report.telemetryOpsPerSec} ops/s`);
  console.log(`  内存: heap ${report.memory.heapUsedBeforeMb}MB → ${report.memory.heapUsedAfterMb}MB (增长 ${report.memory.growthMb}MB)`);
  console.log(`  总耗时: ${report.totalMs}ms`);

  if (!isGate) {
    if (hasBaselineArg) {
      fs.writeFileSync(baselineFile, JSON.stringify(report, null, 2));
      console.log(`\n[perf] 基线已更新：${baselineFile}`);
    } else {
      console.log('\n[perf] 未指定 --baseline，结果仅落盘 perf/latest.json');
    }
    return;
  }

  // ── 回归门禁模式 ──
  if (!fs.existsSync(baselineFile)) {
    fail(`基线不存在：${baselineFile}（先运行 npm run perf:baseline）`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const gate = evaluatePerfGate(report, baseline);

  console.log(`\n[perf:gate] 基线：${baselineFile}（${baseline.timestamp}）`);
  console.log('[perf:gate] 门禁阈值：', JSON.stringify(PERF_THRESHOLDS));
  for (const d of gate.details) {
    const degraded = d.ratio < 1 && !d.name.includes('Growth');
    const improved = d.ratio >= 1 && !d.name.includes('Growth');
    const marker = degraded ? '↓' : improved ? '↑' : '-';
    console.log(`  ${d.name.padEnd(34)} 基线=${String(d.baseline).padStart(8)} 当前=${String(d.current).padStart(8)} 比值=${String(d.ratio).padStart(6)}  ${marker}`);
  }

  if (!gate.ok) {
    console.error(`\n[perf:gate] 存在性能回归（${gate.failures.length} 项）：${gate.failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\n[perf:gate] PASS：所有指标相对基线无回归');
}

await main();
