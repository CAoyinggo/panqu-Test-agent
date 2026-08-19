#!/usr/bin/env node
// Phase 26.8 Production Pilot — 生产试运行 CLI
// 在 staging 数据目录真实执行 ≥30 个 Run（smoke/sanity/regression/autonomous），
// 聚合生产 KPI，产出 10 条人工 QA 对照；结果落盘 output/pilot/pilot-summary.json。
// 用法：node dist/bin/run-pilot.js [--env <env>]
import path from 'node:path';
import fs from 'node:fs';
import { createPlatformService } from '../src/platform/index.js';
import { runPilot } from '../src/platform/ops/pilot.js';
import { outputDir } from '../src/utils/fs-utils.js';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = flagValue(process.argv.slice(2), '--env') ?? 'staging';
  const bundle = createPlatformService({ storage: 'sqlite' });
  await bundle.auth.ensureSeeded();
  const result = await runPilot(bundle, { environment: env, evidence: 'staging-real' });
  const outDir = path.join(outputDir(), 'pilot');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'pilot-summary.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  const match = result.manualQa.filter((q) => q.match).length;
  fs.writeSync(
    1,
    JSON.stringify(
      {
        ok: result.ok,
        summaryFile: file,
        kpi: result.kpi,
        manualQaMatch: `${match}/${result.manualQa.length}`,
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(result.ok ? 0 : 1);
}

main().catch((e: Error) => {
  console.error('Pilot 执行失败：', e.message);
  process.exit(2);
});
