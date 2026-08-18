#!/usr/bin/env node
// Autonomous Release CI Gate（Phase 23.4）
// 用法：
//   node dist/bin/release-gate.js --run-id run-xxxx [--date yyyy-mm-dd] [--feature wan3] [--json]
//   node dist/bin/release-gate.js --decide '<ReleaseDecisionInput JSON>' [--feature wan3] [--json]
// Exit Code（统一规范，任务书九）：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR。
// REVIEW 绝不返回 0；SYSTEM_ERROR 仅在无法加载/无法决策时返回。

import { parseArgs } from 'node:util';
import {
  buildReleaseDecision,
  loadReleaseDecision,
  releaseExitCode,
  writeReleaseDecision,
  type ReleaseDecision,
  type ReleaseDecisionInput,
} from '../src/release-ci/index.js';

const { values } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    'decide': { type: 'string' },
    'feature': { type: 'string' },
    'date': { type: 'string' },
    'base-dir': { type: 'string', default: 'output' },
    'json': { type: 'boolean', default: false },
  },
});

const EMPTY_INPUT: ReleaseDecisionInput = {
  p0: { passed: 0, total: 0 },
  p1: { passed: 0, total: 0 },
  coverage: 0,
  criticalDefects: 0,
};

function main(): void {
  const runId = values['run-id'] ?? `run-${Date.now()}`;
  const baseDir = values['base-dir'] ?? 'output';
  let decision: ReleaseDecision;

  if (values['decide']) {
    let input: ReleaseDecisionInput;
    try {
      input = JSON.parse(values['decide']) as ReleaseDecisionInput;
    } catch (err) {
      decision = buildReleaseDecision({
        runId,
        feature: values['feature'],
        decisionInput: EMPTY_INPUT,
        systemError: `--decide JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
      finish(decision, baseDir, values['json']);
      return;
    }
    decision = buildReleaseDecision({ runId, feature: values['feature'], decisionInput: input });
    writeReleaseDecision(decision, { baseDir });
  } else {
    const loaded = loadReleaseDecision(runId, {
      date: values['date'],
      feature: values['feature'],
      baseDir,
    });
    if (loaded) {
      decision = loaded;
    } else {
      decision = buildReleaseDecision({
        runId,
        feature: values['feature'],
        decisionInput: EMPTY_INPUT,
        systemError: `未找到 run ${runId} 的发布决策文件（baseDir=${baseDir}）`,
      });
    }
  }

  finish(decision, baseDir, values['json']);
}

function finish(decision: ReleaseDecision, baseDir: string, json: boolean): never {
  const code = releaseExitCode(decision.decision);
  if (json) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    console.log(`releaseId=${decision.releaseId} runId=${decision.runId} decision=${decision.decision} exitCode=${code}`);
    if (decision.blockReasons.length) console.log(`reasons: ${decision.blockReasons.join(' | ')}`);
  }
  process.exit(code);
}

main();
