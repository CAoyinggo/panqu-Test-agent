#!/usr/bin/env node
// Autonomous 模式 CLI（Phase 22.6 / 二十四）
// --autonomous 默认 false：不加开关时仅分析规划（manual）。
// 模式：manual（仅分析）/ assisted（AI 规划 + 人工确认）/ autonomous（AI 自动规划/选择/停止）。
// 完全离线：Synthetic Changes / Failures / History / Budget，运行 5 个 Scenario。
// 用法：node dist/bin/run-autonomous.js [--autonomous] [--mode=manual|assisted|autonomous]
//        [--scenario=all|scenario-1-model-change|...] [--json]
// 退出码：任一 Scenario BLOCK → 1，否则 0。
import { pathToFileURL } from 'node:url';
import {
  AUTONOMOUS_SCENARIOS,
  runAllScenarios,
  runScenario,
  type AutonomousMode,
  type AutonomousRunResult,
} from '../src/autonomous/index.js';

interface CliArgs {
  autonomous: boolean;
  mode?: AutonomousMode;
  scenario: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { autonomous: false, scenario: 'all', json: false };
  for (const a of argv) {
    if (a === '--autonomous') out.autonomous = true;
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--mode=')) out.mode = a.slice('--mode='.length) as AutonomousMode;
    else if (a.startsWith('--scenario=')) out.scenario = a.slice('--scenario='.length);
    else if (a === '--help' || a === '-h') return { autonomous: false, mode: 'manual', scenario: 'all', json: false } as never;
  }
  return out;
}

function summarize(r: AutonomousRunResult): string {
  return `[${r.decision}] ${r.mode} 模式：执行 ${r.executed.length}/${r.executed.length + r.remaining.length}，通过 ${r.executed.filter((e) => e.passed).length}，重新规划 ${r.replans.length} 次${r.releaseBlocked ? '，Release BLOCK' : ''}。${r.reason}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // --autonomous 默认 false：未开启且未指定模式 → manual（仅分析）
  const mode: AutonomousMode = args.mode ?? (args.autonomous ? 'autonomous' : 'manual');
  const now = Date.now();

  let results: AutonomousRunResult[];
  if (args.scenario === 'all') {
    results = runAllScenarios({ mode, now });
  } else {
    results = [runScenario(args.scenario, { mode, now })];
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('════════ Autonomous Simulation ════════');
    console.log(`自治模式：${mode}（--autonomous ${args.autonomous ? 'on' : 'off（默认）'}）`);
    console.log(`Scenario：${args.scenario === 'all' ? `${AUTONOMOUS_SCENARIOS.length} 个全部` : args.scenario}`);
    for (const r of results) {
      console.log(`\n【${r.decision}】执行 ${r.executed.length} 个用例，通过 ${r.executed.filter((e) => e.passed).length}`);
      console.log(`  原因：${r.reason}`);
      if (r.replans.length) {
        r.replans.slice(0, 5).forEach((re) => console.log(`  重新规划：${re.failedCase} → ${re.action}`));
      }
      if (r.knownIssueReappeared.length) console.log(`  已知问题复现（不重复创建缺陷）：${r.knownIssueReappeared.join('、')}`);
      if (r.requiresApproval.length) console.log(`  需人工审批：${r.requiresApproval.join('、')}`);
      r.evidence.slice(0, 6).forEach((e) => console.log(`  轨迹：${e}`));
    }
    console.log('\n════════════════════════════');
  }

  return results.some((r) => r.decision === 'BLOCKED') ? 1 : 0;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error('Autonomous 执行出错：', e.message);
      process.exit(2);
    });
}
