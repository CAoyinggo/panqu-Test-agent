#!/usr/bin/env node
// AI Quality Evaluation CLI（Phase 45 / 42.20）
// 用法：
//   node dist/bin/eval-cli.js run [--domain RCA] [--json] [--save <name>]
//   node dist/bin/eval-cli.js report [--json]
//   node dist/bin/eval-cli.js compare --baseline v4.19.0 [--candidate current] [--json]
//   node dist/bin/eval-cli.js regression [--json]
// 说明：
//   - run：运行 8 领域评测，输出报告；默认保存到 eval-reports/<version>-<timestamp>.json
//   - report：读取最新已保存报告
//   - compare：运行候选版本并与基线报告对比，输出 Regression Gate（BLOCK 时退出码 1）
//   - regression：运行当前版本并与此前最新基线对比（回归门，BLOCK 退出码 1）
// 铁律：不虚构 Ground Truth；无 GT 用例 score=null；Gate 失败即阻止（退出码非 0）。
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { runAllEvaluation, runDomain, type EvalReport } from '../src/eval/runner.js';
import { ALL_DOMAINS, DOMAIN_LABELS, isPassed } from '../src/eval/contract.js';
import { compareVersions, formatCompare, type CompareResult } from '../src/eval/regression.js';
import { PLATFORM_VERSION } from '../src/platform/version.js';

const REPORTS_DIR = path.resolve(process.cwd(), 'eval-reports');

function ensureDir(): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function parseDomain(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const upper = v.toUpperCase();
  return (ALL_DOMAINS as readonly string[]).includes(upper) ? upper : undefined;
}

function saveReport(report: EvalReport, name?: string): string {
  ensureDir();
  const file = path.join(REPORTS_DIR, `${name ?? `${report.version}-${Date.now()}`}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

function latestReportFile(): string | null {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('compare'))
    .sort((a, b) => fs.statSync(path.join(REPORTS_DIR, b)).mtimeMs - fs.statSync(path.join(REPORTS_DIR, a)).mtimeMs);
  return files.length ? path.join(REPORTS_DIR, files[0]) : null;
}

function loadReport(file: string): EvalReport {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;
}

function printReport(report: EvalReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`AI Quality Evaluation v${report.version}（${report.generatedAt}）`);
  console.log(`  Model: ${report.versionInfo.model} / Tool: ${report.versionInfo.toolVersion}`);
  console.log(`  Overall: ${(report.overall * 100).toFixed(1)}%（tracked ${report.domains.reduce((s, d) => s + d.tracked, 0)} 条）`);
  console.log(`  关键安全指标：P0 Miss=${report.critical.p0Miss} / False Pass=${report.critical.falsePass} / Unsafe Healing=${report.critical.unsafeHealing} / Skipped Critical=${report.critical.skippedCritical}`);
  console.log(`  成本：$${report.cost.cost.toFixed(6)}（${report.cost.totalTokens} tokens，${report.cost.latencyMs}ms）`);
  for (const d of report.domains) {
    console.log(
      `  [${d.domain}] ${d.label}: ${(d.score * 100).toFixed(1)}%（${d.passed}/${d.tracked}，${d.benchmark}）`,
    );
  }
}

function printCompare(cmp: CompareResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(cmp, null, 2));
    return;
  }
  console.log(formatCompare(cmp));
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'run';
  const json = hasFlag(args, '--json');

  if (cmd === 'run') {
    const domain = parseDomain(flagValue(args, '--domain'));
    if (flagValue(args, '--domain') && !domain) {
      console.error(`未知领域：${flagValue(args, '--domain')}。可用：${ALL_DOMAINS.join(', ')}`);
      process.exit(2);
    }
    const report = domain ? { ...runAllEvaluation(), domains: [runDomain(domain as (typeof ALL_DOMAINS)[number])] } : runAllEvaluation();
    // 单领域时重建 overall 为领域分，避免误导
    if (domain) report.overall = report.domains[0].score;
    printReport(report, json);
    const saved = saveReport(report, flagValue(args, '--save'));
    if (!json) console.log(`\n报告已保存：${saved}`);
    // 关键安全指标非零 → 非 0 退出（阻止）
    const critical = report.critical;
    if (critical.p0Miss > 0 || critical.falsePass > 0 || critical.unsafeHealing > 0 || critical.skippedCritical > 0) {
      console.error('关键安全指标非零，评测未通过。');
      process.exit(1);
    }
    process.exit(0);
  }

  if (cmd === 'report') {
    const file = latestReportFile();
    if (!file) {
      console.error('无已保存的评测报告。先执行：node dist/bin/eval-cli.js run');
      process.exit(1);
    }
    printReport(loadReport(file), json);
    return;
  }

  if (cmd === 'compare') {
    const baselineName = flagValue(args, '--baseline');
    if (!baselineName) {
      console.error('compare 需要 --baseline <version>（如 v4.19.0 或报告文件名）');
      process.exit(2);
    }
    // 候选：优先指定 --candidate 报告文件；否则运行当前
    const candidateFile = flagValue(args, '--candidate');
    const candidate: EvalReport =
      candidateFile && candidateFile !== 'current'
        ? loadReport(path.resolve(process.cwd(), candidateFile))
        : runAllEvaluation();
    const baselineFile = latestReportFile();
    let baseline: EvalReport | null = null;
    if (baselineFile) {
      const loaded = loadReport(baselineFile);
      if (loaded.version.includes(baselineName) || baselineName === 'latest') baseline = loaded;
    }
    if (!baseline) {
      console.error(`未找到基线报告：${baselineName}（在 ${REPORTS_DIR} 中）`);
      process.exit(1);
    }
    const cmp = compareVersions(baseline, candidate);
    printCompare(cmp, json);
    ensureDir();
    fs.writeFileSync(
      path.join(REPORTS_DIR, `compare-${baseline.version}-${candidate.version}-${Date.now()}.json`),
      JSON.stringify(cmp, null, 2),
      'utf8',
    );
    process.exit(cmp.gate.verdict === 'BLOCK' ? 1 : 0);
  }

  if (cmd === 'regression') {
    const candidate = runAllEvaluation();
    const baselineFile = latestReportFile();
    if (!baselineFile) {
      console.error('无基线报告可对比，先执行 run 建立基线。');
      process.exit(1);
    }
    const baseline = loadReport(baselineFile);
    const cmp = compareVersions(baseline, candidate);
    printCompare(cmp, json);
    const saved = saveReport(candidate);
    if (!json) console.log(`\n候选报告已保存：${saved}`);
    process.exit(cmp.gate.verdict === 'BLOCK' ? 1 : 0);
  }

  console.error(`未知命令：${cmd}（可用：run / report / compare / regression）`);
  process.exit(2);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

export { runAllEvaluation, isPassed, DOMAIN_LABELS };
