#!/usr/bin/env node
// agent-release-gate.mjs — Autonomous Release → CI Gate（Phase 23.4）
// 作用：
//   1) 读取自治运行汇总 run-summary.json（23.5 端到端流水线生成），或使用确定性内置 fixture，
//      聚合为 ReleaseDecisionInput；
//   2) 调用统一 Release Contract（dist/release-ci）推导 PASS/BLOCK/REVIEW/SYSTEM_ERROR；
//   3) 写入 output/<date>/<feature>/release-decision.json，并打印决策 JSON 到 stdout；
//   4) 退出码：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR（REVIEW 绝不返回 0）。
// Deterministic First：决策由规则引擎推导，本脚本不调用 LLM。
//
// 用法：
//   node scripts/ci/agent-release-gate.mjs [--run-summary <path>] [--feature <name>] [--base-dir <dir>]
//   GATE_FIXTURE=pass|block|review|error node scripts/ci/agent-release-gate.mjs   # 确定性自检
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析 CLI 参数（--feature / --run-summary / --base-dir） */
function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { feature: undefined, 'run-summary': undefined, 'base-dir': 'output' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--feature') args.feature = argv[++i];
    else if (a === '--run-summary') args['run-summary'] = argv[++i];
    else if (a === '--base-dir') args['base-dir'] = argv[++i];
  }
  return args;
}

const emptyInput = () => ({
  p0: { passed: 0, total: 0 },
  p1: { passed: 0, total: 0 },
  coverage: 0,
  criticalDefects: 0,
});

/** 确定性 fixture（与 tests/unit/release-ci.test.ts 对齐） */
const FIXTURES = {
  pass: {
    input: {
      p0: { passed: 3, total: 3 },
      p1: { passed: 99, total: 100 },
      coverage: 0.95,
      criticalDefects: 0,
      riskLevel: 'LOW',
      failurePrediction: 0.2,
      historicalFailureRate: 0.1,
      modelChange: false,
      environmentAbnormal: false,
      flakyCount: 0,
      knownIssues: 0,
    },
  },
  block: {
    input: {
      p0: { passed: 2, total: 3 },
      p1: { passed: 99, total: 100 },
      coverage: 0.95,
      criticalDefects: 0,
    },
  },
  review: {
    input: {
      p0: { passed: 3, total: 3 },
      p1: { passed: 99, total: 100 },
      coverage: 0.93,
      criticalDefects: 0,
      flakyCount: 2,
      knownIssues: 1,
    },
  },
  error: {
    systemError: 'GATE_FIXTURE=error（模拟系统错误）',
  },
};

/** 将 run-summary.json 聚合为 ReleaseDecisionInput（缺省字段使用安全默认） */
function summaryToInput(s) {
  return {
    p0: s.p0 ?? { total: 0, passed: 0 },
    p1: s.p1 ?? { total: 0, passed: 0 },
    coverage: s.coverage ?? 0,
    criticalDefects: s.criticalDefects ?? 0,
    riskLevel: s.riskLevel,
    failurePrediction: s.failurePrediction,
    historicalFailureRate: s.historicalFailureRate,
    modelChange: s.modelChange,
    environmentAbnormal: s.environmentAbnormal,
    flakyCount: s.flakyCount,
    knownIssues: s.knownIssues,
  };
}

/** 递归查找 output 目录下最新的 run-summary.json */
function scanRunSummary(dir) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestMtime = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = scanRunSummary(full);
      if (hit) {
        const m = fs.statSync(hit).mtimeMs;
        if (m > bestMtime) {
          best = hit;
          bestMtime = m;
        }
      }
    } else if (entry.name === 'run-summary.json') {
      const m = fs.statSync(full).mtimeMs;
      if (m > bestMtime) {
        best = full;
        bestMtime = m;
      }
    }
  }
  return best;
}

/** 读取自治运行汇总（显式路径优先，其次扫描 output） */
function loadRunSummary(explicit, baseDir) {
  if (explicit && fs.existsSync(explicit)) {
    try {
      return JSON.parse(fs.readFileSync(explicit, 'utf8'));
    } catch {
      return null;
    }
  }
  const file = scanRunSummary(baseDir);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const baseDir = path.join(root, args['base-dir']);
  const fixture = process.env.GATE_FIXTURE;
  const runId = `run-${Date.now()}`;

  // 动态加载 dist（构建产物），缺失 → SYSTEM_ERROR
  let releaseCi;
  try {
    releaseCi = await import(pathToFileURL(path.join(root, 'dist/src/release-ci/index.js')).href);
  } catch (err) {
    const msg = `无法加载 dist/release-ci（请先 npm run build）：${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`SYSTEM_ERROR: ${msg}\n`);
    process.exit(3);
  }
  const { buildReleaseDecision, releaseExitCode, writeReleaseDecision } = releaseCi;

  let contract;
  if (fixture && FIXTURES[fixture]) {
    const f = FIXTURES[fixture];
    contract = f.systemError
      ? buildReleaseDecision({ runId, feature: args.feature, decisionInput: emptyInput(), systemError: f.systemError })
      : buildReleaseDecision({ runId, feature: args.feature, decisionInput: f.input });
  } else {
    const summary = loadRunSummary(args['run-summary'], baseDir);
    if (!summary) {
      contract = buildReleaseDecision({
        runId,
        feature: args.feature,
        decisionInput: emptyInput(),
        systemError: `未找到 run-summary.json（自治运行汇总缺失，baseDir=${baseDir}）`,
      });
    } else {
      contract = buildReleaseDecision({
        runId: summary.runId ?? runId,
        feature: args.feature ?? summary.feature,
        decisionInput: summaryToInput(summary),
      });
    }
  }

  const code = releaseExitCode(contract.decision);
  try {
    writeReleaseDecision(contract, { baseDir });
  } catch (err) {
    process.stderr.write(`write warning: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ...contract, exitCode: code }, null, 2)}\n`);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`SYSTEM_ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
});
