#!/usr/bin/env node
// run-autonomous-pipeline.ts — 端到端自治测试流水线 CLI（Phase 23.5）
// 用法：
//   node dist/bin/run-autonomous-pipeline.js --scenario replan-block
//   node dist/bin/run-autonomous-pipeline.js --change-type model --change-target wan3/text-to-video --environment test
// 输出：
//   output/<date>/<feature>/run-summary.json
//   output/<date>/<feature>/autonomous-pipeline.json
//   output/<date>/<feature>/release-decision.json
// 退出码：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR（与 CI Gate 一致）。

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutonomousPipeline, writeAutonomousOutputs } from '../src/autonomous/index.js';
import { caseSet100, findPipelineScenario, PIPELINE_SCENARIOS } from '../src/autonomous/pipeline-scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/bin → 项目根（与 agent-release-gate.mjs 扫描的 output/ 对齐，避免写到 dist/output/）
const root = path.resolve(__dirname, '..', '..');

function parseArgs(): Record<string, string | undefined> {
  const argv = process.argv.slice(2);
  const args: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs();
  const baseDir = args['base-dir'] ?? 'output';
  const now = new Date().toISOString();
  const runId = `run-${now.replace(/\D/g, '').slice(0, 14)}`;

  // ── 批量验收模式：运行全部场景并与期望比对（agent:autonomous:e2e 使用）──
  if (args.all === 'true') {
    const failures: Array<{ id: string; expected: string; actual: string }> = [];
    for (const sc of PIPELINE_SCENARIOS) {
      const input = sc.build();
      // 每个场景独立 runId，保证 Dashboard 区分不同自治运行
      if (!input.runId) input.runId = `${runId}-${sc.id}`;
      const result = runAutonomousPipeline(input);
      // 同步写出产物（run-summary / pipeline / release-decision / autonomous-report.html），
      // 按场景写入独立子目录，保证 Dashboard 可区分全部自治运行
      try {
        writeAutonomousOutputs(result, path.resolve(root, baseDir), { subdir: sc.id });
      } catch {
        // 产物写入失败不影响验收判定
      }
      const ok = result.release.decision === sc.expect.releaseDecision && result.releaseExitCode === sc.expect.exitCode;
      const mark = ok ? 'PASS' : 'FAIL';
      process.stdout.write(
        `[${mark}] ${sc.id}: decision=${result.release.decision} exit=${result.releaseExitCode} (期望 ${sc.expect.releaseDecision}/${sc.expect.exitCode}, RCA=${result.rca.length}, RePlans=${result.regression.replans.length})\n`,
      );
      if (!ok) failures.push({ id: sc.id, expected: sc.expect.releaseDecision, actual: result.release.decision });
    }
    if (failures.length > 0) {
      process.stderr.write(`SYSTEM_ERROR: ${failures.length} 个场景未达预期：${failures.map((f) => `${f.id}(${f.actual}≠${f.expected})`).join(', ')}\n`);
      process.exit(3);
    }
    process.stdout.write('全部场景验收通过（PASS/BLOCK/REVIEW 与 CI Exit Code 一致）\n');
    process.exit(0);
  }

  let input;
  const scenarioId = args.scenario;
  if (scenarioId) {
    const sc = findPipelineScenario(scenarioId);
    if (!sc) {
      process.stderr.write(`SYSTEM_ERROR: 未知场景 ${scenarioId}。可用：${PIPELINE_SCENARIOS.map((s) => s.id).join(', ')}\n`);
      process.exit(3);
    }
    input = sc.build();
    if (!input.runId) input.runId = runId;
    if (!input.feature) input.feature = scenarioId;
    process.stdout.write(`场景：${sc.id} — ${sc.name}\n`);
  } else {
    const changeType = args['change-type'] ?? 'code';
    const changeTarget = args['change-target'] ?? 'wan3/default';
    const environment = args.environment ?? 'test';
    const primaryTag = changeType === 'model' ? 'model' : changeTarget.split('/').pop() ?? changeTarget;
    input = {
      change: { type: changeType as 'code' | 'model', target: changeTarget },
      cases: caseSet100(primaryTag),
      runId,
      feature: args.feature ?? changeTarget,
      environment,
      outcomes: {},
      signals: { coverage: 0.95 },
    };
    process.stdout.write(`变更：${changeType}:${changeTarget}（环境 ${environment}）\n`);
  }

  // 执行端到端流水线
  const result = runAutonomousPipeline(input);

  // 写入产物
  if (args['no-write'] !== 'true') {
    const files = writeAutonomousOutputs(result, path.resolve(root, baseDir));
    process.stdout.write(`已写入：\n  ${files.summary}\n  ${files.pipeline}\n  ${files.release}\n`);
  }

  // 摘要输出
  const s = result.runSummary;
  const trace = result.trace;
  process.stdout.write(
    [
      '── Autonomous Run Summary ──',
      `Run: ${s.runId}`,
      `Cases Planned: ${s.total}`,
      `Cases Executed: ${s.executed}`,
      `Cases Skipped: ${s.skipped}`,
      `Passed: ${s.passed}  Failed: ${s.failed}`,
      `RePlans: ${s.replans}`,
      `Coverage: ${(s.coverage * 100).toFixed(0)}%`,
      `Risk: ${s.riskLevel}`,
      `RCA: ${result.rca.length}   Defects: ${result.defects.length}（critical ${result.defects.filter((d) => d.severity === 'critical').length}）`,
      `Initial Plan: ${trace.initialPlan.join(' → ') || '（空）'}`,
      trace.replans.length ? `RePlans Detail: ${trace.replans.map((r) => `${r.failedCase}→${r.action}`).join(' | ')}` : null,
      trace.pausedCaseIds.length ? `Paused: ${trace.pausedCaseIds.join('、')}` : null,
      `Decision: ${result.release.decision}`,
      `Reason: ${result.release.blockReasons.length ? result.release.blockReasons.join('；') : result.release.recommendations.join('；')}`,
      `Exit Code: ${result.releaseExitCode}`,
      '',
    ]
      .filter((l) => l !== null)
      .join('\n'),
  );

  process.exit(result.releaseExitCode);
}

main();
